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
/// All mutations to entries and isDraining happen on the private serial queue.
/// sendEvent is always dispatched to main before emission.
final class OfflineQueue {

  // MARK: - Constants

  private static let maxEntries = 500
  private static let maxRetries = 10

  // MARK: - Dependencies

  private let ckContainer: CKContainer
  private let recordManager: CloudKitRecordManager
  private let sendEvent: ([String: Any]) -> Void

  // MARK: - Storage

  private var entries: [OfflineQueueEntry] = []
  private let queue = DispatchQueue(label: "expo-cloudkit.offline-queue", qos: .utility)
  private let storageURL: URL

  // MARK: - Drain State

  private var isDraining = false

  // MARK: - Network Monitor

  private let pathMonitor = NWPathMonitor()
  private let monitorQueue = DispatchQueue(
    label: "expo-cloudkit.offline-queue.monitor", qos: .background
  )
  private var previousPathSatisfied = false
  private var debounceWorkItem: DispatchWorkItem?

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

  deinit {
    pathMonitor.cancel()
    debounceWorkItem?.cancel()
    if let observer = foregroundObserver {
      NotificationCenter.default.removeObserver(observer)
    }
  }

  // MARK: - Public API

  /// Adds an entry. Returns its id. Throws queueFull when >= 500 entries.
  @discardableResult
  func enqueue(operation: String, database: String, recordData: [String: Any]) throws -> String {
    return try queue.sync {
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
  }

  /// Processes all eligible entries. Returns immediately if already draining.
  @discardableResult
  func drain() -> [String: Any] {
    var alreadyDraining = false
    queue.sync { alreadyDraining = isDraining }
    guard !alreadyDraining else { return ["skipped": true] }

    queue.sync { isDraining = true }

    let now = Date()
    let eligible: [OfflineQueueEntry] = queue.sync {
      entries
        .filter { $0.status != "failed" && $0.nextRetryAt <= now }
        .sorted { $0.createdAt < $1.createdAt }
    }

    if eligible.isEmpty {
      let snap: [String: Any] = queue.sync {
        isDraining = false
        return buildStatusDict(includeEntries: false)
      }
      emitEvent(["type": "queueDrained", "succeeded": 0, "failed": 0, "skipped": 0])
      return snap
    }

    DispatchQueue.global(qos: .utility).async { [weak self] in
      self?.processBatch(eligible)
    }
    return queue.sync { buildStatusDict(includeEntries: false) }
  }

  func getStatus(includeEntries: Bool) -> [String: Any] {
    queue.sync { buildStatusDict(includeEntries: includeEntries) }
  }

  func clear(status filterStatus: String) {
    queue.sync {
      if filterStatus == "all" {
        entries.removeAll()
      } else {
        entries.removeAll { $0.status == filterStatus }
      }
      persistQueue()
      emitStatusChanged()
    }
  }

  func retryFailed() {
    queue.sync {
      for i in entries.indices where entries[i].status == "failed" {
        entries[i].status = "pending"
        entries[i].retryCount = 0
        entries[i].nextRetryAt = Date.distantPast
        entries[i].lastErrorCode = nil
      }
      persistQueue()
    }
    _ = drain()
  }

  // MARK: - Retry Classification

  // Used only by the queueOnFailure gate in ExpoCloudKitModule.
  // Retryable: NETWORK_UNAVAILABLE, SERVER_REJECTED, UNKNOWN (capped at maxRetries)
  // Non-retryable: QUOTA_EXCEEDED, NOT_AUTHENTICATED, PERMISSION_DENIED,
  //   ZONE_NOT_FOUND, CONFLICT, LIMIT_EXCEEDED, ASSET_TOO_LARGE

  // MARK: - Backoff

  private func nextRetryDelay(for entry: OfflineQueueEntry) -> TimeInterval {
    let base = min(5.0 * pow(2.0, Double(entry.retryCount)), 300.0)
    return base + base * Double.random(in: 0.0...0.2)
  }

  // MARK: - Batch Processing
  //
  // Uses a recursive dispatch chain instead of DispatchGroup/wait-in-loop to
  // avoid the risk of deadlocking between the serial queue and a blocking wait().

  private func processBatch(_ batch: [OfflineQueueEntry]) {
    var succeeded = 0
    var failed = 0

    func processNext(_ remaining: [OfflineQueueEntry]) {
      guard let entry = remaining.first else {
        var snap: [String: Any] = [:]
        queue.sync {
          isDraining = false
          snap = buildStatusDict(includeEntries: false)
        }
        emitEvent(["type": "queueDrained", "succeeded": succeeded, "failed": failed, "skipped": 0])
        emitEvent(["type": "queueStatusChanged", "status": snap])
        return
      }
      let rest = Array(remaining.dropFirst())

      processEntry(entry) { [weak self] outcome in
        guard let self = self else { return }

        switch outcome {
        case .succeeded:
          succeeded += 1
          self.queue.sync {
            self.entries.removeAll { $0.id == entry.id }
            self.persistQueue()
          }
          self.emitEvent(["type": "operationCompleted", "queueId": entry.id])

        case .retryable(let code, let retryAfter):
          self.queue.sync {
            guard let idx = self.entries.firstIndex(where: { $0.id == entry.id }) else { return }
            let newCount = self.entries[idx].retryCount + 1
            let willRetry = newCount < OfflineQueue.maxRetries
            self.entries[idx].retryCount = newCount
            self.entries[idx].lastErrorCode = code
            if willRetry {
              let delay = retryAfter ?? self.nextRetryDelay(for: self.entries[idx])
              self.entries[idx].nextRetryAt = Date().addingTimeInterval(delay)
              self.entries[idx].status = "retrying"
              self.persistQueue()
              self.emitEvent([
                "type": "operationFailed", "queueId": entry.id,
                "errorCode": code, "retryCount": newCount, "willRetry": true
              ])
            } else {
              self.entries[idx].status = "failed"
              failed += 1
              self.persistQueue()
              self.emitEvent([
                "type": "operationMovedToFailed", "queueId": entry.id,
                "errorCode": code, "retryCount": newCount
              ])
            }
          }

        case .nonRetryable(let code):
          failed += 1
          self.queue.sync {
            if let idx = self.entries.firstIndex(where: { $0.id == entry.id }) {
              self.entries[idx].status = "failed"
              self.entries[idx].lastErrorCode = code
              self.entries[idx].retryCount += 1
              self.persistQueue()
            }
          }
          self.emitEvent([
            "type": "operationMovedToFailed", "queueId": entry.id,
            "errorCode": code, "retryCount": entry.retryCount + 1
          ])
        }

        processNext(rest)
      }
    }

    processNext(batch)
  }

  // MARK: - Entry Execution

  private enum EntryOutcome {
    case succeeded
    case retryable(errorCode: String, retryAfterSeconds: TimeInterval?)
    case nonRetryable(errorCode: String)
  }

  private func processEntry(_ entry: OfflineQueueEntry, completion: @escaping (EntryOutcome) -> Void) {
    let scope = Converters.toDatabaseScope(entry.database)

    if entry.operation == "save" {
      guard let record = try? Converters.toCKRecord(from: entry.recordData) else {
        completion(.nonRetryable(errorCode: "INVALID_RECORD_DATA"))
        return
      }
      recordManager.saveRecords([record], in: scope) { result in
        switch result {
        case .success:  completion(.succeeded)
        case .failure(let error): completion(Self.classify(error))
        }
      }

    } else if entry.operation == "delete" {
      guard let recordName = entry.recordData["recordName"] as? String else {
        completion(.nonRetryable(errorCode: "INVALID_RECORD_DATA"))
        return
      }
      let zoneName = entry.recordData["zoneName"] as? String
      let zoneID = zoneName.map {
        CKRecordZone.ID(zoneName: $0, ownerName: CKCurrentUserDefaultName)
      } ?? CKRecordZone.ID.default
      let recordID = CKRecord.ID(recordName: recordName, zoneID: zoneID)
      recordManager.deleteRecords([recordID], in: scope) { result in
        switch result {
        case .success:  completion(.succeeded)
        case .failure(let error): completion(Self.classify(error))
        }
      }

    } else {
      completion(.nonRetryable(errorCode: "UNKNOWN_OPERATION"))
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

  private func emitEvent(_ payload: [String: Any]) {
    DispatchQueue.main.async { [weak self] in self?.sendEvent(payload) }
  }

  private func emitStatusChanged() {
    emitEvent(["type": "queueStatusChanged", "status": buildStatusDict(includeEntries: false)])
  }

  // MARK: - Persistence

  private func persistQueue() {
    // Called while holding queue lock — safe.
    guard let data = try? JSONEncoder().encode(entries) else { return }
    try? data.write(to: storageURL, options: .atomic)
  }

  private func loadQueue() {
    // Called from init before queue is in active use.
    guard FileManager.default.fileExists(atPath: storageURL.path),
          let data = try? Data(contentsOf: storageURL),
          let loaded = try? JSONDecoder().decode([OfflineQueueEntry].self, from: data) else {
      return
    }
    entries = loaded
  }

  // MARK: - Network Monitor

  private func setupPathMonitor() {
    pathMonitor.pathUpdateHandler = { [weak self] path in
      guard let self = self else { return }
      let satisfied = path.status == .satisfied
      if !self.previousPathSatisfied && satisfied {
        self.debounceWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in _ = self?.drain() }
        self.debounceWorkItem = item
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 2.0, execute: item)
      }
      self.previousPathSatisfied = satisfied
    }
    pathMonitor.start(queue: monitorQueue)
  }

  // MARK: - Foreground Observer

  #if canImport(UIKit)
  private func setupForegroundObserver() {
    foregroundObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in _ = self?.drain() }
  }
  #elseif canImport(AppKit)
  private func setupForegroundObserver() {
    foregroundObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.didBecomeActiveNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in _ = self?.drain() }
  }
  #endif
}
