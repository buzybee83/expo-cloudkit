import CloudKit
import Foundation

/// Manages CloudKit push subscriptions (CKQuerySubscription and CKDatabaseSubscription).
///
/// All save and delete operations use `CKModifySubscriptionsOperation` for
/// batching and to avoid the deprecated per-subscription `database.save()` API.
///
/// # Threading
/// Completion handlers are dispatched from whatever queue CloudKit calls back on.
/// Callers that need to update UI or send events should dispatch to the main queue
/// themselves — see `ExpoCloudKitModule` for the `sendEvent` pattern.
final class CloudKitSubscriptionManager {

  // MARK: - Init

  private let ckContainer: CKContainer

  init(ckContainer: CKContainer) {
    self.ckContainer = ckContainer
  }

  // MARK: - Database Accessor

  private func database(for scope: CKDatabase.Scope) -> CKDatabase {
    switch scope {
    case .private:  return ckContainer.privateCloudDatabase
    case .shared:   return ckContainer.sharedCloudDatabase
    case .public:   return ckContainer.publicCloudDatabase
    @unknown default: return ckContainer.privateCloudDatabase
    }
  }

  // MARK: - Save Query Subscription

  /// Creates a `CKQuerySubscription` for the given record type and predicate.
  ///
  /// - Parameters:
  ///   - recordType: The CKRecord type to watch (e.g. "Note", "Task").
  ///   - predicate: Filter applied server-side; use `NSPredicate(value: true)` for all records.
  ///   - options: Bitmask of `CKQuerySubscription.Options` — typically `.firesOnRecordCreation`,
  ///     `.firesOnRecordUpdate`, `.firesOnRecordDeletion`.
  ///   - zoneID: Optional zone to scope the subscription. Nil watches the default zone.
  ///   - database: The CloudKit database to register the subscription on.
  ///   - completion: Called with the generated `subscriptionID` on success, or an error.
  func saveQuerySubscription(
    recordType: String,
    predicate: NSPredicate,
    options: CKQuerySubscription.Options,
    zoneID: CKRecordZone.ID?,
    database: CKDatabase,
    completion: @escaping (Result<String, Error>) -> Void
  ) {
    let subscriptionID = "expo-ck-query-\(UUID().uuidString)"

    let subscription: CKQuerySubscription
    if let zoneID = zoneID {
      subscription = CKQuerySubscription(
        recordType: recordType,
        predicate: predicate,
        subscriptionID: subscriptionID,
        options: options
      )
      subscription.zoneID = zoneID
    } else {
      subscription = CKQuerySubscription(
        recordType: recordType,
        predicate: predicate,
        subscriptionID: subscriptionID,
        options: options
      )
    }

    // Configure notification info for silent push + optional alert body.
    // `shouldSendContentAvailable = true` is required for the app to wake
    // in the background and process incoming changes.
    let notificationInfo = CKSubscription.NotificationInfo()
    notificationInfo.alertBody = "CloudKit record changed"
    notificationInfo.shouldSendContentAvailable = true
    // Include changed fields in the push payload so the notification handler
    // can surface them to JS without a follow-up fetch.
    notificationInfo.desiredKeys = nil  // nil = all keys; caller may restrict via options
    subscription.notificationInfo = notificationInfo

    let operation = CKModifySubscriptionsOperation(
      subscriptionsToSave: [subscription],
      subscriptionIDsToDelete: nil
    )
    operation.qualityOfService = .userInitiated

    operation.modifySubscriptionsResultBlock = { result in
      switch result {
      case .success:
        completion(.success(subscriptionID))
      case .failure(let error):
        completion(.failure(error))
      }
    }

    database.add(operation)
  }

  // MARK: - Save Database Subscription

  /// Creates a `CKDatabaseSubscription` that fires whenever any record in the
  /// database changes — useful for triggering zone-change fetches.
  ///
  /// - Parameters:
  ///   - database: The CloudKit database to register the subscription on.
  ///     Note: `CKDatabaseSubscription` is only valid on the private and shared databases.
  ///   - completion: Called with the generated `subscriptionID` on success, or an error.
  func saveDatabaseSubscription(
    database: CKDatabase,
    completion: @escaping (Result<String, Error>) -> Void
  ) {
    let subscriptionID = "expo-ck-db-\(UUID().uuidString)"

    let subscription = CKDatabaseSubscription(subscriptionID: subscriptionID)

    let notificationInfo = CKSubscription.NotificationInfo()
    notificationInfo.shouldSendContentAvailable = true
    subscription.notificationInfo = notificationInfo

    let operation = CKModifySubscriptionsOperation(
      subscriptionsToSave: [subscription],
      subscriptionIDsToDelete: nil
    )
    operation.qualityOfService = .userInitiated

    operation.modifySubscriptionsResultBlock = { result in
      switch result {
      case .success:
        completion(.success(subscriptionID))
      case .failure(let error):
        completion(.failure(error))
      }
    }

    database.add(operation)
  }

  // MARK: - Delete Subscription

  /// Deletes a subscription by ID.
  ///
  /// CloudKit returns `CKError.Code.unknownItem` when the subscription does not
  /// exist — this is surfaced as `CloudKitModuleError.subscriptionNotFound` by
  /// the module layer.
  ///
  /// - Parameters:
  ///   - subscriptionID: The ID returned from a prior save call.
  ///   - database: The database on which the subscription is registered.
  ///   - completion: Called with `.success(())` or `.failure(error)`.
  func deleteSubscription(
    subscriptionID: String,
    database: CKDatabase,
    completion: @escaping (Result<Void, Error>) -> Void
  ) {
    let operation = CKModifySubscriptionsOperation(
      subscriptionsToSave: nil,
      subscriptionIDsToDelete: [subscriptionID]
    )
    operation.qualityOfService = .userInitiated

    operation.modifySubscriptionsResultBlock = { result in
      switch result {
      case .success:
        completion(.success(()))
      case .failure(let error):
        completion(.failure(error))
      }
    }

    database.add(operation)
  }

  // MARK: - Fetch Subscriptions

  /// Fetches all active subscriptions on the specified database and converts
  /// each one to a JS-bridge-safe dictionary via `Converters.toSubscriptionDict`.
  ///
  /// - Parameters:
  ///   - database: The database to fetch subscriptions from.
  ///   - completion: Called with an array of subscription dicts, or an error.
  func fetchSubscriptions(
    database: CKDatabase,
    completion: @escaping (Result<[[String: Any]], Error>) -> Void
  ) {
    database.fetchAllSubscriptions { subscriptions, error in
      if let error = error {
        completion(.failure(error))
        return
      }

      let dicts = (subscriptions ?? []).map { Converters.toSubscriptionDict($0) }
      completion(.success(dicts))
    }
  }
}
