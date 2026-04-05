import XCTest
import CloudKit
@testable import ExpoCloudKit

// MARK: - CloudKitStoreTests
//
// Unit tests for CloudKitStore (@Observable SwiftUI wrapper, Phase J.1).
//
// All tests are guarded with `#available(iOS 17, *)` and skip gracefully on
// earlier OS versions using `XCTSkip`. No real CKContainer is used — all
// CloudKit networking is avoided.
//
// CloudKitStore is @MainActor-isolated, so every test that touches the store
// must be marked `@MainActor` (or run inside `await MainActor.run { ... }`).

@available(iOS 17, macOS 14, *)
@MainActor
final class CloudKitStoreTests: XCTestCase {

  // MARK: - Lifecycle

  override func setUp() {
    super.setUp()
    ExpoCloudKitModule.sharedRecordManager = nil
  }

  override func tearDown() {
    ExpoCloudKitModule.sharedRecordManager = nil
    super.tearDown()
  }

  // MARK: - test_init_startWithEmptyState

  func test_init_startWithEmptyState() throws {
    guard #available(iOS 17, *) else { throw XCTSkip("CloudKitStore requires iOS 17+") }

    let store = CloudKitStore()

    XCTAssertTrue(store.records.isEmpty, "records should be empty on init")
    XCTAssertFalse(store.isLoading, "isLoading should be false on init")
    XCTAssertEqual(store.syncState.status, .notStarted, "syncState.status should be .notStarted on init")
    XCTAssertNil(store.error, "error should be nil on init")
  }

  // MARK: - test_syncNotification_updatesSyncState

  func test_syncNotification_updatesSyncState() throws {
    guard #available(iOS 17, *) else { throw XCTSkip("CloudKitStore requires iOS 17+") }

    let store = CloudKitStore()

    XCTAssertEqual(store.syncState.status, .notStarted)
    XCTAssertFalse(store.syncState.status == .syncing)

    NotificationCenter.default.post(
      name: .expoCloudKitSyncStateChanged,
      object: nil,
      userInfo: ["state": "syncing"]
    )
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))

    XCTAssertEqual(store.syncState.status, .syncing, "status should update to .syncing")

    NotificationCenter.default.post(
      name: .expoCloudKitSyncStateChanged,
      object: nil,
      userInfo: ["state": "idle"]
    )
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))

    XCTAssertEqual(store.syncState.status, .idle, "status should revert to .idle")
    XCTAssertNotEqual(store.syncState.status, .syncing, "syncing should be false after idle notification")
  }

  // MARK: - test_syncNotification_suspendedState

  func test_syncNotification_suspendedState() throws {
    guard #available(iOS 17, *) else { throw XCTSkip("CloudKitStore requires iOS 17+") }

    let store = CloudKitStore()

    NotificationCenter.default.post(
      name: .expoCloudKitSyncStateChanged,
      object: nil,
      userInfo: ["state": "suspended"]
    )
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))

    XCTAssertEqual(store.syncState.status, .suspended)
    XCTAssertNotEqual(store.syncState.status, .syncing, "suspended is not syncing")
  }

  // MARK: - test_noRecordManager_fetchThrowsNotConfigured

  func test_noRecordManager_fetchThrowsNotConfigured() async throws {
    guard #available(iOS 17, *) else { throw XCTSkip("CloudKitStore requires iOS 17+") }

    let store = CloudKitStore()
    let config = FetchConfig(recordType: "Note")

    await store.fetch(config)

    XCTAssertNotNil(store.error, "error should be set when fetch is called without a manager")
  }

  // MARK: - test_noRecordManager_saveThrowsNotConfigured

  func test_noRecordManager_saveThrowsNotConfigured() async throws {
    guard #available(iOS 17, *) else { throw XCTSkip("CloudKitStore requires iOS 17+") }

    let store = CloudKitStore()
    let toSave = RecordToSave(recordType: "Note", fields: [:])

    await store.save(toSave)

    XCTAssertNotNil(store.error, "error should be set when save is called without a manager")
  }

  // MARK: - test_noRecordManager_deleteThrowsNotConfigured

  func test_noRecordManager_deleteThrowsNotConfigured() async throws {
    guard #available(iOS 17, *) else { throw XCTSkip("CloudKitStore requires iOS 17+") }

    let store = CloudKitStore()
    let identifier = RecordIdentifier(recordName: "nonexistent", zoneName: "_defaultZone", database: "private")

    await store.delete(identifier)

    XCTAssertNotNil(store.error, "error should be set when delete is called without a manager")
  }

  // MARK: - test_records_emptyOnInit

  func test_records_emptyOnInit() throws {
    guard #available(iOS 17, *) else { throw XCTSkip("CloudKitStore requires iOS 17+") }

    let store = CloudKitStore()
    XCTAssertTrue(store.records.isEmpty)
  }

  // MARK: - test_save_setsErrorWhenNoManager

  func test_save_setsErrorWhenNoManager() async throws {
    guard #available(iOS 17, *) else { throw XCTSkip("CloudKitStore requires iOS 17+") }

    let store = CloudKitStore()
    XCTAssertTrue(store.records.isEmpty)

    await store.save(RecordToSave(recordType: "Note", fields: [:]))

    XCTAssertTrue(store.records.isEmpty, "records should remain empty when save has no manager")
    XCTAssertNotNil(store.error, "error should be set")
  }
}
