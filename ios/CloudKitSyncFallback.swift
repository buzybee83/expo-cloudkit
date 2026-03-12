import CloudKit
import Foundation

// MARK: - iOS 16 Sync Fallback Adapter

/// CloudKit sync adapter for iOS 16 using `CKFetchRecordZoneChangesOperation` +
/// `CKModifyRecordsOperation` with persisted `CKServerChangeToken` per zone.
///
/// This adapter mimics CKSyncEngine behavior using timer-based polling and manual
/// operations. The JS API surface is identical to `CloudKitSyncEngineAdapter`.
///
/// # Sync Cycle
/// 1. Push phase: flush `pendingSaves`/`pendingDeletes` via `CKModifyRecordsOperation`.
///    On conflict, apply server-record-wins merge and retry once.
/// 2. Pull phase: run `CKFetchRecordZoneChangesOperation` with stored tokens.
///    Emit `recordsFetched` per zone. Persist new tokens.
/// 3. Emit `stateChanged(.idle)` when the cycle completes.
///
/// # Thread Safety
/// All mutable state (`pendingSaves`, `pendingDeletes`, `trackedZones`, `state`,
/// `isSyncInFlight`, `pendingConflicts`) is accessed through `stateQueue` — a private
/// serial DispatchQueue acting as a synchronisation domain equivalent to an actor's
/// executor. Timer callbacks and CKOperation completion blocks re-enter via
/// `stateQueue.async`; synchronous reads use `stateQueue.sync`.
///
/// # Why not a Swift actor?
/// The push phase (`pushChanges`) uses CKModifyRecordsOperation's
/// `perRecordSaveBlock` — a synchronous callback called on CloudKit's internal queue.
/// Inside that callback, the current implementation calls `stateQueue.sync` to
/// register conflict continuations. Wrapping this in an actor would require converting
/// the entire push/pull callback chain to structured concurrency (async/await) before
/// actor isolation is safe to apply.
///
/// TODO: migrate to actor after converting pushChanges/pullChanges to async throws.
final class CloudKitSyncFallbackAdapter: CloudKitSyncProvider {

  // MARK: - Protocol conformance

  let usesSyncEngine = false
  private(set) var state: SyncProviderState = .notStarted

  // MARK: - Private properties

  private let ckContainer: CKContainer
  private let tokenStore: ChangeTokenStore
  private var eventHandler: ((SyncProviderEvent) -> Void)?

  private var trackedZones: [CKRecordZone.ID] = []
  private var databaseScope: CKDatabase.Scope = .private

  private var pollingTimer: Timer?
  private var pollingInterval: TimeInterval = 30.0

  /// Default: 1 retry on conflict before surfacing the error.
  private let maxConflictRetries = 1

  /// Serial DispatchQueue acting as the synchronisation domain for all mutable state.
  /// Named after the actor-equivalent pattern it approximates.
  private let stateQueue = DispatchQueue(label: "expo.cloudkit.syncfallback.state", qos: .userInitiated)
  private var pendingSaves: [CKRecord] = []
  private var pendingDeletes: [CKRecord.ID] = []

  /// Whether a sync cycle is already in-flight. Prevents overlapping cycles.
  private var isSyncInFlight = false

  /// When true, CONFLICT errors are forwarded to JS via `onSyncConflict` instead of
  /// being auto-resolved with server-record-wins. Default: false.
  var conflictResolutionEnabled = false

  /// Continuations keyed by requestId, awaiting JS resolution of a conflict.
  /// Access only from `stateQueue`.
  private var pendingConflicts: [String: CheckedContinuation<[String: Any]?, Never>] = [:]

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
    stateQueue.sync { [weak self] in
      guard let self = self else { return }
      self.trackedZones = zones
      self.databaseScope = database
      self.state = .idle
    }

    eventHandler(.stateChanged(.idle))

    // Run an initial sync immediately, then start the polling timer if requested.
    runSyncCycle()

    if automaticallySync {
      // Timer must be scheduled on the main run loop.
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { return }
        self.pollingTimer = Timer.scheduledTimer(
          withTimeInterval: self.pollingInterval,
          repeats: true
        ) { [weak self] _ in
          self?.runSyncCycle()
        }
      }
    }
  }

  func stop() {
    DispatchQueue.main.async { [weak self] in
      self?.pollingTimer?.invalidate()
      self?.pollingTimer = nil
    }
    stateQueue.sync { [weak self] in
      guard let self = self else { return }
      self.state = .notStarted
      self.pendingSaves.removeAll()
      self.pendingDeletes.removeAll()
      self.trackedZones = []
      // Drain any pending conflict continuations with nil (server-record-wins)
      // so no Task is left suspended after stop().
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
    runSyncCycle()
  }

  func enqueueSave(_ record: CKRecord) {
    stateQueue.async { [weak self] in
      self?.pendingSaves.append(record)
    }
  }

  func enqueueDelete(_ recordID: CKRecord.ID) {
    stateQueue.async { [weak self] in
      self?.pendingDeletes.append(recordID)
    }
  }

  func resumeConflictResolution(requestId: String, resolvedRecord: [String: Any]?) {
    stateQueue.async { [weak self] in
      guard let self = self else { return }
      guard let continuation = self.pendingConflicts.removeValue(forKey: requestId) else {
        print("[ExpoCloudKit] resumeConflictResolution: no pending conflict for requestId '\(requestId)'")
        return
      }
      continuation.resume(returning: resolvedRecord)
    }
  }

  // MARK: - Sync Cycle

  /// Runs a push-then-pull cycle. Guards against overlapping cycles.
  private func runSyncCycle() {
    stateQueue.async { [weak self] in
      guard let self = self else { return }
      guard !self.isSyncInFlight else { return }
      self.isSyncInFlight = true
      self.state = .syncing
      self.eventHandler?(.stateChanged(.syncing))

      // Capture current pending changes and zone configuration.
      let saves = self.pendingSaves
      let deletes = self.pendingDeletes
      self.pendingSaves.removeAll()
      self.pendingDeletes.removeAll()
      let zones = self.trackedZones
      let scope = self.databaseScope

      // Push phase first, then pull.
      self.pushChanges(saves: saves, deletes: deletes, scope: scope, retryCount: 0) { [weak self] in
        guard let self = self else { return }
        self.pullChanges(zones: zones, scope: scope) {
          self.stateQueue.async {
            self.isSyncInFlight = false
            self.state = .idle
            self.eventHandler?(.stateChanged(.idle))
          }
        }
      }
    }
  }

  // MARK: - Push Phase

  private func pushChanges(
    saves: [CKRecord],
    deletes: [CKRecord.ID],
    scope: CKDatabase.Scope,
    retryCount: Int,
    completion: @escaping () -> Void
  ) {
    guard !saves.isEmpty || !deletes.isEmpty else {
      completion()
      return
    }

    let db = database(for: scope)
    let operation = CKModifyRecordsOperation(
      recordsToSave: saves.isEmpty ? nil : saves,
      recordIDsToDelete: deletes.isEmpty ? nil : deletes
    )
    operation.savePolicy = .changedKeys
    operation.qualityOfService = .userInitiated

    var savedRecords: [CKRecord] = []
    var failedSaves: [(CKRecord.ID, Error)] = []
    var conflictedRecords: [CKRecord] = []

    operation.perRecordSaveBlock = { [weak self] recordID, result in
      guard let self = self else { return }
      switch result {
      case .success(let record):
        savedRecords.append(record)

      case .failure(let error):
        guard let ckError = error as? CKError,
              ckError.code == .serverRecordChanged,
              let serverRecord = ckError.serverRecord else {
          // Non-conflict error — surface as a failed save.
          failedSaves.append((recordID, error))
          return
        }

        guard let clientRecord = saves.first(where: { $0.recordID == recordID }) else {
          // Client record not found in saves list (shouldn't happen, but be safe).
          failedSaves.append((recordID, error))
          return
        }

        if self.conflictResolutionEnabled {
          // Custom conflict resolution: emit to JS and await the result asynchronously.
          // The current perRecordSaveBlock is synchronous, so we spawn a Task to bridge
          // into async. The resolved record will be enqueued for the next sync cycle.
          let requestId = UUID().uuidString
          let clientDict = Converters.toDictionary(clientRecord)
          let serverDict = Converters.toDictionary(serverRecord)

          let eventPayload: [String: Any] = [
            "requestId": requestId,
            "clientRecord": clientDict,
            "serverRecord": serverDict
          ]

          Task { [weak self] in
            guard let self = self else { return }

            // Register the continuation slot synchronously before emitting the
            // event to JS, preventing the race where JS calls resolveSyncConflict
            // before the slot is available.
            // Note: `perRecordSaveBlock` runs on a CloudKit internal queue (not
            // stateQueue), so `stateQueue.sync` is safe here.
            let resolvedDict: [String: Any]? = await withCheckedContinuation { continuation in
              self.stateQueue.sync {
                self.pendingConflicts[requestId] = continuation
              }
              // Emit the event only after the slot is registered.
              DispatchQueue.main.async { [weak self] in
                self?.eventHandler?(.conflictPending(requestId: requestId, payload: eventPayload))
              }
            }

            // Determine the record to enqueue based on JS response.
            let recordToEnqueue: CKRecord
            if let dict = resolvedDict, let resolved = try? Converters.toCKRecord(from: dict) {
              recordToEnqueue = resolved
            } else {
              recordToEnqueue = serverRecord
            }
            self.enqueueSave(recordToEnqueue)
            // Kick off a new sync cycle to send the resolved record.
            self.runSyncCycle()
          }
          // Do NOT add to conflictedRecords — this conflict is handled asynchronously above.
        } else {
          // Default: server-record-wins with client field overlay.
          conflictedRecords.append(self.resolveConflict(clientRecord: clientRecord, serverRecord: serverRecord))
        }
      }
    }

    operation.modifyRecordsResultBlock = { [weak self] result in
      guard let self = self else { return }

      switch result {
      case .failure(let error):
        self.eventHandler?(.syncError(error))
      case .success:
        // Emit what was sent (including partial failures).
        if !savedRecords.isEmpty || !failedSaves.isEmpty {
          self.eventHandler?(.recordsSent(saved: savedRecords, failed: failedSaves))
        }
      }

      // Retry conflict-resolved records once.
      if !conflictedRecords.isEmpty && retryCount < self.maxConflictRetries {
        self.pushChanges(
          saves: conflictedRecords,
          deletes: [],
          scope: scope,
          retryCount: retryCount + 1,
          completion: completion
        )
      } else {
        // Surface any conflict records that exhausted retries as failed.
        if !conflictedRecords.isEmpty {
          let exhaustedFails: [(CKRecord.ID, Error)] = conflictedRecords.map {
            ($0.recordID, CKError(.serverRecordChanged))
          }
          self.eventHandler?(.recordsSent(saved: [], failed: exhaustedFails))
        }
        completion()
      }
    }

    db.add(operation)
  }

  // MARK: - Pull Phase

  private func pullChanges(
    zones: [CKRecordZone.ID],
    scope: CKDatabase.Scope,
    completion: @escaping () -> Void
  ) {
    guard !zones.isEmpty else {
      completion()
      return
    }

    let db = database(for: scope)

    // Build per-zone configuration with stored change tokens.
    var configs: [CKRecordZone.ID: CKFetchRecordZoneChangesOperation.ZoneConfiguration] = [:]
    for zoneID in zones {
      var config = CKFetchRecordZoneChangesOperation.ZoneConfiguration()
      config.previousServerChangeToken = tokenStore.loadZoneToken(zoneID: zoneID, scope: scope)
      configs[zoneID] = config
    }

    let operation = CKFetchRecordZoneChangesOperation(
      recordZoneIDs: zones,
      configurationsByRecordZoneID: configs
    )
    operation.fetchAllChanges = true
    operation.qualityOfService = .utility

    // Accumulate changes per zone.
    var changedByZone: [String: [CKRecord]] = [:]
    var deletedByZone: [String: [CKRecord.ID]] = [:]

    operation.recordWasChangedBlock = { recordID, result in
      switch result {
      case .success(let record):
        let zoneName = recordID.zoneID.zoneName
        changedByZone[zoneName, default: []].append(record)
      case .failure:
        break // individual record errors are non-fatal; the zone result block handles zone-level errors
      }
    }

    operation.recordWithIDWasDeletedBlock = { recordID, _ in
      let zoneName = recordID.zoneID.zoneName
      deletedByZone[zoneName, default: []].append(recordID)
    }

    operation.recordZoneFetchResultBlock = { [weak self] zoneID, result in
      guard let self = self else { return }
      switch result {
      case .success(let (newToken, _, _)):
        // Persist the new token for this zone immediately.
        self.tokenStore.saveZoneToken(newToken, zoneID: zoneID, scope: scope)

        let zoneName = zoneID.zoneName
        let changed = changedByZone[zoneName] ?? []
        let deleted = deletedByZone[zoneName] ?? []

        if !changed.isEmpty || !deleted.isEmpty {
          self.eventHandler?(.recordsFetched(
            changed: changed,
            deleted: deleted,
            zoneName: zoneName
          ))
        }

      case .failure(let error):
        // If the change token expired, clear just this zone's token.
        // The next sync cycle will do a full fetch from the beginning for this zone.
        // Other zones' tokens are left intact.
        if let ckError = error as? CKError, ckError.code == .changeTokenExpired {
          self.tokenStore.clearZoneToken(zoneID: zoneID, scope: scope)
        }
        self.eventHandler?(.syncError(error))
      }
    }

    operation.fetchRecordZoneChangesResultBlock = { [weak self] result in
      switch result {
      case .success:
        break
      case .failure(let error):
        self?.eventHandler?(.syncError(error))
      }
      completion()
    }

    db.add(operation)
  }

  // MARK: - Conflict Resolution

  /// Server-record-wins merge: start with server record and overlay client's
  /// changed fields. Mirrors the strategy in `CloudKitSyncEngineAdapter`.
  private func resolveConflict(clientRecord: CKRecord, serverRecord: CKRecord) -> CKRecord {
    for key in clientRecord.changedKeys() {
      serverRecord[key] = clientRecord[key]
    }
    return serverRecord
  }

  // MARK: - Helpers

  private func database(for scope: CKDatabase.Scope) -> CKDatabase {
    switch scope {
    case .private:  return ckContainer.privateCloudDatabase
    case .shared:   return ckContainer.sharedCloudDatabase
    case .public:   return ckContainer.publicCloudDatabase
    @unknown default: return ckContainer.privateCloudDatabase
    }
  }
}
