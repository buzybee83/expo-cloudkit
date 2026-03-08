import CloudKit
import Foundation

/// Parses incoming remote notification payloads and converts CloudKit notifications
/// into JS event dictionaries.
///
/// Call `handle(userInfo:sendEvent:)` from the app delegate (or the Expo module's
/// `OnAppDidReceiveRemoteNotification` lifecycle hook). Non-CloudKit payloads are
/// ignored and the method returns `false` so the caller can forward them to other
/// handlers.
///
/// # Event Shape
/// All events use the `"onSubscriptionEvent"` channel and carry a `type` key:
///
///   Query notification:
///   ```json
///   {
///     "subscriptionID": "expo-ck-query-...",
///     "type": "query",
///     "notificationType": "created" | "updated" | "deleted",
///     "recordID": { "recordName": "...", "zoneName": "..." },
///     "recordFields": { ... }   // only if server sent fields
///   }
///   ```
///
///   Database notification:
///   ```json
///   {
///     "subscriptionID": "expo-ck-db-...",
///     "type": "database",
///     "databaseScope": "private" | "shared" | "public"
///   }
///   ```
final class CloudKitNotificationHandler {

  // MARK: - Public Entry Point

  /// Processes a remote notification payload.
  ///
  /// - Parameters:
  ///   - userInfo: The raw `[AnyHashable: Any]` dictionary from the notification.
  ///   - sendEvent: Closure that emits a JS event dictionary on `"onSubscriptionEvent"`.
  ///     Always called on the main queue.
  /// - Returns: `true` if the payload was a CloudKit notification and was handled;
  ///   `false` if it was not a CloudKit notification.
  @discardableResult
  static func handle(
    userInfo: [AnyHashable: Any],
    sendEvent: @escaping ([String: Any]) -> Void
  ) -> Bool {
    // CKNotification(fromRemoteNotificationDictionary:) returns nil for
    // non-CloudKit payloads — this is our guard for non-CK pushes.
    guard let ckNotification = CKNotification(fromRemoteNotificationDictionary: userInfo) else {
      return false
    }

    let payload = buildPayload(from: ckNotification)

    // Always emit on the main queue so `sendEvent` (which calls into Expo's
    // JS thread) is called from a safe context.
    DispatchQueue.main.async {
      sendEvent(payload)
    }

    return true
  }

  // MARK: - Payload Construction

  private static func buildPayload(from notification: CKNotification) -> [String: Any] {
    switch notification.notificationType {

    case .query:
      return buildQueryPayload(notification as? CKQueryNotification)

    case .database:
      return buildDatabasePayload(notification as? CKDatabaseNotification)

    case .recordZone:
      // CKRecordZoneNotification is deprecated in favor of CKDatabaseNotification.
      // We surface it minimally so JS is at least aware a change occurred.
      var payload: [String: Any] = ["type": "recordZone"]
      if let subscriptionID = notification.subscriptionID {
        payload["subscriptionID"] = subscriptionID
      }
      return payload

    case .readNotification:
      var payload: [String: Any] = ["type": "readNotification"]
      if let subscriptionID = notification.subscriptionID {
        payload["subscriptionID"] = subscriptionID
      }
      return payload

    @unknown default:
      var payload: [String: Any] = ["type": "unknown"]
      if let subscriptionID = notification.subscriptionID {
        payload["subscriptionID"] = subscriptionID
      }
      return payload
    }
  }

  // MARK: - Query Notification

  private static func buildQueryPayload(_ notification: CKQueryNotification?) -> [String: Any] {
    var payload: [String: Any] = ["type": "query"]

    if let subscriptionID = notification?.subscriptionID {
      payload["subscriptionID"] = subscriptionID
    }

    // Map CKQueryNotification.Reason to a JS string
    if let queryReason = notification?.queryNotificationReason {
      payload["notificationType"] = notificationTypeString(queryReason)
    }

    // Record identity — present for created/updated/deleted notifications
    if let recordID = notification?.recordID {
      payload["recordID"] = [
        "recordName": recordID.recordName,
        "zoneName": recordID.zoneID.zoneName
      ]
    }

    // Record fields — only populated when the subscription's `desiredKeys`
    // caused the server to embed field values in the push payload.
    if let recordFields = notification?.recordFields, !recordFields.isEmpty {
      var fields: [String: Any] = [:]
      for (key, value) in recordFields {
        // recordFields values are basic Foundation types (String, NSNumber, etc.)
        // that are already JS-safe — wrap them with a type tag for consistency
        // with the rest of the SDK's field representation.
        fields[key] = ["value": value]
      }
      payload["recordFields"] = fields
    }

    return payload
  }

  // MARK: - Database Notification

  private static func buildDatabasePayload(_ notification: CKDatabaseNotification?) -> [String: Any] {
    var payload: [String: Any] = ["type": "database"]

    if let subscriptionID = notification?.subscriptionID {
      payload["subscriptionID"] = subscriptionID
    }

    if let scope = notification?.databaseScope {
      payload["databaseScope"] = databaseScopeString(scope)
    }

    return payload
  }

  // MARK: - String Helpers

  private static func notificationTypeString(_ reason: CKQueryNotification.Reason) -> String {
    switch reason {
    case .recordCreated:  return "created"
    case .recordUpdated:  return "updated"
    case .recordDeleted:  return "deleted"
    @unknown default:     return "unknown"
    }
  }

  private static func databaseScopeString(_ scope: CKDatabase.Scope) -> String {
    switch scope {
    case .private:  return "private"
    case .shared:   return "shared"
    case .public:   return "public"
    @unknown default: return "private"
    }
  }
}
