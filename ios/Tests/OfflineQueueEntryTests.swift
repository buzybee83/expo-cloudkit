import XCTest
@testable import ExpoCloudKit

// MARK: - OfflineQueueEntryTests

/// Tests for OfflineQueueEntry's Codable conformance and toDictionary() bridge output.
///
/// All tests are pure in-memory — no file system, no CloudKit, no network.
final class OfflineQueueEntryTests: XCTestCase {

  // MARK: - Helpers

  /// Returns a fully-populated entry with deterministic values so we can assert
  /// exact field values after encode/decode.
  private func makeEntry(
    id: String = "test-id-1234",
    operation: String = "save",
    database: String = "private",
    recordData: [String: Any] = ["recordType": "Note", "title": "Hello"],
    createdAt: Date = Date(timeIntervalSince1970: 1_700_000_000),
    retryCount: Int = 2,
    nextRetryAt: Date = Date(timeIntervalSince1970: 1_700_000_020),
    lastErrorCode: String? = "NETWORK_UNAVAILABLE",
    status: String = "retrying"
  ) -> OfflineQueueEntry {
    OfflineQueueEntry(
      id: id,
      operation: operation,
      database: database,
      recordData: recordData,
      createdAt: createdAt,
      retryCount: retryCount,
      nextRetryAt: nextRetryAt,
      lastErrorCode: lastErrorCode,
      status: status
    )
  }

  // MARK: - Default init values

  func test_defaultInit_status_isPending() {
    let entry = OfflineQueueEntry(operation: "save", database: "private", recordData: [:])
    XCTAssertEqual(entry.status, "pending")
  }

  func test_defaultInit_retryCount_isZero() {
    let entry = OfflineQueueEntry(operation: "save", database: "private", recordData: [:])
    XCTAssertEqual(entry.retryCount, 0)
  }

  func test_defaultInit_lastErrorCode_isNil() {
    let entry = OfflineQueueEntry(operation: "save", database: "private", recordData: [:])
    XCTAssertNil(entry.lastErrorCode)
  }

  func test_defaultInit_idIsNonEmpty() {
    let entry = OfflineQueueEntry(operation: "save", database: "private", recordData: [:])
    XCTAssertFalse(entry.id.isEmpty)
  }

  func test_defaultInit_nextRetryAt_isDistantPast() {
    let entry = OfflineQueueEntry(operation: "save", database: "private", recordData: [:])
    XCTAssertEqual(entry.nextRetryAt, Date.distantPast)
  }

  // MARK: - Codable round-trip

  func test_codableRoundTrip_preservesId() throws {
    let original = makeEntry()
    let decoded = try roundTrip(original)
    XCTAssertEqual(decoded.id, original.id)
  }

  func test_codableRoundTrip_preservesOperation() throws {
    let original = makeEntry(operation: "delete")
    let decoded = try roundTrip(original)
    XCTAssertEqual(decoded.operation, "delete")
  }

  func test_codableRoundTrip_preservesDatabase() throws {
    let original = makeEntry(database: "shared")
    let decoded = try roundTrip(original)
    XCTAssertEqual(decoded.database, "shared")
  }

  func test_codableRoundTrip_preservesStatus() throws {
    let original = makeEntry(status: "retrying")
    let decoded = try roundTrip(original)
    XCTAssertEqual(decoded.status, "retrying")
  }

  func test_codableRoundTrip_preservesRetryCount() throws {
    let original = makeEntry(retryCount: 7)
    let decoded = try roundTrip(original)
    XCTAssertEqual(decoded.retryCount, 7)
  }

  func test_codableRoundTrip_preservesLastErrorCode() throws {
    let original = makeEntry(lastErrorCode: "QUOTA_EXCEEDED")
    let decoded = try roundTrip(original)
    XCTAssertEqual(decoded.lastErrorCode, "QUOTA_EXCEEDED")
  }

  func test_codableRoundTrip_preservesNilLastErrorCode() throws {
    let original = makeEntry(lastErrorCode: nil)
    let decoded = try roundTrip(original)
    XCTAssertNil(decoded.lastErrorCode)
  }

  func test_codableRoundTrip_preservesCreatedAt() throws {
    let date = Date(timeIntervalSince1970: 1_700_000_000)
    let original = makeEntry(createdAt: date)
    let decoded = try roundTrip(original)
    XCTAssertEqual(
      decoded.createdAt.timeIntervalSince1970,
      date.timeIntervalSince1970,
      accuracy: 0.001
    )
  }

  func test_codableRoundTrip_preservesNextRetryAt() throws {
    let date = Date(timeIntervalSince1970: 1_700_000_999)
    let original = makeEntry(nextRetryAt: date)
    let decoded = try roundTrip(original)
    XCTAssertEqual(
      decoded.nextRetryAt.timeIntervalSince1970,
      date.timeIntervalSince1970,
      accuracy: 0.001
    )
  }

  // MARK: - recordData encoding/decoding

  func test_codableRoundTrip_recordData_stringValue() throws {
    let data: [String: Any] = ["recordType": "Note", "title": "Hello"]
    let original = makeEntry(recordData: data)
    let decoded = try roundTrip(original)
    XCTAssertEqual(decoded.recordData["recordType"] as? String, "Note")
    XCTAssertEqual(decoded.recordData["title"] as? String, "Hello")
  }

  func test_codableRoundTrip_recordData_intValue() throws {
    let data: [String: Any] = ["count": 42]
    let original = makeEntry(recordData: data)
    let decoded = try roundTrip(original)
    // JSON numbers are decoded as NSNumber — use Double comparison for robustness
    let value = (decoded.recordData["count"] as? NSNumber)?.intValue
    XCTAssertEqual(value, 42)
  }

  func test_codableRoundTrip_recordData_doubleValue() throws {
    let data: [String: Any] = ["score": 3.14]
    let original = makeEntry(recordData: data)
    let decoded = try roundTrip(original)
    let value = (decoded.recordData["score"] as? NSNumber)?.doubleValue
    XCTAssertNotNil(value)
    XCTAssertEqual(value!, 3.14, accuracy: 0.0001)
  }

  func test_codableRoundTrip_recordData_nestedDict() throws {
    let data: [String: Any] = [
      "fields": [
        "title": ["type": "string", "value": "Deep"],
        "count": ["type": "number", "value": 7]
      ] as [String: Any]
    ]
    let original = makeEntry(recordData: data)
    let decoded = try roundTrip(original)
    let fields = decoded.recordData["fields"] as? [String: Any]
    XCTAssertNotNil(fields)
    let titleField = fields?["title"] as? [String: Any]
    XCTAssertEqual(titleField?["value"] as? String, "Deep")
  }

  func test_codableRoundTrip_emptyRecordData() throws {
    let original = makeEntry(recordData: [:])
    let decoded = try roundTrip(original)
    XCTAssertTrue(decoded.recordData.isEmpty)
  }

  // MARK: - toDictionary

  func test_toDictionary_id() {
    let entry = makeEntry(id: "fixed-id-abc")
    let dict = entry.toDictionary()
    XCTAssertEqual(dict["id"] as? String, "fixed-id-abc")
  }

  func test_toDictionary_operation() {
    let entry = makeEntry(operation: "delete")
    let dict = entry.toDictionary()
    XCTAssertEqual(dict["operation"] as? String, "delete")
  }

  func test_toDictionary_database() {
    let entry = makeEntry(database: "public")
    let dict = entry.toDictionary()
    XCTAssertEqual(dict["database"] as? String, "public")
  }

  func test_toDictionary_status() {
    let entry = makeEntry(status: "failed")
    let dict = entry.toDictionary()
    XCTAssertEqual(dict["status"] as? String, "failed")
  }

  func test_toDictionary_retryCount() {
    let entry = makeEntry(retryCount: 5)
    let dict = entry.toDictionary()
    XCTAssertEqual(dict["retryCount"] as? Int, 5)
  }

  func test_toDictionary_createdAt_isUnixMilliseconds() {
    let knownDate = Date(timeIntervalSince1970: 1_000.0)
    let entry = makeEntry(createdAt: knownDate)
    let dict = entry.toDictionary()
    let ms = dict["createdAt"] as? Double
    XCTAssertNotNil(ms)
    // 1_000 seconds * 1_000 = 1_000_000 ms
    XCTAssertEqual(ms!, 1_000_000.0, accuracy: 1.0)
  }

  func test_toDictionary_nextRetryAt_isUnixMilliseconds() {
    let knownDate = Date(timeIntervalSince1970: 2_000.0)
    let entry = makeEntry(nextRetryAt: knownDate)
    let dict = entry.toDictionary()
    let ms = dict["nextRetryAt"] as? Double
    XCTAssertNotNil(ms)
    XCTAssertEqual(ms!, 2_000_000.0, accuracy: 1.0)
  }

  func test_toDictionary_lastErrorCode_presentWhenSet() {
    let entry = makeEntry(lastErrorCode: "NOT_AUTHENTICATED")
    let dict = entry.toDictionary()
    XCTAssertEqual(dict["lastErrorCode"] as? String, "NOT_AUTHENTICATED")
  }

  func test_toDictionary_lastErrorCode_absentWhenNil() {
    let entry = makeEntry(lastErrorCode: nil)
    let dict = entry.toDictionary()
    XCTAssertNil(dict["lastErrorCode"])
  }

  // MARK: - Multiple encode/decode cycles

  func test_codableRoundTrip_isIdempotent() throws {
    let original = makeEntry()
    // Double round-trip: encode → decode → encode → decode
    let once = try roundTrip(original)
    let twice = try roundTrip(once)
    XCTAssertEqual(twice.id, original.id)
    XCTAssertEqual(twice.status, original.status)
    XCTAssertEqual(twice.retryCount, original.retryCount)
    XCTAssertEqual(twice.recordData["recordType"] as? String,
                   original.recordData["recordType"] as? String)
  }

  // MARK: - Private helper

  private func roundTrip(_ entry: OfflineQueueEntry) throws -> OfflineQueueEntry {
    let data = try JSONEncoder().encode(entry)
    return try JSONDecoder().decode(OfflineQueueEntry.self, from: data)
  }
}
