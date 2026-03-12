import CloudKit
import Foundation
import Network
#if canImport(UIKit)
  import UIKit
#elseif canImport(AppKit)
  import AppKit
#endif

// MARK: - OfflineQueueError

enum OfflineQueueError: Error, LocalizedError {
  case queueFull

  var errorDescription: String? {
    "Offline queue is full (500 entries). Clear failed operations before enqueuing more."
  }
}

// MARK: - OfflineQueue

/// Persists CloudKit operations when the device is offline and drains them
/// automatically when connectivity returns or the app foregrounds.
///
/// # Storage
/// JSON file at Library/Application Support/expo-cloudkit/offline-queue.json.
/// Written atomically after every mutation.
///
/// # Drain Triggers
/// - NWPathMonitor: 2-second debounce when path unsatisfied → satisfied.
/// - UIApplication.didBecomeActiveNotification: drain on foreground.
/// - Direct drain() call.
///
/// # Thread Safety
/// This type is a Swift `actor`. All mutable state (`entries`, `isDraining`,
/// `previousPathSatisfied`, `debounceTask`) is actor-isolated and therefore
/// data-race safe. `sendEvent` is dispatched to `@MainActor` before emission.
///
/// NWPathMonitor and NotificationCenter callbacks are `nonisolated` and
/// re-enter actor isolation via `Task { await self.methodName() }`.
actor OfflineQueue {

  // MARK: - Constants

  private static let maxEntries = 500
  private static let maxRetries = 10

  // MARK: - Dependencies

  private let ckContainer: CKContainer
  private let recordManager: CloudKitRecordManager
  private let sendEvent: ([String: Any]) -> Void

  // MARK: - Storage

  private var entries: [OfflineQueueEntry] = []
  private let storageURL: URL

  // MARK: - Drain State

  private var isDraining = false

  // MARK: - Network Monitor

  private let pathMonitor = NWPathMonitor()
  private var previousPathSatisfied = false
  /// Current debounce task — cancelled and replaced on each unsatisfied→satisfied transition.
  private var debounceTask: Task<Void, Never>?

  // MARK: - Foreground Observer

  private var foregroundObserver: NSObjectProtocol?

  // MARK: - Init

  init(
    container: CKContainer,
    containerID: String,
    recordManager: CloudKitRecordManager,
    sendEvent: @escaping ([String: Any]) -> Void
  ) {
    self.ckContainer = container
    self.recordManager = recordManager
    self.sendEvent = sendEvent

    let appSupport = FileManager.default.urls(
      for: .applicationSupportDirectory, in: .userDomainMask
    ).first!
    let dir = appSupport.appendingPathComponent("expo-cloudkit", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    storageURL = dir.appendingPathComponent("offline-queue.json")

    loadQueue()
    setupPathMonitor()
    #if canImport(UIKit) || canImport(AppKit)
      setupForegroundObserver()
    #endif
  }

  // MARK: - Cleanup

  /// Stops the path monitor and removes the foreground observer.
  /// Call this when the owning object is being torn down.
  func tearDown() {
    pathMonitor.cancel()
    debounceTask?.cancel()
    if let observer = foregroundObserver {
      NotificationCenter.default.removeObserver(observer)
      foregroundObserver = nil
    }
  }

  // MARK: - Public API

  /// Adds an entry. Returns its id. Throws `queueFull` when >= 500 entries.
  @discardableResult
  func enqueue(operation: String, database: String, recordData: [String: Any]) throws -> String {
    guard entries.count < OfflineQueue.maxEntries else {
      throw OfflineQueueError.queueFull
    }
    let entry = OfflineQueueEntry(
      operation: operation,
      database: database,
      recordData: recordData
    )
    entries.append(entry)
    persistQueue()
    emitStatusChanged()
    return entry.id
  }

  /// Processes all eligible entries. Returns immediately if already draining.
  @discardableResult
  func drain() -> [String: Any] {
    guard !isDraining else { return ["skipped": true] }
    isDraining = true

    let now = Date()
    let eligible = entries
      .filter { $0.status != "failed" && $0.nextRetryAt <= now }
      .sorted { $0.createdAt < $1.createdAt }

    if eligible.isEmpty {
      isDraining = false
      let snap = buildStatusDict(includeEntries: false)
      emitEvent(["type": "queueDrained", "succeeded": 0, "failed": 0, "skipped": 0])
      return snap
    }

    // Kick off the async batch — actor isolation is maintained across the Task.
    Task {
      await processBatch(eligible)
    }
    return buildStatusDict(includeEntries: false)
  }

  func getStatus(includeEntries: Bool) -> [String: Any] {
    buildStatusDict(includeEntries: includeEntries)
  }

  func clear(status filterStatus: String) {
    if filterStatus == "all" {
      entries.removeAll()
    } else {
      entries.removeAll { $0.status == filterStatus }
    }
    persistQueue()
    emitStatusChanged()
  }

  func retryFailed() {
    for i in entries.indices where entries[i].status == "failed" {
      entries[i].status = "pending"
      entries[i].retryCount = 0
      entries[i].nextRetryAt = Date.distantPast
      entries[i].lastErrorCode = nil
    }
    persistQueue()
    _ = drain()
  }

  // MARK: - Retry Classification (used by the queueOnFailure gate in ExpoCloudKitModule)
  //
  // Retryable: NETWORK_UNAVAILABLE, SERVER_REJECTED, UNKNOWN (capped at maxRetries)
  // Non-retryable: QUOTA_EXCEEDED, NOT_AUTHENTICATED, PERMISSION_DENIED,
  //   ZONE_NOT_FOUND, CONFLICT, LIMIT_EXCEEDED, ASSET_TOO_LARGE

  // MARK: - Backoff

  private func nextRetryDelay(for entry: OfflineQueueEntry) -> TimeInterval {
    let base = min(5.0 * pow(2.0, Double(entry.retryCount)), 300.0)
    return base + base * Double.random(in: 0.0...0.2)
  }

  // MARK: - Batch Processing

  private func processBatch(_ batch: [OfflineQueueEntry]) async {
    var succeeded = 0
    var failed = 0

    for entry in batch {
      let outcome = await processEntry(entry)

      switch outcome {
      case .succeeded:
        succeeded += 1
        entries.removeAll { $0.id == entry.id }
        persistQueue()
        emitEvent(["type": "operationCompleted", "queueId": entry.id])

      case .retryable(let code, let retryAfter):
        if let idx = entries.firstIndex(where: { $0.id == entry.id }) {
          let newCount = entries[idx].retryCount + 1
          let willRetry = newCount < OfflineQueue.maxRetries
          entries[idx].retryCount = newCount
          entries[idx].lastErrorCode = code
          if willRetry {
            let delay = retryAfter ?? nextRetryDelay(for: entries[idx])
            entries[idx].nextRetryAt = Date().addingTimeInterval(delay)
            entries[idx].status = "retrying"
            persistQueue()
            emitEvent([
              "type": "operationFailed", "queueId": entry.id,
              "errorCode": code, "retryCount": newCount, "willRetry": true
            ])
          } else {
            entries[idx].status = "failed"
            failed += 1
            persistQueue()
            emitEvent([
              "type": "operationMovedToFailed", "queueId": entry.id,
              "errorCode": code, "retryCount": newCount
            ])
          }
        }

      case .nonRetryable(let code):
        failed += 1
        if let idx = entries.firstIndex(where: { $0.id == entry.id }) {
          entries[idx].status = "failed"
          entries[idx].lastErrorCode = code
          entries[idx].retryCount += 1
          persistQueue()
        }
        emitEvent([
          "type": "operationMovedToFailed", "queueId": entry.id,
          "errorCode": code, "retryCount": entry.retryCount + 1
        ])
      }
    }

    isDraining = false
    let snap = buildStatusDict(includeEntries: false)
    emitEvent(["type": "queueDrained", "succeeded": succeeded, "failed": failed, "skipped": 0])
    emitEvent(["type": "queueStatusChanged", "status": snap])
  }

  // MARK: - Entry Execution

  private enum EntryOutcome {
    case succeeded
    case retryable(errorCode: String, retryAfterSeconds: TimeInterval?)
    case nonRetryable(errorCode: String)
  }

  private func processEntry(_ entry: OfflineQueueEntry) async -> EntryOutcome {
    let scope = Converters.toDatabaseScope(entry.database)

    if entry.operation == "save" {
      guard let record = try? Converters.toCKRecord(from: entry.recordData) else {
        return .nonRetryable(errorCode: "INVALID_RECORD_DATA")
      }
      return await withCheckedContinuation { continuation in
        recordManager.saveRecords([record], in: scope) { result in
          switch result {
          case .success:  continuation.resume(returning: .succeeded)
          case .failure(let error): continuation.resume(returning: Self.classify(error))
          }
        }
      }

    } else if entry.operation == "delete" {
      guard let recordName = entry.recordData["recordName"] as? String else {
        return .nonRetryable(errorCode: "INVALID_RECORD_DATA")
      }
      let zoneName = entry.recordData["zoneName"] as? String
      let zoneID = zoneName.map {
        CKRecordZone.ID(zoneName: $0, ownerName: CKCurrentUserDefaultName)
      } ?? CKRecordZone.ID.default
      let recordID = CKRecord.ID(recordName: recordName, zoneID: zoneID)
      return await withCheckedContinuation { continuation in
        recordManager.deleteRecords([recordID], in: scope) { result in
          switch result {
          case .success:  continuation.resume(returning: .succeeded)
          case .failure(let error): continuation.resume(returning: Self.classify(error))
          }
        }
      }

    } else {
      return .nonRetryable(errorCode: "UNKNOWN_OPERATION")
    }
  }

  // MARK: - Error Classification

  private static func classify(_ error: Error) -> EntryOutcome {
    let bridgeError = Converters.toExpoError(error) as? ExpoCloudKitBridgeError
    let code = bridgeError?.code ?? "UNKNOWN"
    let retryAfter: TimeInterval? = (error as? CKError)?.retryAfterSeconds.map { TimeInterval($0) }

    switch code {
    case "NETWORK_UNAVAILABLE", "SERVER_REJECTED", "UNKNOWN":
      return .retryable(errorCode: code, retryAfterSeconds: retryAfter)
    case "QUOTA_EXCEEDED", "NOT_AUTHENTICATED", "PERMISSION_DENIED",
         "ZONE_NOT_FOUND", "CONFLICT", "LIMIT_EXCEEDED", "ASSET_TOO_LARGE":
      return .nonRetryable(errorCode: code)
    default:
      return .retryable(errorCode: code, retryAfterSeconds: retryAfter)
    }
  }

  // MARK: - Status Dictionary

  private func buildStatusDict(includeEntries: Bool) -> [String: Any] {
    var dict: [String: Any] = [
      "pending":  entries.filter { $0.status == "pending" }.count,
      "retrying": entries.filter { $0.status == "retrying" }.count,
      "failed":   entries.filter { $0.status == "failed" }.count,
      "total":    entries.count
    ]
    if includeEntries { dict["entries"] = entries.map { $0.toDictionary() } }
    return dict
  }

  // MARK: - Events
  // `sendEvent` always dispatches to @MainActor — Expo Modules Core requires
  // event emission on the main queue.

  private func emitEvent(_ payload: [String: Any]) {
    let handler = sendEvent
    Task { @MainActor in handler(payload) }
  }

  private func emitStatusChanged() {
    emitEvent(["type": "queueStatusChanged", "status": buildStatusDict(includeEntries: false)])
  }

  // MARK: - Persistence

  private func persistQueue() {
    // Called while actor-isolated — safe to access entries directly.
    guard let data = try? JSONEncoder().encode(entries) else { return }
    try? data.write(to: storageURL, options: .atomic)
  }

  private func loadQueue() {
    // Called from init before any concurrent access — safe.
    guard FileManager.default.fileExists(atPath: storageURL.path),
          let data = try? Data(contentsOf: storageURL),
          let loaded = try? JSONDecoder().decode([OfflineQueueEntry].self, from: data) else {
      return
    }
    entries = loaded
  }

  // MARK: - Network Monitor

  private func setupPathMonitor() {
    // `pathUpdateHandler` is called on an arbitrary queue by NWPathMonitor.
    // We re-enter actor isolation with `Task { await self.handlePathUpdate(...) }`.
    pathMonitor.pathUpdateHandler = { [weak self] path in
      guard let self = self else { return }
      let satisfied = path.status == .satisfied
      Task { await self.handlePathUpdate(satisfied: satisfied) }
    }
    // NWPathMonitor no longer gets its own DispatchQueue — it shares the
    // cooperative thread pool via the Task bridge above.
    pathMonitor.start(queue: DispatchQueue(label: "expo-cloudkit.offline-queue.monitor", qos: .background))
  }

  /// Actor-isolated handler for NWPathMonitor path changes.
  private func handlePathUpdate(satisfied: Bool) {
    if !previousPathSatisfied && satisfied {
      debounceTask?.cancel()
      debounceTask = Task {
        do {
          // 2-second debounce before triggering the drain.
          try await Task.sleep(nanoseconds: 2_000_000_000)
          _ = drain()
        } catch {
          // Task was cancelled (another path change arrived) — do nothing.
        }
      }
    }
    previousPathSatisfied = satisfied
  }

  // MARK: - Foreground Observer

  #if canImport(UIKit)
  private func setupForegroundObserver() {
    foregroundObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      guard let self = self else { return }
      Task { _ = await self.drain() }
    }
  }
  #elseif canImport(AppKit)
  private func setupForegroundObserver() {
    foregroundObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.didBecomeActiveNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      guard let self = self else { return }
      Task { _ = await self.drain() }
    }
  }
  #endif
}
