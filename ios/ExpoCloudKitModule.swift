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

  // MARK: - Subscription manager (Phase B)

  /// Manages push subscriptions (CKQuerySubscription, CKDatabaseSubscription).
  /// Lazily initialised on the first subscription call after `configure()`.
  private var subscriptionManager: CloudKitSubscriptionManager?

  // MARK: - Cursor cache for queryRecords pagination

  /// In-memory store of CKQueryOperation.Cursor objects, keyed by opaque UUID token.
  /// CKQueryOperation.Cursor is not serializable to Data via the public API — the
  /// only safe way to pass it across calls is to keep the Swift object alive in memory
  /// and hand an opaque string token to JS. Cursors do not survive app restarts;
  /// that is acceptable and expected for CloudKit cursor-based pagination.
  private var cursorCache: [String: CKQueryOperation.Cursor] = [:]

  // MARK: - Sync provider (Phase B)

  /// Active sync provider — either CKSyncEngine adapter (iOS 17+) or the
  /// manual fallback (iOS 16). Nil when sync has not been started or was stopped.
  private var syncProvider: CloudKitSyncProvider?

  /// Manages UserDefaults persistence for change tokens and engine state.
  /// Lazily created on first `startSyncEngine()` call.
  private var tokenStore: ChangeTokenStore?

  // MARK: - Module Definition

  public func definition() -> ModuleDefinition {
    Name("ExpoCloudKit")

    // Events emitted to JavaScript
    Events(
      "onAccountStatusChanged",
      "onSyncEngineEvent",
      "onSubscriptionEvent",
      "onAssetProgress"
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
      self.subscriptionManager = CloudKitSubscriptionManager(ckContainer: ck)

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

      // Resolve the cursor token to the live CKQueryOperation.Cursor object.
      // CKQueryOperation.Cursor is opaque and cannot be constructed from Data —
      // it must be the exact Swift object returned by a prior query operation.
      // We store it in cursorCache keyed by a UUID string and give JS that token.
      let resolvedCursor: CKQueryOperation.Cursor? = cursor.flatMap { self.cursorCache[$0] }

      recordManager.queryRecords(
        recordType: recordType,
        predicate: predicate,
        sortDescriptors: sortDescriptors,
        zoneName: zoneName,
        database: scope,
        resultsLimit: resultsLimit,
        cursor: resolvedCursor
      ) { [weak self] result in
        switch result {
        case .success(let (records, nextCursor)):
          // If CloudKit returned a cursor, store it and give JS the token.
          // If nil, there are no more pages.
          var nextToken: String? = nil
          if let nextCursor = nextCursor {
            let token = UUID().uuidString
            self?.cursorCache[token] = nextCursor
            nextToken = token
          }
          promise.resolve([
            "records": records.map { Converters.toDictionary($0) },
            "cursor": nextToken as Any
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
    // Push Subscriptions — Phase B
    // -------------------------------------------------------------------------

    /// Creates a CKQuerySubscription for the given record type and predicate.
    ///
    /// Options flags accepted in the `options` array:
    ///   "firesOnRecordCreation" | "firesOnRecordUpdate" | "firesOnRecordDeletion"
    ///
    /// Returns the generated subscriptionID string.
    AsyncFunction("saveQuerySubscription") { [weak self] (options: [String: Any], promise: Promise) in
      guard let self = self, let manager = self.subscriptionManager, let container = self.container else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }

      guard let recordType = options["recordType"] as? String else {
        promise.reject(CloudKitModuleError.invalidArgument("recordType is required"))
        return
      }

      let predicateDict = options["predicate"] as? [String: Any]
      let predicate = predicateDict.map { Converters.toPredicate(from: $0) } ?? NSPredicate(value: true)

      let dbString = options["database"] as? String ?? "private"
      let scope = Converters.toDatabaseScope(dbString)
      let database = container.ckContainer.database(with: scope)

      // Build zoneID if provided
      let zoneName = options["zoneName"] as? String
      let zoneID = zoneName.map { CKRecordZone.ID(zoneName: $0, ownerName: CKCurrentUserDefaultName) }

      // Map option flag strings to CKQuerySubscription.Options bitmask
      let flagStrings = options["options"] as? [String] ?? ["firesOnRecordCreation", "firesOnRecordUpdate", "firesOnRecordDeletion"]
      var subscriptionOptions: CKQuerySubscription.Options = []
      for flag in flagStrings {
        switch flag {
        case "firesOnRecordCreation": subscriptionOptions.insert(.firesOnRecordCreation)
        case "firesOnRecordUpdate":   subscriptionOptions.insert(.firesOnRecordUpdate)
        case "firesOnRecordDeletion": subscriptionOptions.insert(.firesOnRecordDeletion)
        default: break
        }
      }

      manager.saveQuerySubscription(
        recordType: recordType,
        predicate: predicate,
        options: subscriptionOptions,
        zoneID: zoneID,
        database: database
      ) { result in
        switch result {
        case .success(let subscriptionID):
          promise.resolve(subscriptionID)
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    /// Creates a CKDatabaseSubscription that fires whenever any record in the
    /// specified database changes.
    ///
    /// Only valid for "private" and "shared" databases.
    /// Returns the generated subscriptionID string.
    AsyncFunction("saveDatabaseSubscription") { [weak self] (database: String, promise: Promise) in
      guard let self = self, let manager = self.subscriptionManager, let container = self.container else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }

      let scope = Converters.toDatabaseScope(database)
      let db = container.ckContainer.database(with: scope)

      manager.saveDatabaseSubscription(database: db) { result in
        switch result {
        case .success(let subscriptionID):
          promise.resolve(subscriptionID)
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    /// Deletes the subscription with the given ID from the specified database.
    AsyncFunction("deleteSubscription") { [weak self] (subscriptionID: String, database: String, promise: Promise) in
      guard let self = self, let manager = self.subscriptionManager, let container = self.container else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }

      let scope = Converters.toDatabaseScope(database)
      let db = container.ckContainer.database(with: scope)

      manager.deleteSubscription(subscriptionID: subscriptionID, database: db) { result in
        switch result {
        case .success:
          promise.resolve(nil)
        case .failure(let error):
          // Surface CKError.unknownItem as a typed subscriptionNotFound error
          if let ckError = error as? CKError, ckError.code == .unknownItem {
            promise.reject(CloudKitModuleError.subscriptionNotFound(subscriptionID))
          } else {
            promise.reject(Converters.toExpoError(error))
          }
        }
      }
    }

    /// Fetches all active subscriptions on the specified database.
    ///
    /// Returns an array of subscription dictionaries:
    ///   `[{ id, type, recordType?, zoneID? }]`
    AsyncFunction("fetchSubscriptions") { [weak self] (database: String, promise: Promise) in
      guard let self = self, let manager = self.subscriptionManager, let container = self.container else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }

      let scope = Converters.toDatabaseScope(database)
      let db = container.ckContainer.database(with: scope)

      manager.fetchSubscriptions(database: db) { result in
        switch result {
        case .success(let dicts):
          promise.resolve(dicts)
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    // Forward incoming remote notifications to the CloudKit notification handler.
    // Non-CloudKit payloads are ignored (handler returns false).
    OnAppDidReceiveRemoteNotification { [weak self] userInfo in
      guard let self = self else { return }
      _ = CloudKitNotificationHandler.handle(userInfo: userInfo) { [weak self] payload in
        // CloudKitNotificationHandler already dispatches the closure on the main
        // queue, so sendEvent is always called from the correct thread.
        self?.sendEvent("onSubscriptionEvent", payload)
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
      payload = [
        "type": "recordsFetched",
        "changedRecords": changed.map { Converters.toDictionary($0) },
        "deletedRecordIDs": deleted.map { id in
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

// MARK: - Module-level typed exceptions
//
// Each error case is a separate Exception subclass so that Expo Modules Core
// serializes the `code` field correctly to JavaScript as a structured CloudKitError.
// A plain Swift enum conforming to Error/LocalizedError does not guarantee the
// `code` field is propagated through the JS bridge.

class CloudKitNotConfiguredException: Exception {
  override var reason: String {
    "ExpoCloudKit is not configured. Call configure(containerId) first."
  }
}

class CloudKitRequiresiOS17Exception: Exception {
  override var reason: String {
    "CKSyncEngine requires iOS 17 or later."
  }
}

class CloudKitNotImplementedException: Exception {
  private let feature: String
  init(_ feature: String) { self.feature = feature }
  override var reason: String {
    "\(feature) is not yet implemented in this phase of expo-cloudkit."
  }
}

class CloudKitSyncEngineNotRunningException: Exception {
  override var reason: String {
    "Sync engine is not running. Call startSyncEngine() first."
  }
}

class CloudKitSubscriptionNotFoundException: Exception {
  private let subscriptionID: String
  init(_ subscriptionID: String) { self.subscriptionID = subscriptionID }
  override var reason: String {
    "Subscription not found: \(subscriptionID)"
  }
}

class CloudKitInvalidArgumentException: Exception {
  private let message: String
  init(_ message: String) { self.message = message }
  override var reason: String {
    "Invalid argument: \(message)"
  }
}

// MARK: - CloudKitModuleError namespace
//
// This typealias-style enum is kept so that existing call sites compile
// without modification. Each case now constructs the corresponding Exception
// subclass, which Expo Modules Core serializes correctly to JS.

enum CloudKitModuleError {
  static var notConfigured: Exception         { CloudKitNotConfiguredException() }
  static var requiresiOS17: Exception         { CloudKitRequiresiOS17Exception() }
  static var syncEngineNotRunning: Exception  { CloudKitSyncEngineNotRunningException() }
  static func notImplemented(_ f: String) -> Exception  { CloudKitNotImplementedException(f) }
  static func subscriptionNotFound(_ id: String) -> Exception { CloudKitSubscriptionNotFoundException(id) }
  static func invalidArgument(_ msg: String) -> Exception    { CloudKitInvalidArgumentException(msg) }
}
