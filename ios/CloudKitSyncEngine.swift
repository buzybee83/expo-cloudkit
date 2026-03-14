import CloudKit
import Foundation

// MARK: - CKSyncEngine Adapter (iOS 17+)

/// CloudKit sync adapter backed by CKSyncEngine.
///
/// This entire class is guarded by `@available(iOS 17, macOS 14, *)`. The module layer
/// checks availability once in `startSyncEngine()` and selects this adapter or
/// `CloudKitSyncFallbackAdapter` accordingly. After that, all calls go through
/// the `CloudKitSyncProvider` protocol, with no further availability checks needed.
///
/// # Thread Safety
/// CKSyncEngine calls its delegate on an internal serial queue. All mutable state
/// (`pendingSaves`, `pendingDeletes`, `state`, `pendingConflicts`) is accessed
/// through `stateQueue` — a private serial DispatchQueue acting as a synchronisation
/// domain equivalent to an actor's executor.
///
/// # Why not a Swift actor?
/// `CKSyncEngineDelegate` conformance requires `handleEvent(_:syncEngine:)` to be
/// callable from arbitrary system threads. An actor type would make this method
/// actor-isolated, which conflicts with how CKSyncEngine invokes it. The
/// `nonisolated` + `Task { await self.method() }` pattern *would* work for the
/// non-async delegate methods, but `handleEvent` is `async` — the actor re-entry
/// pattern is correct here, and Swift's actor-reentrancy rules allow it, but the
/// intermediate `stateQueue.sync` calls inside the async delegate body would
/// deadlock against the actor executor. A full actor migration requires converting
/// the push/pull loops to structured concurrency first.
///
/// TODO: migrate to actor when CKSyncEngineDelegate nonisolated patterns are
/// verified — replace `stateQueue` barrier writes with actor isolation.
@available(iOS 17.0, macOS 14.0, *)
final class CloudKitSyncEngineAdapter: CloudKitSyncProvider {

  // MARK: - Protocol conformance

  let usesSyncEngine = true
  private(set) var state: SyncProviderState = .notStarted

  // MARK: - Private properties

  private var engine: CKSyncEngine?
  private var eventHandler: ((SyncProviderEvent) -> Void)?
  private let tokenStore: ChangeTokenStore
  private let ckContainer: CKContainer

  /// When true, CONFLICT errors are forwarded to JS via `onSyncConflict` instead of
  /// being auto-resolved with server-record-wins. Default: false.
  var conflictResolutionEnabled = false

  /// Serial DispatchQueue acting as the synchronisation domain for all mutable state:
  /// `pendingSaves`, `pendingDeletes`, `state`, and `pendingConflicts`.
  /// Named after the actor-equivalent pattern it approximates.
  /// Barrier writes via `stateQueue.sync` ensure exclusive access.
  private let stateQueue = DispatchQueue(label: "expo.cloudkit.sync.state", qos: .userInitiated)
  private var pendingSaves: [CKRecord] = []
  private var pendingDeletes: [CKRecord.ID] = []

  /// Continuations keyed by requestId, awaiting JS resolution of a conflict.
  /// Access only from `stateQueue`.
  private var pendingConflicts: [String: CheckedContinuation<[String: Any]?, Never>] = [:]

  // MARK: - Health Metrics Accumulators (I.3)
  // Accessed exclusively from the CKSyncEngine delegate queue (serial, owned by CKSyncEngine).

  /// Wall-clock start time recorded at willSendChanges / willFetchChanges.
  private var cycleStartTime: Date?
  /// Records received in the current fetch cycle across all zones.
  private var cycleReceivedCount: Int = 0
  /// Records successfully sent in the current send cycle.
  private var cycleSentCount: Int = 0
  /// Records that failed to send in the current send cycle.
  private var cycleFailedCount: Int = 0

  // MARK: - Init

  init(ckContainer: CKContainer, tokenStore: ChangeTokenStore) {
    self.ckContainer = ckContainer
    self.tokenStore = tokenStore
  }

  // MARK: - CloudKitSyncProvider

  func start(
    zones: [CKRecordZone.ID],
    database: CKDatabase.Scope,
    automaticallySync: Bool,
    eventHandler: @escaping (SyncProviderEvent) -> Void
  ) {
    self.eventHandler = eventHandler

    let db = ckContainer.database(with: database)
    let lastKnownState = tokenStore.loadSyncEngineState()

    var config = CKSyncEngine.Configuration(
      database: db,
      stateSerialization: lastKnownState,
      delegate: self
    )
    config.automaticallySync = automaticallySync

    let newEngine = CKSyncEngine(config)
    self.engine = newEngine

    // Register the zones with the engine so it knows which zones to sync.
    // CKSyncEngine de-duplicates these; it's safe to call on every start.
    let zonesToAdd = zones.map { CKRecordZone(zoneID: $0) }
    if !zonesToAdd.isEmpty {
      newEngine.state.add(pendingDatabaseChanges: zonesToAdd.map { .saveZone($0) })
    }

    stateQueue.sync { [weak self] in
      self?.state = .idle
    }
    eventHandler(.stateChanged(.idle))
  }

  func stop() {
    // CKSyncEngine does not have an explicit stop API — releasing the reference
    // stops automatic syncing. Pending changes already queued in the engine are
    // still sent before it releases its resources.
    stateQueue.sync {
      self.engine = nil
      self.state = .notStarted
      self.pendingSaves.removeAll()
      self.pendingDeletes.removeAll()
      // Drain any pending conflict continuations. Resuming with nil means the
      // adapter will fall back to the server record — safe default on shutdown.
      let drained = self.pendingConflicts
      self.pendingConflicts.removeAll()
      for (_, continuation) in drained {
        continuation.resume(returning: nil)
      }
    }
    eventHandler?(.stateChanged(.notStarted))
    eventHandler = nil
  }

  func triggerSync() {
    guard let engine = engine else { return }
    // Asking the engine to fetch changes immediately.
    // CKSyncEngine coalesces overlapping fetches internally.
    // fetchChanges() is async throws — wrap in a Task since triggerSync() is synchronous.
    Task {
      try? await engine.fetchChanges()
    }
  }

  func enqueueSave(_ record: CKRecord) {
    // Both the array append and the engine notification must happen inside the
    // same stateQueue.async block. If engine.state.add() is called first on
    // the calling thread, nextRecordZoneChangeBatch can fire before the append
    // completes, finding pendingSaves empty while the record ID is already
    // registered as pending.
    stateQueue.async { [weak self] in
      guard let self = self else { return }
      self.pendingSaves.append(record)
      self.engine?.state.add(pendingRecordZoneChanges: [.saveRecord(record.recordID)])
    }
  }

  func enqueueDelete(_ recordID: CKRecord.ID) {
    stateQueue.async { [weak self] in
      guard let self = self else { return }
      self.pendingDeletes.append(recordID)
      self.engine?.state.add(pendingRecordZoneChanges: [.deleteRecord(recordID)])
    }
  }

  func resumeConflictResolution(requestId: String, resolvedRecord: [String: Any]?) {
    stateQueue.async { [weak self] in
      guard let self = self else { return }
      guard let continuation = self.pendingConflicts.removeValue(forKey: requestId) else {
        // Stale or unknown requestId — log and return gracefully.
        print("[ExpoCloudKit] resumeConflictResolution: no pending conflict for requestId '\(requestId)'")
        return
      }
      continuation.resume(returning: resolvedRecord)
    }
  }
}

// MARK: - CKSyncEngineDelegate

@available(iOS 17.0, macOS 14.0, *)
extension CloudKitSyncEngineAdapter: CKSyncEngineDelegate {

  func handleEvent(_ event: CKSyncEngine.Event, syncEngine: CKSyncEngine) async {
    switch event {

    case .stateUpdate(let stateUpdate):
      // Persist state immediately — loss of state token means full re-sync.
      tokenStore.saveSyncEngineState(stateUpdate.stateSerialization)

    case .accountChange(let accountEvent):
      // If the account changed, all stored tokens are invalid.
      switch accountEvent.changeType {
      case .signIn, .switchAccounts:
        tokenStore.clearAllTokens()
      default:
        break
      }
      stateQueue.sync { [weak self] in
        self?.state = .suspended
      }
      emit(.stateChanged(.suspended))

    case .fetchedDatabaseChanges(let dbChanges):
      // Process zone deletions — zones that no longer exist on the server.
      // For now we report them as sync errors so the JS layer can react.
      for deletion in dbChanges.deletions {
        emit(.syncError(SyncAdapterError.zoneDeleted(deletion.zoneID.zoneName)))
      }

    case .fetchedRecordZoneChanges(let zoneChanges):
      let changed = zoneChanges.modifications.map { $0.record }
      let deleted = zoneChanges.deletions.map { $0.recordID }
      // CKSyncEngine.Event.FetchedRecordZoneChanges.zoneID was removed in iOS 18.
      // Derive the zone name from the first modification or deletion record ID.
      let zoneName: String
      if let firstRecord = zoneChanges.modifications.first?.record {
        zoneName = firstRecord.recordID.zoneID.zoneName
      } else if let firstDeleted = zoneChanges.deletions.first?.recordID {
        zoneName = firstDeleted.zoneID.zoneName
      } else {
        zoneName = CKRecordZone.default().zoneID.zoneName
      }
      cycleReceivedCount += changed.count + deleted.count
      emit(.recordsFetched(changed: changed, deleted: deleted, zoneName: zoneName))

    case .sentDatabaseChanges:
      // Zone-level sends (zone creation) — no action needed.
      break

    case .sentRecordZoneChanges(let sentChanges):
      let saved = sentChanges.savedRecords
      var failed: [(CKRecord.ID, Error)] = []

      for failedSave in sentChanges.failedRecordSaves {
        let recordID = failedSave.record.recordID
        let error = failedSave.error

        guard let ckError = error as? CKError,
              ckError.code == .serverRecordChanged,
              let serverRecord = ckError.serverRecord else {
          // Non-conflict error — surface as a failed save.
          failed.append((recordID, error))
          continue
        }

        let clientRecord = failedSave.record

        if conflictResolutionEnabled {
          // Custom conflict resolution: emit to JS and await the result.
          let requestId = UUID().uuidString
          let clientDict = Converters.toDictionary(clientRecord)
          let serverDict = Converters.toDictionary(serverRecord)

          let eventPayload: [String: Any] = [
            "requestId": requestId,
            "clientRecord": clientDict,
            "serverRecord": serverDict
          ]

          // Register the continuation slot synchronously before emitting the event
          // to JS. This prevents a race where JS calls resolveSyncConflict before
          // the slot is available. `stateQueue.sync` is safe here because
          // `handleEvent` runs on CKSyncEngine's internal queue (not stateQueue).
          let resolvedDict: [String: Any]? = await withCheckedContinuation { continuation in
            stateQueue.sync { [weak self] in
              self?.pendingConflicts[requestId] = continuation
            }
            // Emit the event to JS only after the slot is registered.
            DispatchQueue.main.async { [weak self] in
              self?.eventHandler?(.conflictPending(requestId: requestId, payload: eventPayload))
            }
          }

          // Determine which record to re-enqueue based on JS resolution.
          let recordToEnqueue: CKRecord
          if let dict = resolvedDict, let resolved = try? Converters.toCKRecord(from: dict) {
            recordToEnqueue = resolved
          } else {
            // JS passed null — accept server version unchanged.
            recordToEnqueue = serverRecord
          }
          stateQueue.async { [weak self] in
            self?.pendingSaves.append(recordToEnqueue)
          }
          syncEngine.state.add(pendingRecordZoneChanges: [.saveRecord(recordToEnqueue.recordID)])

        } else {
          // Default: server-record-wins with client field overlay.
          let merged = resolveConflict(clientRecord: clientRecord, serverRecord: serverRecord)
          stateQueue.async { [weak self] in
            self?.pendingSaves.append(merged)
          }
          syncEngine.state.add(pendingRecordZoneChanges: [.saveRecord(merged.recordID)])
        }
      }

      cycleSentCount += saved.count
      cycleFailedCount += failed.count
      emit(.recordsSent(saved: saved, failed: failed))

    case .willFetchChanges:
      cycleStartTime = Date()
      cycleReceivedCount = 0
      stateQueue.sync { [weak self] in
        self?.state = .syncing
      }
      emit(.stateChanged(.syncing))

    case .willFetchRecordZoneChanges:
      // Covered by willFetchChanges; no additional state emission needed.
      break

    case .didFetchChanges:
      let fetchDurationMs: Double
      if let start = cycleStartTime {
        fetchDurationMs = Date().timeIntervalSince(start) * 1_000
      } else {
        fetchDurationMs = 0
      }
      emit(.syncHealth(
        sentCount: 0,
        receivedCount: cycleReceivedCount,
        failedCount: 0,
        durationMs: fetchDurationMs,
        syncEngine: true
      ))
      cycleStartTime = nil
      cycleReceivedCount = 0
      stateQueue.sync { [weak self] in
        self?.state = .idle
      }
      emit(.stateChanged(.idle))

    case .willSendChanges:
      cycleStartTime = Date()
      cycleSentCount = 0
      cycleFailedCount = 0
      stateQueue.sync { [weak self] in
        self?.state = .syncing
      }
      emit(.stateChanged(.syncing))

    case .didSendChanges:
      let sendDurationMs: Double
      if let start = cycleStartTime {
        sendDurationMs = Date().timeIntervalSince(start) * 1_000
      } else {
        sendDurationMs = 0
      }
      emit(.syncHealth(
        sentCount: cycleSentCount,
        receivedCount: 0,
        failedCount: cycleFailedCount,
        durationMs: sendDurationMs,
        syncEngine: true
      ))
      cycleStartTime = nil
      cycleSentCount = 0
      cycleFailedCount = 0
      stateQueue.sync { [weak self] in
        self?.state = .idle
      }
      emit(.stateChanged(.idle))

    @unknown default:
      break
    }
  }

  func nextRecordZoneChangeBatch(
    _ context: CKSyncEngine.SendChangesContext,
    syncEngine: CKSyncEngine
  ) async -> CKSyncEngine.RecordZoneChangeBatch? {
    return stateQueue.sync {
      guard !pendingSaves.isEmpty || !pendingDeletes.isEmpty else {
        return nil
      }

      let saves = pendingSaves
      let deletes = pendingDeletes
      pendingSaves.removeAll()
      pendingDeletes.removeAll()

      return CKSyncEngine.RecordZoneChangeBatch(
        recordsToSave: saves,
        recordIDsToDelete: deletes
      )
    }
  }

  // MARK: - Conflict Resolution

  /// Server-record-wins merge: start with the server record and overlay the
  /// client's changed fields on top. This preserves the server's system fields
  /// (changeTag, modificationDate) while applying the client's intent.
  private func resolveConflict(clientRecord: CKRecord, serverRecord: CKRecord) -> CKRecord {
    for key in clientRecord.changedKeys() {
      serverRecord[key] = clientRecord[key]
    }
    return serverRecord
  }

  // MARK: - Event Emission Helper

  private func emit(_ event: SyncProviderEvent) {
    eventHandler?(event)
  }
}

// MARK: - Internal Adapter Errors

/// Errors produced internally by `CloudKitSyncEngineAdapter` (not CKErrors).
enum SyncAdapterError: Error, LocalizedError {
  case zoneDeleted(String)

  var errorDescription: String? {
    switch self {
    case .zoneDeleted(let name):
      return "Zone '\(name)' was deleted on the server."
    }
  }
}
