import CloudKit
import Foundation
#if canImport(UIKit)
  import UIKit
#endif

#if canImport(ExpoModulesCore)
import ExpoModulesCore

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

  // MARK: - Shared references (Phase J.1 — CloudKitStore)

  /// Weak reference to the configured `CloudKitRecordManager`, accessible to
  /// `CloudKitStore` without creating a hard dependency on the Expo module lifecycle.
  /// Set to `nil` automatically when the module is deallocated.
  static weak var sharedRecordManager: CloudKitRecordManager?

  /// Weak reference to the active `CloudKitSyncProvider`, accessible to
  /// `CloudKitStore.startSync` without importing ExpoModulesCore.
  /// Nil until `startSyncEngine()` is called, and nil again after `stopSyncEngine()`.
  /// The protocol already inherits from `AnyObject` so weak storage is legal.
  static weak var sharedSyncProvider: CloudKitSyncProvider?

  // MARK: - Subscription manager (Phase B)

  /// Manages push subscriptions (CKQuerySubscription, CKDatabaseSubscription).
  /// Lazily initialised on the first subscription call after `configure()`.
  private var subscriptionManager: CloudKitSubscriptionManager?

  // MARK: - Share manager (Phase B)

  /// Manages CKShare lifecycle: create, delete, fetch participants,
  /// update permissions, remove participants, accept shares.
  /// Lazily initialised after `configure()` is called.
  private var shareManager: CloudKitShareManager?

  // MARK: - Debug helper (Phase C)

  /// Dev-time introspection utilities. Lazily initialised after `configure()`.
  /// Never call these from production code paths — see `__debug` prefix on all
  /// exported JS methods.
  private var debugHelper: CloudKitDebugHelper?

  // MARK: - Cursor cache for queryRecords pagination

  /// In-memory store of CKQueryOperation.Cursor objects, keyed by opaque UUID token.
  /// CKQueryOperation.Cursor is not serializable to Data via the public API — the
  /// only safe way to pass it across calls is to keep the Swift object alive in memory
  /// and hand an opaque string token to JS. When H.5 persistence is enabled the token
  /// is also written to UserDefaults so it survives app restarts.
  private var cursorCache: [String: CKQueryOperation.Cursor] = [:]

  // MARK: - Multi-container client registry (H.3)

  /// Named CloudKit clients, each bound to a specific container identifier.
  /// Keyed by an opaque UUID client ID that is handed to JS after `createClient`.
  /// Access is serialised through `clientsQueue` (barrier writes, concurrent reads).
  private var clients: [String: CloudKitClient] = [:]

  /// Concurrent queue that guards the `clients` dictionary.
  /// Writes use `.barrier` to prevent races; reads use a plain `.sync`.
  private let clientsQueue = DispatchQueue(label: "expo.cloudkit.clients", attributes: .concurrent)

  // MARK: - Sync provider (Phase B)

  /// Active sync provider — either CKSyncEngine adapter (iOS 17+) or the
  /// manual fallback (iOS 16). Nil when sync has not been started or was stopped.
  private var syncProvider: CloudKitSyncProvider?

  /// Manages UserDefaults persistence for change tokens and engine state.
  /// Lazily created on first `startSyncEngine()` call.
  private var tokenStore: ChangeTokenStore?

  // MARK: - Offline queue (Phase C)

  /// Persists and retries CloudKit save/delete operations while offline.
  /// Wired up in `configure()` after the record manager is ready.
  /// Nil until `configure()` is called.
  private var offlineQueue: OfflineQueue?

  // MARK: - Module Definition

  public func definition() -> ModuleDefinition {
    Name("ExpoCloudKit")

    // Events emitted to JavaScript
    Events(
      "onAccountStatusChanged",
      "onSyncEngineEvent",
      "onSyncHealth",
      "onSubscriptionEvent",
      "onAssetProgress",
      "onShareAccepted",
      "onBatchProgress",
      "onOfflineQueueEvent",
      "onSyncConflict",
      "onRateLimited"
    )

    // -------------------------------------------------------------------------
    // G.4 — Dev Menu Integration
    //
    // `DevMenuExtensionProtocol` is not part of the expo-modules-core public API
    // in the version used by this project (checked: no DevMenuExtension* symbols
    // found under node_modules/expo-modules-core/ios/). Implementing a conformance
    // to a non-existent protocol would be a compilation error, so we use a simpler
    // approach:
    //
    //   1. Expose a `Constants` entry `debugMenuAvailable: false` so TypeScript
    //      callers can feature-detect and render their own debug panel instead.
    //   2. In DEBUG builds, print a startup banner that lists every `__debug*`
    //      method available — this surfaces them in the Metro / Xcode console
    //      without any third-party dev-menu dependency.
    // -------------------------------------------------------------------------

    Constants([
      // Signals to JS that the native dev-menu integration is unavailable;
      // callers should fall back to their own debug UI.
      "debugMenuAvailable": false
    ])

    #if DEBUG
    OnCreate {
      print("""
        [expo-cloudkit] DEBUG build detected. Available __debug* methods:
          - __debugDumpContainerInfo()  : container ID, account status, environments
          - __debugListZones()          : all zones across private + shared databases
          - __debugFetchRawRecord()     : single record with full system metadata
          - __debugClearZone()          : wipe + recreate a zone (DESTRUCTIVE)
        Call configure(containerId) first — all methods reject with notConfigured until then.
        """)
    }
    #endif

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
      self.subscriptionManager = CloudKitSubscriptionManager(ckContainer: ck)
      self.shareManager = CloudKitShareManager(ckContainer: ck)
      self.debugHelper = CloudKitDebugHelper(container: ck)

      // Single RecordManager instance shared by the module and the offline queue.
      let rm = CloudKitRecordManager(ckContainer: ck)
      // Forward rate-limit backoff events from the retry wrapper to JS.
      rm.onRateLimited = { [weak self] retryAfterSeconds, operationName, retryCount in
        DispatchQueue.main.async {
          self?.sendEvent("onRateLimited", [
            "retryAfter": retryAfterSeconds,
            "operationName": operationName,
            "retryCount": retryCount
          ])
        }
      }
      self.recordManager = rm
      // Expose to CloudKitStore (@Observable SwiftUI wrapper, Phase J.1)
      ExpoCloudKitModule.sharedRecordManager = rm
      self.offlineQueue = OfflineQueue(
        container: ck,
        containerID: containerId,
        recordManager: rm,
        // OfflineQueue (actor) already dispatches to @MainActor before calling this closure.
        sendEvent: { [weak self] payload in
          self?.sendEvent("onOfflineQueueEvent", payload)
        }
      )

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

    /// Fetches the current user's record ID (iCloud account identifier).
    ///
    /// Returns the `recordName` string of the user's `_defaultZone` record —
    /// typically a stable opaque identifier starting with "_".
    /// Rejects with `notConfigured` if `configure()` has not been called,
    /// or with the mapped CKError if the account is unavailable / not authenticated.
    AsyncFunction("fetchUserRecordID") { [weak self] (promise: Promise) in
      guard let self = self, let container = self.container else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      container.ckContainer.fetchUserRecordID { recordID, error in
        if let error = error {
          promise.reject(Converters.toExpoError(error))
          return
        }
        guard let recordID = recordID else {
          promise.reject(ExpoCloudKitBridgeError(
            code: "UNKNOWN",
            message: "fetchUserRecordID returned nil without an error",
            retryAfterSeconds: nil,
            serverRecord: nil
          ))
          return
        }
        promise.resolve(recordID.recordName)
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
    ///
    /// Automatically chunked at 400 records per CKModifyRecordsOperation.
    /// Fires `onBatchProgress` after each individual record is confirmed saved
    /// Saves one or more records. Inserts new records, updates existing ones.
    ///
    /// Pass options["queueOnFailure"] = true to enqueue offline on retryable errors.
    /// Fires onBatchProgress after each record is confirmed saved.
    AsyncFunction("saveRecords") { [weak self] (recordDicts: [[String: Any]], database: String, options: [String: Any]?, operationConfig: [String: Any]?, promise: Promise) in
      guard let self = self, let recordManager = self.recordManager else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      let scope = Converters.toDatabaseScope(database)
      let shouldQueueOnFailure = options?["queueOnFailure"] as? Bool ?? false
      do {
        let records = try recordDicts.map { try Converters.toCKRecord(from: $0) }
        recordManager.saveRecords(
          records,
          in: scope,
          operationConfig: operationConfig,
          progressHandler: { [weak self] completed, total, recordName in
            self?.sendEvent("onBatchProgress", [
              "completed": completed,
              "total": total,
              "recordName": recordName
            ])
          }
        ) { [weak self] result in
          switch result {
          case .success(let saved):
            promise.resolve(saved.map { Converters.toDictionary($0) })
          case .failure(let error):
            guard shouldQueueOnFailure, let queue = self?.offlineQueue else {
              promise.reject(Converters.toExpoError(error))
              return
            }
            let bridgeError = Converters.toExpoError(error) as? ExpoCloudKitBridgeError
            let code = bridgeError?.code ?? "UNKNOWN"
            let retryableCodes: Set<String> = ["NETWORK_UNAVAILABLE", "SERVER_REJECTED", "UNKNOWN"]
            guard retryableCodes.contains(code) else {
              promise.reject(Converters.toExpoError(error))
              return
            }
            // OfflineQueue is an actor — enqueue must be called from an async context.
            Task {
              var queueResults: [[String: Any]] = []
              for recordDict in recordDicts {
                if let queueId = try? await queue.enqueue(
                  operation: "save",
                  database: database,
                  recordData: recordDict
                ) {
                  queueResults.append(["queued": true, "queueId": queueId])
                }
              }
              promise.resolve(queueResults)
            }
          }
        }
      } catch {
        promise.reject(error)
      }
    }

    /// Fetches a single record by type and recordName.
    ///
    /// Pass `desiredKeys` to limit which fields are fetched from the server.
    /// When omitted (or nil), all fields are fetched.
    ///
    /// Pass `operationConfig: { collectMetrics: true }` to include a `_metrics`
    /// key with `{ durationMs, retryCount }` in the returned record dictionary.
    AsyncFunction("fetchRecord") { [weak self] (recordType: String, recordId: String, zoneName: String?, database: String, desiredKeys: [String]?, operationConfig: [String: Any]?, promise: Promise) in
      guard let self = self, let recordManager = self.recordManager else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      let scope = Converters.toDatabaseScope(database)
      let collectMetrics = operationConfig?["collectMetrics"] as? Bool ?? false

      if collectMetrics, let config = operationConfig {
        // Use the dict-returning overload that attaches _metrics inline.
        recordManager.fetchRecord(
          recordType: recordType,
          recordId: recordId,
          zoneName: zoneName,
          database: scope,
          desiredKeys: desiredKeys,
          operationConfig: config
        ) { result in
          switch result {
          case .success(let dict):
            promise.resolve(dict)
          case .failure(let error):
            promise.reject(Converters.toExpoError(error))
          }
        }
      } else {
        recordManager.fetchRecord(
          recordType: recordType,
          recordId: recordId,
          zoneName: zoneName,
          database: scope,
          desiredKeys: desiredKeys,
          operationConfig: operationConfig
        ) { result in
          switch result {
          case .success(let record):
            promise.resolve(Converters.toDictionary(record))
          case .failure(let error):
            promise.reject(Converters.toExpoError(error))
          }
        }
      }
    }

    /// Queries records by type with optional predicate, sort, and pagination.
    ///
    /// All parameters are passed in a single `options` dictionary to stay within
    /// ExpoModulesCore's 8-argument limit for AsyncFunction closures.
    ///
    /// Required keys: `recordType` (String), `database` (String), `resultsLimit` (Int).
    /// Optional keys: `predicate`, `sortDescriptors`, `zoneName`, `cursor`,
    ///                `desiredKeys`, `operationConfig`, `persistCursor`.
    AsyncFunction("queryRecords") { [weak self] (
      options: [String: Any],
      promise: Promise
    ) in
      guard let self = self, let recordManager = self.recordManager else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      let recordType = options["recordType"] as? String ?? ""
      let database = options["database"] as? String ?? "private"
      let resultsLimit = options["resultsLimit"] as? Int ?? 200
      let predicateDict = options["predicate"] as? [String: Any]
      let sortDescriptorDicts = options["sortDescriptors"] as? [[String: Any]]
      let zoneName = options["zoneName"] as? String
      let cursor = options["cursor"] as? String
      let desiredKeys = options["desiredKeys"] as? [String]
      let operationConfig = options["operationConfig"] as? [String: Any]
      let shouldPersistCursor = options["persistCursor"] as? Bool ?? false

      let scope = Converters.toDatabaseScope(database)
      let predicate = predicateDict.map { Converters.toPredicate(from: $0) } ?? NSPredicate(value: true)
      let sortDescriptors = sortDescriptorDicts?.compactMap { Converters.toNSSortDescriptor(from: $0) }

      // Resolve the cursor token to a live CKQueryOperation.Cursor.
      // Primary lookup: in-memory cursorCache (valid for the current app session).
      // Fallback (H.5): UserDefaults-persisted cursor loaded by the record manager,
      // which survives app restarts when the caller previously set persistCursor: true.
      let resolvedCursor: CKQueryOperation.Cursor? = cursor.flatMap { token in
        if let cached = self.cursorCache[token] { return cached }
        return recordManager.loadPersistedCursor(forToken: token)
      }

      recordManager.queryRecords(
        recordType: recordType,
        predicate: predicate,
        sortDescriptors: sortDescriptors,
        zoneName: zoneName,
        database: scope,
        resultsLimit: resultsLimit,
        cursor: resolvedCursor,
        desiredKeys: desiredKeys,
        operationConfig: operationConfig
      ) { [weak self] result in
        switch result {
        case .success(let (records, nextCursor)):
          // Store the cursor in the in-memory cache and give JS the opaque token.
          // When shouldPersistCursor is true, also write to UserDefaults so the
          // cursor survives the current app session (H.5).
          var nextToken: String? = nil
          if let nextCursor = nextCursor {
            let token = UUID().uuidString
            self?.cursorCache[token] = nextCursor
            if shouldPersistCursor {
              recordManager.persistCursor(nextCursor, forToken: token)
            }
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

    /// Removes all cursor entries persisted to UserDefaults by this module (H.5).
    ///
    /// The in-memory cursor cache is also cleared so stale tokens cannot be
    /// used to accidentally resume a now-invalid server-side cursor.
    AsyncFunction("clearPersistedCursors") { [weak self] (promise: Promise) in
      guard let self = self, let recordManager = self.recordManager else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      recordManager.clearPersistedCursors()
      self.cursorCache.removeAll()
      promise.resolve(nil)
    }

    /// Deletes one or more records by their identifiers.
    AsyncFunction("deleteRecords") { [weak self] (recordIdDicts: [[String: Any]], database: String, operationConfig: [String: Any]?, promise: Promise) in
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
      recordManager.deleteRecords(recordIDs, in: scope, operationConfig: operationConfig) { result in
        switch result {
        case .success:
          promise.resolve(nil)
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    /// Fetches multiple records in a single `CKFetchRecordsOperation`.
    ///
    /// Each item in `recordIDs` must contain `recordName: String`.
    /// Optional keys per item: `zoneName: String`, `zoneOwner: String`.
    ///
    /// Records that fail individually (e.g. not found, permission denied) are
    /// included in the result array with a `_error: { code, message }` key rather
    /// than failing the whole batch. The `onRateLimited` event fires before each
    /// automatic retry so callers can surface backoff UX.
    AsyncFunction("batchFetchRecords") { [weak self] (
      recordIDDicts: [[String: Any]],
      database: String,
      desiredKeys: [String]?,
      operationConfig: [String: Any]?,
      promise: Promise
    ) in
      guard let self = self, let recordManager = self.recordManager else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }

      let scope = Converters.toDatabaseScope(database)

      let recordIDPairs: [(name: String, zoneID: CKRecordZone.ID?)] = recordIDDicts.compactMap { dict in
        guard let recordName = dict["recordName"] as? String else { return nil }
        let zoneName = dict["zoneName"] as? String
        let zoneOwner = dict["zoneOwner"] as? String ?? CKCurrentUserDefaultName
        let zoneID: CKRecordZone.ID? = zoneName.map {
          CKRecordZone.ID(zoneName: $0, ownerName: zoneOwner)
        }
        return (name: recordName, zoneID: zoneID)
      }

      Task {
        do {
          let results = try await recordManager.batchFetchRecords(
            recordIDs: recordIDPairs,
            database: scope,
            desiredKeys: desiredKeys,
            operationConfig: operationConfig
          )
          promise.resolve(results)
        } catch {
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    /// Fetches all record changes in the specified zones since the last sync token.
    ///
    /// Pass `desiredKeys` to limit which fields are included in changed records.
    /// When omitted (or nil), all fields are fetched.
    AsyncFunction("fetchRecordZoneChanges") { [weak self] (zoneNames: [String], database: String, desiredKeys: [String]?, operationConfig: [String: Any]?, promise: Promise) in
      guard let self = self, let recordManager = self.recordManager else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      let scope = Converters.toDatabaseScope(database)
      recordManager.fetchRecordZoneChanges(zoneNames: zoneNames, database: scope, desiredKeys: desiredKeys, operationConfig: operationConfig) { result in
        switch result {
        case .success(let changes):
          promise.resolve(changes)
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    // -------------------------------------------------------------------------
    // Reference Deep Linking — Phase C
    // -------------------------------------------------------------------------

    /// Fetches a record and recursively resolves all CKRecord.Reference fields
    /// up to `depth` levels (clamped to 1...3).
    ///
    /// Options keys:
    ///   - recordName (String, required)
    ///   - zoneName   (String, optional — defaults to the default zone)
    ///   - database   (String, optional — "private"|"shared"|"public", default "private")
    ///   - depth      (Int, optional — 1...3, default 1)
    ///
    /// On success resolves with a fully-resolved record dictionary where every
    /// reference-typed field has been replaced with a complete record dict.
    /// References that cannot be fetched retain their original shallow stub.
    ///
    /// - Rejects with `CloudKitModuleError.notConfigured` if `configure()` has not been called.
    /// - Rejects with `CloudKitModuleError.invalidArgument` if `recordName` is missing.
    AsyncFunction("fetchRecordWithReferences") { [weak self] (options: [String: Any], promise: Promise) in
      guard let self = self, let recordManager = self.recordManager else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      guard let recordName = options["recordName"] as? String else {
        promise.reject(CloudKitModuleError.invalidArgument("recordName is required"))
        return
      }
      let zoneName = options["zoneName"] as? String
      let dbString = options["database"] as? String ?? "private"
      let scope = Converters.toDatabaseScope(dbString)
      let depth: Int
      if let d = options["depth"] as? Int {
        depth = d
      } else if let d = options["depth"] as? Double {
        depth = Int(d)
      } else {
        depth = 1
      }
      recordManager.fetchRecordWithReferences(
        recordName: recordName,
        zoneName: zoneName,
        database: scope,
        depth: depth
      ) { result in
        switch result {
        case .success(let dict):
          promise.resolve(dict)
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    // -------------------------------------------------------------------------
    // Reference Graph Delete — Phase H.4
    // -------------------------------------------------------------------------

    /// Deletes a record and all records reachable through its CKRecord.Reference
    /// fields, up to `maxDepth` levels deep (clamped to 1...3 on the Swift side).
    ///
    /// Options keys:
    ///   - recordName  (String, required) — root record to delete
    ///   - recordType  (String, required) — CloudKit record type of the root record
    ///   - zoneName    (String, optional) — defaults to the default zone
    ///   - database    (String, optional) — "private"|"shared"|"public", default "private"
    ///   - maxDepth    (Int,    optional) — traversal depth 1...3, default 1
    ///
    /// Resolves with an array of deleted recordName strings.
    /// Referenced records that do not exist are silently skipped.
    AsyncFunction("deleteRecordWithReferences") { [weak self] (options: [String: Any], promise: Promise) in
      guard let self = self, let recordManager = self.recordManager else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      guard let recordName = options["recordName"] as? String else {
        promise.reject(CloudKitModuleError.invalidArgument("recordName is required"))
        return
      }
      guard let recordType = options["recordType"] as? String else {
        promise.reject(CloudKitModuleError.invalidArgument("recordType is required"))
        return
      }
      let zoneName = options["zoneName"] as? String
      let dbString = options["database"] as? String ?? "private"
      let maxDepth: Int
      if let d = options["maxDepth"] as? Int {
        maxDepth = d
      } else if let d = options["maxDepth"] as? Double {
        maxDepth = Int(d)
      } else {
        maxDepth = 1
      }

      recordManager.deleteRecordWithReferences(
        recordName: recordName,
        recordType: recordType,
        zoneName: zoneName,
        database: dbString,
        maxDepth: maxDepth
      ) { result in
        switch result {
        case .success(let deletedNames):
          promise.resolve(deletedNames)
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    // -------------------------------------------------------------------------
    // CKSyncEngine — Phase B (iOS 17+)
    // -------------------------------------------------------------------------

    Function("isSyncEngineAvailable") {
      if #available(iOS 17.0, macOS 14.0, *) {
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

      let provider: CloudKitSyncProvider
      if #available(iOS 17.0, macOS 14.0, *) {
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

      // Stop any existing provider before starting a new one.
      // Both stop() and start() are actor-isolated (async) — wrap in a Task so
      // the Promise is resolved only after start() completes its actor turn.
      let resolveConflicts = config["resolveConflicts"] as? Bool == true
      let existingProvider = self.syncProvider
      self.syncProvider = provider
      // Expose the active provider to CloudKitStore (Phase J.1).
      ExpoCloudKitModule.sharedSyncProvider = provider

      // G.6 — enable custom JS conflict resolution if the caller opted in.
      // conflictResolutionEnabled is nonisolated(unsafe) on both actor implementations,
      // written here once before start() is called and never mutated again during a sync
      // cycle, making the unsynchronised write safe in practice.
      if resolveConflicts {
        provider.conflictResolutionEnabled = true
      }

      Task { [weak self] in
        // Stop the old provider (if any) before starting the new one.
        await existingProvider?.stop()

        await provider.start(
          zones: zoneIDs,
          database: scope,
          automaticallySync: autoSync,
          eventHandler: { [weak self] event in
            self?.handleSyncEvent(event)
          }
        )

        promise.resolve(nil)
      }
    }

    /// Resolves a pending conflict that was surfaced via the `onSyncConflict` event.
    ///
    /// - Parameters:
    ///   - requestId: The UUID string from the `onSyncConflict` event payload.
    ///   - resolvedRecord: The merged record dictionary to save, or nil to accept the
    ///     server version unchanged.
    ///
    /// If `requestId` is not found (e.g. already resolved, timed out, or stale), this
    /// call is a no-op — it does not reject, so callers do not need to guard against
    /// double-resolution.
    AsyncFunction("resolveSyncConflict") { [weak self] (requestId: String, resolvedRecord: [String: Any]?) in
      guard let provider = self?.syncProvider else { return }
      // actor-isolated method — must use Task to dispatch asynchronously.
      Task {
        await provider.resumeConflictResolution(requestId: requestId, resolvedRecord: resolvedRecord)
      }
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
      Task {
        await provider.triggerSync()
        promise.resolve(nil)
      }
    }

    /// Enqueues a pending record save or delete for the next sync cycle.
    /// Silently drops malformed entries — callers should validate before enqueuing.
    Function("enqueuePendingChange") { [weak self] (changeDict: [String: Any]) in
      guard let provider = self?.syncProvider else { return }

      let changeType = changeDict["type"] as? String ?? ""

      if changeType == "save", let recordDict = changeDict["record"] as? [String: Any] {
        guard let record = try? Converters.toCKRecord(from: recordDict) else { return }
        // actor-isolated method — dispatch asynchronously via Task.
        Task { await provider.enqueueSave(record) }
      } else if changeType == "delete",
                let idDict = changeDict["recordIdentifier"] as? [String: Any],
                let recordName = idDict["recordName"] as? String {
        let zoneName = idDict["zoneName"] as? String
        let zoneID = zoneName.map {
          CKRecordZone.ID(zoneName: $0, ownerName: CKCurrentUserDefaultName)
        } ?? CKRecordZone.ID.default
        let recordID = CKRecord.ID(recordName: recordName, zoneID: zoneID)
        // actor-isolated method — dispatch asynchronously via Task.
        Task { await provider.enqueueDelete(recordID) }
      }
    }

    /// Stops the sync provider and releases its resources.
    /// Rejects if sync engine is not running.
    AsyncFunction("stopSyncEngine") { [weak self] (promise: Promise) in
      guard let self = self, let provider = self.syncProvider else {
        promise.reject(CloudKitModuleError.syncEngineNotRunning)
        return
      }
      self.syncProvider = nil
      // Clear the Phase J.1 shared reference so CloudKitStore sees nil immediately.
      ExpoCloudKitModule.sharedSyncProvider = nil
      Task {
        await provider.stop()
        promise.resolve(nil)
      }
    }

    // -------------------------------------------------------------------------
    // Background Sync — BGTaskScheduler (iOS 13+)
    // -------------------------------------------------------------------------

    /// Registers the BGAppRefreshTask handler with the system scheduler.
    ///
    /// Must be called early in the app's lifecycle — ideally from the root
    /// component's mount effect — so the registration is in place before the
    /// app first moves to the background. If `startSyncEngine()` has not been
    /// called yet the registration still succeeds; the sync provider reference
    /// is captured lazily when the first background task fires.
    ///
    /// - Parameter taskIdentifier: Must match an entry in
    ///   `BGTaskSchedulerPermittedIdentifiers` in `Info.plist` (injected by
    ///   the config plugin when `backgroundSyncTaskIdentifier` is set).
    ///
    /// Resolves with `nil` on success.
    /// Rejects with `BackgroundSyncUnavailableException` on iOS < 13 (unreachable
    /// in practice — iOS 13 is below the module's minimum deployment target).
    AsyncFunction("registerBackgroundSync") { [weak self] (taskIdentifier: String, promise: Promise) in
      if #available(iOS 13.0, *) {
        // Pass a resolver closure so the background task reads the module's
        // *current* syncProvider when it fires, not a snapshot from registration time.
        // This handles the common pattern: register at app launch, start engine after sign-in.
        CloudKitBackgroundSync.shared.register(
          taskIdentifier: taskIdentifier,
          providerResolver: { [weak self] in self?.syncProvider }
        )
        // Schedule the first refresh now so the system knows a refresh is wanted.
        CloudKitBackgroundSync.shared.scheduleNextRefresh()
        promise.resolve(nil)
      } else {
        promise.reject(CloudKitModuleError.backgroundSyncUnavailable)
      }
    }

    /// Asks the system to schedule a BGAppRefreshTask as soon as conditions allow.
    ///
    /// Call this if you want to proactively reschedule a background refresh
    /// outside of the automatic rescheduling that occurs at the end of each task.
    /// Safe to call multiple times — duplicate requests are coalesced by the system.
    ///
    /// Resolves with `nil` on success (note: success means the request was submitted,
    /// not that the task will necessarily run — the system decides when).
    AsyncFunction("scheduleBackgroundSync") { (promise: Promise) in
      if #available(iOS 13.0, *) {
        CloudKitBackgroundSync.shared.scheduleNextRefresh()
        promise.resolve(nil)
      } else {
        promise.reject(CloudKitModuleError.backgroundSyncUnavailable)
      }
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

      // Read boolean trigger flags directly from the options dict.
      // Default to true when absent — consistent with CloudKit's default behaviour
      // for new subscriptions where all three event types are enabled.
      var subscriptionOptions: CKQuerySubscription.Options = []
      if options["firesOnRecordCreation"] as? Bool ?? true {
        subscriptionOptions.insert(.firesOnRecordCreation)
      }
      if options["firesOnRecordUpdate"] as? Bool ?? true {
        subscriptionOptions.insert(.firesOnRecordUpdate)
      }
      if options["firesOnRecordDeletion"] as? Bool ?? true {
        subscriptionOptions.insert(.firesOnRecordDeletion)
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

    // NOTE: OnAppDidReceiveRemoteNotification was removed in ExpoModulesCore 2.x.
    // Push notification forwarding for CloudKit subscriptions must be handled
    // at the AppDelegate level. See README for the required AppDelegate setup.
    // TODO: Restore automatic subscription event forwarding once a
    // replacement lifecycle hook is available in ExpoModulesCore.

    // -------------------------------------------------------------------------
    // CKShare — Phase B
    // -------------------------------------------------------------------------

    /// Creates a CKShare for the given root record and returns a share dictionary
    /// including the share URL once the server accepts the new share.
    ///
    /// Options keys:
    ///   - recordName (String, required)
    ///   - zoneName (String, optional)
    ///   - database (String, default "private")
    ///   - publicPermission ("none"|"readOnly"|"readWrite", default "none")
    AsyncFunction("createShare") { [weak self] (options: [String: Any], promise: Promise) in
      guard let self = self, let shareManager = self.shareManager, let container = self.container else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }

      guard let recordName = options["recordName"] as? String else {
        promise.reject(CloudKitModuleError.invalidArgument("recordName is required"))
        return
      }

      let zoneName = options["zoneName"] as? String
      let dbString = options["database"] as? String ?? "private"
      let scope = Converters.toDatabaseScope(dbString)
      let database = container.ckContainer.database(with: scope)

      let permissionString = options["publicPermission"] as? String ?? "none"
      let publicPermission = Converters.toSharePermission(permissionString)

      shareManager.createShare(
        recordName: recordName,
        zoneName: zoneName,
        database: database,
        publicPermission: publicPermission
      ) { result in
        switch result {
        case .success(let shareDict):
          promise.resolve(shareDict)
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    /// Deletes the CKShare record identified by shareRecordName, effectively
    /// unsharing the associated root record.
    ///
    /// Options keys:
    ///   - shareRecordName (String, required)
    ///   - zoneName (String, optional)
    ///   - database (String, default "private")
    AsyncFunction("deleteShare") { [weak self] (options: [String: Any], promise: Promise) in
      guard let self = self, let shareManager = self.shareManager, let container = self.container else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }

      guard let shareRecordName = options["shareRecordName"] as? String else {
        promise.reject(CloudKitModuleError.invalidArgument("shareRecordName is required"))
        return
      }

      let zoneName = options["zoneName"] as? String
      let dbString = options["database"] as? String ?? "private"
      let scope = Converters.toDatabaseScope(dbString)
      let database = container.ckContainer.database(with: scope)

      shareManager.deleteShare(
        shareRecordName: shareRecordName,
        zoneName: zoneName,
        database: database
      ) { result in
        switch result {
        case .success:
          promise.resolve(nil)
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    /// Fetches the participant list for an existing CKShare.
    ///
    /// Options keys:
    ///   - shareRecordName (String, required)
    ///   - zoneName (String, optional)
    ///   - database (String, default "private")
    AsyncFunction("fetchShareParticipants") { [weak self] (options: [String: Any], promise: Promise) in
      guard let self = self, let shareManager = self.shareManager, let container = self.container else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }

      guard let shareRecordName = options["shareRecordName"] as? String else {
        promise.reject(CloudKitModuleError.invalidArgument("shareRecordName is required"))
        return
      }

      let zoneName = options["zoneName"] as? String
      let dbString = options["database"] as? String ?? "private"
      let scope = Converters.toDatabaseScope(dbString)
      let database = container.ckContainer.database(with: scope)

      shareManager.fetchShareParticipants(
        shareRecordName: shareRecordName,
        zoneName: zoneName,
        database: database
      ) { result in
        switch result {
        case .success(let participants):
          promise.resolve(participants)
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    /// Updates a participant's permission on an existing CKShare.
    ///
    /// Options keys:
    ///   - shareRecordName (String, required)
    ///   - participantRecordName (String, required) — the user's CKRecord.ID.recordName
    ///   - permission ("none"|"readOnly"|"readWrite", required)
    ///   - zoneName (String, optional)
    ///   - database (String, default "private")
    AsyncFunction("updateSharePermission") { [weak self] (options: [String: Any], promise: Promise) in
      guard let self = self, let shareManager = self.shareManager, let container = self.container else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }

      guard let shareRecordName = options["shareRecordName"] as? String else {
        promise.reject(CloudKitModuleError.invalidArgument("shareRecordName is required"))
        return
      }
      guard let participantRecordName = options["participantRecordName"] as? String else {
        promise.reject(CloudKitModuleError.invalidArgument("participantRecordName is required"))
        return
      }
      guard let permissionString = options["permission"] as? String else {
        promise.reject(CloudKitModuleError.invalidArgument("permission is required"))
        return
      }

      let zoneName = options["zoneName"] as? String
      let dbString = options["database"] as? String ?? "private"
      let scope = Converters.toDatabaseScope(dbString)
      let database = container.ckContainer.database(with: scope)
      let permission = Converters.toSharePermission(permissionString)

      shareManager.updateSharePermission(
        shareRecordName: shareRecordName,
        participantRecordName: participantRecordName,
        permission: permission,
        zoneName: zoneName,
        database: database
      ) { result in
        switch result {
        case .success(let shareDict):
          promise.resolve(shareDict)
        case .failure(let error):
          if case ShareManagerError.participantNotFound = error {
            promise.reject(CloudKitModuleError.participantNotFound(participantRecordName))
          } else {
            promise.reject(Converters.toExpoError(error))
          }
        }
      }
    }

    /// Removes a participant from an existing CKShare.
    ///
    /// Options keys:
    ///   - shareRecordName (String, required)
    ///   - participantRecordName (String, required)
    ///   - zoneName (String, optional)
    ///   - database (String, default "private")
    AsyncFunction("removeShareParticipant") { [weak self] (options: [String: Any], promise: Promise) in
      guard let self = self, let shareManager = self.shareManager, let container = self.container else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }

      guard let shareRecordName = options["shareRecordName"] as? String else {
        promise.reject(CloudKitModuleError.invalidArgument("shareRecordName is required"))
        return
      }
      guard let participantRecordName = options["participantRecordName"] as? String else {
        promise.reject(CloudKitModuleError.invalidArgument("participantRecordName is required"))
        return
      }

      let zoneName = options["zoneName"] as? String
      let dbString = options["database"] as? String ?? "private"
      let scope = Converters.toDatabaseScope(dbString)
      let database = container.ckContainer.database(with: scope)

      shareManager.removeShareParticipant(
        shareRecordName: shareRecordName,
        participantRecordName: participantRecordName,
        zoneName: zoneName,
        database: database
      ) { result in
        switch result {
        case .success(let shareDict):
          promise.resolve(shareDict)
        case .failure(let error):
          if case ShareManagerError.participantNotFound = error {
            promise.reject(CloudKitModuleError.participantNotFound(participantRecordName))
          } else {
            promise.reject(Converters.toExpoError(error))
          }
        }
      }
    }

    /// Accepts a CloudKit share invitation URL.
    ///
    /// The URL is the iCloud share link received via a deep link or universal link.
    ///
    /// Options keys:
    ///   - shareURL (String, required) — the full iCloud share URL
    AsyncFunction("acceptShare") { [weak self] (options: [String: Any], promise: Promise) in
      guard let self = self, let shareManager = self.shareManager else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }

      guard let urlString = options["shareURL"] as? String,
            let shareURL = URL(string: urlString) else {
        promise.reject(CloudKitModuleError.invalidArgument("shareURL must be a valid URL string"))
        return
      }

      shareManager.acceptShare(shareURL: shareURL) { result in
        switch result {
        case .success(let shareDict):
          promise.resolve(shareDict)
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    /// Lists all zones in the shared CloudKit database, each optionally enriched
    /// with its associated CKShare record (participants, URL, public permission).
    AsyncFunction("fetchSharedDatabaseZones") { [weak self] (promise: Promise) in
      guard let self = self, let shareManager = self.shareManager else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }

      shareManager.fetchSharedDatabaseZones { result in
        switch result {
        case .success(let zones):
          promise.resolve(zones)
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    /// Returns the URL of an existing CKShare for the specified root record.
    ///
    /// Fetches the root record by ID, inspects `record.share` for an associated
    /// CKShare reference, then fetches that share to retrieve its `url`.
    ///
    /// - Does NOT present UICloudSharingController.
    /// - Useful for "Copy invite link" flows where the share already exists.
    ///
    /// Options keys:
    ///   - recordName (String, required) — CKRecord.ID.recordName of the root record
    ///   - zoneName   (String, optional) — defaults to the default zone
    ///   - database   (String, default "private")
    ///
    /// Resolves with: String — the share URL (e.g. "https://www.icloud.com/…")
    ///
    /// Rejects with:
    ///   - RECORD_NOT_FOUND  — the root record does not exist
    ///   - SHARE_NOT_FOUND   — no share attached, or the share has no URL yet
    AsyncFunction("getShareURL") { [weak self] (options: [String: Any], promise: Promise) in
      guard let self = self, let container = self.container else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }

      guard let recordName = options["recordName"] as? String else {
        promise.reject(CloudKitModuleError.invalidArgument("recordName is required"))
        return
      }

      let zoneName = options["zoneName"] as? String
      let dbString = options["database"] as? String ?? "private"
      let scope = Converters.toDatabaseScope(dbString)
      let database = container.ckContainer.database(with: scope)

      let zoneID: CKRecordZone.ID
      if let name = zoneName {
        zoneID = CKRecordZone.ID(zoneName: name, ownerName: CKCurrentUserDefaultName)
      } else {
        zoneID = CKRecordZone.ID.default
      }
      let recordID = CKRecord.ID(recordName: recordName, zoneID: zoneID)

      // Step 1: Fetch the root record to obtain its share reference.
      database.fetch(withRecordID: recordID) { rootRecord, fetchError in
        if let fetchError = fetchError {
          promise.reject(Converters.toExpoError(fetchError))
          return
        }

        guard let rootRecord = rootRecord else {
          promise.reject(Converters.toExpoError(CKError(.unknownItem)))
          return
        }

        // Step 2: Check whether the record has an associated CKShare.
        guard let shareReference = rootRecord.share else {
          promise.reject(CloudKitModuleError.shareNotFound(
            "The record '\(recordName)' has no associated share."
          ))
          return
        }

        // Step 3: Fetch the CKShare record to get its URL.
        database.fetch(withRecordID: shareReference.recordID) { shareRecord, shareError in
          if let shareError = shareError {
            promise.reject(Converters.toExpoError(shareError))
            return
          }

          guard let share = shareRecord as? CKShare else {
            promise.reject(CloudKitModuleError.shareNotFound())
            return
          }

          guard let shareURL = share.url?.absoluteString else {
            promise.reject(CloudKitModuleError.shareNotFound(
              "Share exists but has no URL yet — ensure the share has been saved to CloudKit."
            ))
            return
          }

          promise.resolve(shareURL)
        }
      }
    }

    /// Presents the system UICloudSharingController for the given root record.
    ///
    /// If the record already has a share, presents in manage-participants mode.
    /// If not, creates a new share then presents the controller.
    ///
    /// Returns `{ outcome: "shared"|"cancelled", share: {...}|null }`.
    ///
    /// Options keys:
    ///   - recordName (String, required)
    ///   - zoneName (String, optional)
    ///   - database (String, default "private")
    AsyncFunction("presentSharingUI") { [weak self] (options: [String: Any], promise: Promise) in
      #if canImport(UIKit)
      guard let self = self, let shareManager = self.shareManager, let container = self.container else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }

      guard let recordName = options["recordName"] as? String else {
        promise.reject(CloudKitModuleError.invalidArgument("recordName is required"))
        return
      }

      // UICloudSharingController must be presented from the main thread.
      // Capture the presenting view controller before dispatching.
      guard let viewController = self.appContext?.utilities?.currentViewController() else {
        promise.reject(CloudKitModuleError.sharingUIUnavailable)
        return
      }

      let zoneName = options["zoneName"] as? String
      let dbString = options["database"] as? String ?? "private"
      let scope = Converters.toDatabaseScope(dbString)
      let database = container.ckContainer.database(with: scope)

      shareManager.presentSharingUI(
        recordName: recordName,
        zoneName: zoneName,
        database: database,
        presentingViewController: viewController
      ) { result in
        switch result {
        case .success(let outcomeDict):
          promise.resolve(outcomeDict)
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
      #else
      promise.reject(CloudKitModuleError.sharingUINotSupportedOnMacOS)
      #endif
    }

    // NOTE: OnAppOpenURL was removed in ExpoModulesCore 2.x.
    // CloudKit share URL interception for onShareAccepted must be handled
    // at the AppDelegate level. See README for the required AppDelegate setup.
    // TODO: Restore automatic share URL detection once a replacement
    // lifecycle hook is available in ExpoModulesCore.

    // -------------------------------------------------------------------------
    // Debug Helpers — Phase C (dev-only, never call from production)
    // -------------------------------------------------------------------------

    /// Returns container metadata: containerID, accountStatus, environments.
    ///
    /// - Rejects with `CloudKitNotConfiguredException` if `configure()` has not been called.
    AsyncFunction("__debugDumpContainerInfo") { [weak self] (promise: Promise) in
      guard let self = self, let debugHelper = self.debugHelper else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      debugHelper.dumpContainerInfo { result in
        switch result {
        case .success(let info):
          promise.resolve(info)
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    /// Lists all zones in the private and shared databases.
    ///
    /// Returns `[{ zoneName, ownerName, capabilities, database }]`.
    ///
    /// - Rejects with `CloudKitNotConfiguredException` if `configure()` has not been called.
    AsyncFunction("__debugListZones") { [weak self] (promise: Promise) in
      guard let self = self, let debugHelper = self.debugHelper else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      debugHelper.listZones { result in
        switch result {
        case .success(let zones):
          promise.resolve(zones)
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    /// Fetches a single record with all user-defined fields and full system metadata.
    ///
    /// Options keys:
    ///   - `recordName` (String, required)
    ///   - `zoneName`   (String, optional — defaults to the default zone)
    ///   - `database`   (String, optional — "private"|"shared"|"public", default "private")
    ///
    /// - Rejects with `CloudKitInvalidArgumentException` if `recordName` is missing.
    AsyncFunction("__debugFetchRawRecord") { [weak self] (options: [String: Any], promise: Promise) in
      guard let self = self, let debugHelper = self.debugHelper, let container = self.container else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }

      guard let recordName = options["recordName"] as? String else {
        promise.reject(CloudKitModuleError.invalidArgument("recordName is required"))
        return
      }

      let zoneName = options["zoneName"] as? String
      let dbString = options["database"] as? String ?? "private"
      let scope = Converters.toDatabaseScope(dbString)
      let db = container.ckContainer.database(with: scope)

      debugHelper.fetchRawRecord(
        recordName: recordName,
        zoneName: zoneName,
        database: db
      ) { result in
        switch result {
        case .success(let dict):
          promise.resolve(dict)
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    /// Deletes all records in the named zone, then recreates it empty.
    ///
    /// This is destructive and permanent — use only in test/dev environments.
    ///
    /// Options keys:
    ///   - `zoneName`  (String, required)
    ///   - `database`  (String, optional — "private"|"shared"|"public", default "private")
    ///
    /// - Rejects with `CloudKitInvalidArgumentException` if `zoneName` is missing.
    AsyncFunction("__debugClearZone") { [weak self] (options: [String: Any], promise: Promise) in
      guard let self = self, let debugHelper = self.debugHelper, let container = self.container else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }

      guard let zoneName = options["zoneName"] as? String else {
        promise.reject(CloudKitModuleError.invalidArgument("zoneName is required"))
        return
      }

      let dbString = options["database"] as? String ?? "private"
      let scope = Converters.toDatabaseScope(dbString)
      let db = container.ckContainer.database(with: scope)

      debugHelper.clearZone(zoneName: zoneName, database: db) { result in
        switch result {
        case .success:
          promise.resolve(nil)
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    // -------------------------------------------------------------------------
    // CKAsset — Phase D
    // -------------------------------------------------------------------------

    AsyncFunction("downloadAsset") { (_: String, _: String, _: String, _: String, _: String?, _: String, promise: Promise) in
      promise.reject(CloudKitModuleError.notImplemented("downloadAsset (Phase D)"))
    }

    // ---------------------------------------------------------------
    // Offline Queue — Phase C
    // ---------------------------------------------------------------

    /// Enqueues a CloudKit op for offline execution.
    /// Options: operation ("save"|"delete"), database, recordData.
    AsyncFunction("enqueueOfflineOperation") { [weak self] (options: [String: Any], promise: Promise) in
      guard let queue = self?.offlineQueue else {
        promise.reject(CloudKitModuleError.notConfigured); return
      }
      guard let operation = options["operation"] as? String,
            operation == "save" || operation == "delete" else {
        promise.reject(CloudKitModuleError.invalidArgument("operation must be 'save' or 'delete'"))
        return
      }
      guard let database = options["database"] as? String else {
        promise.reject(CloudKitModuleError.invalidArgument("database is required")); return
      }
      guard let recordData = options["recordData"] as? [String: Any] else {
        promise.reject(CloudKitModuleError.invalidArgument("recordData is required")); return
      }
      Task {
        do {
          let queueId = try await queue.enqueue(
            operation: operation, database: database, recordData: recordData
          )
          promise.resolve(["id": queueId])
        } catch OfflineQueueError.queueFull {
          promise.reject(OfflineQueueFullException())
        } catch {
          promise.reject(error)
        }
      }
    }

    /// Processes all pending entries. Returns status dict.
    AsyncFunction("drainOfflineQueue") { [weak self] (promise: Promise) in
      guard let queue = self?.offlineQueue else {
        promise.reject(CloudKitModuleError.notConfigured); return
      }
      Task {
        let status = await queue.drain()
        promise.resolve(status)
      }
    }

    /// Returns queue status. Pass { includeEntries: true } for full list.
    AsyncFunction("getOfflineQueueStatus") { [weak self] (options: [String: Any], promise: Promise) in
      guard let queue = self?.offlineQueue else {
        promise.reject(CloudKitModuleError.notConfigured); return
      }
      let includeEntries = options["includeEntries"] as? Bool ?? false
      Task {
        let status = await queue.getStatus(includeEntries: includeEntries)
        promise.resolve(status)
      }
    }

    /// Removes entries by status ("pending"|"retrying"|"failed"|"all").
    AsyncFunction("clearOfflineQueue") { [weak self] (options: [String: Any], promise: Promise) in
      guard let queue = self?.offlineQueue else {
        promise.reject(CloudKitModuleError.notConfigured); return
      }
      let filterStatus = options["status"] as? String ?? "all"
      Task {
        await queue.clear(status: filterStatus)
        promise.resolve(nil)
      }
    }

    /// Resets all failed entries to pending and immediately triggers a drain.
    AsyncFunction("retryFailedOperations") { [weak self] (promise: Promise) in
      guard let queue = self?.offlineQueue else {
        promise.reject(CloudKitModuleError.notConfigured); return
      }
      Task {
        await queue.retryFailed()
        promise.resolve(nil)
      }
    }

    // -------------------------------------------------------------------------
    // H.3 — Multi-container support (CloudKitClient instance API)
    //
    // A "client" is an opaque UUID token that maps to a CloudKitClient holding
    // its own CKContainer, CloudKitRecordManager, and CloudKitZoneManager.
    // All client IDs are stored in `clients` which is protected by `clientsQueue`.
    // -------------------------------------------------------------------------

    /// Creates a scoped CloudKit client bound to the given container identifier.
    ///
    /// - Parameter containerId: The fully-qualified iCloud container identifier,
    ///   e.g. "iCloud.com.example.app". Must start with "iCloud.".
    /// - Returns: An opaque client ID string. Pass this to `clientSaveRecords`,
    ///   `clientQueryRecords`, `clientDeleteRecords`, and `destroyClient`.
    /// - Throws: `invalidArgument` if `containerId` does not start with "iCloud.".
    AsyncFunction("createClient") { [weak self] (containerId: String, promise: Promise) in
      guard let self = self else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      guard containerId.hasPrefix("iCloud.") else {
        promise.reject(CloudKitModuleError.invalidArgument(
          "containerId must start with 'iCloud.' — got: \(containerId)"
        ))
        return
      }
      let clientId = UUID().uuidString
      let client = CloudKitClient(containerId: containerId)
      self.clientsQueue.sync(flags: .barrier) {
        self.clients[clientId] = client
      }
      promise.resolve(clientId)
    }

    /// Removes the client identified by `clientId` from the registry.
    ///
    /// No-op if the client does not exist. Always resolves without error.
    AsyncFunction("destroyClient") { [weak self] (clientId: String, promise: Promise) in
      guard let self = self else {
        promise.resolve(nil)
        return
      }
      self.clientsQueue.sync(flags: .barrier) {
        self.clients.removeValue(forKey: clientId)
      }
      promise.resolve(nil)
    }

    /// Saves records using the client bound to `clientId`.
    ///
    /// Delegates to the client's `CloudKitRecordManager.saveRecords`.
    /// - Throws: `invalidArgument` if `clientId` is not found.
    AsyncFunction("clientSaveRecords") { [weak self] (
      clientId: String,
      recordDicts: [[String: Any]],
      database: String,
      operationConfig: [String: Any]?,
      promise: Promise
    ) in
      guard let self = self else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      guard let client = self.clientsQueue.sync(execute: { self.clients[clientId] }) else {
        promise.reject(CloudKitModuleError.invalidArgument("No client found for clientId: \(clientId)"))
        return
      }
      let scope = Converters.toDatabaseScope(database)
      var records: [CKRecord] = []
      do {
        records = try recordDicts.map { try Converters.toCKRecord(from: $0) }
      } catch {
        promise.reject(Converters.toExpoError(error))
        return
      }
      client.recordManager.saveRecords(
        records,
        in: scope,
        operationConfig: operationConfig
      ) { result in
        switch result {
        case .success(let saved):
          promise.resolve(saved.map { Converters.toDictionary($0) })
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
    }

    /// Queries records using the client bound to `clientId`.
    ///
    /// Delegates to the client's `CloudKitRecordManager.queryRecords`.
    /// - Throws: `invalidArgument` if `clientId` is not found.
    AsyncFunction("clientQueryRecords") { [weak self] (
      clientId: String,
      options: [String: Any],
      promise: Promise
    ) in
      guard let self = self else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      guard let client = self.clientsQueue.sync(execute: { self.clients[clientId] }) else {
        promise.reject(CloudKitModuleError.invalidArgument("No client found for clientId: \(clientId)"))
        return
      }
      let recordType = options["recordType"] as? String ?? ""
      let database = options["database"] as? String ?? "private"
      let resultsLimit = options["resultsLimit"] as? Int ?? 200
      let predicateDict = options["predicate"] as? [String: Any]
      let sortDescriptorDicts = options["sortDescriptors"] as? [[String: Any]]
      let zoneName = options["zoneName"] as? String
      let cursor = options["cursor"] as? String
      let desiredKeys = options["desiredKeys"] as? [String]
      let operationConfig = options["operationConfig"] as? [String: Any]
      let scope = Converters.toDatabaseScope(database)
      let predicate = predicateDict.map { Converters.toPredicate(from: $0) } ?? NSPredicate(value: true)
      let sortDescriptors = sortDescriptorDicts?.compactMap { Converters.toNSSortDescriptor(from: $0) }

      // Cursor resolution for client queries uses the module-level cursorCache
      // (client queries and singleton queries share the same in-memory store —
      // client IDs are unique UUIDs so there is no key collision risk).
      let resolvedCursor: CKQueryOperation.Cursor? = cursor.flatMap { token in
        if let cached = self.cursorCache[token] { return cached }
        return client.recordManager.loadPersistedCursor(forToken: token)
      }

      client.recordManager.queryRecords(
        recordType: recordType,
        predicate: predicate,
        sortDescriptors: sortDescriptors,
        zoneName: zoneName,
        database: scope,
        resultsLimit: resultsLimit,
        cursor: resolvedCursor,
        desiredKeys: desiredKeys,
        operationConfig: operationConfig
      ) { [weak self] result in
        switch result {
        case .success(let (records, nextCursor)):
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

    /// Deletes records using the client bound to `clientId`.
    ///
    /// Delegates to the client's `CloudKitRecordManager.deleteRecords`.
    /// - Throws: `invalidArgument` if `clientId` is not found.
    AsyncFunction("clientDeleteRecords") { [weak self] (
      clientId: String,
      recordIdDicts: [[String: Any]],
      database: String,
      operationConfig: [String: Any]?,
      promise: Promise
    ) in
      guard let self = self else {
        promise.reject(CloudKitModuleError.notConfigured)
        return
      }
      guard let client = self.clientsQueue.sync(execute: { self.clients[clientId] }) else {
        promise.reject(CloudKitModuleError.invalidArgument("No client found for clientId: \(clientId)"))
        return
      }
      let scope = Converters.toDatabaseScope(database)
      let recordIDs = recordIdDicts.compactMap { dict -> CKRecord.ID? in
        guard let recordName = dict["recordName"] as? String else { return nil }
        let zoneIDName = dict["zoneName"] as? String
        let zoneID = zoneIDName.map { CKRecordZone.ID(zoneName: $0, ownerName: CKCurrentUserDefaultName) }
          ?? CKRecordZone.ID.default
        return CKRecord.ID(recordName: recordName, zoneID: zoneID)
      }
      client.recordManager.deleteRecords(recordIDs, in: scope, operationConfig: operationConfig) { result in
        switch result {
        case .success:
          promise.resolve(nil)
        case .failure(let error):
          promise.reject(Converters.toExpoError(error))
        }
      }
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
      // Post a NotificationCenter notification so CloudKitStore (@Observable
      // SwiftUI wrapper, Phase J.1) can update isSyncing / syncState without
      // depending on the Expo module event bus.
      DispatchQueue.main.async {
        NotificationCenter.default.post(
          name: .expoCloudKitSyncStateChanged,
          object: nil,
          userInfo: ["state": newState.rawValue]
        )
      }
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

    case .conflictPending(_, let eventPayload):
      // Route to the dedicated `onSyncConflict` channel so JS listeners can subscribe
      // independently of the general `onSyncEngineEvent` stream.
      // Expo requires sendEvent on the main thread; this event is already dispatched
      // to main by the sync adapters, but we guard again for safety.
      DispatchQueue.main.async { [weak self] in
        self?.sendEvent("onSyncConflict", eventPayload)
      }
      return

    case .syncHealth(let sentCount, let receivedCount, let failedCount, let durationMs, let syncEngine):
      // Route health metrics to the dedicated `onSyncHealth` channel.
      let healthPayload: [String: Any] = [
        "sentCount": sentCount,
        "receivedCount": receivedCount,
        "failedCount": failedCount,
        "durationMs": durationMs,
        "syncEngine": syncEngine
      ]
      DispatchQueue.main.async { [weak self] in
        self?.sendEvent("onSyncHealth", healthPayload)
      }
      return
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
  init(_ feature: String) { self.feature = feature; super.init() }
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
  init(_ subscriptionID: String) { self.subscriptionID = subscriptionID; super.init() }
  override var reason: String {
    "Subscription not found: \(subscriptionID)"
  }
}

class CloudKitInvalidArgumentException: Exception {
  private let message: String
  init(_ message: String) { self.message = message; super.init() }
  override var reason: String {
    "Invalid argument: \(message)"
  }
}

class ShareNotFoundException: Exception {
  override var reason: String { "Share record not found." }
}

class ShareURLNotFoundException: Exception {
  private let detail: String
  init(_ detail: String = "") { self.detail = detail; super.init() }
  override var reason: String {
    detail.isEmpty
      ? "No share is attached to this record, or the share has no URL yet — ensure the share has been saved to CloudKit."
      : detail
  }
}

class ParticipantNotFoundException: Exception {
  private let participantRecordName: String
  init(_ participantRecordName: String) { self.participantRecordName = participantRecordName; super.init() }
  override var reason: String {
    "Participant '\(participantRecordName)' not found on this share."
  }
}

class SharingUIUnavailableException: Exception {
  override var reason: String {
    "Cannot present sharing UI: no active view controller is available."
  }
}

class SharingUINotSupportedOnMacOSException: Exception {
  override var reason: String {
    "presentSharingUI is not supported on macOS."
  }
}

class OfflineQueueFullException: Exception {
  override var reason: String {
    "Offline queue is full (500 entries). Clear failed operations before enqueuing more."
  }
}

class BackgroundSyncUnavailableException: Exception {
  override var reason: String {
    "Background sync via BGTaskScheduler requires iOS 13 or later."
  }
}

// MARK: - CloudKitModuleError namespace
//
// This typealias-style enum is kept so that existing call sites compile
// without modification. Each case now constructs the corresponding Exception
// subclass, which Expo Modules Core serializes correctly to JS.

enum CloudKitModuleError {
  static var notConfigured: Exception              { CloudKitNotConfiguredException() }
  static var requiresiOS17: Exception              { CloudKitRequiresiOS17Exception() }
  static var syncEngineNotRunning: Exception       { CloudKitSyncEngineNotRunningException() }
  static var sharingUIUnavailable: Exception       { SharingUIUnavailableException() }
  static var sharingUINotSupportedOnMacOS: Exception { SharingUINotSupportedOnMacOSException() }
  static var backgroundSyncUnavailable: Exception { BackgroundSyncUnavailableException() }
  static func notImplemented(_ f: String) -> Exception  { CloudKitNotImplementedException(f) }
  static func subscriptionNotFound(_ id: String) -> Exception { CloudKitSubscriptionNotFoundException(id) }
  static func invalidArgument(_ msg: String) -> Exception    { CloudKitInvalidArgumentException(msg) }
  static func participantNotFound(_ name: String) -> Exception { ParticipantNotFoundException(name) }
  static func shareNotFound(_ detail: String = "") -> Exception { ShareURLNotFoundException(detail) }
}

#endif // canImport(ExpoModulesCore)

// MARK: - Notification Names (Phase J.1)

extension Notification.Name {
  /// Posted on the main queue whenever the sync provider transitions to a new state.
  /// UserInfo:
  ///   - `"state"`: `String` — one of "idle", "syncing", "suspended", "notStarted"
  ///
  /// `CloudKitStore` observes this notification to keep its `syncState` and
  /// `isSyncing` properties current without importing ExpoModulesCore.
  static let expoCloudKitSyncStateChanged = Notification.Name(
    "ExpoCloudKitSyncStateChanged"
  )
}
