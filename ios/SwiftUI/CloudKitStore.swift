import Foundation
import CloudKit
#if canImport(SwiftUI)
import SwiftUI

// MARK: - CloudKitStore

/// A SwiftUI-native `@Observable` store that wraps `CloudKitRecordManager`.
///
/// `CloudKitStore` provides a thin, SwiftUI-idiomatic interface over the underlying
/// CloudKit record operations. It is intended to be used as an environment object or
/// `@State` property in a SwiftUI view hierarchy.
///
/// Usage:
/// ```swift
/// @State private var store = CloudKitStore()
///
/// // Fetch records
/// try await store.fetch(recordType: "Note")
///
/// // Save a record
/// try await store.save(["recordType": "Note", "fields": ["title": ["type": "string", "value": "Hello"]]])
///
/// // Delete a record
/// try await store.delete(recordName: "some-record-name")
/// ```
///
/// Sync state (isSyncing, syncState) is kept current by observing
/// `Notification.Name.expoCloudKitSyncStateChanged`, which is posted by
/// `ExpoCloudKitModule` whenever the sync provider transitions to a new state.
///
/// - Note: Requires iOS 17 for the `@Observable` macro. The entire type is
///   conditionally available; callers on iOS 16 must use the JS-bridge API directly.
@available(iOS 17, macOS 14, *)
@Observable
public final class CloudKitStore {

  // MARK: - Observable State

  /// All fetched/saved records keyed by `recordName`.
  public var records: [String: [String: Any]] = [:]

  /// True while a sync cycle is in progress (syncState == "syncing").
  public var isSyncing: Bool = false

  /// Current sync provider state string — mirrors `SyncProviderState.rawValue`.
  /// Possible values: "idle", "syncing", "suspended", "notStarted".
  public var syncState: String = "idle"

  /// The last error encountered by a fetch/save/delete operation, or nil.
  public var lastError: Error? = nil

  /// Pending conflict payloads forwarded from `onSyncConflict` events.
  public var pendingConflicts: [[String: Any]] = []

  // MARK: - Private

  /// Weak reference to the record manager wired up by `configure()`.
  /// Populated via `ExpoCloudKitModule.sharedRecordManager`.
  private var recordManager: CloudKitRecordManager? {
    CloudKitStore.sharedRecordManager()
  }

  private var syncObserver: NSObjectProtocol?

  // MARK: - Init / Deinit

  public init() {
    wireNotifications()
  }

  deinit {
    if let obs = syncObserver {
      NotificationCenter.default.removeObserver(obs)
    }
  }

  // MARK: - Public API

  /// Fetches records of `recordType` from CloudKit and merges them into `records`.
  ///
  /// - Parameters:
  ///   - recordType: The CKRecord type string (e.g. "Note").
  ///   - database: One of "private", "shared", "public". Defaults to "private".
  ///   - predicate: NSPredicate format string. Defaults to "TRUEPREDICATE".
  ///   - desiredKeys: If provided, only these fields are fetched.
  ///
  /// - Throws: `CloudKitNotConfiguredException` if `configure()` was never called.
  ///   Any CloudKit error is rethrown and stored in `lastError`.
  public func fetch(
    recordType: String,
    database: String = "private",
    predicate: String = "TRUEPREDICATE",
    desiredKeys: [String]? = nil
  ) async throws {
    guard let rm = recordManager else {
      let err = CloudKitNotConfiguredException()
      await MainActor.run { self.lastError = err }
      throw err
    }

    let scope = Converters.toDatabaseScope(database)
    let nsPredicate = NSPredicate(format: predicate)
    let desiredCKKeys: [CKRecord.FieldKey]? = desiredKeys

    let ckRecords: [CKRecord] = try await withCheckedThrowingContinuation { continuation in
      rm.queryRecords(
        recordType: recordType,
        predicate: nsPredicate,
        sortDescriptors: nil,
        zoneName: nil,
        database: scope,
        resultsLimit: 200,
        cursor: nil,
        desiredKeys: desiredCKKeys,
        operationConfig: nil
      ) { result in
        switch result {
        case .success(let (records, _)):
          continuation.resume(returning: records)
        case .failure(let error):
          continuation.resume(throwing: error)
        }
      }
    }

    let dicts = ckRecords.map { Converters.toDictionary($0) }
    await MainActor.run {
      for dict in dicts {
        if let name = dict["recordName"] as? String {
          self.records[name] = dict
        }
      }
      self.lastError = nil
    }
  }

  /// Saves a record described by `recordDict` to CloudKit and updates `records`.
  ///
  /// The dictionary must contain at least `"recordType"` and optionally
  /// `"recordName"`, `"zoneName"`, and `"fields"`.
  ///
  /// - Throws: `CloudKitNotConfiguredException` if `configure()` was never called.
  public func save(_ recordDict: [String: Any]) async throws {
    guard let rm = recordManager else {
      let err = CloudKitNotConfiguredException()
      await MainActor.run { self.lastError = err }
      throw err
    }

    let ckRecord = try Converters.toCKRecord(from: recordDict)
    let scope = Converters.toDatabaseScope(recordDict["database"] as? String ?? "private")

    let savedRecords: [CKRecord] = try await withCheckedThrowingContinuation { continuation in
      rm.saveRecords([ckRecord], in: scope, operationConfig: nil) { result in
        switch result {
        case .success(let records):
          continuation.resume(returning: records)
        case .failure(let error):
          continuation.resume(throwing: error)
        }
      }
    }

    let dicts = savedRecords.map { Converters.toDictionary($0) }
    await MainActor.run {
      for dict in dicts {
        if let name = dict["recordName"] as? String {
          self.records[name] = dict
        }
      }
      self.lastError = nil
    }
  }

  /// Deletes the record identified by `recordName` from CloudKit and removes it
  /// from `records`.
  ///
  /// - Parameters:
  ///   - recordName: The `CKRecord.ID.recordName` of the record to delete.
  ///   - zoneName: The zone the record lives in. Defaults to `_defaultZone`.
  ///   - database: One of "private", "shared", "public". Defaults to "private".
  ///
  /// - Throws: `CloudKitNotConfiguredException` if `configure()` was never called.
  public func delete(
    recordName: String,
    zoneName: String = CKRecordZone.default().zoneID.zoneName,
    database: String = "private"
  ) async throws {
    guard let rm = recordManager else {
      let err = CloudKitNotConfiguredException()
      await MainActor.run { self.lastError = err }
      throw err
    }

    let zoneID = CKRecordZone.ID(zoneName: zoneName, ownerName: CKCurrentUserDefaultName)
    let recordID = CKRecord.ID(recordName: recordName, zoneID: zoneID)
    let scope = Converters.toDatabaseScope(database)

    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      rm.deleteRecords([recordID], in: scope, operationConfig: nil) { result in
        switch result {
        case .success:
          continuation.resume()
        case .failure(let error):
          continuation.resume(throwing: error)
        }
      }
    }

    await MainActor.run {
      self.records.removeValue(forKey: recordName)
      self.lastError = nil
    }
  }

  // MARK: - Private Helpers

  /// Subscribes to `Notification.Name.expoCloudKitSyncStateChanged` so that
  /// `syncState` and `isSyncing` stay current without polling.
  private func wireNotifications() {
    syncObserver = NotificationCenter.default.addObserver(
      forName: .expoCloudKitSyncStateChanged,
      object: nil,
      queue: .main
    ) { [weak self] notification in
      guard let self else { return }
      if let state = notification.userInfo?["state"] as? String {
        self.syncState = state
        self.isSyncing = (state == "syncing")
      }
    }
  }

  /// Returns the `CloudKitRecordManager` that was configured via
  /// `ExpoCloudKitModule.configure()`, or nil if `configure()` has not been called.
  private static func sharedRecordManager() -> CloudKitRecordManager? {
    return ExpoCloudKitModule.sharedRecordManager
  }
}

#endif
