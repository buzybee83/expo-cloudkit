import CloudKit
import Foundation

/// Manages the CKContainer reference and account status observation.
///
/// Wraps CKContainer.accountStatus(completionHandler:) and
/// NotificationCenter account-change notifications into a simple callback API.
final class CloudKitContainer {

  // MARK: - Properties

  let ckContainer: CKContainer

  private var accountStatusObserver: ((CKAccountStatus) -> Void)?

  // MARK: - Init

  init(ckContainer: CKContainer) {
    self.ckContainer = ckContainer
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  // MARK: - Account Status

  /// Queries the current iCloud account status asynchronously.
  func getAccountStatus(completion: @escaping (Result<CKAccountStatus, Error>) -> Void) {
    ckContainer.accountStatus { status, error in
      if let error = error {
        completion(.failure(error))
        return
      }
      completion(.success(status))
    }
  }

  /// Starts observing CKAccountChanged notifications and forwarding them
  /// to the provided callback. Only one observer is active at a time.
  func startAccountStatusObserver(onChange: @escaping (CKAccountStatus) -> Void) {
    self.accountStatusObserver = onChange

    NotificationCenter.default.removeObserver(
      self,
      name: .CKAccountChanged,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleAccountChanged),
      name: .CKAccountChanged,
      object: nil
    )
  }

  @objc private func handleAccountChanged() {
    ckContainer.accountStatus { [weak self] status, error in
      guard error == nil else { return }
      self?.accountStatusObserver?(status)
    }
  }
}
