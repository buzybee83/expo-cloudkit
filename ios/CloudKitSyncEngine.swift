import CloudKit
import Foundation

// MARK: - CKSyncEngine Adapter (iOS 17+)

/// CloudKit sync adapter backed by CKSyncEngine.
///
/// This entire type is guarded by `@available(iOS 17, macOS 14, *)`. The module layer
/// checks availability once in `startSyncEngine()` and selects this adapter or
/// `CloudKitSyncFallbackAdapter` accordingly. After that, all calls go through
/// the `CloudKitSyncProvider` protocol, with no further availability checks needed.
///
/// # Thread Safety
/// `CloudKitSyncEngineAdapter` is a Swift `actor`. All mutable state
/// (`pendingSaves`, `pendingDeletes`, `state`, `pendingConflicts`, and the health
/// metric accumulators) is actor-isolated, providing compile-time data-race safety.
///
/// `CKSyncEngineDelegate` methods (`handleEvent` and `nextRecordZoneChangeBatch`) are
/// called by the system on arbitrary threads. They are annotated `nonisolated` and
/// re-enter actor isolation via `Task { await self.method() }` or
/// `await self.method()` (because the delegate methods are already `async`).
///
/// `sendEvent` dispatches to `@MainActor` before calling `eventHandler` so that
/// Expo Modules Core always receives events on the main queue.
@available(iOS 17.0, macOS 14.0, *)
actor CloudKitSyncEngineAdapter: CloudKitSyncProvider {

  // MARK: - Protocol conformance

  let usesSyncEngine = true

  /// Exposed `nonisolated(unsafe)` so that the synchronous `getSyncState()` JS
  /// function can read it without `await`. Written exclusively from actor-isolated
  /// code, so the single-writer guarantee makes the unsafe annotation safe in
  /// practice. Reads from outside the actor are advisory (best-effort snapshot).
  nonisolated(unsafe) private(set) var state: SyncProviderState = .notStarted

  // MARK: - Private actor-isolated properties

  private var engine: CKSyncEngine?
  private var eventHandler: ((SyncProviderEvent) -> Void)?
  private let tokenStore: ChangeTokenStore
  private let ckContainer: CKContainer

  /// When true, CONFLICT errors are forwarded to JS via `onSyncConflict` instead of
  /// being auto-resolved with server-record-wins. Default: false.
  ///
  /// Declared `nonisolated(unsafe)` so the module can set it synchronously before
  /// calling `start()`. It is written exactly once at configuration time and never
  /// mutated during an in-flight sync cycle, making the unsynchronised write safe.
  nonisolated(unsafe) var conflictResolutionEnabled = false

  private var pendingSaves: [CKRecord] = []
  private var pendingDeletes: [CKRecord.ID] = []

  /// Continuations keyed by requestId, awaiting JS resolution of a conflict.
  private var pendingConflicts: [String: CheckedContinuation<[String: Any]?, Never>] = [:]

  // MARK: - Health Metrics Accumulators (I.3)

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

    // Register zones so CKSyncEngine knows which zones to track.
    // CKSyncEngine de-duplicates these; safe to call on every start.
    let zonesToAdd = zones.map { CKRecordZone(zoneID: $0) }
    if !zonesToAdd.isEmpty {
      newEngine.state.add(pendingDatabaseChanges: zonesToAdd.map { .saveZone($0) })
    }

    state = .idle
    emit(.stateChanged(.idle))
  }

  func stop() {
    // CKSyncEngine has no explicit stop API — releasing the reference stops
    // automatic syncing. Pending changes already queued in the engine are still
    // sent before it releases its resources.
    engine = nil
    state = .notStarted
    pendingSaves.removeAll()
    pendingDeletes.removeAll()

    // Drain any pending conflict continuations. Resuming with nil means the
    // adapter falls back to server-record-wins — safe default on shutdown.
    let drained = pendingConflicts
    pendingConflicts.removeAll()
    for (_, continuation) in drained {
      continuation.resume(returning: nil)
    }

    eventHandler?(.stateChanged(.notStarted))
    eventHandler = nil
  }

  func triggerSync() {
    guard let engine = engine else { return }
    // fetchChanges() is async throws — wrap in a Task since triggerSync() is synchronous.
    Task {
      try? await engine.fetchChanges()
    }
  }

  func enqueueSave(_ record: CKRecord) {
    // Both the array append and the engine notification must be atomic with
    // respect to each other. If engine.state.add() were called first, the
    // delegate's nextRecordZoneChangeBatch could fire before the append
    // completes, finding pendingSaves empty while the record ID is already
    // registered as pending. Executing both inside the same actor turn is safe.
    pendingSaves.append(record)
    engine?.state.add(pendingRecordZoneChanges: [.saveRecord(record.recordID)])
  }

  func enqueueDelete(_ recordID: CKRecord.ID) {
    pendingDeletes.append(recordID)
    engine?.state.add(pendingRecordZoneChanges: [.deleteRecord(recordID)])
  }

  func resumeConflictResolution(requestId: String, resolvedRecord: [String: Any]?) {
    guard let continuation = pendingConflicts.removeValue(forKey: requestId) else {
      // Stale or unknown requestId — log and return gracefully.
      print("[ExpoCloudKit] resumeConflictResolution: no pending conflict for requestId '\(requestId)'")
      return
    }
    continuation.resume(returning: resolvedRecord)
  }

  // MARK: - Actor-isolated delegate helpers

  /// Persists the new state token and does nothing else.
  private func handleStateUpdate(_ stateUpdate: CKSyncEngine.Event.StateUpdate) {
    tokenStore.saveSyncEngineState(stateUpdate.stateSerialization)
  }

  /// Handles an account change event.
  private func handleAccountChange(_ accountEvent: CKSyncEngine.Event.AccountChange) {
    switch accountEvent.changeType {
    case .signIn, .switchAccounts:
      tokenStore.clearAllTokens()
    default:
      break
    }
    state = .suspended
    emit(.stateChanged(.suspended))
  }

  /// Processes fetched database changes (zone deletions).
  private func handleFetchedDatabaseChanges(_ dbChanges: CKSyncEngine.Event.FetchedDatabaseChanges) {
    for deletion in dbChanges.deletions {
      emit(.syncError(SyncAdapterError.zoneDeleted(deletion.zoneID.zoneName)))
    }
  }

  /// Processes fetched record zone changes and emits recordsFetched.
  private func handleFetchedRecordZoneChanges(_ zoneChanges: CKSyncEngine.Event.FetchedRecordZoneChanges) {
    let changed = zoneChanges.modifications.map { $0.record }
    let deleted = zoneChanges.deletions.map { $0.recordID }
    // Derive zone name from the first modification or deletion record ID.
    // (CKSyncEngine.Event.FetchedRecordZoneChanges.zoneID was removed in iOS 18.)
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
  }

  /// Processes sent record zone changes, resolving conflicts as needed.
  private func handleSentRecordZoneChanges(
    _ sentChanges: CKSyncEngine.Event.SentRecordZoneChanges,
    syncEngine: CKSyncEngine
  ) async {
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

        // Register the continuation slot before emitting the event to JS.
        // This prevents a race where JS calls resolveSyncConflict before the slot
        // is available. Because we are actor-isolated here, the assignment is safe.
        let resolvedDict: [String: Any]? = await withCheckedContinuation { continuation in
          // We are still actor-isolated at this point; the continuation is stored
          // before yielding to the caller. The emit below is dispatched to @MainActor
          // asynchronously, so it will not execute until after this withCheckedContinuation
          // block suspends, ensuring the slot is always registered first.
          pendingConflicts[requestId] = continuation
          emit(.conflictPending(requestId: requestId, payload: eventPayload))
        }

        // Determine which record to re-enqueue based on JS resolution.
        let recordToEnqueue: CKRecord
        if let dict = resolvedDict, let resolved = try? Converters.toCKRecord(from: dict) {
          recordToEnqueue = resolved
        } else {
          // JS passed nil — accept server version unchanged.
          recordToEnqueue = serverRecord
        }
        pendingSaves.append(recordToEnqueue)
        syncEngine.state.add(pendingRecordZoneChanges: [.saveRecord(recordToEnqueue.recordID)])

      } else {
        // Default: server-record-wins with client field overlay.
        let merged = resolveConflict(clientRecord: clientRecord, serverRecord: serverRecord)
        pendingSaves.append(merged)
        syncEngine.state.add(pendingRecordZoneChanges: [.saveRecord(merged.recordID)])
      }
    }

    cycleSentCount += saved.count
    cycleFailedCount += failed.count
    emit(.recordsSent(saved: saved, failed: failed))
  }

  /// Marks the start of a fetch cycle.
  private func handleWillFetchChanges() {
    cycleStartTime = Date()
    cycleReceivedCount = 0
    state = .syncing
    emit(.stateChanged(.syncing))
  }

  /// Closes a fetch cycle and emits health metrics.
  private func handleDidFetchChanges() {
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
    state = .idle
    emit(.stateChanged(.idle))
  }

  /// Marks the start of a send cycle.
  private func handleWillSendChanges() {
    cycleStartTime = Date()
    cycleSentCount = 0
    cycleFailedCount = 0
    state = .syncing
    emit(.stateChanged(.syncing))
  }

  /// Closes a send cycle and emits health metrics.
  private func handleDidSendChanges() {
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
    state = .idle
    emit(.stateChanged(.idle))
  }

  /// Returns the current batch of pending changes and clears the queues.
  /// Called from `nextRecordZoneChangeBatch` after hopping into actor isolation.
  private func drainPendingBatch() -> CKSyncEngine.RecordZoneChangeBatch? {
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

  /// Dispatches the event to @MainActor before invoking `eventHandler`.
  /// Expo Modules Core requires event emission on the main queue.
  private func emit(_ event: SyncProviderEvent) {
    guard let handler = eventHandler else { return }
    Task { @MainActor in
      handler(event)
    }
  }
}

// MARK: - CKSyncEngineDelegate

@available(iOS 17.0, macOS 14.0, *)
extension CloudKitSyncEngineAdapter: CKSyncEngineDelegate {

  /// CKSyncEngine calls this on its own internal serial queue. Annotated
  /// `nonisolated` to satisfy the protocol (which imposes no executor constraint).
  /// We then `await` actor-isolated helpers, which is safe because the method is
  /// already `async` — Swift's actor re-entrancy rules allow the hop.
  nonisolated func handleEvent(_ event: CKSyncEngine.Event, syncEngine: CKSyncEngine) async {
    switch event {

    case .stateUpdate(let stateUpdate):
      await handleStateUpdate(stateUpdate)

    case .accountChange(let accountEvent):
      await handleAccountChange(accountEvent)

    case .fetchedDatabaseChanges(let dbChanges):
      await handleFetchedDatabaseChanges(dbChanges)

    case .fetchedRecordZoneChanges(let zoneChanges):
      await handleFetchedRecordZoneChanges(zoneChanges)

    case .sentDatabaseChanges:
      // Zone-level sends (zone creation) — no action needed.
      break

    case .sentRecordZoneChanges(let sentChanges):
      await handleSentRecordZoneChanges(sentChanges, syncEngine: syncEngine)

    case .willFetchChanges:
      await handleWillFetchChanges()

    case .willFetchRecordZoneChanges:
      // Covered by willFetchChanges; no additional state emission needed.
      break

    case .didFetchChanges:
      await handleDidFetchChanges()

    case .willSendChanges:
      await handleWillSendChanges()

    case .didSendChanges:
      await handleDidSendChanges()

    @unknown default:
      break
    }
  }

  /// CKSyncEngine calls this on its own internal serial queue. Annotated
  /// `nonisolated` to satisfy the protocol; we hop to actor isolation to safely
  /// read and mutate `pendingSaves`/`pendingDeletes`.
  nonisolated func nextRecordZoneChangeBatch(
    _ context: CKSyncEngine.SendChangesContext,
    syncEngine: CKSyncEngine
  ) async -> CKSyncEngine.RecordZoneChangeBatch? {
    return await drainPendingBatch()
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
