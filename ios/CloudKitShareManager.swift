import CloudKit
import Foundation
import UIKit

/// Manages CKShare lifecycle: creating, deleting, fetching participants,
/// updating permissions, removing participants, accepting shares, and
/// listing shared database zones.
///
/// # Threading
/// All CloudKit callbacks are dispatched on arbitrary background queues by
/// the CloudKit framework. Completion handlers on this class forward those
/// results unchanged; callers are responsible for dispatching to the main
/// queue when required (e.g. before calling sendEvent or resolving a Promise).
///
/// # Error Handling
/// All CloudKit errors are forwarded to completion as `.failure(Error)`.
/// Converters.toExpoError() in the module layer maps them to typed JS errors.
final class CloudKitShareManager {

  // MARK: - Properties

  private let ckContainer: CKContainer

  // MARK: - Init

  init(ckContainer: CKContainer) {
    self.ckContainer = ckContainer
  }

  // MARK: - Create Share

  /// Creates a CKShare for an existing root record in the private database.
  ///
  /// Fetches the root record by ID, wraps it in a `CKShare`, sets the public
  /// participant permission, then saves both via `CKModifyRecordsOperation`.
  ///
  /// - Parameters:
  ///   - recordName: The `CKRecord.ID.recordName` of the record to share.
  ///   - zoneName: Optional zone name. Defaults to the default zone.
  ///   - database: The database in which the root record lives.
  ///   - publicPermission: Permission granted to participants not explicitly listed.
  ///   - completion: Called with a share dictionary on success, or an error on failure.
  func createShare(
    recordName: String,
    zoneName: String?,
    database: CKDatabase,
    publicPermission: CKShare.ParticipantPermission,
    completion: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    let zoneID = zoneIDFrom(zoneName: zoneName)
    let recordID = CKRecord.ID(recordName: recordName, zoneID: zoneID)

    // Step 1: Fetch the root record so we can wrap it in a CKShare.
    // CKShare(rootRecord:) requires the live CKRecord object — we cannot
    // construct it purely from an ID.
    database.fetch(withRecordID: recordID) { [weak self] record, error in
      guard let self = self else { return }

      if let error = error {
        completion(.failure(error))
        return
      }

      guard let rootRecord = record else {
        completion(.failure(CKError(.unknownItem)))
        return
      }

      // Step 2: Create the share and configure public permission.
      let share = CKShare(rootRecord: rootRecord)
      share.publicPermission = publicPermission

      // Step 3: Save both the root record and the share together in one operation.
      // CloudKit requires both to be in the same CKModifyRecordsOperation.
      let operation = CKModifyRecordsOperation(
        recordsToSave: [rootRecord, share],
        recordIDsToDelete: nil
      )
      operation.savePolicy = .changedKeys
      operation.qualityOfService = .userInitiated

      operation.modifyRecordsResultBlock = { result in
        switch result {
        case .success:
          completion(.success(Converters.toShareDictionary(share)))
        case .failure(let error):
          completion(.failure(error))
        }
      }

      database.add(operation)
    }
  }

  // MARK: - Delete Share

  /// Deletes the CKShare record identified by shareRecordName, effectively
  /// unsharing the associated root record.
  ///
  /// - Parameters:
  ///   - shareRecordName: The `CKRecord.ID.recordName` of the `CKShare` record.
  ///   - zoneName: Optional zone name.
  ///   - database: The database containing the share.
  ///   - completion: Called with `Void` on success, or an error on failure.
  func deleteShare(
    shareRecordName: String,
    zoneName: String?,
    database: CKDatabase,
    completion: @escaping (Result<Void, Error>) -> Void
  ) {
    let zoneID = zoneIDFrom(zoneName: zoneName)
    let shareRecordID = CKRecord.ID(recordName: shareRecordName, zoneID: zoneID)

    let operation = CKModifyRecordsOperation(
      recordsToSave: nil,
      recordIDsToDelete: [shareRecordID]
    )
    operation.qualityOfService = .userInitiated

    operation.modifyRecordsResultBlock = { result in
      switch result {
      case .success:
        completion(.success(()))
      case .failure(let error):
        completion(.failure(error))
      }
    }

    database.add(operation)
  }

  // MARK: - Fetch Participants

  /// Fetches the CKShare record and returns its participant list.
  ///
  /// - Parameters:
  ///   - shareRecordName: The `CKRecord.ID.recordName` of the `CKShare` record.
  ///   - zoneName: Optional zone name.
  ///   - database: The database containing the share.
  ///   - completion: Called with an array of participant dictionaries, or an error.
  func fetchShareParticipants(
    shareRecordName: String,
    zoneName: String?,
    database: CKDatabase,
    completion: @escaping (Result<[[String: Any]], Error>) -> Void
  ) {
    fetchShare(recordName: shareRecordName, zoneName: zoneName, database: database) { result in
      switch result {
      case .success(let share):
        let participants = share.participants.map { Converters.toParticipantDictionary($0) }
        completion(.success(participants))
      case .failure(let error):
        completion(.failure(error))
      }
    }
  }

  // MARK: - Update Participant Permission

  /// Updates the permission of a single participant on an existing CKShare.
  ///
  /// Fetches the share, locates the participant by their user record name,
  /// sets the new permission, then saves the modified share.
  ///
  /// - Parameters:
  ///   - shareRecordName: The `CKRecord.ID.recordName` of the `CKShare` record.
  ///   - participantRecordName: The `CKRecord.ID.recordName` of the participant's user record.
  ///   - permission: The new permission to assign.
  ///   - zoneName: Optional zone name.
  ///   - database: The database containing the share.
  ///   - completion: Called with the updated share dictionary, or an error.
  func updateSharePermission(
    shareRecordName: String,
    participantRecordName: String,
    permission: CKShare.ParticipantPermission,
    zoneName: String?,
    database: CKDatabase,
    completion: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    fetchShare(recordName: shareRecordName, zoneName: zoneName, database: database) { [weak self] result in
      guard let self = self else { return }

      switch result {
      case .failure(let error):
        completion(.failure(error))
        return

      case .success(let share):
        guard let participant = share.participants.first(where: {
          $0.userIdentity.userRecordID?.recordName == participantRecordName
        }) else {
          completion(.failure(ShareManagerError.participantNotFound(participantRecordName)))
          return
        }

        participant.permission = permission

        self.saveShare(share, database: database) { saveResult in
          switch saveResult {
          case .success:
            completion(.success(Converters.toShareDictionary(share)))
          case .failure(let error):
            completion(.failure(error))
          }
        }
      }
    }
  }

  // MARK: - Remove Participant

  /// Removes a participant from an existing CKShare.
  ///
  /// Fetches the share, locates the participant by their user record name,
  /// removes them, then saves the modified share.
  ///
  /// - Parameters:
  ///   - shareRecordName: The `CKRecord.ID.recordName` of the `CKShare` record.
  ///   - participantRecordName: The `CKRecord.ID.recordName` of the participant's user record.
  ///   - zoneName: Optional zone name.
  ///   - database: The database containing the share.
  ///   - completion: Called with the updated share dictionary, or an error.
  func removeShareParticipant(
    shareRecordName: String,
    participantRecordName: String,
    zoneName: String?,
    database: CKDatabase,
    completion: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    fetchShare(recordName: shareRecordName, zoneName: zoneName, database: database) { [weak self] result in
      guard let self = self else { return }

      switch result {
      case .failure(let error):
        completion(.failure(error))
        return

      case .success(let share):
        guard let participant = share.participants.first(where: {
          $0.userIdentity.userRecordID?.recordName == participantRecordName
        }) else {
          completion(.failure(ShareManagerError.participantNotFound(participantRecordName)))
          return
        }

        share.removeParticipant(participant)

        self.saveShare(share, database: database) { saveResult in
          switch saveResult {
          case .success:
            completion(.success(Converters.toShareDictionary(share)))
          case .failure(let error):
            completion(.failure(error))
          }
        }
      }
    }
  }

  // MARK: - Accept Share

  /// Accepts a CloudKit share via its share URL.
  ///
  /// Calls `CKContainer.fetchShareMetadata(with:)` to validate the URL and
  /// retrieve share metadata, then uses `CKAcceptSharesOperation` to accept it.
  ///
  /// - Parameters:
  ///   - shareURL: The URL from a CloudKit share invitation (e.g. from a deep link).
  ///   - completion: Called with a share metadata dictionary, or an error.
  func acceptShare(
    shareURL: URL,
    completion: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    ckContainer.fetchShareMetadata(with: shareURL) { [weak self] metadata, error in
      guard let self = self else { return }

      if let error = error {
        completion(.failure(error))
        return
      }

      guard let metadata = metadata else {
        completion(.failure(CKError(.unknownItem)))
        return
      }

      let acceptOperation = CKAcceptSharesOperation(shareMetadatas: [metadata])
      acceptOperation.qualityOfService = .userInitiated

      var acceptedShare: CKShare?

      acceptOperation.perShareResultBlock = { _, result in
        switch result {
        case .success(let share):
          acceptedShare = share
        case .failure:
          // perShare error is captured in the overall result block
          break
        }
      }

      acceptOperation.acceptSharesResultBlock = { result in
        switch result {
        case .success:
          if let share = acceptedShare {
            completion(.success(Converters.toShareDictionary(share)))
          } else {
            // Share was accepted but we have no share object — return metadata info
            let metadataDict: [String: Any] = [
              "shareURL": shareURL.absoluteString,
              "rootRecordName": metadata.rootRecordID.recordName,
              "zoneName": metadata.rootRecordID.zoneID.zoneName
            ]
            completion(.success(metadataDict))
          }
        case .failure(let error):
          completion(.failure(error))
        }
      }

      self.ckContainer.add(acceptOperation)
    }
  }

  // MARK: - Fetch Shared Database Zones

  /// Lists all zones in the shared database.
  ///
  /// For each zone, attempts to fetch its associated CKShare to include
  /// participant information. Zones without a reachable share are included
  /// with an empty participants array.
  ///
  /// - Parameter completion: Called with an array of zone+share dictionaries, or an error.
  func fetchSharedDatabaseZones(
    completion: @escaping (Result<[[String: Any]], Error>) -> Void
  ) {
    let sharedDB = ckContainer.sharedCloudDatabase
    let fetchZonesOp = CKFetchRecordZonesOperation.fetchAllRecordZonesOperation()
    fetchZonesOp.qualityOfService = .userInitiated

    fetchZonesOp.fetchRecordZonesResultBlock = { result in
      switch result {
      case .failure(let error):
        completion(.failure(error))

      case .success(let zonesByID):
        let zones = Array(zonesByID.values)

        guard !zones.isEmpty else {
          completion(.success([]))
          return
        }

        // For each zone, build a base dictionary and attempt to attach share info.
        // We query for CKShare records in each zone to get participant data.
        var resultDicts: [[String: Any]] = []
        let group = DispatchGroup()

        for zone in zones {
          var zoneDict = Converters.toZoneDictionary(zone)
          group.enter()

          // Query for the CKShare record in this zone.
          let query = CKQuery(recordType: "cloudkit.share", predicate: NSPredicate(value: true))
          let queryOp = CKQueryOperation(query: query)
          queryOp.zoneID = zone.zoneID
          queryOp.resultsLimit = 1
          queryOp.qualityOfService = .utility

          var foundShare: CKShare?

          queryOp.recordMatchedBlock = { _, recordResult in
            if case .success(let record) = recordResult, let share = record as? CKShare {
              foundShare = share
            }
          }

          queryOp.queryResultBlock = { _ in
            if let share = foundShare {
              zoneDict["share"] = Converters.toShareDictionary(share)
            }
            resultDicts.append(zoneDict)
            group.leave()
          }

          sharedDB.add(queryOp)
        }

        group.notify(queue: .global()) {
          completion(.success(resultDicts))
        }
      }
    }

    sharedDB.add(fetchZonesOp)
  }

  // MARK: - Present Sharing UI

  /// Presents the system `UICloudSharingController` on the given view controller.
  ///
  /// If the record already has an associated share (`record.share != nil`), presents
  /// the controller in manage-participants mode using the existing share.
  /// Otherwise presents it in create-share mode using a preparation handler.
  ///
  /// Must be called from the main thread. The caller (ExpoCloudKitModule) is
  /// responsible for dispatching to main before calling this method.
  ///
  /// - Parameters:
  ///   - recordName: The root record to share or manage.
  ///   - zoneName: Optional zone name.
  ///   - database: The database containing the root record.
  ///   - presentingViewController: The view controller to present from.
  ///   - completion: Called with `(outcome: "shared"|"cancelled", share: dict?)`.
  func presentSharingUI(
    recordName: String,
    zoneName: String?,
    database: CKDatabase,
    presentingViewController: UIViewController,
    completion: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    let zoneID = zoneIDFrom(zoneName: zoneName)
    let recordID = CKRecord.ID(recordName: recordName, zoneID: zoneID)

    database.fetch(withRecordID: recordID) { [weak self] record, error in
      guard let self = self else { return }

      if let error = error {
        completion(.failure(error))
        return
      }

      guard let rootRecord = record else {
        completion(.failure(CKError(.unknownItem)))
        return
      }

      // Must present UIKit on the main thread.
      DispatchQueue.main.async {
        // Delegate captures the promise completion; strong ref held by UICloudSharingController.
        let delegate = CloudKitSharingControllerDelegate(completion: completion)

        let controller: UICloudSharingController

        if let shareReference = rootRecord.share {
          // Record is already shared — present in manage-participants mode.
          // Fetch the existing share record first.
          let shareRecordID = shareReference.recordID
          database.fetch(withRecordID: shareRecordID) { shareRecord, fetchError in
            DispatchQueue.main.async {
              if let fetchError = fetchError {
                completion(.failure(fetchError))
                return
              }

              guard let existingShare = shareRecord as? CKShare else {
                completion(.failure(CKError(.unknownItem)))
                return
              }

              let vc = UICloudSharingController(share: existingShare, container: self.ckContainer)
              vc.delegate = delegate
              // Keep delegate alive for the lifetime of the controller.
              objc_setAssociatedObject(vc, &AssociatedKeys.delegate, delegate, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
              presentingViewController.present(vc, animated: true)
            }
          }
        } else {
          // Record is not yet shared — present in create-share mode.
          controller = UICloudSharingController { [weak self] (_, prepCompletion) in
            guard let self = self else {
              prepCompletion(nil, nil, CKError(.internalError))
              return
            }

            let share = CKShare(rootRecord: rootRecord)
            let operation = CKModifyRecordsOperation(
              recordsToSave: [rootRecord, share],
              recordIDsToDelete: nil
            )
            operation.savePolicy = .changedKeys
            operation.qualityOfService = .userInitiated

            operation.modifyRecordsResultBlock = { result in
              switch result {
              case .success:
                prepCompletion(share, self.ckContainer, nil)
              case .failure(let error):
                prepCompletion(nil, nil, error)
              }
            }

            database.add(operation)
          }

          controller.delegate = delegate
          // Keep delegate alive for the lifetime of the controller.
          objc_setAssociatedObject(controller, &AssociatedKeys.delegate, delegate, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
          presentingViewController.present(controller, animated: true)
        }
      }
    }
  }

  // MARK: - Private Helpers

  /// Builds a CKRecordZone.ID from an optional zone name.
  /// Falls back to the default zone when zoneName is nil.
  private func zoneIDFrom(zoneName: String?) -> CKRecordZone.ID {
    if let name = zoneName {
      return CKRecordZone.ID(zoneName: name, ownerName: CKCurrentUserDefaultName)
    }
    return CKRecordZone.ID.default
  }

  /// Fetches the CKShare record with the given record name from the specified database.
  private func fetchShare(
    recordName: String,
    zoneName: String?,
    database: CKDatabase,
    completion: @escaping (Result<CKShare, Error>) -> Void
  ) {
    let zoneID = zoneIDFrom(zoneName: zoneName)
    let recordID = CKRecord.ID(recordName: recordName, zoneID: zoneID)

    database.fetch(withRecordID: recordID) { record, error in
      if let error = error {
        completion(.failure(error))
        return
      }

      guard let share = record as? CKShare else {
        completion(.failure(CKError(.unknownItem)))
        return
      }

      completion(.success(share))
    }
  }

  /// Saves a modified CKShare via CKModifyRecordsOperation.
  private func saveShare(
    _ share: CKShare,
    database: CKDatabase,
    completion: @escaping (Result<Void, Error>) -> Void
  ) {
    let operation = CKModifyRecordsOperation(
      recordsToSave: [share],
      recordIDsToDelete: nil
    )
    operation.savePolicy = .changedKeys
    operation.qualityOfService = .userInitiated

    operation.modifyRecordsResultBlock = { result in
      switch result {
      case .success:
        completion(.success(()))
      case .failure(let error):
        completion(.failure(error))
      }
    }

    database.add(operation)
  }
}

// MARK: - Associated Object Keys

private enum AssociatedKeys {
  static var delegate = "CloudKitSharingControllerDelegate"
}

// MARK: - UICloudSharingControllerDelegate

/// Bridges UICloudSharingController delegate callbacks to the completion closure.
/// Strongly retained via objc_setAssociatedObject on the presenting controller.
private final class CloudKitSharingControllerDelegate: NSObject, UICloudSharingControllerDelegate {

  private let completion: (Result<[String: Any], Error>) -> Void
  private var didComplete = false

  init(completion: @escaping (Result<[String: Any], Error>) -> Void) {
    self.completion = completion
  }

  func cloudSharingController(
    _ csc: UICloudSharingController,
    failedToSaveShareWithError error: Error
  ) {
    guard !didComplete else { return }
    didComplete = true
    completion(.failure(error))
  }

  func itemTitle(for csc: UICloudSharingController) -> String? {
    return nil
  }

  func cloudSharingControllerDidSaveShare(_ csc: UICloudSharingController) {
    guard !didComplete else { return }
    didComplete = true

    let shareDict = csc.share.map { Converters.toShareDictionary($0) }
    completion(.success([
      "outcome": "shared",
      "share": shareDict as Any
    ]))
  }

  func cloudSharingControllerDidStopSharing(_ csc: UICloudSharingController) {
    guard !didComplete else { return }
    didComplete = true
    completion(.success([
      "outcome": "cancelled",
      "share": NSNull()
    ]))
  }
}

// MARK: - Internal Error Types

/// Internal errors from CloudKitShareManager, distinct from CKErrors.
/// These are wrapped into typed Exceptions at the module layer.
enum ShareManagerError: Error {
  case participantNotFound(String)

  var localizedDescription: String {
    switch self {
    case .participantNotFound(let name):
      return "Participant with user record name '\(name)' not found on this share."
    }
  }
}
