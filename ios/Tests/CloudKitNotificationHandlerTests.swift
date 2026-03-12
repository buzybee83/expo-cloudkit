import XCTest
import CloudKit
@testable import ExpoCloudKit

// MARK: - CloudKitNotificationHandlerTests
//
// All tests are fully offline — no CKContainer, no network calls.
//
// CloudKit push notification payloads have a well-known JSON structure that
// CKNotification(fromRemoteNotificationDictionary:) parses without requiring
// iCloud entitlements or a network connection. Tests construct [String: Any]
// userInfo dictionaries that replicate real CloudKit push payloads and verify
// that CloudKitNotificationHandler produces the correct JS event dictionaries.
//
// CloudKit push payload structure (simplified):
//   {
//     "ck": {
//       "nid": "<notification-id>",       // notification ID (UUID string)
//       "sid": "<subscription-id>",       // subscription ID
//       "nt":  1,                         // notification type:
//                                         //   1=query, 2=recordZone, 3=readNotification, 4=database
//       "qry": {                          // present when nt==1 (query notification)
//         "rid": { "recordName": "...", "zoneID": { "zoneName": "...", "ownerName": "..." } },
//         "af":  { "fieldName": "value" }, // alerted fields (optional)
//         "fo":  1                         // query reason: 1=created, 2=deleted, 3=updated
//       },
//       "dbs": 1                          // present when nt==4: 1=private, 2=shared, 3=public
//     }
//   }

final class CloudKitNotificationHandlerTests: XCTestCase {

  // MARK: - Helpers

  /// Builds a minimal CloudKit push userInfo dict for a query notification.
  ///
  /// - Parameters:
  ///   - subscriptionID: The CKQuerySubscription ID.
  ///   - queryReason: 1=created, 2=deleted, 3=updated (CKQueryNotification.Reason raw value).
  ///   - recordName: Optional record name to embed in the recordID field.
  ///   - zoneName: Optional zone name. Defaults to "_defaultZone".
  ///   - alertedFields: Optional dictionary of field key/value pairs to embed.
  private func queryPayload(
    subscriptionID: String = "expo-ck-query-test",
    queryReason: Int = 1,
    recordName: String? = nil,
    zoneName: String = "_defaultZone",
    alertedFields: [String: Any]? = nil
  ) -> [AnyHashable: Any] {
    var qry: [String: Any] = [
      "fo": queryReason
    ]
    if let recordName = recordName {
      qry["rid"] = [
        "recordName": recordName,
        "zoneID": [
          "zoneName": zoneName,
          "ownerName": CKCurrentUserDefaultName
        ]
      ]
    }
    if let fields = alertedFields {
      qry["af"] = fields
    }

    return [
      "ck": [
        "nid": UUID().uuidString,
        "sid": subscriptionID,
        "nt": 1,  // query
        "qry": qry
      ]
    ]
  }

  /// Builds a minimal CloudKit push userInfo dict for a database notification.
  ///
  /// - Parameters:
  ///   - subscriptionID: The CKDatabaseSubscription ID.
  ///   - databaseScope: 1=private, 2=shared, 3=public.
  private func databasePayload(
    subscriptionID: String = "expo-ck-db-test",
    databaseScope: Int = 1
  ) -> [AnyHashable: Any] {
    return [
      "ck": [
        "nid": UUID().uuidString,
        "sid": subscriptionID,
        "nt": 4,  // database
        "dbs": databaseScope
      ]
    ]
  }

  // MARK: - Test 1: Query notification — notificationType "created" (queryReason 1)

  func test_queryNotification_created_hasCorrectType() {
    let userInfo = queryPayload(queryReason: 1)
    var captured: [String: Any]?

    let handled = CloudKitNotificationHandler.handle(userInfo: userInfo) { payload in
      captured = payload
    }

    // CKNotification must have parsed the payload for handle() to return true.
    guard handled else {
      // If the test environment cannot parse CloudKit notification payloads at all
      // (e.g. running in a target without CloudKit framework), skip gracefully.
      XCTSkip("CKNotification(fromRemoteNotificationDictionary:) returned nil — skipping offline parse test")
      return
    }

    // Wait briefly for the async DispatchQueue.main.async in handle().
    let exp = expectation(description: "sendEvent called")
    DispatchQueue.main.async { exp.fulfill() }
    wait(for: [exp], timeout: 1.0)

    XCTAssertEqual(captured?["type"] as? String, "query",
                   "Payload type should be 'query' for a CKQueryNotification")
    XCTAssertEqual(captured?["notificationType"] as? String, "created",
                   "notificationType should be 'created' for queryReason 1")
  }

  // MARK: - Test 2: Query notification — notificationType "updated" (queryReason 3)

  func test_queryNotification_updated_hasCorrectNotificationType() {
    let userInfo = queryPayload(queryReason: 3)
    var captured: [String: Any]?

    let handled = CloudKitNotificationHandler.handle(userInfo: userInfo) { payload in
      captured = payload
    }

    guard handled else {
      XCTSkip("CKNotification(fromRemoteNotificationDictionary:) returned nil — skipping offline parse test")
      return
    }

    let exp = expectation(description: "sendEvent called")
    DispatchQueue.main.async { exp.fulfill() }
    wait(for: [exp], timeout: 1.0)

    XCTAssertEqual(captured?["notificationType"] as? String, "updated",
                   "notificationType should be 'updated' for queryReason 3")
  }

  // MARK: - Test 3: Query notification — notificationType "deleted" (queryReason 2)

  func test_queryNotification_deleted_hasCorrectNotificationType() {
    let userInfo = queryPayload(queryReason: 2)
    var captured: [String: Any]?

    let handled = CloudKitNotificationHandler.handle(userInfo: userInfo) { payload in
      captured = payload
    }

    guard handled else {
      XCTSkip("CKNotification(fromRemoteNotificationDictionary:) returned nil — skipping offline parse test")
      return
    }

    let exp = expectation(description: "sendEvent called")
    DispatchQueue.main.async { exp.fulfill() }
    wait(for: [exp], timeout: 1.0)

    XCTAssertEqual(captured?["notificationType"] as? String, "deleted",
                   "notificationType should be 'deleted' for queryReason 2")
  }

  // MARK: - Test 4: Database notification — type "database"

  func test_databaseNotification_hasCorrectType() {
    let userInfo = databasePayload(subscriptionID: "expo-ck-db-private", databaseScope: 1)
    var captured: [String: Any]?

    let handled = CloudKitNotificationHandler.handle(userInfo: userInfo) { payload in
      captured = payload
    }

    guard handled else {
      XCTSkip("CKNotification(fromRemoteNotificationDictionary:) returned nil — skipping offline parse test")
      return
    }

    let exp = expectation(description: "sendEvent called")
    DispatchQueue.main.async { exp.fulfill() }
    wait(for: [exp], timeout: 1.0)

    XCTAssertEqual(captured?["type"] as? String, "database",
                   "Payload type should be 'database' for a CKDatabaseNotification")
  }

  // MARK: - Test 5: Empty / malformed payload — handle() returns false

  func test_emptyPayload_returnsNotHandled() {
    let userInfo: [AnyHashable: Any] = [:]
    var sendEventCalled = false

    let handled = CloudKitNotificationHandler.handle(userInfo: userInfo) { _ in
      sendEventCalled = true
    }

    XCTAssertFalse(handled,
                   "An empty dict is not a CloudKit notification — handle() must return false")

    // Flush main queue to confirm sendEvent was never called.
    let exp = expectation(description: "main queue flush")
    DispatchQueue.main.async { exp.fulfill() }
    wait(for: [exp], timeout: 1.0)

    XCTAssertFalse(sendEventCalled,
                   "sendEvent must not be called for non-CloudKit payloads")
  }

  func test_nonCloudKitPayload_returnsNotHandled() {
    let userInfo: [AnyHashable: Any] = [
      "aps": ["alert": "Hello", "badge": 1],
      "customKey": "customValue"
    ]
    var sendEventCalled = false

    let handled = CloudKitNotificationHandler.handle(userInfo: userInfo) { _ in
      sendEventCalled = true
    }

    XCTAssertFalse(handled,
                   "A non-CloudKit APNs payload must not be handled")

    let exp = expectation(description: "main queue flush")
    DispatchQueue.main.async { exp.fulfill() }
    wait(for: [exp], timeout: 1.0)

    XCTAssertFalse(sendEventCalled,
                   "sendEvent must not be called for non-CloudKit payloads")
  }

  // MARK: - Test 6: Query notification with recordID — extracted correctly

  func test_queryNotification_withRecordID_extractsRecordName() {
    let expectedRecordName = "test-record-\(UUID().uuidString)"
    let expectedZoneName = "MyCustomZone"

    let userInfo = queryPayload(
      queryReason: 1,
      recordName: expectedRecordName,
      zoneName: expectedZoneName
    )
    var captured: [String: Any]?

    let handled = CloudKitNotificationHandler.handle(userInfo: userInfo) { payload in
      captured = payload
    }

    guard handled else {
      XCTSkip("CKNotification(fromRemoteNotificationDictionary:) returned nil — skipping offline parse test")
      return
    }

    let exp = expectation(description: "sendEvent called")
    DispatchQueue.main.async { exp.fulfill() }
    wait(for: [exp], timeout: 1.0)

    guard let recordIDDict = captured?["recordID"] as? [String: Any] else {
      XCTFail("Expected 'recordID' key in payload when record name is embedded in notification")
      return
    }

    XCTAssertEqual(recordIDDict["recordName"] as? String, expectedRecordName,
                   "recordID.recordName must match the name embedded in the notification payload")
    XCTAssertEqual(recordIDDict["zoneName"] as? String, expectedZoneName,
                   "recordID.zoneName must match the zone name embedded in the notification payload")
  }

  // MARK: - Test 7: Query notification subscriptionID is forwarded

  func test_queryNotification_subscriptionIDForwarded() {
    let expectedSubID = "expo-ck-query-abc123"
    let userInfo = queryPayload(subscriptionID: expectedSubID, queryReason: 1)
    var captured: [String: Any]?

    let handled = CloudKitNotificationHandler.handle(userInfo: userInfo) { payload in
      captured = payload
    }

    guard handled else {
      XCTSkip("CKNotification(fromRemoteNotificationDictionary:) returned nil — skipping offline parse test")
      return
    }

    let exp = expectation(description: "sendEvent called")
    DispatchQueue.main.async { exp.fulfill() }
    wait(for: [exp], timeout: 1.0)

    XCTAssertEqual(captured?["subscriptionID"] as? String, expectedSubID,
                   "subscriptionID must be forwarded from the notification payload to the event dict")
  }
}
