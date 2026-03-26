import CloudKit
import Foundation

#if canImport(WidgetKit)
import WidgetKit
#endif

/// Bridges CloudKit record changes to WidgetKit timelines and ActivityKit Live Activities
/// via a shared App Group UserDefaults container.
///
/// On each sync cycle where watched zones have changes, this manager:
/// 1. Writes the changed records to App Group UserDefaults (keyed by binding ID)
/// 2. Calls WidgetCenter.shared.reloadTimelines(ofKind:) for registered widget bindings
/// 3. Invokes the `onActivityUpdate` callback for registered activity bindings so the
///    module can emit `onLiveActivityUpdate` events to JavaScript
///
/// The App Group identifier must be configured in app.config.ts via the
/// expo-cloudkit config plugin's `appGroupIdentifier` option.
///
/// - Note: WidgetKit is only available on iOS 14+; all WidgetCenter calls are
///   guarded with `#if canImport(WidgetKit)` so the file compiles on older SDKs.
final class CloudKitExtensionBridgeManager {

  // MARK: - Types

  /// Identifies a WidgetKit widget that should be refreshed when records in a
  /// given zone change.
  struct WidgetBinding {
    /// Opaque identifier provided by JS — used as the UserDefaults key suffix.
    let id: String
    /// Matches the `Widget.kind` string declared in the widget extension target.
    let widgetKind: String
    /// The zone whose changes trigger a reload.
    let zoneName: String
    /// Which CloudKit database the zone lives in.
    let database: CKDatabase.Scope
    /// If non-nil, only records of this type trigger a reload.
    let recordType: String?
  }

  /// Identifies an ActivityKit Live Activity that should receive update events
  /// when records in a given zone change.
  struct ActivityBinding {
    /// Opaque identifier provided by JS.
    let id: String
    /// Activity type identifier (e.g. "com.myapp.DeliveryActivity").
    let activityType: String
    /// The zone whose changes trigger an update event.
    let zoneName: String
    /// Which CloudKit database the zone lives in.
    let database: CKDatabase.Scope
    /// If non-nil, only records of this type trigger an event.
    let recordType: String?
  }

  // MARK: - State

  private let appGroupIdentifier: String

  /// Active widget bindings keyed by binding ID.
  private var widgetBindings: [String: WidgetBinding] = [:]

  /// Active activity bindings keyed by binding ID.
  private var activityBindings: [String: ActivityBinding] = [:]

  /// Timestamp of the last widget reload per widget kind, used for throttling.
  private var lastWidgetReload: [String: Date] = [:]

  /// Minimum time between consecutive reloads of the same widget kind.
  private let reloadThrottleInterval: TimeInterval = 300 // 5 minutes

  /// Called by the module to emit `onLiveActivityUpdate` events to JS.
  /// Parameters: (payload: [String: Any])
  var onActivityUpdate: (([String: Any]) -> Void)?

  // MARK: - Lifecycle

  init(appGroupIdentifier: String) {
    self.appGroupIdentifier = appGroupIdentifier
  }

  // MARK: - Registration

  /// Registers a widget binding. Replaces any existing binding with the same ID.
  func registerWidgetBinding(_ binding: WidgetBinding) {
    widgetBindings[binding.id] = binding
  }

  /// Removes the widget binding with the given ID. No-op if not found.
  func removeWidgetBinding(id: String) {
    widgetBindings.removeValue(forKey: id)
    lastWidgetReload.removeValue(forKey: id)
  }

  /// Registers a Live Activity binding. Replaces any existing binding with the same ID.
  func registerActivityBinding(_ binding: ActivityBinding) {
    activityBindings[binding.id] = binding
  }

  /// Removes the Live Activity binding with the given ID. No-op if not found.
  func removeActivityBinding(id: String) {
    activityBindings.removeValue(forKey: id)
  }

  // MARK: - Core: handle zone changes

  /// Called by the module after a sync cycle produces changed records for a zone.
  ///
  /// For each matching widget binding:
  ///   - Writes the record payload to shared UserDefaults.
  ///   - Requests a WidgetKit timeline reload (throttled to `reloadThrottleInterval`).
  ///
  /// For each matching activity binding:
  ///   - Invokes `onActivityUpdate` so the module can emit `onLiveActivityUpdate` to JS.
  ///
  /// - Parameters:
  ///   - zoneName: The name of the CloudKit zone that changed.
  ///   - database: The database scope the zone belongs to.
  ///   - changedRecords: Serialisable record dictionaries (output of `Converters.toDictionary`).
  ///   - deletedRecordIDs: Array of `{ recordName, zoneName }` dicts for deleted records.
  func handleZoneChanges(
    zoneName: String,
    database: CKDatabase.Scope,
    changedRecords: [[String: Any]],
    deletedRecordIDs: [[String: Any]]
  ) {
    // --- Widget bindings -------------------------------------------------------
    let matchingWidgets = widgetBindings.values.filter {
      $0.zoneName == zoneName && $0.database == database
    }

    for binding in matchingWidgets {
      // Filter by recordType when specified.
      let filtered = filterRecords(changedRecords, by: binding.recordType)
      guard !filtered.isEmpty || !deletedRecordIDs.isEmpty else { continue }

      persistToSharedDefaults(
        bindingId: binding.id,
        changedRecords: filtered,
        deletedRecordIDs: deletedRecordIDs
      )

      reloadWidgetTimeline(widgetKind: binding.widgetKind)
    }

    // --- Activity bindings ----------------------------------------------------
    let matchingActivities = activityBindings.values.filter {
      $0.zoneName == zoneName && $0.database == database
    }

    for binding in matchingActivities {
      let filtered = filterRecords(changedRecords, by: binding.recordType)
      guard !filtered.isEmpty || !deletedRecordIDs.isEmpty else { continue }

      // Persist to shared defaults so the extension target can read state directly.
      persistToSharedDefaults(
        bindingId: binding.id,
        changedRecords: filtered,
        deletedRecordIDs: deletedRecordIDs
      )

      let payload: [String: Any] = [
        "bindingId": binding.id,
        "activityType": binding.activityType,
        "zoneName": zoneName,
        "databaseScope": scopeString(database),
        "changedRecords": filtered,
        "deletedRecordIDs": deletedRecordIDs
      ]
      onActivityUpdate?(payload)
    }
  }

  /// Manually requests a WidgetKit timeline reload for a specific widget kind,
  /// bypassing throttle. Useful when JS explicitly calls `reloadWidgetTimeline`.
  func forceReloadWidgetTimeline(widgetKind: String) {
    lastWidgetReload[widgetKind] = Date()
    #if canImport(WidgetKit)
    if #available(iOS 14, *) {
      WidgetCenter.shared.reloadTimelines(ofKind: widgetKind)
    }
    #endif
  }

  // MARK: - Private helpers

  /// Requests a WidgetKit timeline reload for the given kind, subject to
  /// `reloadThrottleInterval` (5 minutes).
  func reloadWidgetTimeline(widgetKind: String) {
    let now = Date()
    if let last = lastWidgetReload[widgetKind],
       now.timeIntervalSince(last) < reloadThrottleInterval {
      // Throttled — too soon since last reload.
      return
    }
    lastWidgetReload[widgetKind] = now

    #if canImport(WidgetKit)
    if #available(iOS 14, *) {
      WidgetCenter.shared.reloadTimelines(ofKind: widgetKind)
    }
    #endif
  }

  /// Writes a record payload to the shared App Group UserDefaults under the key
  /// `"expo.cloudkit.widget.<bindingId>"` as JSON-encoded data.
  ///
  /// The widget extension target reads this key to hydrate its timeline entries.
  private func persistToSharedDefaults(
    bindingId: String,
    changedRecords: [[String: Any]],
    deletedRecordIDs: [[String: Any]]
  ) {
    guard let defaults = sharedDefaults() else { return }

    let key = "expo.cloudkit.widget.\(bindingId)"
    let payload: [String: Any] = [
      "changedRecords": changedRecords,
      "deletedRecordIDs": deletedRecordIDs,
      "updatedAt": Date().timeIntervalSince1970 * 1000
    ]

    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
    defaults.set(data, forKey: key)
  }

  /// Returns the App Group UserDefaults suite, or nil if the identifier is
  /// not configured in the app's entitlements.
  private func sharedDefaults() -> UserDefaults? {
    UserDefaults(suiteName: appGroupIdentifier)
  }

  /// Filters `records` to those whose `recordType` field matches `type`.
  /// Returns all records unchanged when `type` is nil.
  private func filterRecords(_ records: [[String: Any]], by type: String?) -> [[String: Any]] {
    guard let type = type else { return records }
    return records.filter { ($0["recordType"] as? String) == type }
  }

  /// Maps a `CKDatabase.Scope` to the string used in JS event payloads.
  private func scopeString(_ scope: CKDatabase.Scope) -> String {
    switch scope {
    case .private:  return "private"
    case .shared:   return "shared"
    case .public:   return "public"
    @unknown default: return "private"
    }
  }
}
