import XCTest
import CloudKit
import CoreLocation
@testable import ExpoCloudKit

// MARK: - ConvertersTests

/// Tests for the pure static helpers in Converters.swift.
///
/// All tests are offline — no CKContainer, no network calls.
final class ConvertersTests: XCTestCase {

  // MARK: - toDatabaseScope

  func test_toDatabaseScope_private() {
    XCTAssertEqual(Converters.toDatabaseScope("private"), .private)
  }

  func test_toDatabaseScope_shared() {
    XCTAssertEqual(Converters.toDatabaseScope("shared"), .shared)
  }

  func test_toDatabaseScope_public() {
    XCTAssertEqual(Converters.toDatabaseScope("public"), .public)
  }

  func test_toDatabaseScope_unknownFallsBackToPrivate() {
    XCTAssertEqual(Converters.toDatabaseScope(""), .private)
    XCTAssertEqual(Converters.toDatabaseScope("PRIVATE"), .private)
    XCTAssertEqual(Converters.toDatabaseScope("garbage"), .private)
  }

  // MARK: - accountStatusToString

  func test_accountStatusToString_available() {
    XCTAssertEqual(Converters.accountStatusToString(.available), "available")
  }

  func test_accountStatusToString_noAccount() {
    XCTAssertEqual(Converters.accountStatusToString(.noAccount), "noAccount")
  }

  func test_accountStatusToString_restricted() {
    XCTAssertEqual(Converters.accountStatusToString(.restricted), "restricted")
  }

  func test_accountStatusToString_couldNotDetermine() {
    XCTAssertEqual(Converters.accountStatusToString(.couldNotDetermine), "couldNotDetermine")
  }

  // MARK: - toZoneDictionary

  func test_toZoneDictionary_defaultZone() {
    let zone = CKRecordZone.default()
    let dict = Converters.toZoneDictionary(zone)

    XCTAssertEqual(dict["zoneName"] as? String, CKRecordZone.ID.default.zoneName)
    XCTAssertEqual(dict["ownerName"] as? String, CKRecordZone.ID.default.ownerName)
    XCTAssertNotNil(dict["capabilities"])
  }

  func test_toZoneDictionary_customZone() {
    let zoneID = CKRecordZone.ID(zoneName: "MyCustomZone", ownerName: CKCurrentUserDefaultName)
    let zone = CKRecordZone(zoneID: zoneID)
    let dict = Converters.toZoneDictionary(zone)

    XCTAssertEqual(dict["zoneName"] as? String, "MyCustomZone")
    XCTAssertEqual(dict["ownerName"] as? String, CKCurrentUserDefaultName)
    XCTAssertNotNil(dict["capabilities"] as? [String])
  }

  func test_toZoneDictionary_capabilitiesIsArray() {
    let zone = CKRecordZone.default()
    let dict = Converters.toZoneDictionary(zone)
    let capabilities = dict["capabilities"] as? [String]
    XCTAssertNotNil(capabilities)
  }

  // MARK: - toExpoError — CKError code mapping

  func test_toExpoError_notAuthenticated() {
    let ckError = CKError(.notAuthenticated)
    let bridgeError = Converters.toExpoError(ckError) as? ExpoCloudKitBridgeError
    XCTAssertNotNil(bridgeError)
    XCTAssertEqual(bridgeError?.code, "NOT_AUTHENTICATED")
  }

  func test_toExpoError_networkUnavailable() {
    let ckError = CKError(.networkUnavailable)
    let bridgeError = Converters.toExpoError(ckError) as? ExpoCloudKitBridgeError
    XCTAssertEqual(bridgeError?.code, "NETWORK_UNAVAILABLE")
  }

  func test_toExpoError_networkFailure() {
    let ckError = CKError(.networkFailure)
    let bridgeError = Converters.toExpoError(ckError) as? ExpoCloudKitBridgeError
    XCTAssertEqual(bridgeError?.code, "NETWORK_UNAVAILABLE")
  }

  func test_toExpoError_quotaExceeded() {
    let ckError = CKError(.quotaExceeded)
    let bridgeError = Converters.toExpoError(ckError) as? ExpoCloudKitBridgeError
    XCTAssertEqual(bridgeError?.code, "QUOTA_EXCEEDED")
  }

  func test_toExpoError_zoneNotFound() {
    let ckError = CKError(.zoneNotFound)
    let bridgeError = Converters.toExpoError(ckError) as? ExpoCloudKitBridgeError
    XCTAssertEqual(bridgeError?.code, "ZONE_NOT_FOUND")
  }

  func test_toExpoError_unknownItem() {
    let ckError = CKError(.unknownItem)
    let bridgeError = Converters.toExpoError(ckError) as? ExpoCloudKitBridgeError
    XCTAssertEqual(bridgeError?.code, "RECORD_NOT_FOUND")
  }

  func test_toExpoError_permissionFailure() {
    let ckError = CKError(.permissionFailure)
    let bridgeError = Converters.toExpoError(ckError) as? ExpoCloudKitBridgeError
    XCTAssertEqual(bridgeError?.code, "PERMISSION_DENIED")
  }

  func test_toExpoError_serverRejectedRequest() {
    let ckError = CKError(.serverRejectedRequest)
    let bridgeError = Converters.toExpoError(ckError) as? ExpoCloudKitBridgeError
    XCTAssertEqual(bridgeError?.code, "SERVER_REJECTED")
  }

  func test_toExpoError_changeTokenExpired() {
    let ckError = CKError(.changeTokenExpired)
    let bridgeError = Converters.toExpoError(ckError) as? ExpoCloudKitBridgeError
    XCTAssertEqual(bridgeError?.code, "TOKEN_EXPIRED")
  }

  func test_toExpoError_accountTemporarilyUnavailable() {
    let ckError = CKError(.accountTemporarilyUnavailable)
    let bridgeError = Converters.toExpoError(ckError) as? ExpoCloudKitBridgeError
    XCTAssertEqual(bridgeError?.code, "NOT_AUTHENTICATED")
  }

  func test_toExpoError_nonCKErrorBecomesUNKNOWN() {
    let genericError = NSError(domain: "TestDomain", code: 42, userInfo: [NSLocalizedDescriptionKey: "Test error"])
    let bridgeError = Converters.toExpoError(genericError) as? ExpoCloudKitBridgeError
    XCTAssertNotNil(bridgeError)
    XCTAssertEqual(bridgeError?.code, "UNKNOWN")
  }

  func test_toExpoError_bridgeErrorMessageIsNonEmpty() {
    let ckError = CKError(.notAuthenticated)
    let bridgeError = Converters.toExpoError(ckError) as? ExpoCloudKitBridgeError
    XCTAssertNotNil(bridgeError?.message)
    XCTAssertFalse(bridgeError!.message.isEmpty)
  }

  // MARK: - toDictionary — field type mapping

  /// Helper that builds a minimal CKRecord with a single field and returns
  /// the resulting `fields` sub-dictionary from toDictionary(_:).
  private func fields(forRecord record: CKRecord) -> [String: [String: Any]] {
    let dict = Converters.toDictionary(record)
    return dict["fields"] as? [String: [String: Any]] ?? [:]
  }

  func test_toDictionary_stringField() {
    let record = CKRecord(recordType: "Note")
    record["title"] = "Hello" as CKRecordValue
    let fields = self.fields(forRecord: record)

    XCTAssertEqual(fields["title"]?["type"] as? String, "string")
    XCTAssertEqual(fields["title"]?["value"] as? String, "Hello")
  }

  func test_toDictionary_intField_becomesNumber() {
    let record = CKRecord(recordType: "Note")
    record["count"] = 42 as CKRecordValue
    let fields = self.fields(forRecord: record)

    XCTAssertEqual(fields["count"]?["type"] as? String, "number")
    // CKRecord stores Int as NSNumber — the converter emits doubleValue
    let value = fields["count"]?["value"] as? Double
    XCTAssertNotNil(value)
    XCTAssertEqual(value!, 42.0, accuracy: 0.001)
  }

  func test_toDictionary_doubleField() {
    let record = CKRecord(recordType: "Metric")
    record["score"] = 3.14 as CKRecordValue
    let fields = self.fields(forRecord: record)

    XCTAssertEqual(fields["score"]?["type"] as? String, "number")
    let value = fields["score"]?["value"] as? Double
    XCTAssertNotNil(value)
    XCTAssertEqual(value!, 3.14, accuracy: 0.0001)
  }

  func test_toDictionary_dateField_isISOString() {
    let record = CKRecord(recordType: "Event")
    let knownDate = Date(timeIntervalSince1970: 0)  // 1970-01-01T00:00:00Z
    record["startAt"] = knownDate as CKRecordValue
    let fields = self.fields(forRecord: record)

    XCTAssertEqual(fields["startAt"]?["type"] as? String, "date")
    let isoValue = fields["startAt"]?["value"] as? String
    XCTAssertNotNil(isoValue)
    // Round-trip through ISO8601DateFormatter
    let parsed = ISO8601DateFormatter().date(from: isoValue!)
    XCTAssertNotNil(parsed)
    XCTAssertEqual(parsed!.timeIntervalSince1970, 0.0, accuracy: 1.0)
  }

  func test_toDictionary_dataField_isBase64String() {
    let record = CKRecord(recordType: "Blob")
    let originalData = Data([0xDE, 0xAD, 0xBE, 0xEF])
    record["payload"] = originalData as CKRecordValue
    let fields = self.fields(forRecord: record)

    XCTAssertEqual(fields["payload"]?["type"] as? String, "data")
    let base64 = fields["payload"]?["value"] as? String
    XCTAssertNotNil(base64)
    let decoded = Data(base64Encoded: base64!)
    XCTAssertEqual(decoded, originalData)
  }

  func test_toDictionary_locationField() {
    let record = CKRecord(recordType: "Place")
    let location = CLLocation(latitude: 37.7749, longitude: -122.4194)
    record["coords"] = location as CKRecordValue
    let fields = self.fields(forRecord: record)

    XCTAssertEqual(fields["coords"]?["type"] as? String, "location")
    let loc = fields["coords"]?["value"] as? [String: Double]
    XCTAssertNotNil(loc)
    XCTAssertEqual(loc!["latitude"]!, 37.7749, accuracy: 0.0001)
    XCTAssertEqual(loc!["longitude"]!, -122.4194, accuracy: 0.0001)
  }

  func test_toDictionary_stringListField() {
    let record = CKRecord(recordType: "Tag")
    record["tags"] = ["swift", "cloudkit"] as CKRecordValue
    let fields = self.fields(forRecord: record)

    XCTAssertEqual(fields["tags"]?["type"] as? String, "stringList")
    let values = fields["tags"]?["value"] as? [String]
    XCTAssertEqual(values, ["swift", "cloudkit"])
  }

  func test_toDictionary_numberListField() {
    let record = CKRecord(recordType: "Scores")
    record["scores"] = [NSNumber(value: 1.0), NSNumber(value: 2.0), NSNumber(value: 3.0)] as CKRecordValue
    let fields = self.fields(forRecord: record)

    XCTAssertEqual(fields["scores"]?["type"] as? String, "numberList")
    let values = fields["scores"]?["value"] as? [Double]
    XCTAssertNotNil(values)
    XCTAssertEqual(values!, [1.0, 2.0, 3.0])
  }

  // MARK: - toDictionary — top-level metadata

  func test_toDictionary_containsExpectedTopLevelKeys() {
    let record = CKRecord(recordType: "Article")
    let dict = Converters.toDictionary(record)

    XCTAssertNotNil(dict["recordType"])
    XCTAssertNotNil(dict["recordName"])
    XCTAssertNotNil(dict["zoneName"])
    XCTAssertNotNil(dict["ownerName"])
    XCTAssertNotNil(dict["fields"])
    // modificationDate / creationDate / changeTag may be nil for a brand-new local record
  }

  func test_toDictionary_recordType() {
    let record = CKRecord(recordType: "Article")
    let dict = Converters.toDictionary(record)
    XCTAssertEqual(dict["recordType"] as? String, "Article")
  }

  func test_toDictionary_recordName_preservedFromID() {
    let recordID = CKRecord.ID(recordName: "my-fixed-id")
    let record = CKRecord(recordType: "Note", recordID: recordID)
    let dict = Converters.toDictionary(record)
    XCTAssertEqual(dict["recordName"] as? String, "my-fixed-id")
  }

  // MARK: - toCKRecord — round-trip from dict

  func test_toCKRecord_roundTrip_stringField() throws {
    let input: [String: Any] = [
      "recordType": "Note",
      "fields": [
        "title": ["type": "string", "value": "Hello World"]
      ]
    ]
    let record = try Converters.toCKRecord(from: input)
    XCTAssertEqual(record.recordType, "Note")
    XCTAssertEqual(record["title"] as? String, "Hello World")
  }

  func test_toCKRecord_roundTrip_numberField() throws {
    let input: [String: Any] = [
      "recordType": "Metric",
      "fields": [
        "count": ["type": "number", "value": NSNumber(value: 99.0)]
      ]
    ]
    let record = try Converters.toCKRecord(from: input)
    let val = try XCTUnwrap((record["count"] as? NSNumber)?.doubleValue)
    XCTAssertEqual(val, 99.0, accuracy: 0.001)
  }

  func test_toCKRecord_missingRecordTypeThrows() {
    let input: [String: Any] = ["fields": [:]]
    XCTAssertThrowsError(try Converters.toCKRecord(from: input))
  }

  func test_toCKRecord_usesProvidedRecordName() throws {
    let input: [String: Any] = [
      "recordType": "Note",
      "recordName": "test-record-name-123",
      "fields": [:]
    ]
    let record = try Converters.toCKRecord(from: input)
    XCTAssertEqual(record.recordID.recordName, "test-record-name-123")
  }

  func test_toCKRecord_generatesUUIDWhenNoRecordName() throws {
    let input: [String: Any] = [
      "recordType": "Note",
      "fields": [:]
    ]
    let record = try Converters.toCKRecord(from: input)
    XCTAssertFalse(record.recordID.recordName.isEmpty)
    // UUID format: 36-char hex with dashes
    XCTAssertEqual(record.recordID.recordName.count, 36)
  }

  func test_toCKRecord_usesCustomZoneName() throws {
    let input: [String: Any] = [
      "recordType": "Note",
      "zoneName": "MyZone",
      "fields": [:]
    ]
    let record = try Converters.toCKRecord(from: input)
    XCTAssertEqual(record.recordID.zoneID.zoneName, "MyZone")
  }

  // MARK: - toPredicate

  func test_toPredicate_missingFieldReturnsTrue() {
    let pred = Converters.toPredicate(from: [:])
    // NSPredicate(value: true) evaluates to true against any object
    XCTAssertTrue(pred.evaluate(with: nil))
  }

  func test_toPredicate_unknownComparatorReturnsTrue() {
    let pred = Converters.toPredicate(from: ["field": "name", "comparator": "???"])
    XCTAssertTrue(pred.evaluate(with: nil))
  }

  // MARK: - toNSSortDescriptor

  func test_toNSSortDescriptor_returnsNilWhenNoField() {
    XCTAssertNil(Converters.toNSSortDescriptor(from: [:]))
  }

  func test_toNSSortDescriptor_ascendingDefault() {
    let descriptor = Converters.toNSSortDescriptor(from: ["field": "title"])
    XCTAssertNotNil(descriptor)
    XCTAssertTrue(descriptor!.ascending)
  }

  func test_toNSSortDescriptor_descending() {
    let descriptor = Converters.toNSSortDescriptor(from: ["field": "title", "ascending": false])
    XCTAssertNotNil(descriptor)
    XCTAssertFalse(descriptor!.ascending)
  }

  // MARK: - participantPermissionToString

  func test_participantPermissionToString_none() {
    XCTAssertEqual(Converters.participantPermissionToString(.none), "none")
  }

  func test_participantPermissionToString_readOnly() {
    XCTAssertEqual(Converters.participantPermissionToString(.readOnly), "readOnly")
  }

  func test_participantPermissionToString_readWrite() {
    XCTAssertEqual(Converters.participantPermissionToString(.readWrite), "readWrite")
  }

  // MARK: - participantRoleToString

  func test_participantRoleToString_owner() {
    XCTAssertEqual(Converters.participantRoleToString(.owner), "owner")
  }

  func test_participantRoleToString_privateUser() {
    XCTAssertEqual(Converters.participantRoleToString(.privateUser), "privateUser")
  }

  func test_participantRoleToString_publicUser() {
    XCTAssertEqual(Converters.participantRoleToString(.publicUser), "publicUser")
  }

  // MARK: - toSharePermission

  func test_toSharePermission_readOnly() {
    XCTAssertEqual(Converters.toSharePermission("readOnly"), .readOnly)
  }

  func test_toSharePermission_readWrite() {
    XCTAssertEqual(Converters.toSharePermission("readWrite"), .readWrite)
  }

  func test_toSharePermission_unknownFallsToNone() {
    XCTAssertEqual(Converters.toSharePermission("garbage"), .none)
  }

  // MARK: - toErrorDict

  func test_toErrorDict_nonCKError() {
    let error = NSError(domain: "TestDomain", code: 1, userInfo: [NSLocalizedDescriptionKey: "test msg"])
    let dict = Converters.toErrorDict(error)
    XCTAssertEqual(dict["code"] as? String, "UNKNOWN")
    XCTAssertNotNil(dict["message"])
  }

  func test_toErrorDict_ckError_hasCode() {
    let ckError = CKError(.notAuthenticated)
    let dict = Converters.toErrorDict(ckError)
    XCTAssertEqual(dict["code"] as? String, "NOT_AUTHENTICATED")
    XCTAssertNotNil(dict["message"])
  }

  // MARK: - toCKRecord — additional field types

  func test_toCKRecord_roundTrip_dateField() throws {
    let input: [String: Any] = [
      "recordType": "Event",
      "fields": [
        "startAt": ["type": "date", "value": "1970-01-01T00:00:00Z"]
      ]
    ]
    let record = try Converters.toCKRecord(from: input)
    let date = record["startAt"] as? Date
    XCTAssertNotNil(date, "Expected a Date value for field 'startAt'")
    XCTAssertEqual(date!.timeIntervalSince1970, 0.0, accuracy: 1.0)
  }

  func test_toCKRecord_roundTrip_locationField() throws {
    let input: [String: Any] = [
      "recordType": "Place",
      "fields": [
        "coords": [
          "type": "location",
          "value": ["latitude": 37.7749, "longitude": -122.4194]
        ]
      ]
    ]
    let record = try Converters.toCKRecord(from: input)
    let location = record["coords"] as? CLLocation
    XCTAssertNotNil(location, "Expected a CLLocation value for field 'coords'")
    XCTAssertEqual(location!.coordinate.latitude, 37.7749, accuracy: 0.0001)
    XCTAssertEqual(location!.coordinate.longitude, -122.4194, accuracy: 0.0001)
  }

  func test_toCKRecord_roundTrip_stringListField() throws {
    let input: [String: Any] = [
      "recordType": "Tag",
      "fields": [
        "tags": ["type": "stringList", "value": ["a", "b", "c"]]
      ]
    ]
    let record = try Converters.toCKRecord(from: input)
    let tags = record["tags"] as? [String]
    XCTAssertNotNil(tags, "Expected a [String] value for field 'tags'")
    XCTAssertEqual(tags, ["a", "b", "c"])
  }

  func test_toCKRecord_roundTrip_numberListField() throws {
    let input: [String: Any] = [
      "recordType": "Scores",
      "fields": [
        "scores": [
          "type": "numberList",
          "value": [NSNumber(value: 1.0), NSNumber(value: 2.0)]
        ]
      ]
    ]
    let record = try Converters.toCKRecord(from: input)
    let scores = record["scores"] as? NSArray
    XCTAssertNotNil(scores, "Expected an NSArray of NSNumbers for field 'scores'")
    XCTAssertEqual(scores!.count, 2)
    XCTAssertEqual(try XCTUnwrap((scores![0] as? NSNumber)?.doubleValue), 1.0, accuracy: 0.001)
    XCTAssertEqual(try XCTUnwrap((scores![1] as? NSNumber)?.doubleValue), 2.0, accuracy: 0.001)
  }

  // MARK: - toExpoError — additional CKError codes

  func test_toExpoError_serverRecordChanged_mapsToCONFLICT() {
    let ckError = CKError(.serverRecordChanged)
    let bridgeError = Converters.toExpoError(ckError) as? ExpoCloudKitBridgeError
    XCTAssertNotNil(bridgeError)
    XCTAssertEqual(bridgeError?.code, "CONFLICT")
  }

  func test_toExpoError_limitExceeded_mapsToLIMIT_EXCEEDED() {
    let ckError = CKError(.limitExceeded)
    let bridgeError = Converters.toExpoError(ckError) as? ExpoCloudKitBridgeError
    XCTAssertNotNil(bridgeError)
    XCTAssertEqual(bridgeError?.code, "LIMIT_EXCEEDED")
  }

  func test_toExpoError_operationCancelled_mapsToUNKNOWN() {
    let ckError = CKError(.operationCancelled)
    let bridgeError = Converters.toExpoError(ckError) as? ExpoCloudKitBridgeError
    XCTAssertNotNil(bridgeError)
    XCTAssertEqual(bridgeError?.code, "UNKNOWN")
  }

  // MARK: - toDictionary — reference field

  func test_toDictionary_referenceField_typeAndValue() {
    let record = CKRecord(recordType: "Note")
    let refID = CKRecord.ID(recordName: "target-record-abc")
    let reference = CKRecord.Reference(recordID: refID, action: .none)
    record["ref"] = reference as CKRecordValue
    let fields = self.fields(forRecord: record)

    XCTAssertEqual(fields["ref"]?["type"] as? String, "reference")
    let value = fields["ref"]?["value"] as? [String: Any]
    XCTAssertNotNil(value, "Expected a [String: Any] value dict for reference field")
    XCTAssertEqual(value?["recordName"] as? String, "target-record-abc")
  }

  func test_toDictionary_referenceField_deleteSelfAction() {
    let record = CKRecord(recordType: "Note")
    let refID = CKRecord.ID(recordName: "child-record-xyz")
    let reference = CKRecord.Reference(recordID: refID, action: .deleteSelf)
    record["ref"] = reference as CKRecordValue
    let fields = self.fields(forRecord: record)

    let value = fields["ref"]?["value"] as? [String: Any]
    XCTAssertEqual(value?["action"] as? String, "deleteSelf")
  }

  func test_toDictionary_referenceField_noneAction() {
    let record = CKRecord(recordType: "Note")
    let refID = CKRecord.ID(recordName: "peer-record-def")
    let reference = CKRecord.Reference(recordID: refID, action: .none)
    record["ref"] = reference as CKRecordValue
    let fields = self.fields(forRecord: record)

    let value = fields["ref"]?["value"] as? [String: Any]
    XCTAssertEqual(value?["action"] as? String, "none")
  }
}

// MARK: - CKError convenience init (test helper)

extension CKError {
  /// Convenience initializer used only in tests. Creates a CKError with only
  /// a code set — the real info dict is empty (matching how XCTest mocks errors).
  init(_ code: CKError.Code) {
    self.init(code, userInfo: [:])
  }
}
