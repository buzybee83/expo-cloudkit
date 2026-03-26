import CloudKit
import Foundation
#if canImport(ExpoModulesCore)
import ExpoModulesCore
#endif

/// Static helpers for converting between CloudKit native types and
/// JS-bridge-compatible dictionaries.
///
/// All values passed across the Expo JS bridge must be serializable to JSON,
/// so CKRecord field types are mapped as follows:
///
/// | CKRecord field Swift type   | JS bridge type                          |
/// |-----------------------------|-----------------------------------------|
/// | String                      | String                                  |
/// | Int / Double / NSNumber     | Double (JS Number)                      |
/// | Date                        | ISO 8601 String                         |
/// | Data                        | Base64 String                           |
/// | CLLocation                  | { latitude: Double, longitude: Double } |
/// | CKRecord.Reference          | { recordName: String, action: String }  |
/// | CKAsset                     | { downloadURL: String, size: Int }      |
/// | [String]                    | [String]                                |
/// | [NSNumber]                  | [Double]                                |
enum Converters {

  // MARK: - CKRecord → Dictionary

  /// Converts a CKRecord to a JS-bridge-safe dictionary.
  static func toDictionary(_ record: CKRecord) -> [String: Any] {
    var fields: [String: [String: Any]] = [:]

    for key in record.allKeys() {
      if let fieldDict = fieldToDictionary(record[key], for: key) {
        fields[key] = fieldDict
      }
    }

    // Serialize encrypted fields (iOS 15+). Uses the same typed-dict format
    // as regular fields so JS callers receive a uniform structure. On iOS < 15
    // this key is absent from the returned dictionary.
    var encryptedFields: [String: [String: Any]] = [:]
    if #available(iOS 15.0, *) {
      for key in record.encryptedValues.allKeys() {
        if let fieldDict = fieldToDictionary(record.encryptedValues[key], for: key) {
          encryptedFields[key] = fieldDict
        }
      }
    }

    var dict: [String: Any] = [
      "recordType": record.recordType,
      "recordName": record.recordID.recordName,
      "zoneName": record.recordID.zoneID.zoneName,
      "ownerName": record.recordID.zoneID.ownerName,
      "changeTag": record.recordChangeTag as Any,
      "fields": fields
    ]

    if #available(iOS 15.0, *), !encryptedFields.isEmpty {
      dict["encryptedFields"] = encryptedFields
    }

    // System metadata — absent on locally-created records that have not yet
    // been saved to CloudKit. Serialised as Unix ms timestamps so JS callers
    // receive a plain number rather than an ISO 8601 string.
    if let creationDate = record.creationDate {
      dict["creationDate"] = creationDate.timeIntervalSince1970 * 1000
    }
    if let modificationDate = record.modificationDate {
      dict["modificationDate"] = modificationDate.timeIntervalSince1970 * 1000
    }
    if let creatorID = record.creatorUserRecordID {
      dict["createdByUserRecordID"] = creatorID.recordName
    }
    if let modifierID = record.lastModifiedUserRecordID {
      dict["modifiedByUserRecordID"] = modifierID.recordName
    }

    return dict
  }

  // MARK: - Field → Dictionary

  private static func fieldToDictionary(_ value: CKRecordValueProtocol?, for key: String) -> [String: Any]? {
    guard let value = value else { return nil }

    switch value {
    case let s as String:
      return ["type": "string", "value": s]

    case let n as NSNumber:
      return ["type": "number", "value": n.doubleValue]

    case let d as Date:
      return ["type": "date", "value": isoString(from: d)]

    case let data as Data:
      return ["type": "data", "value": data.base64EncodedString()]

    case let location as CLLocation:
      return [
        "type": "location",
        "value": [
          "latitude": location.coordinate.latitude,
          "longitude": location.coordinate.longitude
        ]
      ]

    case let ref as CKRecord.Reference:
      let action: String
      switch ref.action {
      case .deleteSelf: action = "deleteSelf"
      default: action = "none"
      }
      return [
        "type": "reference",
        "value": [
          "recordName": ref.recordID.recordName,
          "action": action
        ]
      ]

    case let asset as CKAsset:
      var dict: [String: Any] = ["type": "asset"]
      var valueDict: [String: Any] = [:]
      if let url = asset.fileURL {
        valueDict["downloadURL"] = url.absoluteString
        valueDict["size"] = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? -1
      }
      dict["value"] = valueDict
      return dict

    case let strings as [String]:
      return ["type": "stringList", "value": strings]

    case let numbers as [NSNumber]:
      return ["type": "numberList", "value": numbers.map { $0.doubleValue }]

    default:
      // Unknown type — skip rather than crash
      return nil
    }
  }

  // MARK: - Dictionary → CKRecord

  /// Converts a JS dictionary (from saveRecords call) into a CKRecord.
  ///
  /// Expects keys: recordType, recordName (optional), zoneName (optional),
  /// changeTag (optional), fields (dictionary of field dicts).
  static func toCKRecord(from dict: [String: Any]) throws -> CKRecord {
    guard let recordType = dict["recordType"] as? String else {
      throw ConverterError.missingField("recordType")
    }

    let zoneName = dict["zoneName"] as? String
    let zoneID: CKRecordZone.ID
    if let zoneName = zoneName {
      zoneID = CKRecordZone.ID(zoneName: zoneName, ownerName: CKCurrentUserDefaultName)
    } else {
      zoneID = CKRecordZone.ID.default
    }

    let record: CKRecord
    if let recordName = dict["recordName"] as? String {
      let recordID = CKRecord.ID(recordName: recordName, zoneID: zoneID)
      record = CKRecord(recordType: recordType, recordID: recordID)
    } else {
      // Let CloudKit generate a UUID
      let recordID = CKRecord.ID(recordName: UUID().uuidString, zoneID: zoneID)
      record = CKRecord(recordType: recordType, recordID: recordID)
    }

    if let fields = dict["fields"] as? [String: [String: Any]] {
      for (key, fieldDict) in fields {
        if let value = try fieldDictToValue(fieldDict) {
          record[key] = value
        }
      }
    }

    // Apply encrypted fields (iOS 15+). On iOS < 15 these are silently
    // dropped — the record is saved as if encryptedFields were absent.
    if #available(iOS 15.0, *),
       let encryptedFields = dict["encryptedFields"] as? [String: [String: Any]] {
      for (key, fieldDict) in encryptedFields {
        if let value = try fieldDictToValue(fieldDict) {
          record.encryptedValues[key] = value
        }
      }
    }

    return record
  }

  // MARK: - Field Dictionary → CKRecord Value

  private static func fieldDictToValue(_ dict: [String: Any]) throws -> CKRecordValueProtocol? {
    guard let type = dict["type"] as? String else {
      throw ConverterError.missingField("type")
    }
    let value = dict["value"]

    switch type {
    case "string":
      guard let s = value as? String else { throw ConverterError.typeMismatch("string", value) }
      return s

    case "number":
      guard let n = value as? NSNumber else { throw ConverterError.typeMismatch("number", value) }
      return n

    case "date":
      guard let s = value as? String, let date = ISO8601DateFormatter().date(from: s) else {
        throw ConverterError.typeMismatch("date ISO string", value)
      }
      return date

    case "data":
      guard let s = value as? String, let data = Data(base64Encoded: s) else {
        throw ConverterError.typeMismatch("base64 data string", value)
      }
      return data

    case "location":
      guard let loc = value as? [String: Any],
            let lat = loc["latitude"] as? Double,
            let lon = loc["longitude"] as? Double else {
        throw ConverterError.typeMismatch("location {latitude, longitude}", value)
      }
      return CLLocation(latitude: lat, longitude: lon)

    case "reference":
      guard let ref = value as? [String: Any],
            let recordName = ref["recordName"] as? String else {
        throw ConverterError.typeMismatch("reference {recordName, action}", value)
      }
      let actionString = ref["action"] as? String ?? "none"
      let action: CKRecord.Reference.Action = actionString == "deleteSelf" ? .deleteSelf : .none
      let refID = CKRecord.ID(recordName: recordName)
      return CKRecord.Reference(recordID: refID, action: action)

    case "asset":
      guard let fileURL = value as? String, let url = URL(string: fileURL) else {
        throw ConverterError.typeMismatch("asset fileURL string", value)
      }
      return CKAsset(fileURL: url)

    case "stringList":
      guard let strings = value as? [String] else {
        throw ConverterError.typeMismatch("stringList [String]", value)
      }
      return strings

    case "numberList":
      guard let numbers = value as? [NSNumber] else {
        throw ConverterError.typeMismatch("numberList [NSNumber]", value)
      }
      return numbers

    default:
      throw ConverterError.unknownType(type)
    }
  }

  // MARK: - CKRecordZone → Dictionary

  static func toZoneDictionary(_ zone: CKRecordZone) -> [String: Any] {
    var capabilities: [String] = []
    if zone.capabilities.contains(.fetchChanges) { capabilities.append("fetchChanges") }
    // .atomicChanges was renamed to .atomic in iOS 15+
    if zone.capabilities.contains(.atomic) { capabilities.append("atomicChanges") }
    if zone.capabilities.contains(.sharing) { capabilities.append("sharing") }

    return [
      "zoneName": zone.zoneID.zoneName,
      "ownerName": zone.zoneID.ownerName,
      "capabilities": capabilities
    ]
  }

  // MARK: - Account Status

  static func accountStatusToString(_ status: CKAccountStatus) -> String {
    switch status {
    case .available:            return "available"
    case .noAccount:            return "noAccount"
    case .restricted:           return "restricted"
    case .couldNotDetermine:    return "couldNotDetermine"
    case .temporarilyUnavailable: return "temporarilyUnavailable"
    @unknown default:           return "couldNotDetermine"
    }
  }

  // MARK: - Database Scope

  static func toDatabaseScope(_ string: String) -> CKDatabase.Scope {
    switch string {
    case "private":  return .private
    case "shared":   return .shared
    case "public":   return .public
    default:         return .private
    }
  }

  static func fromDatabaseScope(_ scope: CKDatabase.Scope) -> String {
    switch scope {
    case .private:  return "private"
    case .shared:   return "shared"
    case .public:   return "public"
    @unknown default: return "private"
    }
  }

  // MARK: - NSPredicate from JS

  /// Builds an NSPredicate from a JS predicate dict:
  /// { field: String, comparator: String, value: Any }
  static func toPredicate(from dict: [String: Any]) -> NSPredicate {
    guard
      let field = dict["field"] as? String,
      let comparator = dict["comparator"] as? String
    else {
      return NSPredicate(value: true)
    }

    let value = dict["value"]

    switch comparator {
    case "=":
      return NSPredicate(format: "%K == %@", field, asNSObject(value))
    case "!=":
      return NSPredicate(format: "%K != %@", field, asNSObject(value))
    case "<":
      return NSPredicate(format: "%K < %@", field, asNSObject(value))
    case "<=":
      return NSPredicate(format: "%K <= %@", field, asNSObject(value))
    case ">":
      return NSPredicate(format: "%K > %@", field, asNSObject(value))
    case ">=":
      return NSPredicate(format: "%K >= %@", field, asNSObject(value))
    case "BEGINSWITH":
      return NSPredicate(format: "%K BEGINSWITH %@", field, asNSObject(value))
    case "CONTAINS":
      return NSPredicate(format: "%K CONTAINS %@", field, asNSObject(value))
    case "IN":
      guard let list = value as? [Any] else { return NSPredicate(value: true) }
      return NSPredicate(format: "%K IN %@", field, list as NSArray)
    default:
      return NSPredicate(value: true)
    }
  }

  // MARK: - NSSortDescriptor from JS

  static func toNSSortDescriptor(from dict: [String: Any]) -> NSSortDescriptor? {
    guard let field = dict["field"] as? String else { return nil }
    let ascending = dict["ascending"] as? Bool ?? true
    return NSSortDescriptor(key: field, ascending: ascending)
  }

  // MARK: - Error mapping

  /// Converts a CloudKit CKError into an ExpoModulesCore-compatible error
  /// with a JS-friendly code string and message.
  static func toExpoError(_ error: Error) -> Error {
    guard let ckError = error as? CKError else {
      return ExpoCloudKitBridgeError(
        code: "UNKNOWN",
        message: error.localizedDescription,
        retryAfterSeconds: nil,
        serverRecord: nil
      )
    }

    let code: String
    var retryAfterSeconds: Double? = nil
    var serverRecord: [String: Any]? = nil

    switch ckError.code {
    case .notAuthenticated:
      code = "NOT_AUTHENTICATED"
    case .networkUnavailable, .networkFailure:
      code = "NETWORK_UNAVAILABLE"
      if let retryAfter = ckError.retryAfterSeconds {
        retryAfterSeconds = retryAfter
      }
    case .quotaExceeded:
      code = "QUOTA_EXCEEDED"
    case .zoneNotFound:
      code = "ZONE_NOT_FOUND"
    case .unknownItem:
      code = "RECORD_NOT_FOUND"
    case .serverRecordChanged:
      code = "CONFLICT"
      if let sr = ckError.serverRecord {
        serverRecord = toDictionary(sr)
      }
    case .permissionFailure:
      code = "PERMISSION_DENIED"
    case .serverRejectedRequest, .invalidArguments:
      code = "SERVER_REJECTED"
    case .limitExceeded:
      code = "LIMIT_EXCEEDED"
    case .changeTokenExpired:
      code = "TOKEN_EXPIRED"
    case .accountTemporarilyUnavailable:
      code = "NOT_AUTHENTICATED"
    case .alreadyShared:
      code = "ALREADY_SHARED"
    case .participantMayNeedVerification:
      code = "PARTICIPANT_NEEDS_VERIFICATION"
    case .referenceViolation:
      code = "REFERENCE_VIOLATION"
    default:
      code = "UNKNOWN"
      if let retryAfter = ckError.retryAfterSeconds {
        retryAfterSeconds = retryAfter
      }
    }

    return ExpoCloudKitBridgeError(
      code: code,
      message: ckError.localizedDescription,
      retryAfterSeconds: retryAfterSeconds,
      serverRecord: serverRecord
    )
  }

  // MARK: - Error Dictionary (for event payloads, not Promise rejection)

  /// Converts an Error to a simple `{code, message}` dictionary for use in
  /// sync event payloads sent over `sendEvent`. Not used for Promise rejection
  /// (use `toExpoError` for that).
  static func toErrorDict(_ error: Error) -> [String: Any] {
    if let ckError = error as? CKError {
      let bridgeError = toExpoError(ckError) as? ExpoCloudKitBridgeError
      return [
        "code": bridgeError?.code ?? "UNKNOWN",
        "message": bridgeError?.message ?? ckError.localizedDescription
      ]
    }
    // All other error types (including SyncAdapterError) fall through to the
    // generic path. LocalizedError.errorDescription is used when available.
    let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    return [
      "code": "UNKNOWN",
      "message": message
    ]
  }

  // MARK: - CKSubscription → Dictionary

  /// Converts a `CKSubscription` (either `CKQuerySubscription` or
  /// `CKDatabaseSubscription`) to a JS-bridge-safe dictionary.
  ///
  /// Shape:
  /// ```json
  /// {
  ///   "id":         "expo-ck-query-...",
  ///   "type":       "query" | "database" | "unknown",
  ///   "recordType": "Note",          // query subscriptions only
  ///   "zoneID":     { "zoneName": "...", "ownerName": "..." }  // query, if set
  /// }
  /// ```
  ///
  /// Note: `CKSubscription` does not expose which database the subscription
  /// was registered on. Callers should track database scope at registration time.
  static func toSubscriptionDict(_ subscription: CKSubscription) -> [String: Any] {
    var dict: [String: Any] = [
      "id": subscription.subscriptionID
    ]

    switch subscription {
    case let query as CKQuerySubscription:
      dict["type"] = "query"
      dict["recordType"] = query.recordType
      if let zoneID = query.zoneID {
        dict["zoneID"] = [
          "zoneName": zoneID.zoneName,
          "ownerName": zoneID.ownerName
        ]
      }

    case _ as CKDatabaseSubscription:
      dict["type"] = "database"

    default:
      dict["type"] = "unknown"
    }

    return dict
  }

  // MARK: - CKShare → Dictionary

  /// Converts a CKShare to a JS-bridge-safe dictionary.
  ///
  /// Shape:
  /// ```json
  /// {
  ///   "recordName":       "CK-share-uuid",
  ///   "zoneName":         "MyZone",
  ///   "publicPermission": "readOnly",
  ///   "url":              "https://www.icloud.com/...",
  ///   "participants":     [{ ... }]
  /// }
  /// ```
  static func toShareDictionary(_ share: CKShare) -> [String: Any] {
    var dict: [String: Any] = [
      "shareRecordName": share.recordID.recordName,
      "zoneName": share.recordID.zoneID.zoneName,
      "publicPermission": participantPermissionToString(share.publicPermission),
      "participants": share.participants.map { toParticipantDictionary($0) }
    ]

    if let url = share.url {
      dict["url"] = url.absoluteString
    }

    return dict
  }

  /// Converts a CKShare.Participant to a JS-bridge-safe dictionary.
  ///
  /// Shape:
  /// ```json
  /// {
  ///   "recordName":       "user-record-uuid",
  ///   "role":             "owner" | "privateUser" | "publicUser" | "unknown",
  ///   "permission":       "none" | "readOnly" | "readWrite" | "unknown",
  ///   "acceptanceStatus": "unknown" | "pending" | "accepted" | "removed"
  /// }
  /// ```
  static func toParticipantDictionary(_ participant: CKShare.Participant) -> [String: Any] {
    var dict: [String: Any] = [
      "role": participantRoleToString(participant.role),
      "permission": participantPermissionToString(participant.permission),
      "acceptanceStatus": participantAcceptanceToString(participant.acceptanceStatus),
      "isCurrentUser": participant.isCurrentUser
    ]

    if let userRecordID = participant.userIdentity.userRecordID {
      dict["participantRecordName"] = userRecordID.recordName
    }

    // Include name components when the user identity has been looked up.
    if let nameComponents = participant.userIdentity.nameComponents {
      var nameDict: [String: Any] = [:]
      if let givenName = nameComponents.givenName { nameDict["givenName"] = givenName }
      if let familyName = nameComponents.familyName { nameDict["familyName"] = familyName }
      dict["name"] = nameDict
    }

    return dict
  }

  /// Maps a JS permission string to CKShare.ParticipantPermission.
  /// Unknown strings map to `.none` (no access).
  static func toSharePermission(_ string: String) -> CKShare.ParticipantPermission {
    switch string {
    case "readOnly":  return .readOnly
    case "readWrite": return .readWrite
    default:          return .none
    }
  }

  /// Maps CKShare.ParticipantPermission to a JS-friendly string.
  static func participantPermissionToString(_ permission: CKShare.ParticipantPermission) -> String {
    switch permission {
    case .none:      return "none"
    case .readOnly:  return "readOnly"
    case .readWrite: return "readWrite"
    @unknown default: return "unknown"
    }
  }

  /// Maps CKShare.ParticipantRole to a JS-friendly string.
  static func participantRoleToString(_ role: CKShare.ParticipantRole) -> String {
    switch role {
    case .owner:       return "owner"
    case .privateUser: return "privateUser"
    case .publicUser:  return "publicUser"
    case .unknown:     return "unknown"
    @unknown default:  return "unknown"
    }
  }

  /// Maps CKShare.ParticipantAcceptanceStatus to a JS-friendly string.
  static func participantAcceptanceToString(_ status: CKShare.ParticipantAcceptanceStatus) -> String {
    switch status {
    case .unknown:  return "unknown"
    case .pending:  return "pending"
    case .accepted: return "accepted"
    case .removed:  return "removed"
    @unknown default: return "unknown"
    }
  }

  // MARK: - Private helpers

  private static func isoString(from date: Date?) -> String? {
    guard let date = date else { return nil }
    return ISO8601DateFormatter().string(from: date)
  }

  private static func asNSObject(_ value: Any?) -> NSObject {
    switch value {
    case let s as String: return s as NSString
    case let n as NSNumber: return n
    case let d as Date: return d as NSDate
    default: return NSNull()
    }
  }
}

// MARK: - Bridge error type

/// A structured error type that Expo's Promise.reject() can serialize to JS.
/// The `userInfo` dictionary keys match what CloudKitError.fromNativeError() expects.
struct ExpoCloudKitBridgeError: Error, LocalizedError {
  let code: String
  let message: String
  let retryAfterSeconds: Double?
  let serverRecord: [String: Any]?

  var errorDescription: String? { message }

  // Expo's error protocol reads these to build the JS error object
  var userInfo: [String: Any] {
    var info: [String: Any] = [
      "code": code,
      "message": message
    ]
    if let retry = retryAfterSeconds {
      info["retryAfterSeconds"] = retry
    }
    if let sr = serverRecord {
      info["serverRecord"] = sr
    }
    return info
  }
}

// MARK: - Converter errors

enum ConverterError: Error, LocalizedError {
  case missingField(String)
  case typeMismatch(String, Any?)
  case unknownType(String)

  var errorDescription: String? {
    switch self {
    case .missingField(let f): return "Missing required field: \(f)"
    case .typeMismatch(let expected, let got): return "Expected \(expected), got \(String(describing: got))"
    case .unknownType(let t): return "Unknown CloudKit field type: \(t)"
    }
  }
}
