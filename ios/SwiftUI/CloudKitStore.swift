import Foundation
import CloudKit
#if canImport(SwiftUI)
import SwiftUI

// MARK: - Supporting Types

/// A structured representation of a CloudKit record, used as the element type
/// for `CloudKitStore.records` and `CloudKitStoreLegacy.records`.
public struct CloudKitRecord: Identifiable, Equatable {
  /// The `CKRecord.ID.recordName` — used as the stable SwiftUI identity.
  public let id: String
  /// The CKRecord type string (e.g. "Note").
  public let recordType: String
  /// The zone name this record lives in.
  public let zoneName: String
  /// The raw field dictionary as converted by `Converters.toDictionary`.
  public let fields: [String: [String: Any]]
  /// Server-assigned modification date, if available.
  public let modificationDate: String?

  public static func == (lhs: CloudKitRecord, rhs: CloudKitRecord) -> Bool {
    lhs.id == rhs.id
  }

  /// Constructs a `CloudKitRecord` from the dictionary produced by `Converters.toDictionary`.
  init?(from dict: [String: Any]) {
    guard let recordName = dict["recordName"] as? String,
          let recordType = dict["recordType"] as? String,
          let zoneName = dict["zoneName"] as? String else {
      return nil
    }
    self.id = recordName
    self.recordType = recordType
    self.zoneName = zoneName
    self.fields = dict["fields"] as? [String: [String: Any]] ?? [:]
    self.modificationDate = dict["modificationDate"] as? String
  }
}

/// Current state of the sync engine as observed by the store.
public struct SyncState: Equatable {
  public let usesSyncEngine: Bool
  public let status: SyncStatus

  public init(usesSyncEngine: Bool, status: SyncStatus) {
    self.usesSyncEngine = usesSyncEngine
    self.status = status
  }

  public enum SyncStatus: String, Equatable {
    case notStarted
    case idle
    case syncing
    case suspended
  }
}

/// A typed CloudKit error surfaced on the store — does not throw to the SwiftUI layer.
public struct CloudKitError: Error, Identifiable, Equatable {
  public let id: UUID
  /// One of the error code strings from `Converters.toExpoError` (e.g. "NOT_AUTHENTICATED").
  public let code: String
  public let message: String
  /// Present for `.requestRateLimited`, `.serviceUnavailable`, `.zoneBusy`.
  public let retryAfterSeconds: Double?

  public init(code: String, message: String, retryAfterSeconds: Double? = nil) {
    self.id = UUID()
    self.code = code
    self.message = message
    self.retryAfterSeconds = retryAfterSeconds
  }

  public static func == (lhs: CloudKitError, rhs: CloudKitError) -> Bool {
    lhs.id == rhs.id
  }

  /// Converts any `Error` to a `CloudKitError` using the existing converter mapping.
  static func from(_ error: Error) -> CloudKitError {
    if let bridge = error as? ExpoCloudKitBridgeError {
      return CloudKitError(
        code: bridge.code,
        message: bridge.message,
        retryAfterSeconds: bridge.retryAfterSeconds
      )
    }
    if let ck = error as? CKError {
      let bridge = Converters.toExpoError(ck) as? ExpoCloudKitBridgeError
      return CloudKitError(
        code: bridge?.code ?? "UNKNOWN",
        message: bridge?.message ?? ck.localizedDescription,
        retryAfterSeconds: bridge?.retryAfterSeconds
      )
    }
    return CloudKitError(code: "UNKNOWN", message: error.localizedDescription)
  }
}

/// Parameters for a `queryRecords` call passed to `CloudKitStore.fetch`.
public struct FetchConfig {
  /// The CKRecord type string. Required.
  public let recordType: String
  /// One of "private", "shared", "public". Defaults to "private".
  public let database: String
  /// NSPredicate format string. Defaults to "TRUEPREDICATE".
  public let predicate: String
  /// If set, only these field keys are fetched from CloudKit.
  public let desiredKeys: [String]?
  /// Maximum number of records returned per page. Defaults to 200.
  public let resultsLimit: Int

  public init(
    recordType: String,
    database: String = "private",
    predicate: String = "TRUEPREDICATE",
    desiredKeys: [String]? = nil,
    resultsLimit: Int = 200
  ) {
    self.recordType = recordType
    self.database = database
    self.predicate = predicate
    self.desiredKeys = desiredKeys
    self.resultsLimit = resultsLimit
  }
}

/// Minimal description of a record to save — mirrors the JS `saveRecords` input shape.
public struct RecordToSave {
  public let recordType: String
  /// Omit to let CloudKit generate a UUID.
  public let recordName: String?
  public let zoneName: String?
  public let database: String
  /// Field values using the typed `{ type, value }` dictionary format.
  public let fields: [String: [String: Any]]

  public init(
    recordType: String,
    recordName: String? = nil,
    zoneName: String? = nil,
    database: String = "private",
    fields: [String: [String: Any]] = [:]
  ) {
    self.recordType = recordType
    self.recordName = recordName
    self.zoneName = zoneName
    self.database = database
    self.fields = fields
  }

  func toDictionary() -> [String: Any] {
    var dict: [String: Any] = [
      "recordType": recordType,
      "database": database,
      "fields": fields
    ]
    if let rn = recordName { dict["recordName"] = rn }
    if let zn = zoneName { dict["zoneName"] = zn }
    return dict
  }
}

/// Identifies a record for deletion.
public struct RecordIdentifier {
  public let recordName: String
  public let zoneName: String
  public let database: String

  public init(
    recordName: String,
    zoneName: String = CKRecordZone.default().zoneID.zoneName,
    database: String = "private"
  ) {
    self.recordName = recordName
    self.zoneName = zoneName
    self.database = database
  }
}

/// Configuration passed to `startSync`.
public struct SyncEngineConfig {
  public let zoneName: String
  public let database: String
  public let automaticallySync: Bool

  public init(
    zoneName: String,
    database: String = "private",
    automaticallySync: Bool = true
  ) {
    self.zoneName = zoneName
    self.database = database
    self.automaticallySync = automaticallySync
  }
}

// MARK: - CloudKitStore (iOS 17+ @Observable)

/// A SwiftUI-native `@Observable` store that wraps `CloudKitRecordManager`.
///
/// Provides a thin, SwiftUI-idiomatic interface over the CloudKit record operations
/// exposed by `ExpoCloudKitModule`. It is intended to be used as a `@State` property
/// or an environment object in a SwiftUI view hierarchy.
///
/// All async methods catch errors internally and assign them to `self.error`.
/// They never propagate errors to the caller, keeping the SwiftUI view layer clean.
///
/// Sync state (`syncState`, `isSyncing`) is kept current by observing
/// `Notification.Name.expoCloudKitSyncStateChanged`, which is posted by
/// `ExpoCloudKitModule` whenever the sync provider transitions to a new state.
///
/// - Important: Requires iOS 17 for the `@Observable` macro. On iOS 16 use
///   `CloudKitStoreLegacy` which provides an identical API via `ObservableObject`.
///
/// - Note: `configure()` must be called on `ExpoCloudKitModule` before the store
///   is used. If the module is not configured, operations will set `error` to a
///   `CloudKitError` with code `"NOT_CONFIGURED"`.
@available(iOS 17.0, macOS 14.0, *)
@MainActor
@Observable
public final class CloudKitStore {

  // MARK: - Observable State

  /// All fetched records in insertion order, keyed by `CloudKitRecord.id` (recordName).
  ///
  /// SwiftUI views should iterate `records.values` for display, or use
  /// `records[recordName]` for point lookup.
  public var records: [String: CloudKitRecord] = [:]

  /// True while any async CloudKit operation is in flight.
  public var isLoading: Bool = false

  /// Current sync state — reflects the last `expoCloudKitSyncStateChanged` notification.
  public var syncState: SyncState = SyncState(usesSyncEngine: false, status: .notStarted)

  /// The last error from any `fetch`, `save`, `delete`, or `startSync` call.
  /// Assign nil to clear (e.g. after displaying an alert).
  public var error: CloudKitError? = nil

  // MARK: - Private

  nonisolated(unsafe) private var syncObserver: NSObjectProtocol?

  // MARK: - Init / Deinit

  public init() {
    wireNotifications()
  }

  deinit {
    if let obs = syncObserver {
      NotificationCenter.default.removeObserver(obs)
    }
  }

  // MARK: - Public API — Records

  /// Queries records from CloudKit and merges the results into `records`.
  ///
  /// Sets `isLoading` to `true` for the duration and assigns `error` on failure.
  /// On success, clears `error` and merges returned records into `self.records`
  /// using `recordName` as the key (upsert semantics).
  public func fetch(_ config: FetchConfig) async {
    guard let rm = recordManager else {
      error = CloudKitError(code: "NOT_CONFIGURED",
                            message: "ExpoCloudKit is not configured. Call configure(containerId) first.")
      return
    }

    isLoading = true
    defer { isLoading = false }

    let scope = Converters.toDatabaseScope(config.database)
    let nsPredicate = NSPredicate(format: config.predicate)
    let desiredCKKeys: [CKRecord.FieldKey]? = config.desiredKeys

    do {
      let ckRecords: [CKRecord] = try await withCheckedThrowingContinuation { continuation in
        rm.queryRecords(
          recordType: config.recordType,
          predicate: nsPredicate,
          sortDescriptors: nil,
          zoneName: nil,
          database: scope,
          resultsLimit: config.resultsLimit,
          cursor: nil,
          desiredKeys: desiredCKKeys,
          operationConfig: nil
        ) { result in
          switch result {
          case .success(let (records, _)):
            continuation.resume(returning: records)
          case .failure(let err):
            continuation.resume(throwing: err)
          }
        }
      }

      let fetched = ckRecords.compactMap { CloudKitRecord(from: Converters.toDictionary($0)) }
      for record in fetched {
        self.records[record.id] = record
      }
      self.error = nil
    } catch {
      self.error = CloudKitError.from(error)
    }
  }

  /// Saves a record to CloudKit and upserts it into `records` on success.
  ///
  /// Sets `isLoading` to `true` for the duration and assigns `error` on failure.
  public func save(_ toSave: RecordToSave) async {
    guard let rm = recordManager else {
      error = CloudKitError(code: "NOT_CONFIGURED",
                            message: "ExpoCloudKit is not configured. Call configure(containerId) first.")
      return
    }

    isLoading = true
    defer { isLoading = false }

    do {
      let ckRecord = try Converters.toCKRecord(from: toSave.toDictionary())
      let scope = Converters.toDatabaseScope(toSave.database)

      let savedRecords: [CKRecord] = try await withCheckedThrowingContinuation { continuation in
        rm.saveRecords([ckRecord], in: scope, operationConfig: nil) { result in
          switch result {
          case .success(let records):
            continuation.resume(returning: records)
          case .failure(let err):
            continuation.resume(throwing: err)
          }
        }
      }

      for saved in savedRecords where saved.recordType != "__metrics__" {
        if let record = CloudKitRecord(from: Converters.toDictionary(saved)) {
          self.records[record.id] = record
        }
      }
      self.error = nil
    } catch {
      self.error = CloudKitError.from(error)
    }
  }

  /// Deletes a record from CloudKit and removes it from `records` on success.
  ///
  /// Sets `isLoading` to `true` for the duration and assigns `error` on failure.
  public func delete(_ identifier: RecordIdentifier) async {
    guard let rm = recordManager else {
      error = CloudKitError(code: "NOT_CONFIGURED",
                            message: "ExpoCloudKit is not configured. Call configure(containerId) first.")
      return
    }

    isLoading = true
    defer { isLoading = false }

    let zoneID = CKRecordZone.ID(
      zoneName: identifier.zoneName,
      ownerName: CKCurrentUserDefaultName
    )
    let recordID = CKRecord.ID(recordName: identifier.recordName, zoneID: zoneID)
    let scope = Converters.toDatabaseScope(identifier.database)

    do {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        rm.deleteRecords([recordID], in: scope, operationConfig: nil) { result in
          switch result {
          case .success:
            continuation.resume()
          case .failure(let err):
            continuation.resume(throwing: err)
          }
        }
      }

      self.records.removeValue(forKey: identifier.recordName)
      self.error = nil
    } catch {
      self.error = CloudKitError.from(error)
    }
  }

  // MARK: - Public API — Sync

  /// Starts the sync engine for the given configuration.
  ///
  /// Delegates to the existing `CloudKitSyncProvider` infrastructure via
  /// `ExpoCloudKitModule.sharedSyncProvider`. If the sync provider is not
  /// available (module not configured), `error` is set.
  ///
  /// On iOS 16, `CloudKitSyncProvider` is backed by the manual fetch fallback
  /// rather than CKSyncEngine.
  public func startSync(config: SyncEngineConfig) async {
    guard let provider = syncProvider else {
      error = CloudKitError(
        code: "NOT_CONFIGURED",
        message: "Sync requires ExpoCloudKit to be configured and startSyncEngine() called first."
      )
      return
    }

    isLoading = true
    defer { isLoading = false }

    let scope = Converters.toDatabaseScope(config.database)
    let zoneID = CKRecordZone.ID(zoneName: config.zoneName, ownerName: CKCurrentUserDefaultName)

    await provider.start(
      zones: [zoneID],
      database: scope,
      automaticallySync: config.automaticallySync
    ) { [weak self, weak provider] event in
      guard let self, let provider else { return }
      switch event {
      case .stateChanged(let state):
        let usesSyncEngine = provider.usesSyncEngine
        self.syncState = SyncState(
          usesSyncEngine: usesSyncEngine,
          status: SyncState.SyncStatus(rawValue: state.rawValue) ?? .idle
        )
      case .recordsFetched(let changed, _, _):
        for record in changed {
          if let cr = CloudKitRecord(from: Converters.toDictionary(record)) {
            self.records[cr.id] = cr
          }
        }
      case .syncError(let err):
        self.error = CloudKitError.from(err)
      default:
        break
      }
    }
  }

  // MARK: - Private Helpers

  private var recordManager: CloudKitRecordManager? {
    #if canImport(ExpoModulesCore)
    return ExpoCloudKitModule.sharedRecordManager
    #else
    return nil
    #endif
  }

  private var syncProvider: CloudKitSyncProvider? {
    #if canImport(ExpoModulesCore)
    return ExpoCloudKitModule.sharedSyncProviders[.private]?.value
    #else
    return nil
    #endif
  }

  /// Subscribes to `Notification.Name.expoCloudKitSyncStateChanged` so that
  /// `syncState` reflects module-level sync transitions without polling.
  private func wireNotifications() {
    syncObserver = NotificationCenter.default.addObserver(
      forName: .expoCloudKitSyncStateChanged,
      object: nil,
      queue: .main
    ) { [weak self] notification in
      guard let self else { return }
      if let stateString = notification.userInfo?["state"] as? String {
        let status = SyncState.SyncStatus(rawValue: stateString) ?? .idle
        let usesSyncEngine = notification.userInfo?["usesSyncEngine"] as? Bool ?? false
        self.syncState = SyncState(usesSyncEngine: usesSyncEngine, status: status)
      }
    }
  }
}

// MARK: - CloudKitStoreLegacy (iOS 16 ObservableObject)

/// An `ObservableObject` equivalent of `CloudKitStore` for iOS 16.
///
/// Provides an identical public API surface to `CloudKitStore` but uses
/// `@Published` properties and `ObservableObject` conformance so it works
/// on iOS 16 where the `@Observable` macro is unavailable.
///
/// - Note: Prefer `CloudKitStore` on iOS 17+. Use `CloudKitStoreLegacy` only
///   when your deployment target is iOS 16.
@available(iOS 16.0, macOS 13.0, *)
public final class CloudKitStoreLegacy: ObservableObject {

  // MARK: - Published State

  @Published public var records: [String: CloudKitRecord] = [:]
  @Published public var isLoading: Bool = false
  @Published public var syncState: SyncState = SyncState(usesSyncEngine: false, status: .notStarted)
  @Published public var error: CloudKitError? = nil

  // MARK: - Private

  nonisolated(unsafe) private var syncObserver: NSObjectProtocol?

  // MARK: - Init / Deinit

  public init() {
    wireNotifications()
  }

  deinit {
    if let obs = syncObserver {
      NotificationCenter.default.removeObserver(obs)
    }
  }

  // MARK: - Public API — Records

  /// Queries records from CloudKit and merges the results into `records`.
  public func fetch(_ config: FetchConfig) async {
    guard let rm = recordManager else {
      await setError(CloudKitError(code: "NOT_CONFIGURED",
                                   message: "ExpoCloudKit is not configured. Call configure(containerId) first."))
      return
    }

    await setIsLoading(true)
    defer { Task { await self.setIsLoading(false) } }

    let scope = Converters.toDatabaseScope(config.database)
    let nsPredicate = NSPredicate(format: config.predicate)
    let desiredCKKeys: [CKRecord.FieldKey]? = config.desiredKeys

    do {
      let ckRecords: [CKRecord] = try await withCheckedThrowingContinuation { continuation in
        rm.queryRecords(
          recordType: config.recordType,
          predicate: nsPredicate,
          sortDescriptors: nil,
          zoneName: nil,
          database: scope,
          resultsLimit: config.resultsLimit,
          cursor: nil,
          desiredKeys: desiredCKKeys,
          operationConfig: nil
        ) { result in
          switch result {
          case .success(let (records, _)):
            continuation.resume(returning: records)
          case .failure(let err):
            continuation.resume(throwing: err)
          }
        }
      }

      let fetched = ckRecords.compactMap { CloudKitRecord(from: Converters.toDictionary($0)) }
      await MainActor.run {
        for record in fetched {
          self.records[record.id] = record
        }
        self.error = nil
      }
    } catch {
      await setError(CloudKitError.from(error))
    }
  }

  /// Saves a record to CloudKit and upserts it into `records` on success.
  public func save(_ toSave: RecordToSave) async {
    guard let rm = recordManager else {
      await setError(CloudKitError(code: "NOT_CONFIGURED",
                                   message: "ExpoCloudKit is not configured. Call configure(containerId) first."))
      return
    }

    await setIsLoading(true)
    defer { Task { await self.setIsLoading(false) } }

    do {
      let ckRecord = try Converters.toCKRecord(from: toSave.toDictionary())
      let scope = Converters.toDatabaseScope(toSave.database)

      let savedRecords: [CKRecord] = try await withCheckedThrowingContinuation { continuation in
        rm.saveRecords([ckRecord], in: scope, operationConfig: nil) { result in
          switch result {
          case .success(let records):
            continuation.resume(returning: records)
          case .failure(let err):
            continuation.resume(throwing: err)
          }
        }
      }

      await MainActor.run {
        for saved in savedRecords where saved.recordType != "__metrics__" {
          if let record = CloudKitRecord(from: Converters.toDictionary(saved)) {
            self.records[record.id] = record
          }
        }
        self.error = nil
      }
    } catch {
      await setError(CloudKitError.from(error))
    }
  }

  /// Deletes a record from CloudKit and removes it from `records` on success.
  public func delete(_ identifier: RecordIdentifier) async {
    guard let rm = recordManager else {
      await setError(CloudKitError(code: "NOT_CONFIGURED",
                                   message: "ExpoCloudKit is not configured. Call configure(containerId) first."))
      return
    }

    await setIsLoading(true)
    defer { Task { await self.setIsLoading(false) } }

    let zoneID = CKRecordZone.ID(
      zoneName: identifier.zoneName,
      ownerName: CKCurrentUserDefaultName
    )
    let recordID = CKRecord.ID(recordName: identifier.recordName, zoneID: zoneID)
    let scope = Converters.toDatabaseScope(identifier.database)

    do {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        rm.deleteRecords([recordID], in: scope, operationConfig: nil) { result in
          switch result {
          case .success:
            continuation.resume()
          case .failure(let err):
            continuation.resume(throwing: err)
          }
        }
      }

      await MainActor.run {
        self.records.removeValue(forKey: identifier.recordName)
        self.error = nil
      }
    } catch {
      await setError(CloudKitError.from(error))
    }
  }

  // MARK: - Public API — Sync

  /// Starts the sync engine for the given configuration.
  public func startSync(config: SyncEngineConfig) async {
    guard let provider = syncProvider else {
      await setError(CloudKitError(
        code: "NOT_CONFIGURED",
        message: "Sync requires ExpoCloudKit to be configured and startSyncEngine() called first."
      ))
      return
    }

    await setIsLoading(true)
    defer { Task { await self.setIsLoading(false) } }

    let scope = Converters.toDatabaseScope(config.database)
    let zoneID = CKRecordZone.ID(zoneName: config.zoneName, ownerName: CKCurrentUserDefaultName)

    await provider.start(
      zones: [zoneID],
      database: scope,
      automaticallySync: config.automaticallySync
    ) { [weak self, weak provider] event in
      guard let self, let provider else { return }
      switch event {
      case .stateChanged(let state):
        let usesSyncEngine = provider.usesSyncEngine
        Task { @MainActor in
          self.syncState = SyncState(
            usesSyncEngine: usesSyncEngine,
            status: SyncState.SyncStatus(rawValue: state.rawValue) ?? .idle
          )
        }
      case .recordsFetched(let changed, _, _):
        let dicts = changed.compactMap { CloudKitRecord(from: Converters.toDictionary($0)) }
        Task { @MainActor in
          for record in dicts {
            self.records[record.id] = record
          }
        }
      case .syncError(let err):
        Task { await self.setError(CloudKitError.from(err)) }
      default:
        break
      }
    }
  }

  // MARK: - Private Helpers

  private var recordManager: CloudKitRecordManager? {
    #if canImport(ExpoModulesCore)
    return ExpoCloudKitModule.sharedRecordManager
    #else
    return nil
    #endif
  }

  private var syncProvider: CloudKitSyncProvider? {
    #if canImport(ExpoModulesCore)
    return ExpoCloudKitModule.sharedSyncProviders[.private]?.value
    #else
    return nil
    #endif
  }

  @MainActor
  private func setIsLoading(_ value: Bool) {
    isLoading = value
  }

  @MainActor
  private func setError(_ value: CloudKitError) {
    error = value
    isLoading = false
  }

  private func wireNotifications() {
    syncObserver = NotificationCenter.default.addObserver(
      forName: .expoCloudKitSyncStateChanged,
      object: nil,
      queue: .main
    ) { [weak self] notification in
      guard let self else { return }
      if let stateString = notification.userInfo?["state"] as? String {
        let status = SyncState.SyncStatus(rawValue: stateString) ?? .idle
        let usesSyncEngine = notification.userInfo?["usesSyncEngine"] as? Bool ?? false
        self.syncState = SyncState(usesSyncEngine: usesSyncEngine, status: status)
      }
    }
  }
}

#endif // canImport(SwiftUI)
