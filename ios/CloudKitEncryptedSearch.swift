import CloudKit
import Foundation

/// Lightweight client-side search index for encrypted CloudKit fields.
///
/// CloudKit cannot execute server-side queries against encrypted values stored
/// in `CKRecord.encryptedValues`. This helper maintains a per-zone inverted
/// index so that JS callers can perform full-text search over encrypted content
/// entirely on-device.
///
/// ## Index storage
/// One `_SearchIndex` record is kept per zone (identified by `recordName =
/// "_searchIndex_\(zoneName)"`). The record holds a single `indexJSON` string
/// field that serialises the inverted map as `{ "<token>": ["<recordName>", ...] }`.
///
/// The index record is stored in the **regular** (non-encrypted) portion of
/// the record so it can be fetched quickly. It contains only lowercased tokens
/// extracted from the original plaintext — not the plaintext values — so it
/// does not reveal the encrypted content to unauthorised readers.
///
/// ## Thread safety
/// All public methods are safe to call from any queue. Index mutations are
/// serialised through the private `queue` barrier.
final class CloudKitEncryptedSearch {

  // MARK: - Properties

  private let database: CKDatabase
  private let zone: CKRecordZone.ID

  /// The fixed recordName used for this zone's index record.
  private var indexRecordName: String {
    "_searchIndex_\(zone.zoneName)"
  }

  /// Serial queue that serialises read-modify-write cycles on the index.
  private let queue = DispatchQueue(
    label: "expo-cloudkit.encrypted-search",
    attributes: .concurrent
  )

  // MARK: - Init

  init(container: CKContainer, database: CKDatabase, zone: CKRecordZone.ID) {
    self.database = database
    self.zone = zone
  }

  // MARK: - Public API

  /// Adds `recordName` to the inverted index for each token in `encryptedTextValues`.
  ///
  /// Call this **after** saving the encrypted record but **before** returning to JS,
  /// so the index is always consistent with the stored record set.
  ///
  /// - Parameters:
  ///   - recordName:            The `CKRecord.ID.recordName` of the indexed record.
  ///   - encryptedTextValues:   Plaintext strings to tokenise and index.
  ///   - completion:            Called on an arbitrary queue. `nil` on success.
  func index(
    recordName: String,
    encryptedTextValues: [String],
    completion: @escaping (Error?) -> Void
  ) {
    let newTokens = encryptedTextValues
      .flatMap { tokenize($0) }
      .reduce(into: Set<String>()) { $0.insert($1) }

    loadIndex { [weak self] result in
      guard let self = self else { return }
      switch result {
      case .failure(let error):
        completion(error)
      case .success(var index):
        for token in newTokens {
          var records = index[token] ?? []
          if !records.contains(recordName) {
            records.append(recordName)
          }
          index[token] = records
        }
        self.saveIndex(index, completion: completion)
      }
    }
  }

  /// Removes all index entries that reference `recordName`.
  ///
  /// Safe to call even if the record was never indexed — a no-op in that case.
  ///
  /// - Parameters:
  ///   - recordName: The `CKRecord.ID.recordName` to remove.
  ///   - completion: Called on an arbitrary queue. `nil` on success.
  func deindex(
    recordName: String,
    completion: @escaping (Error?) -> Void
  ) {
    loadIndex { [weak self] result in
      guard let self = self else { return }
      switch result {
      case .failure(let error):
        completion(error)
      case .success(var index):
        var modified = false
        for token in index.keys {
          let before = index[token] ?? []
          let after = before.filter { $0 != recordName }
          if after.count != before.count {
            if after.isEmpty {
              index.removeValue(forKey: token)
            } else {
              index[token] = after
            }
            modified = true
          }
        }
        // Only round-trip a save if we actually changed anything.
        guard modified else {
          completion(nil)
          return
        }
        self.saveIndex(index, completion: completion)
      }
    }
  }

  /// Searches the index for records whose indexed content contained **all** of
  /// the tokens produced by tokenising `query`.
  ///
  /// Empty queries return an empty array rather than all records.
  ///
  /// - Parameters:
  ///   - query:      The search string. Tokenised with the same rules as `index()`.
  ///   - completion: Called on an arbitrary queue with the matched `recordName` array.
  func search(
    query: String,
    completion: @escaping (Result<[String], Error>) -> Void
  ) {
    let queryTokens = tokenize(query)
    guard !queryTokens.isEmpty else {
      completion(.success([]))
      return
    }

    loadIndex { result in
      switch result {
      case .failure(let error):
        completion(.failure(error))
      case .success(let index):
        // Intersect the record-name sets for each query token.
        var matchSets: [Set<String>] = []
        for token in queryTokens {
          let records = Set(index[token] ?? [])
          matchSets.append(records)
        }
        // All tokens must match (AND semantics).
        guard let first = matchSets.first else {
          completion(.success([]))
          return
        }
        let intersection = matchSets.dropFirst().reduce(first) { $0.intersection($1) }
        completion(.success(Array(intersection).sorted()))
      }
    }
  }

  // MARK: - Tokenisation

  /// Lowercases `text`, splits on whitespace and punctuation, and filters tokens
  /// shorter than 2 characters. Returns a `Set` so duplicates are collapsed.
  private func tokenize(_ text: String) -> Set<String> {
    let lower = text.lowercased()
    // Split on any character that is not a letter or digit (Unicode-aware).
    let separators = CharacterSet.alphanumerics.inverted
    let raw = lower.components(separatedBy: separators)
    return Set(raw.filter { $0.count >= 2 })
  }

  // MARK: - Index persistence

  /// Fetches the `_SearchIndex` record from CloudKit and deserialises the JSON blob.
  /// Returns an empty dictionary if no index record has been written yet.
  private func loadIndex(
    completion: @escaping (Result<[String: [String]], Error>) -> Void
  ) {
    let recordID = CKRecord.ID(recordName: indexRecordName, zoneID: zone)
    let operation = CKFetchRecordsOperation(recordIDs: [recordID])
    operation.desiredKeys = ["indexJSON"]
    operation.fetchRecordsResultBlock = { result in
      switch result {
      case .failure(let error):
        let ckError = error as? CKError
        // A missing record is normal on first use — return an empty index.
        if ckError?.code == .unknownItem {
          completion(.success([:]))
        } else {
          completion(.failure(error))
        }
      case .success:
        // The per-record block below will have populated our local variable.
        break
      }
    }

    // Collect the per-record result before the completion block fires.
    var fetchedIndex: [String: [String]] = [:]
    var fetchError: Error?

    operation.perRecordResultBlock = { _, result in
      switch result {
      case .failure(let err):
        let ckErr = err as? CKError
        if ckErr?.code != .unknownItem {
          fetchError = err
        }
        // .unknownItem → first-run, leave fetchedIndex empty.
      case .success(let record):
        guard
          let jsonString = record["indexJSON"] as? String,
          let data = jsonString.data(using: .utf8),
          let decoded = try? JSONSerialization.jsonObject(with: data) as? [String: [String]]
        else {
          // Corrupt or missing JSON — treat as an empty index.
          return
        }
        fetchedIndex = decoded
      }
    }

    // Override the result block to use the per-record data.
    operation.fetchRecordsResultBlock = { result in
      if let error = fetchError {
        completion(.failure(error))
        return
      }
      switch result {
      case .failure(let error):
        let ckError = error as? CKError
        if ckError?.code == .unknownItem {
          completion(.success([:]))
        } else {
          completion(.failure(error))
        }
      case .success:
        completion(.success(fetchedIndex))
      }
    }

    database.add(operation)
  }

  /// Serialises `index` to JSON and saves (or updates) the `_SearchIndex` record.
  private func saveIndex(
    _ index: [String: [String]],
    completion: @escaping (Error?) -> Void
  ) {
    guard
      let data = try? JSONSerialization.data(withJSONObject: index),
      let jsonString = String(data: data, encoding: .utf8)
    else {
      completion(EncryptedSearchSerializationError())
      return
    }

    let recordID = CKRecord.ID(recordName: indexRecordName, zoneID: zone)
    let record = CKRecord(recordType: "_SearchIndex", recordID: recordID)
    record["indexJSON"] = jsonString as CKRecordValue

    let operation = CKModifyRecordsOperation(recordsToSave: [record], recordIDsToDelete: nil)
    operation.savePolicy = .allKeys
    operation.modifyRecordsResultBlock = { result in
      switch result {
      case .success:
        completion(nil)
      case .failure(let error):
        completion(error)
      }
    }
    database.add(operation)
  }
}

// MARK: - Error types

/// Thrown when the in-memory index dictionary cannot be serialised to JSON.
/// This should never happen in practice since the dictionary only contains
/// `String` keys and `[String]` values, which are always JSON-serialisable.
class EncryptedSearchSerializationError: NSError {
  init() {
    super.init(
      domain: "ExpoCloudKit.EncryptedSearch",
      code: 1001,
      userInfo: [NSLocalizedDescriptionKey: "Failed to serialise the search index to JSON."]
    )
  }
  required init?(coder: NSCoder) { nil }
}
