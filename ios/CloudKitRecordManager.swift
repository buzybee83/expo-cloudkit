import CloudKit
import Foundation

// MARK: - Rate-limit retry helper (I.1)

/// CloudKit error codes that signal the caller should back off and retry.
private let retryableCKErrorCodes: Set<CKError.Code> = [
  .requestRateLimited,
  .serviceUnavailable,
  .zoneBusy
]

/// Executes `operation` up to `maxRetries` additional times.
///
/// When CloudKit returns a retryable error (`.requestRateLimited`,
/// `.serviceUnavailable`, or `.zoneBusy`) the wrapper reads
/// `CKErrorRetryAfterKey` from the error's userInfo (defaulting to 5 s when
/// absent), invokes `onRateLimited` so the module can emit an event to JS,
/// then sleeps for that duration using `Task.sleep(nanoseconds:)` — which is
/// actor-safe and never blocks a thread. After exhausting all retries the
/// original error is rethrown.
///
/// - Parameters:
///   - maxRetries:      Maximum number of additional attempts (default 3).
///   - operationName:   Human-readable label surfaced in `onRateLimited` events.
///   - onRateLimited:   Called before each retry with `(retryAfterSeconds, retryCount)`.
///   - operation:       The async throwing closure to retry.
func withRetry<T>(
  maxRetries: Int = 3,
  operationName: String = "unknown",
  onRateLimited: ((Double, Int) -> Void)? = nil,
  operation: @escaping () async throws -> T
) async throws -> T {
  var attempt = 0
  while true {
    do {
      return try await operation()
    } catch let error as CKError
      where retryableCKErrorCodes.contains(error.code) && attempt < maxRetries {
      attempt += 1
      let delay = (error.userInfo[CKErrorRetryAfterKey] as? Double) ?? 5.0
      onRateLimited?(delay, attempt)
      let nanoseconds = UInt64(delay * 1_000_000_000)
      try await Task.sleep(nanoseconds: nanoseconds)
    }
    // All other errors and exhausted-retry paths fall through and rethrow.
  }
}

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

  /// UserDefaults key prefix used by cursor persistence (H.5).
  /// Each persisted cursor is stored at "\(prefix)\(token)" so that all
  /// expo-cloudkit cursor entries can be enumerated and cleared atomically.
  private static let cursorDefaultsPrefix = "expo.cloudkit.cursor."

  // MARK: - Operation Configuration

  /// Applies optional JS-provided operation configuration to any CKOperation.
  ///
  /// Accepted keys in `config`:
  ///   - `qos`     (String): "userInitiated" | "utility" | "background" | "default"
  ///   - `timeout` (Double): request timeout in seconds
  ///
  /// When `config` is nil this is a no-op, so callers never need to guard before
  /// calling it.
  static func applyConfig(_ config: [String: Any]?, to operation: CKOperation) {
    guard let config = config else { return }
    if let qosString = config["qos"] as? String {
      switch qosString {
      case "userInitiated": operation.configuration.qualityOfService = .userInitiated
      case "utility":       operation.configuration.qualityOfService = .utility
      case "background":    operation.configuration.qualityOfService = .background
      default:              operation.configuration.qualityOfService = .default
      }
    }
    if let timeout = config["timeout"] as? Double {
      operation.configuration.timeoutIntervalForRequest = timeout
    }
  }

  // MARK: - Properties

  private let ckContainer: CKContainer

  // In-memory cursor store for pagination between queryRecords calls.
  // Key: opaque token string produced by queryRecords; Value: CKQueryOperation.Cursor
  private var cursorStore: [String: CKQueryOperation.Cursor] = [:]

  /// Optional hook called by `withRetry` before each automatic retry.
  /// The module sets this callback in `configure()` so it can emit
  /// `onRateLimited` events to JavaScript with full context.
  var onRateLimited: ((_ retryAfterSeconds: Double, _ operationName: String, _ retryCount: Int) -> Void)?

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
    operationConfig: [String: Any]? = nil,
    progressHandler: ((_ completed: Int, _ total: Int, _ recordName: String) -> Void)? = nil,
    completion: @escaping (Result<[CKRecord], Error>) -> Void
  ) {
    guard records.count > 0 else {
      completion(.success([]))
      return
    }

    let db = database(for: scope)
    Task {
      do {
        let saved = try await withRetry(operationName: "saveRecords", onRateLimited: makeRateLimitedCallback("saveRecords")) {
          try await self.saveRecordsChunked(records, in: db, operationConfig: operationConfig, progressHandler: progressHandler)
        }
        completion(.success(saved))
      } catch {
        completion(.failure(error))
      }
    }
  }

  /// Async inner implementation: chunks records into 400-record batches and
  /// dispatches them serially. Throws on the first operation-level or per-record
  /// error. Called exclusively by `saveRecords` via the `withRetry` wrapper.
  private func saveRecordsChunked(
    _ records: [CKRecord],
    in db: CKDatabase,
    operationConfig: [String: Any]?,
    progressHandler: ((_ completed: Int, _ total: Int, _ recordName: String) -> Void)?
  ) async throws -> [CKRecord] {
    let total = records.count
    let chunks = stride(from: 0, to: total, by: CloudKitRecordManager.batchSize).map { start -> [CKRecord] in
      let end = min(start + CloudKitRecordManager.batchSize, total)
      return Array(records[start..<end])
    }

    var completedCount = 0
    var allSaved: [CKRecord] = []
    allSaved.reserveCapacity(total)

    for chunk in chunks {
      let chunkResult: [CKRecord] = try await withCheckedThrowingContinuation { continuation in
        var chunkSaved: [CKRecord] = []
        var firstError: Error?

        let operation = CKModifyRecordsOperation(
          recordsToSave: chunk,
          recordIDsToDelete: nil
        )
        operation.qualityOfService = .userInitiated
        operation.savePolicy = .changedKeys
        CloudKitRecordManager.applyConfig(operationConfig, to: operation)

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
              continuation.resume(throwing: error)
            } else {
              continuation.resume(returning: chunkSaved)
            }
          case .failure(let error):
            continuation.resume(throwing: error)
          }
        }

        db.add(operation)
      }
      allSaved.append(contentsOf: chunkResult)
    }

    return allSaved
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
    operationConfig: [String: Any]? = nil,
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

    Task {
      do {
        let record = try await withRetry(operationName: "fetchRecord", onRateLimited: makeRateLimitedCallback("fetchRecord")) {
          try await self.fetchRecordAsync(recordID: recordID, desiredKeys: desiredKeys, operationConfig: operationConfig, in: db)
        }
        completion(.success(record))
      } catch {
        completion(.failure(error))
      }
    }
  }

  private func fetchRecordAsync(
    recordID: CKRecord.ID,
    desiredKeys: [String]?,
    operationConfig: [String: Any]?,
    in db: CKDatabase
  ) async throws -> CKRecord {
    try await withCheckedThrowingContinuation { continuation in
      let operation = CKFetchRecordsOperation(recordIDs: [recordID])
      operation.qualityOfService = .userInitiated
      if let desiredKeys = desiredKeys {
        operation.desiredKeys = desiredKeys
      }
      CloudKitRecordManager.applyConfig(operationConfig, to: operation)

      operation.perRecordResultBlock = { _, result in
        switch result {
        case .success(let record):
          continuation.resume(returning: record)
        case .failure(let error):
          continuation.resume(throwing: error)
        }
      }

      db.add(operation)
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
    desiredKeys: [CKRecord.FieldKey]? = nil,
    operationConfig: [String: Any]? = nil,
    completion: @escaping (Result<([CKRecord], CKQueryOperation.Cursor?), Error>) -> Void
  ) {
    let db = database(for: scope)
    let zoneID: CKRecordZone.ID? = zoneName.map {
      CKRecordZone.ID(zoneName: $0, ownerName: CKCurrentUserDefaultName)
    }

    Task {
      do {
        let result = try await withRetry(operationName: "queryRecords", onRateLimited: makeRateLimitedCallback("queryRecords")) {
          try await self.queryRecordsAsync(
            recordType: recordType,
            predicate: predicate,
            sortDescriptors: sortDescriptors,
            zoneID: zoneID,
            resultsLimit: resultsLimit,
            cursor: cursor,
            desiredKeys: desiredKeys,
            operationConfig: operationConfig,
            in: db
          )
        }
        completion(.success(result))
      } catch {
        completion(.failure(error))
      }
    }
  }

  private func queryRecordsAsync(
    recordType: String,
    predicate: NSPredicate,
    sortDescriptors: [NSSortDescriptor]?,
    zoneID: CKRecordZone.ID?,
    resultsLimit: Int,
    cursor: CKQueryOperation.Cursor?,
    desiredKeys: [CKRecord.FieldKey]?,
    operationConfig: [String: Any]?,
    in db: CKDatabase
  ) async throws -> ([CKRecord], CKQueryOperation.Cursor?) {
    try await withCheckedThrowingContinuation { continuation in
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
      CloudKitRecordManager.applyConfig(operationConfig, to: operation)

      operation.recordMatchedBlock = { _, result in
        switch result {
        case .success(let record):
          matchedRecords.append(record)
        case .failure:
          break // individual record errors are non-fatal; surfaced via queryResultBlock
        }
      }

      operation.queryResultBlock = { result in
        switch result {
        case .success(let nextCursor):
          continuation.resume(returning: (matchedRecords, nextCursor))
        case .failure(let error):
          continuation.resume(throwing: error)
        }
      }

      db.add(operation)
    }
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
    operationConfig: [String: Any]? = nil,
    completion: @escaping (Result<Void, Error>) -> Void
  ) {
    guard recordIDs.count > 0 else {
      completion(.success(()))
      return
    }

    let db = database(for: scope)
    Task {
      do {
        try await withRetry(operationName: "deleteRecords", onRateLimited: makeRateLimitedCallback("deleteRecords")) {
          try await self.deleteRecordsChunked(recordIDs, in: db, operationConfig: operationConfig)
        }
        completion(.success(()))
      } catch {
        completion(.failure(error))
      }
    }
  }

  /// Async inner implementation: chunks record IDs into 400-record batches and
  /// dispatches them serially. Throws on the first operation-level error.
  private func deleteRecordsChunked(
    _ recordIDs: [CKRecord.ID],
    in db: CKDatabase,
    operationConfig: [String: Any]?
  ) async throws {
    let total = recordIDs.count
    let chunks = stride(from: 0, to: total, by: CloudKitRecordManager.batchSize).map { start -> [CKRecord.ID] in
      let end = min(start + CloudKitRecordManager.batchSize, total)
      return Array(recordIDs[start..<end])
    }

    for chunk in chunks {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        let operation = CKModifyRecordsOperation(
          recordsToSave: nil,
          recordIDsToDelete: chunk
        )
        operation.qualityOfService = .userInitiated
        CloudKitRecordManager.applyConfig(operationConfig, to: operation)

        operation.modifyRecordsResultBlock = { result in
          switch result {
          case .success:
            continuation.resume()
          case .failure(let error):
            continuation.resume(throwing: error)
          }
        }

        db.add(operation)
      }
    }
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
    operationConfig: [String: Any]? = nil,
    completion: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    let db = database(for: scope)
    let zoneIDs = zoneNames.map {
      CKRecordZone.ID(zoneName: $0, ownerName: CKCurrentUserDefaultName)
    }

    Task {
      do {
        let result = try await withRetry(operationName: "fetchRecordZoneChanges", onRateLimited: makeRateLimitedCallback("fetchRecordZoneChanges")) {
          try await self.fetchRecordZoneChangesAsync(zoneIDs: zoneIDs, desiredKeys: desiredKeys, operationConfig: operationConfig, in: db)
        }
        completion(.success(result))
      } catch {
        completion(.failure(error))
      }
    }
  }

  private func fetchRecordZoneChangesAsync(
    zoneIDs: [CKRecordZone.ID],
    desiredKeys: [CKRecord.FieldKey]?,
    operationConfig: [String: Any]?,
    in db: CKDatabase
  ) async throws -> [String: Any] {
    try await withCheckedThrowingContinuation { continuation in
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
      CloudKitRecordManager.applyConfig(operationConfig, to: operation)

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
          continuation.resume(returning: response)

        case .failure(let error):
          continuation.resume(throwing: error)
        }
      }

      db.add(operation)
    }
  }

  // MARK: - Batch Fetch (I.1)

  /// Fetches multiple records in a single `CKFetchRecordsOperation`.
  ///
  /// Unlike `fetchRecord`, this method does **not** abort on per-record failure.
  /// Each record that cannot be fetched is represented in the returned array
  /// with a `_error: { code, message }` key so the caller can handle partial
  /// results without a second round-trip. The `onRateLimited` event fires before
  /// each automatic retry so callers can surface backoff UX.
  ///
  /// - Parameters:
  ///   - recordIDs:       Tuples of `(name: String, zoneID: CKRecordZone.ID?)`.
  ///                      When `zoneID` is nil the default zone is used.
  ///   - database:        Database scope to fetch from.
  ///   - desiredKeys:     Specific field keys to fetch. Pass nil for all keys.
  ///   - operationConfig: Optional QoS / timeout overrides (same as other methods).
  func batchFetchRecords(
    recordIDs: [(name: String, zoneID: CKRecordZone.ID?)],
    database scope: CKDatabase.Scope,
    desiredKeys: [String]?,
    operationConfig: [String: Any]?
  ) async throws -> [[String: Any]] {
    let db = database(for: scope)
    return try await withRetry(operationName: "batchFetchRecords", onRateLimited: makeRateLimitedCallback("batchFetchRecords")) {
      try await self.batchFetchRecordsAsync(recordIDs: recordIDs, desiredKeys: desiredKeys, operationConfig: operationConfig, in: db)
    }
  }

  private func batchFetchRecordsAsync(
    recordIDs: [(name: String, zoneID: CKRecordZone.ID?)],
    desiredKeys: [String]?,
    operationConfig: [String: Any]?,
    in db: CKDatabase
  ) async throws -> [[String: Any]] {
    try await withCheckedThrowingContinuation { continuation in
      let ckRecordIDs = recordIDs.map { pair -> CKRecord.ID in
        let zoneID = pair.zoneID ?? CKRecordZone.ID.default
        return CKRecord.ID(recordName: pair.name, zoneID: zoneID)
      }

      // Keyed by recordID so we can preserve caller order and surface per-record errors.
      var resultsByID: [CKRecord.ID: [String: Any]] = [:]

      let operation = CKFetchRecordsOperation(recordIDs: ckRecordIDs)
      operation.qualityOfService = .userInitiated
      operation.desiredKeys = desiredKeys
      CloudKitRecordManager.applyConfig(operationConfig, to: operation)

      operation.perRecordResultBlock = { recordID, result in
        switch result {
        case .success(let record):
          resultsByID[recordID] = Converters.toDictionary(record)
        case .failure(let error):
          // Represent per-record failure with a `_error` key so the batch
          // continues and the caller can handle individual failures.
          let bridgedError = Converters.toErrorDict(error)
          resultsByID[recordID] = [
            "recordName": recordID.recordName,
            "zoneName": recordID.zoneID.zoneName,
            "_error": bridgedError
          ]
        }
      }

      operation.fetchRecordsResultBlock = { result in
        switch result {
        case .success:
          // Preserve the original caller-supplied ordering.
          let ordered = ckRecordIDs.compactMap { resultsByID[$0] }
          continuation.resume(returning: ordered)
        case .failure(let error):
          continuation.resume(throwing: error)
        }
      }

      db.add(operation)
    }
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

      let dict = Converters.toDictionary(record)
      self.resolveReferencesInDict(dict, db: db, remainingDepth: clampedDepth - 1) { resolvedDict in
        completion(.success(resolvedDict))
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
  // NOTE: dict is passed by value (not inout) to allow capture in @escaping closures
  // (Xcode 16 / Swift 6 forbids capturing inout parameters in escaping closures).
  // The resolved copy is returned via the completion handler.
  private func resolveReferencesInDict(
    _ dict: [String: Any],
    db: CKDatabase,
    remainingDepth: Int,
    completion: @escaping ([String: Any]) -> Void
  ) {
    guard let fields = dict["fields"] as? [String: [String: Any]] else {
      completion(dict)
      return
    }

    // Collect keys whose field type is "reference" so we fan out only those.
    let referenceKeys: [String] = fields.compactMap { key, fieldDict in
      fieldDict["type"] as? String == "reference" ? key : nil
    }

    guard !referenceKeys.isEmpty else {
      completion(dict)
      return
    }

    let group = DispatchGroup()
    // Serial queue guards mutations to resolvedFields from concurrent CloudKit callbacks.
    let writeQueue = DispatchQueue(label: "expo.cloudkit.refresolver.\(UUID().uuidString)")
    var resolvedFields = fields
    var mutableDict = dict

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

        let refDict = Converters.toDictionary(refRecord)

        if remainingDepth > 0 {
          self.resolveReferencesInDict(refDict, db: db, remainingDepth: remainingDepth - 1) { resolvedRefDict in
            writeQueue.sync {
              resolvedFields[capturedKey] = ["type": "reference", "value": resolvedRefDict]
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
        mutableDict["fields"] = resolvedFields
      }
      completion(mutableDict)
    }
  }

  // MARK: - Reference Graph Delete

  /// Deletes a record and all records reachable via its CKRecord.Reference fields,
  /// up to `maxDepth` levels deep (clamped to 1...3).
  ///
  /// Algorithm:
  ///   1. Fetch the root record.
  ///   2. Walk every field typed as `CKRecord.Reference` and collect the referenced IDs.
  ///   3. If `maxDepth > 1`, fetch each referenced record in parallel and repeat
  ///      step 2 for its references, continuing until the depth limit is reached.
  ///   4. Collect all discovered record IDs into a deduplicated set (including the root).
  ///   5. Delete the full set using the existing chunked `deleteRecords` implementation.
  ///
  /// Reference fetch failures (e.g. RECORD_NOT_FOUND) are silently skipped — a missing
  /// referenced record should not block deletion of the records that do exist.
  ///
  /// - Parameters:
  ///   - recordName: The recordName of the root record.
  ///   - recordType: The CloudKit record type of the root record (used only for building
  ///     the fetch ID; not required to match by CloudKit when fetching by ID).
  ///   - zoneName: Optional zone name; nil resolves to the default zone.
  ///   - database: Database scope string ("private" | "shared" | "public").
  ///   - maxDepth: Maximum reference traversal depth. Clamped to the range 1...3.
  ///   - completion: Called with the array of deleted recordName strings, or an error.
  func deleteRecordWithReferences(
    recordName: String,
    recordType: String,
    zoneName: String?,
    database: String,
    maxDepth: Int,
    completion: @escaping (Result<[String], Error>) -> Void
  ) {
    let clampedDepth = min(max(maxDepth, 1), 3)
    let scope = Converters.toDatabaseScope(database)
    let db = self.database(for: scope)

    let zoneID: CKRecordZone.ID
    if let zoneName = zoneName {
      zoneID = CKRecordZone.ID(zoneName: zoneName, ownerName: CKCurrentUserDefaultName)
    } else {
      zoneID = .default
    }

    let rootID = CKRecord.ID(recordName: recordName, zoneID: zoneID)

    // Fetch the root record, then walk the reference graph.
    fetchRecordByID(rootID, db: db) { [weak self] result in
      guard let self = self else { return }
      switch result {
      case .failure(let error):
        completion(.failure(error))
      case .success(let rootRecord):
        // Seed the collection with the root.
        var collectedIDs: Set<CKRecord.ID> = [rootID]

        // Collect IDs directly referenced by rootRecord.
        let directRefs = self.referenceIDs(in: rootRecord)

        if clampedDepth <= 1 || directRefs.isEmpty {
          // No further traversal needed — delete what we have so far.
          collectedIDs.formUnion(directRefs)
          self.deleteRecords(Array(collectedIDs), in: scope) { deleteResult in
            switch deleteResult {
            case .success:
              completion(.success(collectedIDs.map { $0.recordName }))
            case .failure(let error):
              completion(.failure(error))
            }
          }
        } else {
          // Traverse remaining levels (levels 2 and 3).
          self.collectReferenceIDs(
            startingFrom: directRefs,
            db: db,
            remainingDepth: clampedDepth - 1
          ) { deepIDs in
            collectedIDs.formUnion(directRefs)
            collectedIDs.formUnion(deepIDs)
            self.deleteRecords(Array(collectedIDs), in: scope) { deleteResult in
              switch deleteResult {
              case .success:
                completion(.success(collectedIDs.map { $0.recordName }))
              case .failure(let error):
                completion(.failure(error))
              }
            }
          }
        }
      }
    }
  }

  /// Fetches a CKRecord by its ID using CKFetchRecordsOperation.
  ///
  /// Returns only the first result block's outcome (single-record fetch).
  /// This private helper exists so `deleteRecordWithReferences` can reuse
  /// the same underlying operation pattern as `fetchRecord` without duplicating
  /// the desiredKeys / operationConfig wiring that the public method carries.
  private func fetchRecordByID(
    _ recordID: CKRecord.ID,
    db: CKDatabase,
    completion: @escaping (Result<CKRecord, Error>) -> Void
  ) {
    let operation = CKFetchRecordsOperation(recordIDs: [recordID])
    operation.qualityOfService = .userInitiated

    // We only care about reference-typed fields during graph traversal, so
    // fetching all keys is intentional here — we cannot know ahead of time
    // which keys hold references without reading the full record.
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

  /// Recursively collects all `CKRecord.ID`s reachable from `frontier` up to
  /// `remainingDepth` additional levels.
  ///
  /// All records in the frontier are fetched in parallel via `DispatchGroup`.
  /// Fetch failures for individual records are silently skipped so that a
  /// missing referenced record never blocks collection of existing records.
  ///
  /// `completion` is always called exactly once, on an arbitrary background queue.
  private func collectReferenceIDs(
    startingFrom frontier: [CKRecord.ID],
    db: CKDatabase,
    remainingDepth: Int,
    completion: @escaping (_ collected: Set<CKRecord.ID>) -> Void
  ) {
    guard remainingDepth > 0, !frontier.isEmpty else {
      completion([])
      return
    }

    let group = DispatchGroup()
    // Serial write queue prevents data races on `nextFrontier` and `collected`
    // when multiple CloudKit callbacks arrive concurrently.
    let writeQueue = DispatchQueue(label: "expo.cloudkit.refdelete.\(UUID().uuidString)")
    var nextFrontier: [CKRecord.ID] = []
    var collected: Set<CKRecord.ID> = []

    for recordID in frontier {
      group.enter()
      fetchRecordByID(recordID, db: db) { [weak self] result in
        guard let self = self else { group.leave(); return }
        switch result {
        case .failure:
          // Non-fatal — record may have already been deleted or never existed.
          group.leave()
        case .success(let record):
          let refs = self.referenceIDs(in: record)
          writeQueue.sync {
            collected.formUnion(refs)
            nextFrontier.append(contentsOf: refs)
          }
          group.leave()
        }
      }
    }

    group.notify(queue: .global(qos: .userInitiated)) { [weak self] in
      guard let self = self else { completion(collected); return }
      if remainingDepth <= 1 || nextFrontier.isEmpty {
        completion(collected)
      } else {
        // Deduplicate before the next level to avoid redundant fetches.
        let uniqueNextFrontier = writeQueue.sync { Array(Set(nextFrontier)) }
        self.collectReferenceIDs(
          startingFrom: uniqueNextFrontier,
          db: db,
          remainingDepth: remainingDepth - 1
        ) { deeperIDs in
          completion(collected.union(deeperIDs))
        }
      }
    }
  }

  /// Extracts all `CKRecord.ID`s stored in reference-typed fields of a record.
  ///
  /// The zone for each referenced ID is inherited from the root record's zone
  /// when the reference itself does not carry explicit zone information (which
  /// is the normal CloudKit behaviour for same-zone references).
  private func referenceIDs(in record: CKRecord) -> [CKRecord.ID] {
    var ids: [CKRecord.ID] = []
    for key in record.allKeys() {
      if let ref = record[key] as? CKRecord.Reference {
        ids.append(ref.recordID)
      }
    }
    return ids
  }

  // MARK: - Cursor Persistence (H.5)

  /// Persists a `CKQueryOperation.Cursor` to `UserDefaults` under a key derived
  /// from the opaque `token` string handed to JS.
  ///
  /// `NSKeyedArchiver` with `requiringSecureCoding: true` is the only supported
  /// way to serialise a `CKQueryOperation.Cursor` — the type conforms to
  /// `NSSecureCoding`. If archiving fails the cursor is silently dropped;
  /// the in-memory cache entry remains authoritative for the current session.
  ///
  /// This is `internal` (not `private`) so that `ExpoCloudKitModule` can call
  /// it from the module layer after assigning the UUID token to the new cursor.
  func persistCursor(_ cursor: CKQueryOperation.Cursor, forToken token: String) {
    guard let data = try? NSKeyedArchiver.archivedData(
      withRootObject: cursor,
      requiringSecureCoding: true
    ) else { return }
    UserDefaults.standard.set(data, forKey: Self.cursorDefaultsPrefix + token)
  }

  /// Attempts to deserialise a previously persisted cursor from `UserDefaults`.
  ///
  /// Returns `nil` when no persisted entry exists for `token` or when
  /// unarchiving fails (e.g. the cursor has expired on the server since the
  /// last app session — callers should treat nil as "start from the beginning").
  ///
  /// This is `internal` so that `ExpoCloudKitModule` can use it during cursor
  /// resolution when the in-memory cache misses on a cold-start token.
  func loadPersistedCursor(forToken token: String) -> CKQueryOperation.Cursor? {
    guard let data = UserDefaults.standard.data(
      forKey: Self.cursorDefaultsPrefix + token
    ) else { return nil }
    return try? NSKeyedUnarchiver.unarchivedObject(
      ofClass: CKQueryOperation.Cursor.self,
      from: data
    )
  }

  /// Removes all cursor entries written by this module from `UserDefaults`.
  ///
  /// Call from `AsyncFunction("clearPersistedCursors")` in the module layer.
  /// The in-memory cursor cache (`cursorStore`) is NOT cleared here — the module
  /// layer is responsible for clearing that separately if required.
  func clearPersistedCursors() {
    let defaults = UserDefaults.standard
    defaults.dictionaryRepresentation().keys
      .filter { $0.hasPrefix(Self.cursorDefaultsPrefix) }
      .forEach { defaults.removeObject(forKey: $0) }
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

  /// Builds the `onRateLimited` closure for `withRetry` that captures
  /// the operation name and forwards events through the module-level callback.
  ///
  /// Using a weak reference to self avoids a retain cycle if the manager is
  /// replaced (e.g. by a second `configure()` call) while a retry is in flight.
  private func makeRateLimitedCallback(_ operationName: String) -> (Double, Int) -> Void {
    return { [weak self] retryAfterSeconds, retryCount in
      self?.onRateLimited?(retryAfterSeconds, operationName, retryCount)
    }
  }
}
