import ExpoModulesCore
import CloudKit

/// Main Expo module entry point for expo-cloudkit.
///
/// Registers all CloudKit operations with the Expo Modules DSL so they are
/// callable from JavaScript via the native bridge.
///
/// # iOS Requirement
/// All CloudKit operations require iOS 16+. CKSyncEngine functions require iOS 17+.
///
/// # Threading
/// All async CloudKit operations are dispatched from background queues by the
/// CloudKit framework itself. Expo's `Promise` type is thread-safe and handles
/// resolution from any queue.
public class ExpoCloudKitModule: Module {

  // MARK: - Internal managers (lazily wired after configure() is called)

  private var container: CloudKitContainer?
  private var zoneManager: CloudKitZoneManager?
  private var recordManager: CloudKitRecordManager?

  // MARK: - Sync provider (Phase B)

  /// Active sync provider — either CKSyncEngine adapter (iOS 17+) or the
  /// manual fallback (iOS 16). Nil when sync has not been started or was stopped.
  private var syncProvider: CloudKitSyncProvider?

  /// Manages UserDefaults persistence for change tokens and engine state.
  /// Lazily created on first `startSyncEngine()` call.
  private var tokenStore: ChangeTokenStore?

  // MARK: - Presence managers (Phase K.1)

  /// Active presence managers, keyed by zoneName. One per zone.
  private var presenceManagers: [String: CloudKitPresenceManager] = [:]

  // MARK: - Module Definition

  public func definition() -> ModuleDefinition {
    Name("ExpoCloudKit")

    // Events emitted to JavaScript
    Events(
      "onAccountStatusChanged",
      "onSyncEngineEvent",
      "onAssetProgress",
      // Phase K.1 — Presence & Cursors
      "onPresenceChanged"
    )

    // -------------------------------------------------------------------------
    // Container & Account
    // -------------------------------------------------------------------------

    /// Configure the module with a CloudKit container identifier.
    /// Must be called before any other operation.
    ///
    /// - Parameter containerId: e.g. "iCloud.com.example.myapp"
    Function("configure") { [weak self] (containerId: String) in
      guard let self = self else { return }

      let ck = CKContainer(identifier: containerId)
      let container = CloudKitContainer(ckContainer: ck)
      self.container = container
      self.zoneManager = CloudKitZoneManager(ckContainer: ck)
      self.recordManager = CloudKitRecordManager(ckContainer: ck)

      // Start listening for account status changes and forward to JS
      container.startAccountStatusObserver { [weak self] status in
        self?.sendEvent("onAccountStatusChanged", [
          "status": Converters.accountStatusToString(status)
        ])
      }
    }

    /// Returns the current iCloud account status.
    AsyncFunction("getAccountStatus") { [weak self] (promise: Promise) in
      guard let self = self, let container = self.container else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      container.getAccountStatus { result in
        switch result {
        case .success(let status):
          promise.resolve(Converters.accountStatusToString(status))
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    // -------------------------------------------------------------------------
    // Zone Management
    // -------------------------------------------------------------------------

    /// Creates a custom CKRecordZone. Idempotent — safe if zone already exists.
    AsyncFunction("createZone") { [weak self] (zoneName: String, database: String, promise: Promise) in
      guard let self = self, let zoneManager = self.zoneManager else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      let scope = Converters.toDatabaseScope(database)
      zoneManager.createZone(named: zoneName, in: scope) { result in
        switch result {
        case .success(let zone):
          promise.resolve(Converters.toZoneDictionary(zone))
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    /// Deletes a zone and all records within it. Permanent.
    AsyncFunction("deleteZone") { [weak self] (zoneName: String, database: String, promise: Promise) in
      guard let self = self, let zoneManager = self.zoneManager else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      let scope = Converters.toDatabaseScope(database)
      zoneManager.deleteZone(named: zoneName, in: scope) { result in
        switch result {
        case .success:
          promise.resolve(nil)
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    /// Fetches all custom zones in the specified database.
    AsyncFunction("fetchZones") { [weak self] (database: String, promise: Promise) in
      guard let self = self, let zoneManager = self.zoneManager else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      let scope = Converters.toDatabaseScope(database)
      zoneManager.fetchZones(in: scope) { result in
        switch result {
        case .success(let zones):
          promise.resolve(zones.map { Converters.toZoneDictionary($0) })
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    // -------------------------------------------------------------------------
    // Record CRUD
    // -------------------------------------------------------------------------

    /// Saves one or more records. Inserts new records, updates existing ones.
    AsyncFunction("saveRecords") { [weak self] (recordDicts: [[String: Any]], database: String, promise: Promise) in
      guard let self = self, let recordManager = self.recordManager else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      let scope = Converters.toDatabaseScope(database)
      do {
        let records = try recordDicts.map { try Converters.toCKRecord(from: $0) }
        recordManager.saveRecords(records, in: scope) { result in
          switch result {
          case .success(let saved):
            promise.resolve(saved.map { Converters.toDictionary($0) })
          case .failure(let error):
            promise.reject(Converters.toExpoError(error))
          }
        }
      } catch {
        promise.reject(error)
      }
    }

    /// Fetches a single record by type and recordName.
    AsyncFunction("fetchRecord") { [weak self] (recordType: String, recordId: String, zoneName: String?, database: String, promise: Promise) in
      guard let self = self, let recordManager = self.recordManager else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      let scope = Converters.toDatabaseScope(database)
      recordManager.fetchRecord(
        recordType: recordType,
        recordId: recordId,
        zoneName: zoneName,
        database: scope
      ) { result in
        switch result {
        case .success(let record):
          promise.resolve(Converters.toDictionary(record))
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    /// Queries records by type with optional predicate, sort, and pagination.
    AsyncFunction("queryRecords") { [weak self] (
      recordType: String,
      predicateDict: [String: Any]?,
      sortDescriptorDicts: [[String: Any]]?,
      zoneName: String?,
      database: String,
      resultsLimit: Int,
      cursor: String?,
      promise: Promise
    ) in
      guard let self = self, let recordManager = self.recordManager else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      let scope = Converters.toDatabaseScope(database)
      let predicate = predicateDict.map { Converters.toPredicate(from: $0) } ?? NSPredicate(value: true)
      let sortDescriptors = sortDescriptorDicts?.compactMap { Converters.toNSSortDescriptor(from: $0) }

      recordManager.queryRecords(
        recordType: recordType,
        predicate: predicate,
        sortDescriptors: sortDescriptors,
        zoneName: zoneName,
        database: scope,
        resultsLimit: resultsLimit,
        cursor: cursor.flatMap { Data(base64Encoded: $0).map { CKQueryOperation.Cursor.fromData($0) } } ?? nil
      ) { result in
        switch result {
        case .success(let (records, nextCursor)):
          let cursorString = nextCursor.map { _ in "opaque_cursor_placeholder" }
          promise.resolve([
            "records": records.map { Converters.toDictionary($0) },
            "cursor": cursorString as Any
          ])
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    /// Deletes one or more records by their identifiers.
    AsyncFunction("deleteRecords") { [weak self] (recordIdDicts: [[String: Any]], database: String, promise: Promise) in
      guard let self = self, let recordManager = self.recordManager else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      let scope = Converters.toDatabaseScope(database)
      let recordIDs = recordIdDicts.compactMap { dict -> CKRecord.ID? in
        guard let recordName = dict["recordName"] as? String else { return nil }
        let zoneName = dict["zoneName"] as? String
        let zoneID = zoneName.map { CKRecordZone.ID(zoneName: $0, ownerName: CKCurrentUserDefaultName) }
          ?? CKRecordZone.ID.default
        return CKRecord.ID(recordName: recordName, zoneID: zoneID)
      }
      recordManager.deleteRecords(recordIDs, in: scope) { result in
        switch result {
        case .success:
          promise.resolve(nil)
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    /// Fetches all record changes in the specified zones since the last sync token.
    AsyncFunction("fetchRecordZoneChanges") { [weak self] (zoneNames: [String], database: String, promise: Promise) in
      guard let self = self, let recordManager = self.recordManager else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      let scope = Converters.toDatabaseScope(database)
      recordManager.fetchRecordZoneChanges(zoneNames: zoneNames, database: scope) { result in
        switch result {
        case .success(let changes):
          promise.resolve(changes)
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    // -------------------------------------------------------------------------
    // CKSyncEngine — Phase B (iOS 17+)
    // -------------------------------------------------------------------------

    Function("isSyncEngineAvailable") {
      if #available(iOS 17.0, *) {
        return true
      }
      return false
    }

    /// Starts sync for the specified zones.
    /// On iOS 17+ uses CKSyncEngine; on iOS 16 uses timer-based polling fallback.
    AsyncFunction("startSyncEngine") { [weak self] (config: [String: Any], promise: Promise) in
      guard let self = self, let container = self.container else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }

      let zoneNames = config["zones"] as? [String] ?? []
      let dbString = config["database"] as? String ?? "private"
      let autoSync = config["automaticallySync"] as? Bool ?? true
      let scope = Converters.toDatabaseScope(dbString)

      let zoneIDs = zoneNames.map {
        CKRecordZone.ID(zoneName: $0, ownerName: CKCurrentUserDefaultName)
      }

      // Lazily create the token store keyed by container identifier.
      if self.tokenStore == nil {
        let containerID = container.ckContainer.containerIdentifier ?? "default"
        self.tokenStore = ChangeTokenStore(containerIdentifier: containerID)
      }

      guard let store = self.tokenStore else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }

      // Stop any existing provider before starting a new one.
      self.syncProvider?.stop()
      self.syncProvider = nil

      let provider: CloudKitSyncProvider
      if #available(iOS 17.0, *) {
        provider = CloudKitSyncEngineAdapter(
          ckContainer: container.ckContainer,
          tokenStore: store
        )
      } else {
        provider = CloudKitSyncFallbackAdapter(
          ckContainer: container.ckContainer,
          tokenStore: store
        )
      }

      self.syncProvider = provider

      provider.start(
        zones: zoneIDs,
        database: scope,
        automaticallySync: autoSync,
        eventHandler: { [weak self] event in
          self?.handleSyncEvent(event)
        }
      )

      promise.resolve(nil)
    }

    /// Returns the current sync state synchronously from in-memory provider state.
    Function("getSyncState") { [weak self] () -> [String: Any] in
      guard let provider = self?.syncProvider else {
        return [
          "usesSyncEngine": false,
          "status": SyncProviderState.notStarted.rawValue
        ]
      }
      return [
        "usesSyncEngine": provider.usesSyncEngine,
        "status": provider.state.rawValue
      ]
    }

    /// Manually triggers a sync cycle. Rejects if sync engine is not running.
    AsyncFunction("triggerSync") { [weak self] (promise: Promise) in
      guard let provider = self?.syncProvider else {
        promise.reject(CloudKitModuleError.syncEngineNotRunning)
        return
      }
      provider.triggerSync()
      promise.resolve(nil)
    }

    /// Enqueues a pending record save or delete for the next sync cycle.
    /// Silently drops malformed entries — callers should validate before enqueuing.
    Function("enqueuePendingChange") { [weak self] (changeDict: [String: Any]) in
      guard let provider = self?.syncProvider else { return }

      let changeType = changeDict["type"] as? String ?? ""

      if changeType == "save", let recordDict = changeDict["record"] as? [String: Any] {
        guard let record = try? Converters.toCKRecord(from: recordDict) else { return }
        provider.enqueueSave(record)
      } else if changeType == "delete",
                let idDict = changeDict["recordIdentifier"] as? [String: Any],
                let recordName = idDict["recordName"] as? String {
        let zoneName = idDict["zoneName"] as? String
        let zoneID = zoneName.map {
          CKRecordZone.ID(zoneName: $0, ownerName: CKCurrentUserDefaultName)
        } ?? CKRecordZone.ID.default
        let recordID = CKRecord.ID(recordName: recordName, zoneID: zoneID)
        provider.enqueueDelete(recordID)
      }
    }

    /// Stops the sync provider and releases its resources.
    /// Rejects if sync engine is not running.
    AsyncFunction("stopSyncEngine") { [weak self] (promise: Promise) in
      guard let provider = self?.syncProvider else {
        promise.reject(CloudKitModuleError.syncEngineNotRunning)
        return
      }
      provider.stop()
      self?.syncProvider = nil
      promise.resolve(nil)
    }

    // -------------------------------------------------------------------------
    // Presence & Cursors — Phase K.1
    // -------------------------------------------------------------------------

    /// Starts real-time presence tracking in a shared zone.
    ///
    /// Creates or updates an `ExpoPresence` record for the local user and begins
    /// the 30-second heartbeat. The sync engine delivers presence records from
    /// other participants via `onPresenceChanged` events.
    ///
    /// options keys:
    ///   zoneName    — required; the shared zone to track presence in
    ///   database    — optional; defaults to "shared"
    ///   displayName — optional; shown to other participants
    ///   status      — optional; "active" | "idle" | "editing"; defaults to "active"
    ///   metadata    — optional; [String: Any] serialised to JSON in the record
    AsyncFunction("startPresence") { [weak self] (options: [String: Any], promise: Promise) in
      guard let self = self, let container = self.container else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }

      guard let zoneName = options["zoneName"] as? String else {
        promise.reject(CloudKitModuleError.notImplemented("startPresence: zoneName is required"))
        return
      }

      let dbString = options["database"] as? String ?? "shared"
      let scope = Converters.toDatabaseScope(dbString)
      let displayName = options["displayName"] as? String
      let status = options["status"] as? String ?? "active"
      let metadata = options["metadata"] as? [String: Any]
      let database = container.ckContainer.database(with: scope)

      // Fetch the current user's record name so we can key the presence record.
      container.ckContainer.fetchUserRecordID { [weak self] recordID, error in
        guard let self = self else {
          promise.reject(CloudKitModuleError.notConfigured)
          return
        }
        if let error = error {
          promise.reject(Converters.toExpoError(error))
          return
        }
        guard let userRecordName = recordID?.recordName else {
          promise.reject(CloudKitModuleError.notImplemented("startPresence: could not resolve user record ID"))
          return
        }

        let manager = CloudKitPresenceManager(
          ckContainer: container.ckContainer,
          database: database,
          zoneName: zoneName,
          localUserRecordName: userRecordName
        )

        // Wire event emission back to JS.
        manager.onPresenceChanged = { [weak self] payload in
          DispatchQueue.main.async {
            self?.sendEvent("onPresenceChanged", payload)
          }
        }

        // Wire save/delete through the active sync provider for batching.
        manager.enqueueSave = { [weak self] record in
          self?.syncProvider?.enqueueSave(record)
        }
        manager.enqueueDelete = { [weak self] recordID in
          self?.syncProvider?.enqueueDelete(recordID)
        }

        // Stop any existing manager for this zone before replacing it.
        let existingManager = self.presenceManagers[zoneName]
        self.presenceManagers[zoneName] = manager

        Task {
          if let existing = existingManager {
            await existing.stop()
          }
          await manager.start(
            displayName: displayName,
            initialStatus: status,
            metadata: metadata
          )
          promise.resolve(nil)
        }
      }
    }

    /// Stops presence tracking in a zone and deletes the local user's presence record.
    ///
    /// options keys:
    ///   zoneName — required
    ///   database — optional (unused; manager is keyed only by zoneName)
    AsyncFunction("stopPresence") { [weak self] (options: [String: Any], promise: Promise) in
      guard let self = self else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      guard let zoneName = options["zoneName"] as? String else {
        promise.reject(CloudKitModuleError.notImplemented("stopPresence: zoneName is required"))
        return
      }
      guard let manager = self.presenceManagers.removeValue(forKey: zoneName) else {
        promise.resolve(nil) // Idempotent — no error if already stopped
        return
      }
      Task {
        await manager.stop()
        promise.resolve(nil)
      }
    }

    /// Updates the local user's cursor position in a shared zone.
    /// Debounced 500 ms — rapid calls are coalesced before writing to CloudKit.
    ///
    /// options keys:
    ///   zoneName — required
    ///   cursor   — required; [String: Any] with app-defined position data
    AsyncFunction("updatePresenceCursor") { [weak self] (options: [String: Any], promise: Promise) in
      guard let self = self else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      guard let zoneName = options["zoneName"] as? String else {
        promise.reject(CloudKitModuleError.notImplemented("updatePresenceCursor: zoneName is required"))
        return
      }
      guard let cursor = options["cursor"] as? [String: Any] else {
        promise.reject(CloudKitModuleError.notImplemented("updatePresenceCursor: cursor is required"))
        return
      }
      guard let manager = self.presenceManagers[zoneName] else {
        promise.resolve(nil) // No presence active in this zone; no-op
        return
      }
      Task {
        await manager.updateCursor(cursor)
        promise.resolve(nil)
      }
    }

    /// Updates the local user's status in a shared zone.
    ///
    /// options keys:
    ///   zoneName — required
    ///   status   — required; "active" | "idle" | "editing"
    AsyncFunction("updatePresenceStatus") { [weak self] (options: [String: Any], promise: Promise) in
      guard let self = self else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      guard let zoneName = options["zoneName"] as? String else {
        promise.reject(CloudKitModuleError.notImplemented("updatePresenceStatus: zoneName is required"))
        return
      }
      guard let status = options["status"] as? String else {
        promise.reject(CloudKitModuleError.notImplemented("updatePresenceStatus: status is required"))
        return
      }
      guard let manager = self.presenceManagers[zoneName] else {
        promise.resolve(nil)
        return
      }
      Task {
        await manager.updateStatus(status)
        promise.resolve(nil)
      }
    }

    /// Returns all currently online presence entries for a zone.
    ///
    /// options keys:
    ///   zoneName — required
    ///   database — optional (unused; manager is keyed by zoneName)
    AsyncFunction("getPresence") { [weak self] (options: [String: Any], promise: Promise) in
      guard let self = self else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      guard let zoneName = options["zoneName"] as? String else {
        promise.reject(CloudKitModuleError.notImplemented("getPresence: zoneName is required"))
        return
      }
      guard let manager = self.presenceManagers[zoneName] else {
        promise.resolve([[String: Any]]()) // No presence active — return empty list
        return
      }
      Task {
        let participants = await manager.allOnlineParticipants()
        promise.resolve(participants)
      }
    }

    // -------------------------------------------------------------------------
    // CKAsset — Phase D
    // -------------------------------------------------------------------------

    AsyncFunction("downloadAsset") { (_: String, _: String, _: String, _: String, _: String?, _: String, promise: Promise) in
      promise.reject(CloudKitModuleError.notImplemented("downloadAsset (Phase D)"))
    }
  }
}

// MARK: - Sync Event Bridging

extension ExpoCloudKitModule {

  /// Converts a `SyncProviderEvent` to a JS-bridge dictionary and dispatches it
  /// via `sendEvent("onSyncEngineEvent", ...)` on the main queue.
  ///
  /// All sync events flow through the single `"onSyncEngineEvent"` channel,
  /// differentiated by the `type` field. JS callers filter by `event.type`.
  func handleSyncEvent(_ event: SyncProviderEvent) {
    let payload: [String: Any]

    switch event {
    case .stateChanged(let newState):
      payload = [
        "type": "stateChanged",
        "state": [
          "usesSyncEngine": syncProvider?.usesSyncEngine ?? false,
          "status": newState.rawValue
        ]
      ]

    case .recordsFetched(let changed, let deleted, let zoneName):
      // Phase K.1 — Filter ExpoPresence records out of the normal business-record event.
      // Route them to the presence manager for this zone; everything else goes to JS.
      let presenceRecords = changed.filter { $0.recordType == "ExpoPresence" }
      let businessRecords = changed.filter { $0.recordType != "ExpoPresence" }

      // Identify deleted records that are presence entries and route to manager.
      let presenceDeletedIDs = deleted.filter { id in
        id.recordName.hasPrefix("presence-")
      }
      let businessDeletedIDs = deleted.filter { id in
        !id.recordName.hasPrefix("presence-")
      }

      if !presenceRecords.isEmpty || !presenceDeletedIDs.isEmpty,
         let manager = presenceManagers[zoneName] {
        Task {
          if !presenceRecords.isEmpty {
            await manager.handlePresenceRecords(presenceRecords)
          }
          for presenceID in presenceDeletedIDs {
            await manager.handlePresenceDeletion(recordID: presenceID)
          }
        }
      }

      payload = [
        "type": "recordsFetched",
        "changedRecords": businessRecords.map { Converters.toDictionary($0) },
        "deletedRecordIDs": businessDeletedIDs.map { id in
          [
            "recordName": id.recordName,
            "zoneName": id.zoneID.zoneName
          ] as [String: Any]
        },
        "zoneName": zoneName
      ]

    case .recordsSent(let saved, let failed):
      payload = [
        "type": "recordsSent",
        "savedRecords": saved.map { Converters.toDictionary($0) },
        "failedRecords": failed.map { (recordID, error) -> [String: Any] in
          var dict: [String: Any] = [
            "recordIdentifier": [
              "recordName": recordID.recordName,
              "zoneName": recordID.zoneID.zoneName
            ] as [String: Any],
            "error": Converters.toErrorDict(error)
          ]
          // Attach server record for conflict errors so JS can implement
          // custom merge logic if desired.
          if let ckError = error as? CKError,
             ckError.code == .serverRecordChanged,
             let serverRecord = ckError.serverRecord {
            dict["serverRecord"] = Converters.toDictionary(serverRecord)
          }
          return dict
        }
      ]

    case .syncError(let error):
      payload = [
        "type": "syncError",
        "error": Converters.toErrorDict(error)
      ]
    }

    // Expo requires sendEvent on the main thread.
    DispatchQueue.main.async { [weak self] in
      self?.sendEvent("onSyncEngineEvent", payload)
    }
  }
}

// MARK: - Module-level error codes

enum CloudKitModuleError: Error, LocalizedError {
  case notConfigured
  case requiresiOS17
  case notImplemented(String)
  case syncEngineNotRunning

  var errorDescription: String? {
    switch self {
    case .notConfigured:
      return "ExpoCloudKit is not configured. Call configure(containerId) first."
    case .requiresiOS17:
      return "CKSyncEngine requires iOS 17 or later."
    case .notImplemented(let feature):
      return "\(feature) is not yet implemented in this phase of expo-cloudkit."
    case .syncEngineNotRunning:
      return "Sync engine is not running. Call startSyncEngine() first."
    }
  }

  // Expo's error protocol requires a code string for JS
  var code: String {
    switch self {
    case .notConfigured:         return "NOT_CONFIGURED"
    case .requiresiOS17:         return "REQUIRES_IOS_17"
    case .notImplemented:        return "NOT_IMPLEMENTED"
    case .syncEngineNotRunning:  return "SYNC_ENGINE_NOT_RUNNING"
    }
  }
}

// MARK: - CKQueryOperation.Cursor serialization placeholder
// In Phase A we return an opaque cursor string. This extension provides
// a hook that Phase B can replace with real serialization.
extension CKQueryOperation.Cursor {
  static func fromData(_ data: Data) -> CKQueryOperation.Cursor? {
    // CKQueryOperation.Cursor is not directly constructable from Data in the
    // public API — the cursor must come from a previous query operation.
    // This is a placeholder; real cursor passing is handled by storing the
    // cursor object in memory between paginated calls (Phase A+).
    return nil
  }
}
