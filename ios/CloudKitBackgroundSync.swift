import BackgroundTasks
import CloudKit
import Foundation

/// Manages BGTaskScheduler registration and scheduling for CloudKit background sync.
///
/// # Overview
/// `CloudKitBackgroundSync` wires `BGAppRefreshTask` to the active `CloudKitSyncProvider`
/// so that the app can fetch CloudKit changes while backgrounded. The system does not
/// guarantee exact timing — it learns from usage patterns and battery state. The
/// 15-minute `earliestBeginDate` is the minimum allowed by `BGAppRefreshTask`; the
/// system may defer the task significantly beyond that.
///
/// # Integration
/// Call `register(taskIdentifier:providerResolver:)` once at app launch (before the app
/// moves to the background). Call `scheduleNextRefresh()` after each completed task
/// to re-arm the scheduler — the handler does this automatically before executing work.
///
/// # Availability
/// `BGTaskScheduler` is available on iOS 13+. The class itself is guarded at the
/// call sites in `ExpoCloudKitModule` with `#available(iOS 13, *)`.
@available(iOS 13.0, *)
public final class CloudKitBackgroundSync: @unchecked Sendable {

  // MARK: - Shared instance

  public static let shared = CloudKitBackgroundSync()

  // MARK: - State

  private var registeredTaskIdentifier: String?

  /// Closure that resolves the active sync providers at task-fire time.
  ///
  /// Using a resolver closure instead of a direct weak reference means the background
  /// task always reads the module's *current* `syncProviders` when it fires, regardless
  /// of the order in which `registerBackgroundSync()` and `startSyncEngine()` were called.
  /// Returns an array so all running scopes (private, shared) are triggered together.
  private var providerResolver: (() -> [any CloudKitSyncProvider])?

  // MARK: - Init (private — use `shared`)

  private init() {}

  // MARK: - Public API

  /// Registers the BGTask handler with the system.
  ///
  /// Must be called **before** the application moves to the background for the
  /// first time. `BGTaskScheduler.shared.register` must be called in
  /// `application(_:didFinishLaunchingWithOptions:)` or the SwiftUI equivalent.
  ///
  /// The Expo module calls this from `registerBackgroundSync()`, which React
  /// Native apps typically invoke in their root component's `useEffect`.
  /// If the app has not yet moved to the background when this is called, the
  /// registration succeeds. If the app IS already in the background this call
  /// has no effect (BGTaskScheduler ignores late registrations silently).
  ///
  /// - Parameters:
  ///   - taskIdentifier: The BGTask identifier. Must match the value declared in
  ///     `BGTaskSchedulerPermittedIdentifiers` in `Info.plist` — otherwise the
  ///     system will silently refuse to launch the task.
  ///   - providerResolver: A closure invoked at task-fire time to obtain all
  ///     currently active `CloudKitSyncProvider` instances. Returns an array so
  ///     all running scopes are triggered together. Use `[weak self]` capture.
  func register(taskIdentifier: String, providerResolver: @escaping () -> [any CloudKitSyncProvider]) {
    self.registeredTaskIdentifier = taskIdentifier
    self.providerResolver = providerResolver

    BGTaskScheduler.shared.register(
      forTaskWithIdentifier: taskIdentifier,
      using: nil
    ) { [weak self] task in
      guard let appRefreshTask = task as? BGAppRefreshTask else {
        task.setTaskCompleted(success: false)
        return
      }
      self?.handleBackgroundTask(appRefreshTask)
    }
  }

  /// Submits a BGAppRefreshTaskRequest to the system scheduler.
  ///
  /// The system will launch the app in the background at some point after
  /// `earliestBeginDate` when conditions are appropriate (power, connectivity, etc.).
  /// Call this once after `register()` to arm the first refresh, and again inside
  /// the task handler to keep the chain alive — the handler does this automatically.
  func scheduleNextRefresh() {
    guard let id = registeredTaskIdentifier else { return }

    let request = BGAppRefreshTaskRequest(identifier: id)
    // iOS enforces a minimum of ~15 minutes. Set exactly 15 minutes; the system
    // may defer longer based on battery state and usage patterns.
    request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)

    do {
      try BGTaskScheduler.shared.submit(request)
    } catch {
      // Non-fatal: if submission fails (e.g., backgrounding is disabled by the
      // user in Settings) we log but do not surface to JS. The app will still
      // sync normally when foregrounded.
#if DEBUG
      print("[expo-cloudkit] BGTaskScheduler submission failed: \(error.localizedDescription)")
#endif
    }
  }

  // MARK: - Private

  private func handleBackgroundTask(_ task: BGAppRefreshTask) {
    // Re-arm immediately so a crash during sync doesn't break the chain.
    scheduleNextRefresh()

    let providers = providerResolver?() ?? []
    guard !providers.isEmpty else {
      // No active sync providers — either startSyncEngine was never called,
      // or it was called but the module has since been deallocated.
      // Mark as complete so the system doesn't penalise the app for hanging tasks.
      task.setTaskCompleted(success: true)
      return
    }

    // Dispatch sync work on a Swift concurrency Task so we can honour the
    // expiration handler by cancelling it.
    // Fan out to all running providers concurrently so all scopes are refreshed
    // within the single background time allocation.
    let syncTask = Task {
      await withTaskGroup(of: Void.self) { group in
        for provider in providers {
          group.addTask { await provider.triggerSync() }
        }
      }
    }

    // The system calls this handler when the allocated background time is about
    // to expire. Cancel the in-flight sync and mark complete so the system
    // records a clean termination.
    task.expirationHandler = {
      syncTask.cancel()
      task.setTaskCompleted(success: false)
    }

    // Wait for the sync to finish, then signal completion.
    Task {
      // `await syncTask.value` propagates cancellation — if cancelled via the
      // expiration handler the task exits immediately and we do not call
      // `setTaskCompleted` a second time (the expiration handler already did).
      _ = await syncTask.result
      if !syncTask.isCancelled {
        task.setTaskCompleted(success: true)
      }
    }
  }
}
