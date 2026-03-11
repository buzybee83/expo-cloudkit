import CloudKit
import Foundation

// MARK: - Sync Provider Events

/// Events emitted by a sync provider, forwarded to JS via ExpoCloudKitModule.
enum SyncProviderEvent {
  case stateChanged(SyncProviderState)
  case recordsFetched(changed: [CKRecord], deleted: [CKRecord.ID], zoneName: String)
  case recordsSent(saved: [CKRecord], failed: [(CKRecord.ID, Error)])
  case syncError(Error)
}

// MARK: - Sync Provider State

/// Possible lifecycle states for a sync provider.
enum SyncProviderState: String {
  case idle = "idle"
  case syncing = "syncing"
  case suspended = "suspended"
  case notStarted = "notStarted"
}

// MARK: - Sync Provider Protocol

/// Abstraction over CKSyncEngine (iOS 17+) and the manual token fetch fallback (iOS 16).
///
/// The module file holds a `CloudKitSyncProvider?` reference and calls through it.
/// The `#available` check happens exactly once at `startSyncEngine()` time to select
/// the correct implementation. All subsequent calls are dispatch-agnostic.
protocol CloudKitSyncProvider: AnyObject {

  /// Whether this provider uses CKSyncEngine (true) or the manual fallback (false).
  var usesSyncEngine: Bool { get }

  /// Current lifecycle state of the sync provider.
  var state: SyncProviderState { get }

  /// Start syncing the specified zones.
  ///
  /// - Parameters:
  ///   - zones: CKRecordZone IDs to track.
  ///   - database: Which CloudKit database scope to sync.
  ///   - automaticallySync: Whether the provider should schedule syncs automatically.
  ///     On iOS 17+ this uses CKSyncEngine's built-in scheduling.
  ///     On iOS 16 this starts a polling timer.
  ///   - eventHandler: Closure called on each sync event. The module layer dispatches
  ///     emission to the main queue before calling `sendEvent`.
  func start(
    zones: [CKRecordZone.ID],
    database: CKDatabase.Scope,
    automaticallySync: Bool,
    eventHandler: @escaping (SyncProviderEvent) -> Void
  )

  /// Stop syncing and release resources (timers, engine references, etc.).
  func stop()

  /// Manually trigger a sync cycle. On iOS 17+ this asks CKSyncEngine to fetch;
  /// on iOS 16 it immediately runs a fetch+push cycle outside the timer.
  func triggerSync()

  /// Enqueue a record save for the next sync cycle.
  func enqueueSave(_ record: CKRecord)

  /// Enqueue a record deletion for the next sync cycle.
  func enqueueDelete(_ recordID: CKRecord.ID)
}

// MARK: - Change Token Store

/// Manages persistence of CKSyncEngine state (iOS 17+) and per-zone
/// CKServerChangeTokens (iOS 16) in UserDefaults.
///
/// Key schema:
///   expo.cloudkit.<containerID>.syncEngineState         — CKSyncEngine.State.Serialization
///   expo.cloudkit.<containerID>.token.<scope>.<zone>    — CKServerChangeToken
///
/// If UserDefaults are cleared (e.g. app reinstall), the adapters perform a full
/// re-sync — this is safe but expensive. Both adapters handle nil tokens correctly.
final class ChangeTokenStore {

  // MARK: - Properties

  private let defaults: UserDefaults
  /// e.g. "expo.cloudkit.iCloud.com.example.myapp"
  private let prefix: String

  // MARK: - Init

  init(containerIdentifier: String, defaults: UserDefaults = .standard) {
    self.prefix = "expo.cloudkit.\(containerIdentifier)"
    self.defaults = defaults
  }

  // MARK: - iOS 17+ CKSyncEngine State

  /// Persists the CKSyncEngine state serialization blob.
  /// Must be called on every `.stateUpdate` event to keep the token current.
  @available(iOS 17, macOS 14, *)
  func saveSyncEngineState(_ serialization: CKSyncEngine.State.Serialization) {
    do {
      let data = try NSKeyedArchiver.archivedData(
        withRootObject: serialization,
        requiringSecureCoding: true
      )
      defaults.set(data, forKey: key("syncEngineState"))
    } catch {
      // Non-fatal: next launch will trigger a full re-sync
    }
  }

  /// Loads the previously persisted CKSyncEngine state serialization, or nil
  /// if none exists (triggers a full re-sync on first launch or after token loss).
  @available(iOS 17, macOS 14, *)
  func loadSyncEngineState() -> CKSyncEngine.State.Serialization? {
    guard let data = defaults.data(forKey: key("syncEngineState")) else { return nil }
    return try? NSKeyedUnarchiver.unarchivedObject(
      ofClass: CKSyncEngine.State.Serialization.self,
      from: data
    )
  }

  // MARK: - iOS 16 Per-Zone Tokens

  /// Persists a per-zone CKServerChangeToken.
  func saveZoneToken(_ token: CKServerChangeToken, zoneID: CKRecordZone.ID, scope: CKDatabase.Scope) {
    do {
      let data = try NSKeyedArchiver.archivedData(
        withRootObject: token,
        requiringSecureCoding: true
      )
      defaults.set(data, forKey: zoneTokenKey(zoneID: zoneID, scope: scope))
    } catch {
      // Non-fatal: next fetch will be a full re-sync for this zone
    }
  }

  /// Loads the persisted CKServerChangeToken for a zone, or nil if not found.
  /// Passing nil as the change token to CKFetchRecordZoneChangesOperation
  /// fetches all records from the beginning of time.
  func loadZoneToken(zoneID: CKRecordZone.ID, scope: CKDatabase.Scope) -> CKServerChangeToken? {
    guard let data = defaults.data(forKey: zoneTokenKey(zoneID: zoneID, scope: scope)) else {
      return nil
    }
    return try? NSKeyedUnarchiver.unarchivedObject(
      ofClass: CKServerChangeToken.self,
      from: data
    )
  }

  /// Clears the token for a single zone. The next fetch for this zone will
  /// be a full re-sync (from the beginning of the zone's history).
  /// Used when `changeTokenExpired` is returned for one zone without
  /// affecting tokens for other zones.
  func clearZoneToken(zoneID: CKRecordZone.ID, scope: CKDatabase.Scope) {
    defaults.removeObject(forKey: zoneTokenKey(zoneID: zoneID, scope: scope))
  }

  /// Clears all tokens for this container — used after an account change event.
  /// After clearing, the next sync will be a full re-sync.
  func clearAllTokens() {
    let allKeys = defaults.dictionaryRepresentation().keys.filter {
      $0.hasPrefix(prefix)
    }
    for k in allKeys {
      defaults.removeObject(forKey: k)
    }
  }

  // MARK: - Key Construction

  private func key(_ suffix: String) -> String {
    return "\(prefix).\(suffix)"
  }

  private func zoneTokenKey(zoneID: CKRecordZone.ID, scope: CKDatabase.Scope) -> String {
    let scopeStr: String
    switch scope {
    case .private: scopeStr = "private"
    case .shared:  scopeStr = "shared"
    case .public:  scopeStr = "public"
    @unknown default: scopeStr = "private"
    }
    return "\(prefix).token.\(scopeStr).\(zoneID.zoneName)"
  }
}
