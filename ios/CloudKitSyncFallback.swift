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
/// All mutable state (`pendingSaves`, `pendingDeletes`, `trackedZones`, `state`) is
/// accessed through `pendingQueue` (serial DispatchQueue). Timer callbacks dispatch
/// sync work to a background queue. The `eventHandler` is always called from the
/// internal queue; the module layer dispatches to main before `sendEvent`.
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

  /// Serial queue for all mutable state access and sync cycle coordination.
  private let pendingQueue = DispatchQueue(label: "expo.cloudkit.syncfallback.pending")
  private var pendingSaves: [CKRecord] = []
  private var pendingDeletes: [CKRecord.ID] = []

  /// Whether a sync cycle is already in-flight. Prevents overlapping cycles.
  private var isSyncInFlight = false

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
    pendingQueue.sync { [weak self] in
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
    pendingQueue.sync { [weak self] in
      guard let self = self else { return }
      self.state = .notStarted
      self.pendingSaves.removeAll()
      self.pendingDeletes.removeAll()
      self.trackedZones = []
    }
    eventHandler?(.stateChanged(.notStarted))
    eventHandler = nil
  }

  func triggerSync() {
    runSyncCycle()
  }

  func enqueueSave(_ record: CKRecord) {
    pendingQueue.async { [weak self] in
      self?.pendingSaves.append(record)
    }
  }

  func enqueueDelete(_ recordID: CKRecord.ID) {
    pendingQueue.async { [weak self] in
      self?.pendingDeletes.append(recordID)
    }
  }

  // MARK: - Sync Cycle

  /// Runs a push-then-pull cycle. Guards against overlapping cycles.
  private func runSyncCycle() {
    pendingQueue.async { [weak self] in
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
          self.pendingQueue.async {
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

        // Conflict: apply server-record-wins merge if we can find the client record.
        if let clientRecord = saves.first(where: { $0.recordID == recordID }) {
          conflictedRecords.append(self.resolveConflict(clientRecord: clientRecord, serverRecord: serverRecord))
        } else {
          // Client record not found in saves list (shouldn't happen, but be safe).
          // Surface the server record as a conflict failure.
          failedSaves.append((recordID, error))
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
