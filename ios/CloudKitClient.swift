import CloudKit
#if canImport(ExpoModulesCore)
import ExpoModulesCore
#endif

/// A scoped CloudKit client bound to a specific CKContainer.
///
/// Provides the same record/zone operations as the module-level singletons
/// but isolated to a single container identity. Used by H.3 multi-container
/// support so callers can address multiple iCloud containers from a single
/// module instance.
///
/// `CloudKitClient` is thread-safe under concurrent reads and barrier-protected
/// writes via the `clientsQueue` in `ExpoCloudKitModule`. The managers it owns
/// (`CloudKitRecordManager`, `CloudKitZoneManager`) are themselves stateless
/// with respect to the container reference, so sharing them across calls is safe.
final class CloudKitClient {

  // MARK: - Properties

  /// The container identifier passed at creation time (e.g. "iCloud.com.example.app").
  let containerId: String

  /// The underlying CKContainer bound to `containerId`.
  let ckContainer: CKContainer

  /// Record CRUD manager scoped to this container.
  let recordManager: CloudKitRecordManager

  /// Zone management scoped to this container.
  let zoneManager: CloudKitZoneManager

  // MARK: - Init

  init(containerId: String) {
    self.containerId = containerId
    self.ckContainer = CKContainer(identifier: containerId)
    self.recordManager = CloudKitRecordManager(ckContainer: self.ckContainer)
    self.zoneManager = CloudKitZoneManager(ckContainer: self.ckContainer)
  }
}
