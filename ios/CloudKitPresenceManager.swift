import CloudKit
import Foundation

// MARK: - Presence Record Constants

private let kPresenceRecordType = "ExpoPresence"
private let kFieldUserId = "userId"
private let kFieldDisplayName = "displayName"
private let kFieldLastSeen = "lastSeen"
private let kFieldStatus = "status"
private let kFieldCursor = "cursor"
private let kFieldMetadata = "metadata"

// Heartbeat every 30 s; offline threshold at 90 s (3 missed heartbeats)
private let kHeartbeatInterval: TimeInterval = 30
private let kOfflineThreshold: TimeInterval = 90
// Cursor writes are debounced 500 ms before enqueueing to CloudKit
private let kCursorDebounceDelay: TimeInterval = 0.5

// MARK: - CloudKitPresenceManager

/// Manages real-time presence for shared CloudKit zones.
///
/// Presence state is persisted as `ExpoPresence` CKRecord instances — one per
/// (local user, zone) pair. The sync engine delivers these records alongside
/// regular records; this manager intercepts them before they reach the JS layer.
///
/// Heartbeat interval: 30 seconds
/// Offline threshold:  90 seconds (3 missed heartbeats)
/// Cursor coalescing:  500 ms debounce before writing to CloudKit
///
/// All mutable state is confined to the `actor`, providing data-race safety
/// without explicit locks.
actor CloudKitPresenceManager {

  // MARK: - Types

  struct PresenceEntry {
    let userRecordName: String
    let displayName: String?
    var status: String           // "active", "idle", "editing", "offline"
    var cursor: [String: Any]?   // app-defined position data (opaque JSON)
    var metadata: [String: Any]? // app-defined extras (avatar URL, color, etc.)
    var lastSeen: Date
    var isOnline: Bool { Date().timeIntervalSince(lastSeen) < kOfflineThreshold }
    var isCurrentUser: Bool      // set by handlePresenceRecords based on localUserRecordName

    /// JS-bridge-safe dictionary. Always resolves the online flag from the current time.
    func toDictionary() -> [String: Any] {
      var dict: [String: Any] = [
        "userRecordName": userRecordName,
        "displayName": displayName as Any,
        "status": isOnline ? status : "offline",
        "lastSeen": lastSeen.timeIntervalSince1970 * 1000, // Unix ms
        "isCurrentUser": isCurrentUser
      ]
      if let cursor = cursor {
        dict["cursor"] = cursor
      } else {
        dict["cursor"] = NSNull()
      }
      if let metadata = metadata {
        dict["metadata"] = metadata
      } else {
        dict["metadata"] = NSNull()
      }
      return dict
    }
  }

  // MARK: - State

  private let ckContainer: CKContainer
  private let database: CKDatabase
  private let zoneName: String
  private let localUserRecordName: String

  /// The CKRecord owned by the local user — kept in memory, updated on heartbeat and status/cursor changes.
  private var localPresenceRecord: CKRecord?

  /// Debounced cursor writes — tracks the most recent cursor value to flush.
  private var pendingCursorValue: [String: Any]?
  private var cursorDebounceTask: Task<Void, Never>?

  /// Heartbeat loop task.
  private var heartbeatTask: Task<Void, Never>?

  /// All known participants, keyed by their userRecordName.
  private var knownPresence: [String: PresenceEntry] = [:]

  /// Called by the module layer to emit events to JS.
  /// Weak reference pattern is achieved by storing a closure that captures `[weak module]` at the call site.
  var onPresenceChanged: (([String: Any]) -> Void)?

  /// Enqueue-save closure injected by the module layer (calls `syncProvider.enqueueSave`).
  var enqueueSave: ((CKRecord) -> Void)?

  /// Enqueue-delete closure injected by the module layer.
  var enqueueDelete: ((CKRecord.ID) -> Void)?

  // MARK: - Init

  init(
    ckContainer: CKContainer,
    database: CKDatabase,
    zoneName: String,
    localUserRecordName: String
  ) {
    self.ckContainer = ckContainer
    self.database = database
    self.zoneName = zoneName
    self.localUserRecordName = localUserRecordName
  }

  // MARK: - Public API

  /// Starts presence tracking by writing an initial presence record and launching the heartbeat.
  func start(displayName: String?, initialStatus: String, metadata: [String: Any]?) async {
    let recordName = presenceRecordName(for: localUserRecordName)
    let zoneID = CKRecordZone.ID(zoneName: zoneName, ownerName: CKCurrentUserDefaultName)
    let recordID = CKRecord.ID(recordName: recordName, zoneID: zoneID)
    let record = CKRecord(recordType: kPresenceRecordType, recordID: recordID)
    record[kFieldUserId] = localUserRecordName as CKRecordValue
    record[kFieldDisplayName] = displayName as CKRecordValue?
    record[kFieldLastSeen] = Date() as CKRecordValue
    record[kFieldStatus] = (initialStatus.isEmpty ? "active" : initialStatus) as CKRecordValue
    if let metadata = metadata, let json = jsonString(from: metadata) {
      record[kFieldMetadata] = json as CKRecordValue
    }
    localPresenceRecord = record

    // Persist immediately — don't wait for the first heartbeat tick.
    await writeLocalPresence()

    // Start the 30-second heartbeat loop.
    heartbeatTask?.cancel()
    heartbeatTask = startHeartbeat()
  }

  /// Stops presence tracking: cancels the heartbeat, deletes the local presence record.
  func stop() async {
    heartbeatTask?.cancel()
    heartbeatTask = nil
    cursorDebounceTask?.cancel()
    cursorDebounceTask = nil
    await deleteLocalPresence()
    localPresenceRecord = nil
    knownPresence.removeAll()
  }

  /// Updates the local cursor position. Debounced 500 ms before writing to CloudKit.
  func updateCursor(_ cursor: [String: Any]) async {
    pendingCursorValue = cursor
    cursorDebounceTask?.cancel()
    cursorDebounceTask = Task {
      do {
        try await Task.sleep(nanoseconds: UInt64(kCursorDebounceDelay * 1_000_000_000))
      } catch {
        return // Task was cancelled — a newer cursor update is pending
      }
      await flushPendingCursor()
    }
  }

  /// Updates the local status field and writes to CloudKit immediately.
  func updateStatus(_ status: String) async {
    guard let record = localPresenceRecord else { return }
    record[kFieldStatus] = status as CKRecordValue
    await writeLocalPresence()
  }

  /// Returns all currently online presence entries (including the local user).
  func allOnlineParticipants() -> [[String: Any]] {
    knownPresence.values
      .filter { $0.isOnline }
      .map { $0.toDictionary() }
  }

  // MARK: - Incoming Presence Records (called by module when sync delivers ExpoPresence records)

  /// Processes `ExpoPresence` records received from the sync engine.
  ///
  /// For each record the manager:
  /// 1. Updates `knownPresence`.
  /// 2. Determines the change type (joined / updated / left).
  /// 3. Emits `onPresenceChanged` with the parsed entry.
  ///
  /// Never touches business records — those are filtered at the call site
  /// in `ExpoCloudKitModule.handleSyncEvent`.
  func handlePresenceRecords(_ records: [CKRecord]) async {
    for record in records {
      guard record.recordType == kPresenceRecordType else { continue }
      guard let userId = record[kFieldUserId] as? String else { continue }

      let lastSeen = (record[kFieldLastSeen] as? Date) ?? Date(timeIntervalSince1970: 0)
      let status = (record[kFieldStatus] as? String) ?? "active"
      let displayName = record[kFieldDisplayName] as? String
      let cursorJSON = record[kFieldCursor] as? String
      let metadataJSON = record[kFieldMetadata] as? String

      let cursor = cursorJSON.flatMap { parsedDict(from: $0) }
      let metadata = metadataJSON.flatMap { parsedDict(from: $0) }

      let wasOnline = knownPresence[userId]?.isOnline ?? false
      var entry = PresenceEntry(
        userRecordName: userId,
        displayName: displayName,
        status: status,
        cursor: cursor,
        metadata: metadata,
        lastSeen: lastSeen,
        isCurrentUser: userId == localUserRecordName
      )

      let changeType: String
      if knownPresence[userId] == nil {
        changeType = "joined"
      } else if !wasOnline {
        changeType = "joined" // came back online
      } else {
        // Synthesize "left" for entries that have drifted past the threshold
        changeType = entry.isOnline ? "updated" : "left"
      }

      knownPresence[userId] = entry

      // Emit to JS only if we have a callback wired up.
      emitPresenceChanged(entry: entry, changeType: changeType)
    }

    // Passive stale-check: mark online→offline for entries we haven't received
    // an update for since the threshold. We don't delete them — only the owner deletes.
    for (userId, entry) in knownPresence {
      guard !entry.isOnline, userId != localUserRecordName else { continue }
      // Emit "left" once per transition — detect by checking last-emitted state.
      // Simple heuristic: re-emit "left" if we see them for the first time as offline.
      if entry.status != "offline" {
        var updated = entry
        updated.status = "offline"
        knownPresence[userId] = updated
        emitPresenceChanged(entry: updated, changeType: "left")
      }
    }
  }

  /// Handles a deleted ExpoPresence record (participant departed cleanly).
  func handlePresenceDeletion(recordID: CKRecord.ID) async {
    let userId = userRecordName(fromPresenceRecordID: recordID)
    guard let entry = knownPresence[userId] else { return }
    knownPresence.removeValue(forKey: userId)
    emitPresenceChanged(entry: entry, changeType: "left")
  }

  // MARK: - Private helpers

  private func writeLocalPresence() async {
    guard let record = localPresenceRecord else { return }
    record[kFieldLastSeen] = Date() as CKRecordValue
    // Use the injected enqueue closure so the record goes through the sync engine
    // batch pipeline rather than a standalone save operation.
    enqueueSave?(record)
  }

  private func deleteLocalPresence() async {
    guard let record = localPresenceRecord else { return }
    enqueueDelete?(record.recordID)
  }

  private func flushPendingCursor() async {
    guard let cursor = pendingCursorValue,
          let record = localPresenceRecord else { return }
    pendingCursorValue = nil
    if let json = jsonString(from: cursor) {
      record[kFieldCursor] = json as CKRecordValue
    } else {
      record[kFieldCursor] = nil
    }
    await writeLocalPresence()
  }

  private func startHeartbeat() -> Task<Void, Never> {
    Task { [weak self] in
      while !Task.isCancelled {
        do {
          try await Task.sleep(nanoseconds: UInt64(kHeartbeatInterval * 1_000_000_000))
        } catch {
          break // cancelled
        }
        guard !Task.isCancelled else { break }
        await self?.writeLocalPresence()
      }
    }
  }

  private func emitPresenceChanged(entry: PresenceEntry, changeType: String) {
    guard let callback = onPresenceChanged else { return }
    var payload = entry.toDictionary()
    payload["changeType"] = changeType
    payload["zoneName"] = zoneName
    callback(payload)
  }

  // MARK: - Record name helpers

  /// Stable record name encoding: "presence-<userRecordName>"
  /// The userRecordName from CloudKit is already URL-safe (UUID-ish), so no escaping needed.
  private func presenceRecordName(for userRecordName: String) -> String {
    "presence-\(userRecordName)"
  }

  /// Extracts the userRecordName from a presence CKRecord.ID's recordName.
  private func userRecordName(fromPresenceRecordID recordID: CKRecord.ID) -> String {
    let name = recordID.recordName
    if name.hasPrefix("presence-") {
      return String(name.dropFirst("presence-".count))
    }
    return name
  }

  // MARK: - JSON helpers

  private func jsonString(from dict: [String: Any]) -> String? {
    guard let data = try? JSONSerialization.data(withJSONObject: dict, options: []) else {
      return nil
    }
    return String(data: data, encoding: .utf8)
  }

  private func parsedDict(from jsonString: String) -> [String: Any]? {
    guard let data = jsonString.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data, options: []),
          let dict = obj as? [String: Any] else {
      return nil
    }
    return dict
  }
}
