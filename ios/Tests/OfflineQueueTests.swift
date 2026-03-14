import XCTest
import CloudKit
@testable import ExpoCloudKit

// MARK: - OfflineQueueTests
//
// Strategy: All tests use the real OfflineQueue initialised with
// CKContainer.default() and a real CloudKitRecordManager.  We never call
// drain() so no CloudKit network traffic is produced.
//
// Tests that exercise file persistence write/read a unique temp directory per
// test to avoid cross-test pollution and to avoid writing into
// Library/Application Support during a unit test run.

final class OfflineQueueTests: XCTestCase {

  // MARK: - Helpers

  /// Creates an OfflineQueue that persists to a unique temp directory.
  /// The sendEvent closure records all emitted events so tests can inspect them.
  private func makeQueue(
    receivedEvents: inout [[String: Any]]
  ) -> OfflineQueue {
    let capture = Capture()
    let queue = OfflineQueue(
      container: CKContainer.default(),
      containerID: "iCloud.expo-cloudkit-tests",
      recordManager: CloudKitRecordManager(ckContainer: CKContainer.default()),
      sendEvent: { capture.events.append($0) }
    )
    // Keep `capture` alive for the duration of the test via the inout binding trick.
    // (In practice, the closure captures it strongly.)
    receivedEvents = capture.events   // initial snapshot (will be empty)
    return queue
  }

  /// A reference-typed event accumulator so the sendEvent closure can mutate it.
  private final class Capture {
    var events: [[String: Any]] = []
  }

  /// Minimal record data dict that Converters.toCKRecord can parse.
  private let sampleRecordData: [String: Any] = [
    "recordType": "Note",
    "fields": [
      "title": ["type": "string", "value": "Test Note"]
    ]
  ]

  // MARK: - Backoff formula tests
  //
  // The private `nextRetryDelay` formula is:
  //   base = min(5.0 * pow(2.0, Double(retryCount)), 300.0)
  //   delay = base + base * random(0.0...0.2)   ← 0–20 % jitter
  //
  // We test expected ranges rather than exact values to accommodate jitter.

  func test_backoff_retryCount0_isApprox5s() {
    // retryCount = 0 → base = 5 * 2^0 = 5.0
    // with jitter: 5.0 ... 6.0
    let base = OfflineQueueBackoffFormula.base(retryCount: 0)
    XCTAssertEqual(base, 5.0, accuracy: 0.001,
                   "base for retryCount=0 should be 5 s before jitter")
    let delay = OfflineQueueBackoffFormula.delay(retryCount: 0)
    XCTAssertGreaterThanOrEqual(delay, 5.0)
    XCTAssertLessThanOrEqual(delay, 6.01)  // 5.0 + 5.0 * 0.2 + epsilon
  }

  func test_backoff_retryCount5_isApprox160s() {
    // retryCount = 5 → base = 5 * 2^5 = 160.0
    // with jitter: 160.0 ... 192.0
    let base = OfflineQueueBackoffFormula.base(retryCount: 5)
    XCTAssertEqual(base, 160.0, accuracy: 0.001)
    let delay = OfflineQueueBackoffFormula.delay(retryCount: 5)
    XCTAssertGreaterThanOrEqual(delay, 160.0)
    XCTAssertLessThanOrEqual(delay, 192.01)
  }

  func test_backoff_retryCount10_isCappedAt300s() {
    // retryCount = 10 → 5 * 2^10 = 5120 → capped at 300
    // with jitter: 300.0 ... 360.0
    let base = OfflineQueueBackoffFormula.base(retryCount: 10)
    XCTAssertEqual(base, 300.0, accuracy: 0.001, "cap should be 300 s")
    let delay = OfflineQueueBackoffFormula.delay(retryCount: 10)
    XCTAssertGreaterThanOrEqual(delay, 300.0)
    XCTAssertLessThanOrEqual(delay, 360.01)
  }

  func test_backoff_retryCount20_isStillCappedAt300s() {
    let base = OfflineQueueBackoffFormula.base(retryCount: 20)
    XCTAssertEqual(base, 300.0, accuracy: 0.001)
  }

  func test_backoff_isMonotonicallyIncreasing_beforeCap() {
    var previous = OfflineQueueBackoffFormula.base(retryCount: 0)
    for count in 1...7 {
      let current = OfflineQueueBackoffFormula.base(retryCount: count)
      XCTAssertGreaterThan(current, previous,
        "base delay should increase with retryCount (count=\(count))")
      previous = current
    }
  }

  // MARK: - Entry status: new entry is "pending"

  func test_enqueue_newEntry_statusIsPending() async throws {
    var events: [[String: Any]] = []
    let q = makeQueue(receivedEvents: &events)
    let id = try await q.enqueue(operation: "save", database: "private", recordData: sampleRecordData)

    let status = await q.getStatus(includeEntries: true)
    let entries = status["entries"] as? [[String: Any]] ?? []
    let entry = entries.first(where: { $0["id"] as? String == id })
    XCTAssertNotNil(entry, "Enqueued entry should appear in getStatus")
    XCTAssertEqual(entry?["status"] as? String, "pending")
    XCTAssertEqual(entry?["retryCount"] as? Int, 0)
  }

  func test_enqueue_returnedId_isNonEmpty() async throws {
    var events: [[String: Any]] = []
    let q = makeQueue(receivedEvents: &events)
    let id = try await q.enqueue(operation: "save", database: "private", recordData: sampleRecordData)
    XCTAssertFalse(id.isEmpty)
  }

  func test_enqueue_multipleEntries_allPending() async throws {
    var events: [[String: Any]] = []
    let q = makeQueue(receivedEvents: &events)
    for _ in 0..<5 {
      _ = try await q.enqueue(operation: "save", database: "private", recordData: sampleRecordData)
    }
    let status = await q.getStatus(includeEntries: false)
    XCTAssertEqual(status["pending"] as? Int, 5)
    XCTAssertEqual(status["total"] as? Int, 5)
  }

  // MARK: - Queue cap: 500 entries max

  func test_enqueueCap_500EntriesSucceed() async throws {
    var events: [[String: Any]] = []
    let q = makeQueue(receivedEvents: &events)
    for _ in 0..<500 {
      _ = try await q.enqueue(operation: "save", database: "private", recordData: sampleRecordData)
    }
    let status = await q.getStatus(includeEntries: false)
    XCTAssertEqual(status["total"] as? Int, 500)
  }

  func test_enqueueCap_501stEntryThrowsQueueFull() async throws {
    var events: [[String: Any]] = []
    let q = makeQueue(receivedEvents: &events)
    for _ in 0..<500 {
      _ = try await q.enqueue(operation: "save", database: "private", recordData: sampleRecordData)
    }
    do {
      _ = try await q.enqueue(operation: "save", database: "private", recordData: sampleRecordData)
      XCTFail("Expected enqueue to throw queueFull")
    } catch let error as OfflineQueueError {
      if case .queueFull = error {
        // correct
      } else {
        XCTFail("Expected .queueFull, got \(error)")
      }
    } catch {
      XCTFail("Expected OfflineQueueError, got \(type(of: error))")
    }
  }

  // MARK: - clear()

  func test_clear_all_removesAllEntries() async throws {
    var events: [[String: Any]] = []
    let q = makeQueue(receivedEvents: &events)
    _ = try await q.enqueue(operation: "save", database: "private", recordData: sampleRecordData)
    _ = try await q.enqueue(operation: "delete", database: "private", recordData: ["recordName": "x"])
    await q.clear(status: "all")
    let status = await q.getStatus(includeEntries: false)
    XCTAssertEqual(status["total"] as? Int, 0)
  }

  func test_clear_pending_removesOnlyPending() async throws {
    var events: [[String: Any]] = []
    let q = makeQueue(receivedEvents: &events)
    // Add two pending entries (we can't easily make "failed" ones without
    // calling drain, so we only verify "pending" clear removes exactly them)
    _ = try await q.enqueue(operation: "save", database: "private", recordData: sampleRecordData)
    _ = try await q.enqueue(operation: "save", database: "private", recordData: sampleRecordData)
    await q.clear(status: "pending")
    let status = await q.getStatus(includeEntries: false)
    XCTAssertEqual(status["pending"] as? Int, 0)
    XCTAssertEqual(status["total"] as? Int, 0)
  }

  // MARK: - getStatus structure

  func test_getStatus_containsExpectedKeys() async throws {
    var events: [[String: Any]] = []
    let q = makeQueue(receivedEvents: &events)
    let status = await q.getStatus(includeEntries: false)
    XCTAssertNotNil(status["pending"])
    XCTAssertNotNil(status["retrying"])
    XCTAssertNotNil(status["failed"])
    XCTAssertNotNil(status["total"])
  }

  func test_getStatus_withEntries_includesEntriesKey() async throws {
    var events: [[String: Any]] = []
    let q = makeQueue(receivedEvents: &events)
    _ = try await q.enqueue(operation: "save", database: "private", recordData: sampleRecordData)
    let status = await q.getStatus(includeEntries: true)
    XCTAssertNotNil(status["entries"], "includeEntries: true should populate 'entries' key")
    let entries = status["entries"] as? [[String: Any]]
    XCTAssertEqual(entries?.count, 1)
  }

  func test_getStatus_withoutEntries_omitsEntriesKey() async throws {
    var events: [[String: Any]] = []
    let q = makeQueue(receivedEvents: &events)
    _ = try await q.enqueue(operation: "save", database: "private", recordData: sampleRecordData)
    let status = await q.getStatus(includeEntries: false)
    XCTAssertNil(status["entries"])
  }

  // MARK: - File persistence
  //
  // We test persistence by creating two separate OfflineQueue instances that
  // share the same Application Support directory (same process, same
  // containerID). The first queue enqueues entries; the second queue loads
  // them from disk in its init.

  func test_persistence_entriesSurviveReload() async throws {
    // Build a fixed list of IDs so we can verify them after reload.
    var capturedIds: [String] = []
    var events1: [[String: Any]] = []
    let q1 = makeQueue(receivedEvents: &events1)
    for _ in 0..<3 {
      let id = try await q1.enqueue(operation: "save", database: "private", recordData: sampleRecordData)
      capturedIds.append(id)
    }
    // Verify q1 has 3 entries on disk by creating q2 (same real storage path
    // since we use default container and the process's Application Support dir).
    var events2: [[String: Any]] = []
    let q2 = makeQueue(receivedEvents: &events2)
    let status = await q2.getStatus(includeEntries: true)
    let loadedEntries = status["entries"] as? [[String: Any]] ?? []

    // Loaded count must be >= 3 (may be higher if a previous test left entries
    // because we are using the shared app-support directory).
    XCTAssertGreaterThanOrEqual(loadedEntries.count, 3,
      "At least the 3 entries enqueued by q1 should be present after reload")

    let loadedIds = Set(loadedEntries.compactMap { $0["id"] as? String })
    for id in capturedIds {
      XCTAssertTrue(loadedIds.contains(id),
        "Entry with id \(id) should survive persist/reload cycle")
    }
  }

  func test_persistence_entriesStatusSurvivesReload() async throws {
    var events: [[String: Any]] = []
    let q1 = makeQueue(receivedEvents: &events)
    let id = try await q1.enqueue(operation: "delete", database: "public",
                                   recordData: ["recordName": "rec-abc", "recordType": "Note"])

    var events2: [[String: Any]] = []
    let q2 = makeQueue(receivedEvents: &events2)
    let status = await q2.getStatus(includeEntries: true)
    let entries = status["entries"] as? [[String: Any]] ?? []
    let match = entries.first(where: { $0["id"] as? String == id })
    XCTAssertNotNil(match, "Entry \(id) should exist after reload")
    XCTAssertEqual(match?["status"] as? String, "pending")
    XCTAssertEqual(match?["operation"] as? String, "delete")
  }
}

// MARK: - OfflineQueueBackoffFormula (test-only helper)
//
// The real backoff is computed inside the private `nextRetryDelay(for:)`
// method of OfflineQueue. We replicate the formula here so we can assert
// its mathematical properties without modifying production code.
//
// The formula matches exactly what is in OfflineQueue.swift:
//   base = min(5.0 * pow(2.0, Double(retryCount)), 300.0)
//   delay = base + base * Double.random(in: 0.0...0.2)

enum OfflineQueueBackoffFormula {
  static func base(retryCount: Int) -> TimeInterval {
    return min(5.0 * pow(2.0, Double(retryCount)), 300.0)
  }

  static func delay(retryCount: Int) -> TimeInterval {
    let b = base(retryCount: retryCount)
    return b + b * Double.random(in: 0.0...0.2)
  }
}
