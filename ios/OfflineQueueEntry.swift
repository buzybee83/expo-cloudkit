import Foundation

// MARK: - OfflineQueueEntry

/// A single pending CloudKit operation persisted in the offline queue.
///
/// `recordData` is a `[String: Any]` that cannot be Codable-synthesised,
/// so we encode it manually as a base64 JSON blob via JSONSerialization.
struct OfflineQueueEntry {

  // MARK: - Properties

  let id: String
  let operation: String   // "save" | "delete"
  let database: String    // "private" | "shared" | "public"
  let recordData: [String: Any]
  let createdAt: Date
  var retryCount: Int
  var nextRetryAt: Date
  var lastErrorCode: String?
  var status: String      // "pending" | "retrying" | "failed"

  // MARK: - Init

  init(
    id: String = UUID().uuidString,
    operation: String,
    database: String,
    recordData: [String: Any],
    createdAt: Date = Date(),
    retryCount: Int = 0,
    nextRetryAt: Date = Date.distantPast,
    lastErrorCode: String? = nil,
    status: String = "pending"
  ) {
    self.id = id
    self.operation = operation
    self.database = database
    self.recordData = recordData
    self.createdAt = createdAt
    self.retryCount = retryCount
    self.nextRetryAt = nextRetryAt
    self.lastErrorCode = lastErrorCode
    self.status = status
  }

  // MARK: - JS Bridge

  func toDictionary() -> [String: Any] {
    var dict: [String: Any] = [
      "id":          id,
      "operation":   operation,
      "database":    database,
      "createdAt":   createdAt.timeIntervalSince1970 * 1000,
      "retryCount":  retryCount,
      "nextRetryAt": nextRetryAt.timeIntervalSince1970 * 1000,
      "status":      status
    ]
    if let code = lastErrorCode { dict["lastErrorCode"] = code }
    return dict
  }
}

// MARK: - Codable

extension OfflineQueueEntry: Codable {

  private enum CodingKeys: String, CodingKey {
    case id, operation, database, recordDataJSON
    case createdAt, retryCount, nextRetryAt, lastErrorCode, status
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id,                                forKey: .id)
    try c.encode(operation,                          forKey: .operation)
    try c.encode(database,                           forKey: .database)
    try c.encode(createdAt.timeIntervalSince1970,    forKey: .createdAt)
    try c.encode(retryCount,                         forKey: .retryCount)
    try c.encode(nextRetryAt.timeIntervalSince1970,  forKey: .nextRetryAt)
    try c.encodeIfPresent(lastErrorCode,             forKey: .lastErrorCode)
    try c.encode(status,                             forKey: .status)
    let json = try JSONSerialization.data(withJSONObject: recordData)
    try c.encode(json.base64EncodedString(),          forKey: .recordDataJSON)
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id            = try c.decode(String.self, forKey: .id)
    operation     = try c.decode(String.self, forKey: .operation)
    database      = try c.decode(String.self, forKey: .database)
    retryCount    = try c.decode(Int.self,    forKey: .retryCount)
    lastErrorCode = try c.decodeIfPresent(String.self, forKey: .lastErrorCode)
    status        = try c.decode(String.self, forKey: .status)
    createdAt   = Date(timeIntervalSince1970: try c.decode(Double.self, forKey: .createdAt))
    nextRetryAt  = Date(timeIntervalSince1970: try c.decode(Double.self, forKey: .nextRetryAt))
    let b64 = try c.decode(String.self, forKey: .recordDataJSON)
    if let data = Data(base64Encoded: b64),
       let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      recordData = dict
    } else {
      recordData = [:]
    }
  }
}
