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
/// `CloudKitSyncFallbackAdapter` is a Swift `actor`. All mutable state
/// (`pendingSaves`, `pendingDeletes`, `trackedZones`, `state`, `isSyncInFlight`,
/// `pendingConflicts`, and the health metric accumulators) is actor-isolated,
/// providing compile-time data-race safety.
///
/// Timer callbacks and CKOperation completion blocks re-enter actor isolation via
/// `Task { await self.method() }`. The push and pull phases are fully async,
/// bridging the CloudKit callback API with `withCheckedContinuation`.
actor CloudKitSyncFallbackAdapter: CloudKitSyncProvider {

  // MARK: - Protocol conformance

  let usesSyncEngine = false

  /// Exposed `nonisolated(unsafe)` so that the synchronous `getSyncState()` JS
  /// function can read it without `await`. Written exclusively from actor-isolated
  /// code, so the single-writer guarantee makes the unsafe annotation safe in
  /// practice.
  nonisolated(unsafe) private(set) var state: SyncProviderState = .notStarted

  // MARK: - Private actor-isolated properties

  private let ckContainer: CKContainer
  private let tokenStore: ChangeTokenStore
  private var eventHandler: ((SyncProviderEvent) -> Void)?

  private var trackedZones: [CKRecordZone.ID] = []
  private var databaseScope: CKDatabase.Scope = .private

  private var pollingTimer: Timer?
  private var pollingInterval: TimeInterval = 30.0

  /// Default: 1 retry on conflict before surfacing the error.
  private let maxConflictRetries = 1

  private var pendingSaves: [CKRecord] = []
  private var pendingDeletes: [CKRecord.ID] = []

  /// Whether a sync cycle is already in-flight. Prevents overlapping cycles.
  private var isSyncInFlight = false

  /// When true, CONFLICT errors are forwarded to JS via `onSyncConflict` instead of
  /// being auto-resolved with server-record-wins. Default: false.
  ///
  /// Declared `nonisolated(unsafe)` so the module can set it synchronously before
  /// calling `start()`. It is written exactly once at configuration time and never
  /// mutated during an in-flight sync cycle, making the unsynchronised write safe.
  nonisolated(unsafe) var conflictResolutionEnabled = false

  /// Continuations keyed by requestId, awaiting JS resolution of a conflict.
  private var pendingConflicts: [String: CheckedContinuation<[String: Any]?, Never>] = [:]

  // MARK: - Health Metrics Accumulators (I.3)

  /// Wall-clock start time of the current sync cycle.
  private var cycleStartTime: Date?
  /// Total records received (changed + deleted) during the current pull phase.
  private var cycleReceivedCount: Int = 0
  /// Total records successfully saved during the current push phase.
  private var cycleSentCount: Int = 0
  /// Total record save failures during the current push phase.
  private var cycleFailedCount: Int = 0

  // MARK: - syncCompleted Accumulators

  /// Zone names that contributed records in the current pull phase.
  private var cycleZoneNames: Set<String> = []
  /// True if no change token existed for any tracked zone before the first cycle.
  /// Computed lazily at the start of `runSyncCycle()` on the first invocation
  /// and reset to false after that first cycle completes.
  private var isFirstSyncCycle: Bool = true

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
    trackedZones = zones
    databaseScope = database
    state = .idle

    emit(.stateChanged(.idle))

    // Run an initial sync immediately.
    Task { await runSyncCycle() }

    if automaticallySync {
      // Timer must be scheduled on the main run loop; we hop back to the actor
      // from the timer callback via Task.
      // Capture pollingInterval inside actor isolation before crossing to @MainActor.
      let interval = pollingInterval
      Task { @MainActor in
        let timer = Timer.scheduledTimer(
          withTimeInterval: interval,
          repeats: true
        ) { [weak self] _ in
          guard let self = self else { return }
          Task { await self.runSyncCycle() }
        }
        await self.storePollingTimer(timer)
      }
    }
  }

  /// Stores the timer reference from the @MainActor context into actor-isolated state.
  private func storePollingTimer(_ timer: Timer) {
    pollingTimer = timer
  }

  func stop() {
    // Invalidate the timer on the main run loop.
    let timer = pollingTimer
    pollingTimer = nil
    Task { @MainActor in
      timer?.invalidate()
    }

    state = .notStarted
    pendingSaves.removeAll()
    pendingDeletes.removeAll()
    trackedZones = []
    cycleZoneNames.removeAll()
    isFirstSyncCycle = true

    // Drain any pending conflict continuations with nil (server-record-wins)
    // so no Task is left suspended after stop().
    let drained = pendingConflicts
    pendingConflicts.removeAll()
    for (_, continuation) in drained {
      continuation.resume(returning: nil)
    }

    emit(.stateChanged(.notStarted))
    eventHandler = nil
  }

  func triggerSync() {
    Task { await runSyncCycle() }
  }

  func enqueueSave(_ record: CKRecord) {
    pendingSaves.append(record)
  }

  func enqueueDelete(_ recordID: CKRecord.ID) {
    pendingDeletes.append(recordID)
  }

  func resumeConflictResolution(requestId: String, resolvedRecord: [String: Any]?) {
    guard let continuation = pendingConflicts.removeValue(forKey: requestId) else {
      print("[ExpoCloudKit] resumeConflictResolution: no pending conflict for requestId '\(requestId)'")
      return
    }
    continuation.resume(returning: resolvedRecord)
  }

  // MARK: - Sync Cycle

  /// Runs a push-then-pull cycle. Guards against overlapping cycles.
  private func runSyncCycle() async {
    guard !isSyncInFlight else { return }
    isSyncInFlight = true
    state = .syncing
    cycleStartTime = Date()
    cycleReceivedCount = 0
    cycleSentCount = 0
    cycleFailedCount = 0
    cycleZoneNames.removeAll()
    emit(.stateChanged(.syncing))

    // Determine if this is an initial sync: no persisted token for any tracked zone
    // means the entire zone history will be fetched from scratch.
    let isInitialSync: Bool
    if isFirstSyncCycle {
      let scope = databaseScope
      isInitialSync = trackedZones.allSatisfy {
        tokenStore.loadZoneToken(zoneID: $0, scope: scope) == nil
      }
    } else {
      isInitialSync = false
    }

    // Capture current pending changes and zone configuration.
    let saves = pendingSaves
    let deletes = pendingDeletes
    pendingSaves.removeAll()
    pendingDeletes.removeAll()
    let zones = trackedZones
    let scope = databaseScope

    // Push phase first, then pull.
    await pushChanges(saves: saves, deletes: deletes, scope: scope, retryCount: 0)
    await pullChanges(zones: zones, scope: scope)

    // Compute duration and emit health event for this cycle.
    let durationMs: Double
    if let start = cycleStartTime {
      durationMs = Date().timeIntervalSince(start) * 1_000
    } else {
      durationMs = 0
    }
    emit(.syncHealth(
      sentCount: cycleSentCount,
      receivedCount: cycleReceivedCount,
      failedCount: cycleFailedCount,
      durationMs: durationMs,
      syncEngine: false
    ))

    // Emit the "sync is done" signal with cycle-level aggregates.
    emit(.syncCompleted(
      recordCount: cycleReceivedCount,
      zoneNames: Array(cycleZoneNames),
      isInitialSync: isInitialSync
    ))

    // After the first cycle, subsequent cycles are incremental.
    isFirstSyncCycle = false

    cycleStartTime = nil
    isSyncInFlight = false
    state = .idle
    emit(.stateChanged(.idle))
  }

  // MARK: - Push Phase

  private func pushChanges(
    saves: [CKRecord],
    deletes: [CKRecord.ID],
    scope: CKDatabase.Scope,
    retryCount: Int
  ) async {
    guard !saves.isEmpty || !deletes.isEmpty else { return }

    let db = database(for: scope)
    let operation = CKModifyRecordsOperation(
      recordsToSave: saves.isEmpty ? nil : saves,
      recordIDsToDelete: deletes.isEmpty ? nil : deletes
    )
    operation.savePolicy = .changedKeys
    operation.qualityOfService = .userInitiated

    // Bridge the completion callback API to async/await using a SendableBox.
    // perRecordSaveBlock and modifyRecordsResultBlock are called by CloudKit on its
    // own serial internal queue. The SendableBox accumulates results on that queue;
    // all reads happen after the continuation resumes (i.e. back in actor isolation).

    /// A per-conflict record awaiting async JS resolution.
    struct PendingAsyncConflict {
      let requestId: String
      let payload: [String: Any]
      let serverRecord: CKRecord
    }

    /// Container for results collected across CloudKit's per-record callbacks.
    /// Marked @unchecked Sendable because it is mutated serially on CloudKit's
    /// internal queue and read only after the continuation fires.
    final class PushResultBox: @unchecked Sendable {
      var savedRecords: [CKRecord] = []
      var failedSaves: [(CKRecord.ID, Error)] = []
      var conflictedRecords: [CKRecord] = []
      var asyncConflicts: [PendingAsyncConflict] = []
    }
    let box = PushResultBox()

    // `conflictResolutionEnabled` is nonisolated(unsafe) — safe to capture in the
    // @escaping block which fires on CloudKit's queue.
    let resolveConflicts = conflictResolutionEnabled

    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in

      operation.perRecordSaveBlock = { recordID, result in
        switch result {
        case .success(let record):
          box.savedRecords.append(record)

        case .failure(let error):
          guard let ckError = error as? CKError,
                ckError.code == .serverRecordChanged,
                let serverRecord = ckError.serverRecord else {
            box.failedSaves.append((recordID, error))
            return
          }

          guard let clientRecord = saves.first(where: { $0.recordID == recordID }) else {
            box.failedSaves.append((recordID, error))
            return
          }

          if resolveConflicts {
            // Collect for async JS resolution after the operation completes.
            let requestId = UUID().uuidString
            let clientDict = Converters.toDictionary(clientRecord)
            let serverDict = Converters.toDictionary(serverRecord)
            let payload: [String: Any] = [
              "requestId": requestId,
              "clientRecord": clientDict,
              "serverRecord": serverDict
            ]
            box.asyncConflicts.append(PendingAsyncConflict(requestId: requestId, payload: payload, serverRecord: serverRecord))
          } else {
            // Default: server-record-wins with client field overlay.
            box.conflictedRecords.append(
              CloudKitSyncFallbackAdapter.resolveConflictStatic(clientRecord: clientRecord, serverRecord: serverRecord)
            )
          }
        }
      }

      operation.modifyRecordsResultBlock = { [weak self] result in
        if case .failure(let error) = result {
          Task { await self?.emit(.syncError(error)) }
        }
        continuation.resume()
      }

      db.add(operation)
    }

    // Back in actor isolation: read results from the box.
    let savedRecords = box.savedRecords
    let failedSaves = box.failedSaves
    let conflictedRecords = box.conflictedRecords
    let asyncConflicts = box.asyncConflicts

    // Back in actor isolation: accumulate health counters and emit.
    cycleSentCount += savedRecords.count
    cycleFailedCount += failedSaves.count

    if !savedRecords.isEmpty || !failedSaves.isEmpty {
      emit(.recordsSent(saved: savedRecords, failed: failedSaves))
    }

    // Handle async conflict resolutions (conflictResolutionEnabled=true path).
    var asyncResolvedRecords: [CKRecord] = []
    for conflict in asyncConflicts {
      // Register the continuation slot before emitting the event, preventing
      // the race where JS calls resolveSyncConflict before the slot is ready.
      let resolvedDict: [String: Any]? = await withCheckedContinuation { continuation in
        pendingConflicts[conflict.requestId] = continuation
        emit(.conflictPending(requestId: conflict.requestId, payload: conflict.payload))
      }

      let recordToEnqueue: CKRecord
      if let dict = resolvedDict, let resolved = try? Converters.toCKRecord(from: dict) {
        recordToEnqueue = resolved
      } else {
        recordToEnqueue = conflict.serverRecord
      }
      asyncResolvedRecords.append(recordToEnqueue)
    }

    // Enqueue async-resolved records for the next sync cycle.
    if !asyncResolvedRecords.isEmpty {
      for record in asyncResolvedRecords {
        pendingSaves.append(record)
      }
      // Kick off a new sync cycle to send the resolved records.
      Task { await runSyncCycle() }
    }

    // Retry conflict-resolved records once (server-record-wins path).
    if !conflictedRecords.isEmpty && retryCount < maxConflictRetries {
      await pushChanges(
        saves: conflictedRecords,
        deletes: [],
        scope: scope,
        retryCount: retryCount + 1
      )
    } else if !conflictedRecords.isEmpty {
      // Surface conflict records that exhausted retries as failed.
      let exhaustedFails: [(CKRecord.ID, Error)] = conflictedRecords.map {
        ($0.recordID, CKError(.serverRecordChanged))
      }
      emit(.recordsSent(saved: [], failed: exhaustedFails))
    }
  }

  // MARK: - Pull Phase

  private func pullChanges(zones: [CKRecordZone.ID], scope: CKDatabase.Scope) async {
    guard !zones.isEmpty else { return }

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

    // Accumulate changes per zone using a box to safely bridge across the escaping
    // CloudKit callbacks. CloudKit calls these blocks on its own serial internal
    // queue; the box is mutated serially and read only after the continuation fires.
    struct ZoneResult {
      let zoneID: CKRecordZone.ID
      let token: CKServerChangeToken?
      let error: Error?
    }
    final class PullResultBox: @unchecked Sendable {
      var changedByZone: [String: [CKRecord]] = [:]
      var deletedByZone: [String: [CKRecord.ID]] = [:]
      var zoneResults: [ZoneResult] = []
    }
    let box = PullResultBox()

    operation.recordWasChangedBlock = { recordID, result in
      switch result {
      case .success(let record):
        box.changedByZone[recordID.zoneID.zoneName, default: []].append(record)
      case .failure:
        break // individual record errors are non-fatal
      }
    }

    operation.recordWithIDWasDeletedBlock = { recordID, _ in
      box.deletedByZone[recordID.zoneID.zoneName, default: []].append(recordID)
    }

    operation.recordZoneFetchResultBlock = { zoneID, result in
      switch result {
      case .success(let (newToken, _, _)):
        box.zoneResults.append(ZoneResult(zoneID: zoneID, token: newToken, error: nil))
      case .failure(let error):
        box.zoneResults.append(ZoneResult(zoneID: zoneID, token: nil, error: error))
      }
    }

    // Bridge the completion callback to async/await.
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      operation.fetchRecordZoneChangesResultBlock = { [weak self] result in
        if case .failure(let error) = result {
          Task { await self?.emit(.syncError(error)) }
        }
        continuation.resume()
      }
      db.add(operation)
    }

    // Back in actor isolation: process zone results.
    for zoneResult in box.zoneResults {
      if let error = zoneResult.error {
        if let ckError = error as? CKError, ckError.code == .changeTokenExpired {
          tokenStore.clearZoneToken(zoneID: zoneResult.zoneID, scope: scope)
        }
        emit(.syncError(error))
        continue
      }

      guard let newToken = zoneResult.token else { continue }
      tokenStore.saveZoneToken(newToken, zoneID: zoneResult.zoneID, scope: scope)

      let zoneName = zoneResult.zoneID.zoneName
      let changed = box.changedByZone[zoneName] ?? []
      let deleted = box.deletedByZone[zoneName] ?? []

      cycleReceivedCount += changed.count + deleted.count

      // Track zone names for the syncCompleted event even if there were no changes —
      // the zone was still polled this cycle, which is meaningful for isInitialSync.
      cycleZoneNames.insert(zoneName)

      if !changed.isEmpty || !deleted.isEmpty {
        emit(.recordsFetched(
          changed: changed,
          deleted: deleted,
          zoneName: zoneName
        ))
      }
    }
  }

  // MARK: - Conflict Resolution

  /// Server-record-wins merge: start with server record and overlay client's
  /// changed fields. Mirrors the strategy in `CloudKitSyncEngineAdapter`.
  private func resolveConflict(clientRecord: CKRecord, serverRecord: CKRecord) -> CKRecord {
    CloudKitSyncFallbackAdapter.resolveConflictStatic(clientRecord: clientRecord, serverRecord: serverRecord)
  }

  /// Static version so it can be called from `nonisolated` closures (perRecordSaveBlock).
  private static func resolveConflictStatic(clientRecord: CKRecord, serverRecord: CKRecord) -> CKRecord {
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
