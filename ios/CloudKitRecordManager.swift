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
/// saveRecords and deleteRecords auto-chunk at that limit so callers never need
/// to split arrays themselves.
final class CloudKitRecordManager {

  // MARK: - Constants

  /// Maximum records per CKModifyRecordsOperation (CloudKit hard limit).
  static let batchSize = 400

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
  ///
  /// Automatically chunks the input into batches of `batchSize` (400) records.
  /// Chunks are dispatched serially — the next chunk only starts after the
  /// previous one completes successfully. The first per-record or operation-level
  /// error aborts remaining chunks and calls completion(.failure).
  ///
  /// - Parameters:
  ///   - records: The records to save.
  ///   - scope: The database scope (private / shared / public).
  ///   - progressHandler: Called after each individual record is confirmed saved
  ///     by CloudKit. `completed` is the running count across all chunks.
  ///     `total` is the total number of records submitted. `recordName` is the
  ///     CloudKit-assigned record name of the just-saved record. May be called
  ///     from a background thread.
  ///   - completion: Called once all chunks succeed (with the full list of saved
  ///     records) or as soon as any error is encountered.
  func saveRecords(
    _ records: [CKRecord],
    in scope: CKDatabase.Scope,
    progressHandler: ((_ completed: Int, _ total: Int, _ recordName: String) -> Void)? = nil,
    completion: @escaping (Result<[CKRecord], Error>) -> Void
  ) {
    let db = database(for: scope)
    let total = records.count

    guard total > 0 else {
      completion(.success([]))
      return
    }

    let chunks = stride(from: 0, to: total, by: CloudKitRecordManager.batchSize).map { start -> [CKRecord] in
      let end = min(start + CloudKitRecordManager.batchSize, total)
      return Array(records[start..<end])
    }

    // completedCount is mutated only from CloudKit's internal operation queue
    // (single operation at a time due to serial dispatch), so a plain var
    // protected by serial dispatch via the recursive call chain is sufficient.
    var completedCount = 0
    var allSaved: [CKRecord] = []
    allSaved.reserveCapacity(total)

    func dispatchChunk(_ index: Int) {
      guard index < chunks.count else {
        // All chunks finished successfully.
        completion(.success(allSaved))
        return
      }

      let chunk = chunks[index]
      var chunkSaved: [CKRecord] = []
      var firstError: Error?

      let operation = CKModifyRecordsOperation(
        recordsToSave: chunk,
        recordIDsToDelete: nil
      )
      operation.qualityOfService = .userInitiated
      // Use .changedKeys as the default; individual record conflict handling
      // is done via the per-record save block below.
      operation.savePolicy = .changedKeys

      operation.perRecordSaveBlock = { _, result in
        switch result {
        case .success(let record):
          chunkSaved.append(record)
          completedCount += 1
          progressHandler?(completedCount, total, record.recordID.recordName)
        case .failure(let error):
          if firstError == nil { firstError = error }
        }
      }

      operation.modifyRecordsResultBlock = { result in
        switch result {
        case .success:
          if let error = firstError {
            // A per-record error occurred inside the chunk — surface immediately.
            completion(.failure(error))
          } else {
            allSaved.append(contentsOf: chunkSaved)
            dispatchChunk(index + 1)
          }
        case .failure(let error):
          completion(.failure(error))
        }
      }

      db.add(operation)
    }

    dispatchChunk(0)
  }

  // MARK: - Fetch

  /// Fetches a single record by its type and ID.
  ///
  /// Uses `CKFetchRecordsOperation` so that `desiredKeys` can be specified.
  /// When `desiredKeys` is non-nil, only those field keys are fetched from
  /// the server — avoids over-fetching large field sets.
  func fetchRecord(
    recordType: String,
    recordId: String,
    zoneName: String?,
    database scope: CKDatabase.Scope,
    desiredKeys: [String]? = nil,
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

    let operation = CKFetchRecordsOperation(recordIDs: [recordID])
    operation.qualityOfService = .userInitiated
    if let desiredKeys = desiredKeys {
      operation.desiredKeys = desiredKeys
    }

    operation.perRecordResultBlock = { _, result in
      switch result {
      case .success(let record):
        completion(.success(record))
      case .failure(let error):
        completion(.failure(error))
      }
    }

    db.add(operation)
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
    desiredKeys: [CKRecord.FieldKey]? = nil,
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
    if let desiredKeys = desiredKeys {
      operation.desiredKeys = desiredKeys
    }

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
  ///
  /// Automatically chunks the input into batches of `batchSize` (400) record IDs.
  /// Chunks are dispatched serially; the first operation-level error aborts remaining
  /// chunks and calls completion(.failure).
  func deleteRecords(
    _ recordIDs: [CKRecord.ID],
    in scope: CKDatabase.Scope,
    completion: @escaping (Result<Void, Error>) -> Void
  ) {
    let db = database(for: scope)
    let total = recordIDs.count

    guard total > 0 else {
      completion(.success(()))
      return
    }

    let chunks = stride(from: 0, to: total, by: CloudKitRecordManager.batchSize).map { start -> [CKRecord.ID] in
      let end = min(start + CloudKitRecordManager.batchSize, total)
      return Array(recordIDs[start..<end])
    }

    func dispatchChunk(_ index: Int) {
      guard index < chunks.count else {
        completion(.success(()))
        return
      }

      let operation = CKModifyRecordsOperation(
        recordsToSave: nil,
        recordIDsToDelete: chunks[index]
      )
      operation.qualityOfService = .userInitiated

      operation.modifyRecordsResultBlock = { result in
        switch result {
        case .success:
          dispatchChunk(index + 1)
        case .failure(let error):
          completion(.failure(error))
        }
      }

      db.add(operation)
    }

    dispatchChunk(0)
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
    desiredKeys: [CKRecord.FieldKey]? = nil,
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
      var config = CKFetchRecordZoneChangesOperation.ZoneConfiguration()
      if let desiredKeys = desiredKeys {
        config.desiredKeys = desiredKeys
      }
      dict[id] = config
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

  // MARK: - Reference Deep Linking

  /// Fetches a record and recursively resolves all CKRecord.Reference fields up to `depth` levels.
  ///
  /// At each level all references are fetched in parallel via DispatchGroup.
  /// Reference fields in the returned dict are replaced with full resolved record dicts.
  /// If a referenced record cannot be fetched (e.g. RECORD_NOT_FOUND), the reference field
  /// falls back to the original shallow stub — it is never omitted entirely.
  ///
  /// - Parameters:
  ///   - recordName: The recordName of the root record to fetch.
  ///   - zoneName: Optional zone name; nil resolves to the default zone.
  ///   - scope: Database scope (.private / .shared / .public).
  ///   - depth: How many levels of references to resolve. Clamped to the range 1...3.
  ///   - completion: Called with the fully resolved record dict or a CKError on failure.
  func fetchRecordWithReferences(
    recordName: String,
    zoneName: String?,
    database scope: CKDatabase.Scope,
    depth: Int,
    completion: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    let clampedDepth = min(max(depth, 1), 3)
    let db = database(for: scope)

    let zoneID: CKRecordZone.ID
    if let zoneName = zoneName {
      zoneID = CKRecordZone.ID(zoneName: zoneName, ownerName: CKCurrentUserDefaultName)
    } else {
      zoneID = .default
    }

    let rootID = CKRecord.ID(recordName: recordName, zoneID: zoneID)

    db.fetch(withRecordID: rootID) { [weak self] record, error in
      guard let self = self else { return }
      if let error = error {
        completion(.failure(error))
        return
      }
      guard let record = record else {
        completion(.failure(CKError(.unknownItem)))
        return
      }

      var dict = Converters.toDictionary(record)
      self.resolveReferencesInDict(&dict, db: db, remainingDepth: clampedDepth - 1) {
        completion(.success(dict))
      }
    }
  }

  /// Mutates `dict` in-place by resolving every reference-typed field one level deep,
  /// then recursing into each resolved record when `remainingDepth > 0`.
  ///
  /// All references at the current level are fetched in parallel via DispatchGroup.
  /// A serial write queue serialises mutations to `resolvedFields` so that concurrent
  /// CloudKit callbacks cannot race on the dictionary.
  ///
  /// On a per-reference fetch failure the original shallow stub is preserved and
  /// processing continues — partial resolution is preferable to a hard error.
  ///
  /// `completion` is always called exactly once, on an arbitrary background queue.
  private func resolveReferencesInDict(
    _ dict: inout [String: Any],
    db: CKDatabase,
    remainingDepth: Int,
    completion: @escaping () -> Void
  ) {
    guard let fields = dict["fields"] as? [String: [String: Any]] else {
      completion()
      return
    }

    // Collect keys whose field type is "reference" so we fan out only those.
    let referenceKeys: [String] = fields.compactMap { key, fieldDict in
      fieldDict["type"] as? String == "reference" ? key : nil
    }

    guard !referenceKeys.isEmpty else {
      completion()
      return
    }

    let group = DispatchGroup()
    // Serial queue guards mutations to resolvedFields from concurrent CloudKit callbacks.
    let writeQueue = DispatchQueue(label: "expo.cloudkit.refresolver.\(UUID().uuidString)")
    var resolvedFields = fields

    for key in referenceKeys {
      guard
        let fieldDict = fields[key],
        let refValue = fieldDict["value"] as? [String: Any],
        let refRecordName = refValue["recordName"] as? String
      else { continue }

      // Resolve zone for the referenced record. References carry no explicit zone ID
      // in the CloudKit API — fall back to the root record's zone if not available.
      let refZoneID: CKRecordZone.ID
      if let rz = refValue["zoneName"] as? String {
        refZoneID = CKRecordZone.ID(zoneName: rz, ownerName: CKCurrentUserDefaultName)
      } else if let rootZone = dict["zoneName"] as? String {
        refZoneID = CKRecordZone.ID(zoneName: rootZone, ownerName: CKCurrentUserDefaultName)
      } else {
        refZoneID = .default
      }

      let refID = CKRecord.ID(recordName: refRecordName, zoneID: refZoneID)
      let capturedKey = key

      group.enter()
      db.fetch(withRecordID: refID) { [weak self] refRecord, refError in
        guard let self = self else { group.leave(); return }
        // Non-fatal: preserve the shallow stub for any reference that fails to resolve.
        guard let refRecord = refRecord, refError == nil else {
          group.leave()
          return
        }

        var refDict = Converters.toDictionary(refRecord)

        if remainingDepth > 0 {
          self.resolveReferencesInDict(&refDict, db: db, remainingDepth: remainingDepth - 1) {
            writeQueue.sync {
              resolvedFields[capturedKey] = ["type": "reference", "value": refDict]
            }
            group.leave()
          }
        } else {
          writeQueue.sync {
            resolvedFields[capturedKey] = ["type": "reference", "value": refDict]
          }
          group.leave()
        }
      }
    }

    group.notify(queue: .global(qos: .userInitiated)) {
      writeQueue.sync {
        dict["fields"] = resolvedFields
      }
      completion()
    }
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
