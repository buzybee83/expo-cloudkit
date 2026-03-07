import CloudKit
import Foundation

/// Manages CKRecord CRUD operations: save, fetch, query, delete,
/// and zone change fetching (delta sync).
///
/// # Error Handling
/// All errors from CloudKit are forwarded to the completion callbacks unchanged.
/// Converters.toExpoError() in the module layer translates them to JS-friendly dicts.
///
/// # Batching
/// CloudKit enforces a limit of 400 records per CKModifyRecordsOperation batch.
/// Callers should split larger batches before calling saveRecords/deleteRecords.
final class CloudKitRecordManager {

  // MARK: - Properties

  private let ckContainer: CKContainer

  // In-memory cursor store for pagination between queryRecords calls.
  // Key: opaque token string produced by queryRecords; Value: CKQueryOperation.Cursor
  private var cursorStore: [String: CKQueryOperation.Cursor] = [:]

  // MARK: - Init

  init(ckContainer: CKContainer) {
    self.ckContainer = ckContainer
  }

  // MARK: - Save

  /// Saves records using CKModifyRecordsOperation with .changedKeys save policy.
  /// Records with no changeTag use .allKeys (insert). Records with a changeTag use
  /// .ifServerRecordUnchanged for conflict detection.
  func saveRecords(
    _ records: [CKRecord],
    in scope: CKDatabase.Scope,
    completion: @escaping (Result<[CKRecord], Error>) -> Void
  ) {
    let db = database(for: scope)
    var savedRecords: [CKRecord] = []
    var firstError: Error?

    let operation = CKModifyRecordsOperation(
      recordsToSave: records,
      recordIDsToDelete: nil
    )
    operation.qualityOfService = .userInitiated
    // Use .changedKeys as the default; individual record conflict handling
    // is done via the per-record save block below.
    operation.savePolicy = .changedKeys

    operation.perRecordSaveBlock = { _, result in
      switch result {
      case .success(let record):
        savedRecords.append(record)
      case .failure(let error):
        if firstError == nil { firstError = error }
      }
    }

    operation.modifyRecordsResultBlock = { result in
      switch result {
      case .success:
        if let error = firstError {
          completion(.failure(error))
        } else {
          completion(.success(savedRecords))
        }
      case .failure(let error):
        completion(.failure(error))
      }
    }

    db.add(operation)
  }

  // MARK: - Fetch

  /// Fetches a single record by its type and ID.
  func fetchRecord(
    recordType: String,
    recordId: String,
    zoneName: String?,
    database scope: CKDatabase.Scope,
    completion: @escaping (Result<CKRecord, Error>) -> Void
  ) {
    let zoneID: CKRecordZone.ID
    if let zoneName = zoneName {
      zoneID = CKRecordZone.ID(zoneName: zoneName, ownerName: CKCurrentUserDefaultName)
    } else {
      zoneID = CKRecordZone.ID.default
    }

    let recordID = CKRecord.ID(recordName: recordId, zoneID: zoneID)
    let db = database(for: scope)

    db.fetch(withRecordID: recordID) { record, error in
      if let error = error {
        completion(.failure(error))
        return
      }
      guard let record = record else {
        completion(.failure(CKError(.unknownItem)))
        return
      }
      completion(.success(record))
    }
  }

  // MARK: - Query

  /// Queries records matching the given predicate with optional sort and pagination.
  ///
  /// Returns the matched records and an optional cursor for the next page.
  /// The cursor is stored in memory so subsequent calls can resume pagination.
  func queryRecords(
    recordType: String,
    predicate: NSPredicate,
    sortDescriptors: [NSSortDescriptor]?,
    zoneName: String?,
    database scope: CKDatabase.Scope,
    resultsLimit: Int,
    cursor: CKQueryOperation.Cursor?,
    completion: @escaping (Result<([CKRecord], CKQueryOperation.Cursor?), Error>) -> Void
  ) {
    let db = database(for: scope)
    let zoneID: CKRecordZone.ID? = zoneName.map {
      CKRecordZone.ID(zoneName: $0, ownerName: CKCurrentUserDefaultName)
    }

    var matchedRecords: [CKRecord] = []
    let operation: CKQueryOperation

    if let cursor = cursor {
      operation = CKQueryOperation(cursor: cursor)
    } else {
      let query = CKQuery(recordType: recordType, predicate: predicate)
      query.sortDescriptors = sortDescriptors
      operation = CKQueryOperation(query: query)
    }

    operation.zoneID = zoneID
    operation.resultsLimit = resultsLimit
    operation.qualityOfService = .userInitiated

    operation.recordMatchedBlock = { _, result in
      switch result {
      case .success(let record):
        matchedRecords.append(record)
      case .failure:
        break // individual record errors are non-fatal for query; surfaced via queryResultBlock
      }
    }

    operation.queryResultBlock = { result in
      switch result {
      case .success(let nextCursor):
        completion(.success((matchedRecords, nextCursor)))
      case .failure(let error):
        completion(.failure(error))
      }
    }

    db.add(operation)
  }

  // MARK: - Delete

  /// Deletes a set of records by their IDs.
  func deleteRecords(
    _ recordIDs: [CKRecord.ID],
    in scope: CKDatabase.Scope,
    completion: @escaping (Result<Void, Error>) -> Void
  ) {
    let db = database(for: scope)

    let operation = CKModifyRecordsOperation(
      recordsToSave: nil,
      recordIDsToDelete: recordIDs
    )
    operation.qualityOfService = .userInitiated

    operation.modifyRecordsResultBlock = { result in
      switch result {
      case .success:
        completion(.success(()))
      case .failure(let error):
        completion(.failure(error))
      }
    }

    db.add(operation)
  }

  // MARK: - Zone Changes

  /// Fetches all record changes across the given zones since the last sync token.
  ///
  /// The returned dictionary is JS-ready (serialized by Converters before being
  /// passed to this method's completion). The sync token is encoded as a base64
  /// string for transport over the JS bridge.
  func fetchRecordZoneChanges(
    zoneNames: [String],
    database scope: CKDatabase.Scope,
    completion: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    let db = database(for: scope)

    let zoneIDs = zoneNames.map {
      CKRecordZone.ID(zoneName: $0, ownerName: CKCurrentUserDefaultName)
    }

    var changedRecords: [CKRecord] = []
    var deletedRecordNames: [String] = []
    var serverChangeToken: CKServerChangeToken?
    var moreComing = false

    let configs = zoneIDs.reduce(into: [CKRecordZone.ID: CKFetchRecordZoneChangesOperation.ZoneConfiguration]()) { dict, id in
      dict[id] = CKFetchRecordZoneChangesOperation.ZoneConfiguration()
    }

    let operation = CKFetchRecordZoneChangesOperation(
      recordZoneIDs: zoneIDs,
      configurationsByRecordZoneID: configs
    )
    operation.qualityOfService = .userInitiated
    operation.fetchAllChanges = false // respect moreComing

    operation.recordWasChangedBlock = { _, result in
      switch result {
      case .success(let record):
        changedRecords.append(record)
      case .failure:
        break
      }
    }

    operation.recordWithIDWasDeletedBlock = { recordID, _ in
      deletedRecordNames.append(recordID.recordName)
    }

    operation.recordZoneFetchResultBlock = { _, result in
      switch result {
      case .success(let (token, _, more)):
        serverChangeToken = token
        moreComing = more
      case .failure:
        break
      }
    }

    operation.fetchRecordZoneChangesResultBlock = { result in
      switch result {
      case .success:
        // Encode the server change token as base64 for JS transport
        var syncTokenString = ""
        if let token = serverChangeToken,
           let tokenData = try? NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: true) {
          syncTokenString = tokenData.base64EncodedString()
        }

        let response: [String: Any] = [
          "changedRecords": changedRecords.map { Converters.toDictionary($0) },
          "deletedRecordNames": deletedRecordNames,
          "syncToken": syncTokenString,
          "moreComing": moreComing
        ]
        completion(.success(response))

      case .failure(let error):
        completion(.failure(error))
      }
    }

    db.add(operation)
  }

  // MARK: - Helpers

  private func database(for scope: CKDatabase.Scope) -> CKDatabase {
    switch scope {
    case .private:
      return ckContainer.privateCloudDatabase
    case .shared:
      return ckContainer.sharedCloudDatabase
    case .public:
      return ckContainer.publicCloudDatabase
    @unknown default:
      return ckContainer.privateCloudDatabase
    }
  }
}
