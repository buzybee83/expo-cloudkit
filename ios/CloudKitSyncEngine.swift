import CloudKit
import Foundation

// MARK: - CKSyncEngine Adapter (iOS 17+)

/// CloudKit sync adapter backed by CKSyncEngine.
///
/// This entire class is guarded by `@available(iOS 17, *)`. The module layer
/// checks availability once in `startSyncEngine()` and selects this adapter or
/// `CloudKitSyncFallbackAdapter` accordingly. After that, all calls go through
/// the `CloudKitSyncProvider` protocol, with no further availability checks needed.
///
/// # Thread Safety
/// CKSyncEngine calls its delegate on an internal serial queue. All mutable state
/// (`pendingSaves`, `pendingDeletes`, `state`) is accessed through `pendingQueue`
/// (a private serial DispatchQueue). The `eventHandler` closure is called from
/// whatever queue CKSyncEngine provides; the module layer dispatches to the main
/// queue before calling `sendEvent`.
@available(iOS 17.0, *)
final class CloudKitSyncEngineAdapter: CloudKitSyncProvider {

  // MARK: - Protocol conformance

  let usesSyncEngine = true
  private(set) var state: SyncProviderState = .notStarted

  // MARK: - Private properties

  private var engine: CKSyncEngine?
  private var eventHandler: ((SyncProviderEvent) -> Void)?
  private let tokenStore: ChangeTokenStore
  private let ckContainer: CKContainer

  /// Serial queue protecting all mutable state: pendingSaves, pendingDeletes, state.
  private let pendingQueue = DispatchQueue(label: "expo.cloudkit.sync.pending")
  private var pendingSaves: [CKRecord] = []
  private var pendingDeletes: [CKRecord.ID] = []

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

    pendingQueue.sync { [weak self] in
      self?.state = .idle
    }
    eventHandler(.stateChanged(.idle))
  }

  func stop() {
    // CKSyncEngine does not have an explicit stop API — releasing the reference
    // stops automatic syncing. Pending changes already queued in the engine are
    // still sent before it releases its resources.
    pendingQueue.sync {
      self.engine = nil
      self.state = .notStarted
      self.pendingSaves.removeAll()
      self.pendingDeletes.removeAll()
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
    // same pendingQueue.async block. If engine.state.add() is called first on
    // the calling thread, nextRecordZoneChangeBatch can fire before the append
    // completes, finding pendingSaves empty while the record ID is already
    // registered as pending.
    pendingQueue.async { [weak self] in
      guard let self = self else { return }
      self.pendingSaves.append(record)
      self.engine?.state.add(pendingRecordZoneChanges: [.saveRecord(record.recordID)])
    }
  }

  func enqueueDelete(_ recordID: CKRecord.ID) {
    pendingQueue.async { [weak self] in
      guard let self = self else { return }
      self.pendingDeletes.append(recordID)
      self.engine?.state.add(pendingRecordZoneChanges: [.deleteRecord(recordID)])
    }
  }
}

// MARK: - CKSyncEngineDelegate

@available(iOS 17.0, *)
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
      pendingQueue.sync { [weak self] in
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
      let zoneName = zoneChanges.zoneID.zoneName
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

        // Conflict resolution: server-record-wins with client field overlay.
        if let ckError = error as? CKError,
           ckError.code == .serverRecordChanged,
           let serverRecord = ckError.serverRecord {
          let merged = resolveConflict(clientRecord: failedSave.record, serverRecord: serverRecord)
          // Re-enqueue the merged record for the next send cycle.
          pendingQueue.async { [weak self] in
            self?.pendingSaves.append(merged)
          }
          syncEngine.state.add(pendingRecordZoneChanges: [.saveRecord(merged.recordID)])
        } else {
          failed.append((recordID, error))
        }
      }

      emit(.recordsSent(saved: saved, failed: failed))

    case .willFetchChanges:
      pendingQueue.sync { [weak self] in
        self?.state = .syncing
      }
      emit(.stateChanged(.syncing))

    case .willFetchRecordZoneChanges:
      // Covered by willFetchChanges; no additional state emission needed.
      break

    case .didFetchChanges:
      pendingQueue.sync { [weak self] in
        self?.state = .idle
      }
      emit(.stateChanged(.idle))

    case .willSendChanges:
      pendingQueue.sync { [weak self] in
        self?.state = .syncing
      }
      emit(.stateChanged(.syncing))

    case .didSendChanges:
      pendingQueue.sync { [weak self] in
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
    return pendingQueue.sync {
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
