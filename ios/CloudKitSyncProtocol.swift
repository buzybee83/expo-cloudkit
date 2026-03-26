import CloudKit
import Foundation

// MARK: - Conflict Resolution Strategy

/// Determines how write conflicts are resolved when a client save is rejected
/// by CloudKit because the server has a newer record version.
enum ConflictStrategy: String {
  /// Accept the server record as-is. The client change is discarded. (default)
  case serverWins
  /// Take all client fields, stamp the record with the server's changeTag,
  /// and re-enqueue. Overwrites any concurrent server-side changes.
  case clientWins
  /// Per-field merge: for each field, prefer the version (client or server)
  /// whose record has the more recent modificationDate. Re-enqueues merged record.
  case fieldLevelMerge
  /// Emit a `recordsSent` failure event so JS can implement custom merge logic.
  /// Equivalent to the legacy `resolveConflicts: true` behaviour.
  case manual
  /// Auto-merge using CRDT algorithms defined in `crdtSchema`.
  /// CRDT-governed fields are merged by `CRDTManager.merge`; all other fields
  /// fall back to server-wins.
  case crdtMerge
}

// MARK: - Sync Provider Events

/// Events emitted by a sync provider, forwarded to JS via ExpoCloudKitModule.
enum SyncProviderEvent {
  case stateChanged(SyncProviderState)
  case recordsFetched(changed: [CKRecord], deleted: [CKRecord.ID], zoneName: String)
  case recordsSent(saved: [CKRecord], failed: [(CKRecord.ID, Error)])
  case syncError(Error)
  /// Emitted when `conflictResolutionEnabled` is true and a CONFLICT error occurs.
  /// The `payload` dictionary is forwarded verbatim as the `onSyncConflict` event body.
  case conflictPending(requestId: String, payload: [String: Any])
  /// Emitted after each complete sync cycle with aggregate health metrics.
  case syncHealth(sentCount: Int, receivedCount: Int, failedCount: Int, durationMs: Double, syncEngine: Bool)
  /// Emitted once after a full zone pull cycle finishes — the "sync is done" signal.
  /// `recordCount` is the total across all `recordsFetched` batches in this cycle.
  /// `zoneNames` lists every zone that was polled.
  /// `isInitialSync` is true when there was no persisted change token before this cycle.
  case syncCompleted(recordCount: Int, zoneNames: [String], isInitialSync: Bool)
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
///
/// # Actor Conformance
/// Both concrete implementations (`CloudKitSyncEngineAdapter` and
/// `CloudKitSyncFallbackAdapter`) are Swift `actor` types. Protocol methods are
/// therefore implicitly `async` when called through the protocol — callers must
/// use `await` or wrap in a `Task { await provider.method() }`.
///
/// `usesSyncEngine` and `state` are `nonisolated` on both implementations so that
/// the synchronous `getSyncState()` JS function can read them without `await`.
protocol CloudKitSyncProvider: AnyObject, Sendable {

  /// Whether this provider uses CKSyncEngine (true) or the manual fallback (false).
  /// Declared `nonisolated` on actor conformers so it can be read synchronously.
  var usesSyncEngine: Bool { get }

  /// Current lifecycle state of the sync provider.
  /// Declared `nonisolated(unsafe)` on actor conformers for synchronous module access.
  var state: SyncProviderState { get }

  /// Start syncing the specified zones.
  ///
  /// - Parameters:
  ///   - zones: CKRecordZone IDs to track.
  ///   - database: Which CloudKit database scope to sync.
  ///   - automaticallySync: Whether the provider should schedule syncs automatically.
  ///     On iOS 17+ this uses CKSyncEngine's built-in scheduling.
  ///     On iOS 16 this starts a polling timer.
  ///   - eventHandler: Closure called on each sync event. Both adapters dispatch
  ///     emission to @MainActor before calling the handler.
  func start(
    zones: [CKRecordZone.ID],
    database: CKDatabase.Scope,
    automaticallySync: Bool,
    eventHandler: @escaping (SyncProviderEvent) -> Void
  ) async

  /// Stop syncing and release resources (timers, engine references, etc.).
  func stop() async

  /// Manually trigger a sync cycle. On iOS 17+ this asks CKSyncEngine to fetch;
  /// on iOS 16 it immediately runs a fetch+push cycle outside the timer.
  func triggerSync() async

  /// Enqueue a record save for the next sync cycle.
  func enqueueSave(_ record: CKRecord) async

  /// Enqueue a record deletion for the next sync cycle.
  func enqueueDelete(_ recordID: CKRecord.ID) async

  /// Adds a new zone to the running sync provider without requiring a restart.
  ///
  /// On iOS 17+ (`CloudKitSyncEngineAdapter`), this adds a pending zone save to
  /// `CKSyncEngine.state` so the engine registers and fetches the zone on its next cycle.
  /// On iOS 16 (`CloudKitSyncFallbackAdapter`), this appends the zone to `trackedZones`
  /// and immediately triggers a fetch for the new zone only.
  ///
  /// Used by the `autoSyncNewShares` feature to add newly-accepted shared zones
  /// to a running shared-database sync provider without a full restart.
  func addZone(_ zoneID: CKRecordZone.ID) async

  /// Strategy for resolving write conflicts detected during a sync cycle.
  ///
  /// Set this before calling `start()`. Both adapter implementations expose this as
  /// `nonisolated(unsafe)` so the module can write it synchronously before crossing
  /// the actor boundary. It is written exactly once at configuration time.
  ///
  /// - `serverWins`: Use the server record unchanged. Client change is discarded. (default)
  /// - `clientWins`: Copy all client fields over the server record and re-enqueue.
  /// - `fieldLevelMerge`: Per-field: prefer whichever record (client/server) was modified more recently.
  /// - `manual`: Surface via `onSyncConflict` event so JS can implement custom resolution.
  ///
  /// `conflictResolutionEnabled` is a backwards-compat alias: setting it true is
  /// equivalent to setting `conflictStrategy = .manual`.
  var conflictStrategy: ConflictStrategy { get set }

  /// Backwards-compatibility alias for `conflictStrategy = .manual`.
  /// Setting this to `true` overrides `conflictStrategy` to `.manual`.
  /// Ignored when `conflictStrategy` is set explicitly in `startSyncEngine` config.
  var conflictResolutionEnabled: Bool { get set }

  /// Resumes a pending conflict resolution continuation. Called by the module when JS
  /// invokes `resolveSyncConflict(requestId, resolvedRecord)`.
  ///
  /// - Parameters:
  ///   - requestId: The UUID string that was included in the `onSyncConflict` event.
  ///   - resolvedRecord: A JS-bridge dictionary for the resolved record, or nil to accept
  ///     the server version unchanged.
  func resumeConflictResolution(requestId: String, resolvedRecord: [String: Any]?) async
}

// MARK: - Change Token Store

/// Manages persistence of CKSyncEngine state (iOS 17+) and per-zone
/// CKServerChangeTokens (iOS 16) in UserDefaults.
///
/// Key schema:
///   expo.cloudkit.<containerID>.syncEngineState.<scope> — CKSyncEngine.State.Serialization
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
  ///
  /// CKSyncEngine.State.Serialization conforms to Codable (iOS 17+) and
  /// NSSecureCoding (iOS 17–17.x). In iOS 18+, NSSecureCoding was removed;
  /// we use PropertyListEncoder which works across all supported versions.
  ///
  /// The `scope` parameter qualifies the key so multiple engines (private,
  /// shared) can each persist their own state without overwriting each other.
  /// The default value of `.private` keeps backwards compatibility for any
  /// call sites that do not pass a scope explicitly.
  @available(iOS 17, macOS 14, *)
  func saveSyncEngineState(_ serialization: CKSyncEngine.State.Serialization, scope: CKDatabase.Scope = .private) {
    let scopeStr = scopeString(scope)
    do {
      let data = try PropertyListEncoder().encode(serialization)
      defaults.set(data, forKey: key("syncEngineState.\(scopeStr)"))
    } catch {
      // Non-fatal: next launch will trigger a full re-sync
    }
  }

  /// Loads the previously persisted CKSyncEngine state serialization, or nil
  /// if none exists (triggers a full re-sync on first launch or after token loss).
  ///
  /// Pass `scope` to load state for a specific database scope. Defaults to `.private`
  /// for backwards compatibility.
  @available(iOS 17, macOS 14, *)
  func loadSyncEngineState(scope: CKDatabase.Scope = .private) -> CKSyncEngine.State.Serialization? {
    let scopeStr = scopeString(scope)
    guard let data = defaults.data(forKey: key("syncEngineState.\(scopeStr)")) else { return nil }
    return try? PropertyListDecoder().decode(CKSyncEngine.State.Serialization.self, from: data)
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
    return "\(prefix).token.\(scopeString(scope)).\(zoneID.zoneName)"
  }

  private func scopeString(_ scope: CKDatabase.Scope) -> String {
    switch scope {
    case .private: return "private"
    case .shared:  return "shared"
    case .public:  return "public"
    @unknown default: return "private"
    }
  }
}
