import CloudKit
import Foundation
#if canImport(UIKit)
  import UIKit
#endif

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

  // MARK: - Add Participant

  /// Programmatically adds a participant to an existing CKShare by email address,
  /// without presenting UICloudSharingController.
  ///
  /// Steps:
  ///   1. Fetch the CKShare record by shareRecordName + zoneName.
  ///   2. Look up the iCloud user via `CKContainer.fetchShareParticipant(withEmailAddress:)`.
  ///   3. Set the participant's permission and add them to the share.
  ///   4. Save the modified share via CKModifyRecordsOperation with savePolicy .changedKeys.
  ///
  /// The participant lookup is internal — it is not exposed as a standalone API
  /// to prevent callers from using it for email enumeration.
  ///
  /// Error handling:
  /// - If the participant lookup returns nil (or errors), a generic error is returned
  ///   that does NOT reveal whether the email address corresponds to an iCloud account.
  ///
  /// - Parameters:
  ///   - shareRecordName: The `CKRecord.ID.recordName` of the `CKShare` record.
  ///   - email: Email address of the person to invite.
  ///   - permission: The permission to grant the new participant.
  ///   - zoneName: Optional zone name.
  ///   - database: The database containing the share.
  ///   - completion: Called with the updated participant list on success, or an error on failure.
  func addParticipant(
    shareRecordName: String,
    email: String,
    permission: CKShare.ParticipantPermission,
    zoneName: String?,
    database: CKDatabase,
    completion: @escaping (Result<[[String: Any]], Error>) -> Void
  ) {
    // Step 1: Fetch the CKShare record.
    fetchShare(recordName: shareRecordName, zoneName: zoneName, database: database) { [weak self] result in
      guard let self = self else { return }

      switch result {
      case .failure(let error):
        completion(.failure(error))

      case .success(let share):
        // Step 2: Look up the participant by email address.
        // CKContainer.fetchShareParticipant(withEmailAddress:completionHandler:) is
        // available on iOS 10+ and is the correct callback-based API for this task.
        self.ckContainer.fetchShareParticipant(withEmailAddress: email) { participant, lookupError in
          if let lookupError = lookupError {
            // Map the lookup error — but use a generic message to avoid
            // revealing whether the email is a valid iCloud account.
            let ckErr = lookupError as? CKError
            // participantMayNeedVerification means CloudKit found the account but
            // the user must verify before they can be added. Surface that code
            // directly so callers can prompt appropriately.
            if ckErr?.code == .participantMayNeedVerification {
              completion(.failure(lookupError))
            } else {
              // For all other lookup failures (including .unknownItem and network
              // errors), return a generic error — do not reveal email existence.
              completion(.failure(ShareManagerError.participantLookupFailed))
            }
            return
          }

          guard let participant = participant else {
            // Nil participant without an error — treat as "not found" generically.
            completion(.failure(ShareManagerError.participantLookupFailed))
            return
          }

          // Step 3: Set permission and add to share.
          participant.permission = permission
          share.addParticipant(participant)

          // Step 4: Save the modified share.
          self.saveShare(share, database: database) { saveResult in
            switch saveResult {
            case .failure(let error):
              completion(.failure(error))
            case .success:
              let participants = share.participants.map { Converters.toParticipantDictionary($0) }
              completion(.success(participants))
            }
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

    // Collect zones via perRecordZoneResultBlock (iOS 15+).
    // In iOS 18, fetchRecordZonesResultBlock returns Result<Void, Error> so
    // individual zone results must be captured here instead.
    let zonesLock = NSLock()
    var collectedZones: [CKRecordZone] = []

    fetchZonesOp.perRecordZoneResultBlock = { (zoneID: CKRecordZone.ID, result: Result<CKRecordZone, Error>) in
      if case .success(let zone) = result {
        zonesLock.lock()
        collectedZones.append(zone)
        zonesLock.unlock()
      }
    }

    fetchZonesOp.fetchRecordZonesResultBlock = { (result: Result<Void, Error>) in
      if case .failure(let error) = result {
        completion(.failure(error))
        return
      }

      let zones = collectedZones

      guard !zones.isEmpty else {
        completion(.success([]))
        return
      }

      // For each zone, build a base dictionary and attempt to attach share info.
      // We query for CKShare records in each zone to get participant data.
      let resultQueue = DispatchQueue(label: "expo.cloudkit.fetchSharedZones.results")
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
          resultQueue.sync {
            resultDicts.append(zoneDict)
          }
          group.leave()
        }

        sharedDB.add(queryOp)
      }

      group.notify(queue: .global()) {
        completion(.success(resultDicts))
      }
    }

    sharedDB.add(fetchZonesOp)
  }

  // MARK: - Present Sharing UI

  #if canImport(UIKit)
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
  #endif // canImport(UIKit)

  // MARK: - Create Zone Share

  /// Creates or retrieves a zone-level CKShare without requiring a pre-existing root record.
  ///
  /// Internally creates a `_zoneShare` sentinel anchor record (`recordName = "\(zoneName)_share"`)
  /// in the specified zone. If a CKShare already exists for that anchor, returns the existing
  /// share immediately without creating a new one or presenting any UI.
  ///
  /// When the anchor has no share yet, creates a new CKShare with the given public permission,
  /// saves both records, then presents `UICloudSharingController` so the user can customise
  /// participants. Resolves with `nil` if the user cancels the sheet.
  ///
  /// - Parameters:
  ///   - zoneName: The zone to share.
  ///   - database: The database containing the zone.
  ///   - publicPermission: Permission granted to public participants. Default `.readWrite`.
  ///   - presentingViewController: The view controller to present `UICloudSharingController` from.
  ///   - completion: Called with a share dictionary on success, `nil` on user-cancel, or an error.
  #if canImport(UIKit)
  func createZoneShare(
    zoneName: String,
    database: CKDatabase,
    publicPermission: CKShare.ParticipantPermission,
    presentingViewController: UIViewController,
    completion: @escaping (Result<[String: Any]?, Error>) -> Void
  ) {
    let anchorRecordName = "\(zoneName)_share"
    let zoneID = CKRecordZone.ID(zoneName: zoneName, ownerName: CKCurrentUserDefaultName)
    let anchorRecordID = CKRecord.ID(recordName: anchorRecordName, zoneID: zoneID)

    // Attempt to fetch the existing anchor record.
    database.fetch(withRecordID: anchorRecordID) { [weak self] existingRecord, fetchError in
      guard let self = self else { return }

      let anchorRecord: CKRecord

      if let existing = existingRecord {
        // Anchor record exists.
        anchorRecord = existing

        // If it already has a share, return the existing share immediately.
        if let shareReference = anchorRecord.share {
          database.fetch(withRecordID: shareReference.recordID) { shareRecord, shareError in
            if let shareError = shareError {
              completion(.failure(shareError))
              return
            }
            guard let existingShare = shareRecord as? CKShare else {
              completion(.failure(CKError(.unknownItem)))
              return
            }
            completion(.success(Converters.toShareDictionary(existingShare)))
          }
          return
        }
        // Anchor exists but has no share yet — fall through to create a new share.
      } else if let ckFetchError = fetchError as? CKError, ckFetchError.code == .unknownItem {
        // Anchor does not exist yet — create a fresh one.
        anchorRecord = CKRecord(recordType: "_zoneShare", recordID: anchorRecordID)
      } else if let error = fetchError {
        // Genuine fetch error (network, auth, etc.).
        completion(.failure(error))
        return
      } else {
        // Nil record without an error — should not happen but handle defensively.
        completion(.failure(CKError(.internalError)))
        return
      }

      // Create the share and set public permission.
      let share = CKShare(rootRecord: anchorRecord)
      share.publicPermission = publicPermission

      // Save the anchor record and the share together.
      let operation = CKModifyRecordsOperation(
        recordsToSave: [anchorRecord, share],
        recordIDsToDelete: nil
      )
      operation.savePolicy = .changedKeys
      operation.qualityOfService = .userInitiated

      operation.modifyRecordsResultBlock = { result in
        switch result {
        case .failure(let error):
          completion(.failure(error))

        case .success:
          // Present UICloudSharingController on the main thread after a successful save.
          DispatchQueue.main.async {
            let delegate = ZoneShareSharingDelegate(completion: completion)
            let controller = UICloudSharingController(share: share, container: self.ckContainer)
            controller.delegate = delegate
            // Also act as presentation controller delegate so we can detect swipe-dismiss / Cancel.
            controller.presentationController?.delegate = delegate
            // Retain the delegate for the lifetime of the presented controller.
            objc_setAssociatedObject(
              controller,
              &ZoneShareAssociatedKeys.delegate,
              delegate,
              .OBJC_ASSOCIATION_RETAIN_NONATOMIC
            )
            presentingViewController.present(controller, animated: true) {
              // presentationController is set after present() completes; wire it up here
              // in case it was nil before the presentation began.
              controller.presentationController?.delegate = delegate
            }
          }
        }
      }

      database.add(operation)
    }
  }
  #endif // canImport(UIKit)

  // MARK: - Leave Share

  /// Lets the current user leave a CKShare they previously accepted.
  ///
  /// Fetches the CKShare from the specified database, locates the current user's
  /// participant entry via `share.currentUserParticipant`, removes them, then
  /// saves the modified share via `CKModifyRecordsOperation`.
  ///
  /// CloudKit notes:
  /// - The owner cannot leave their own share — CloudKit will reject the save.
  ///   Callers should use `deleteShare` instead when the current user is the owner.
  /// - If `currentUserParticipant` is nil (e.g. the share was fetched from the
  ///   owner's private DB rather than the shared DB), this rejects with
  ///   `participantNotFound("current user")`.
  ///
  /// - Parameters:
  ///   - shareRecordName: The `CKRecord.ID.recordName` of the `CKShare`.
  ///   - zoneName: Optional zone name. Defaults to the default zone.
  ///   - database: Database that contains the share (typically `sharedCloudDatabase`).
  ///   - completion: Called with `Void` on success, or an error on failure.
  func leaveShare(
    shareRecordName: String,
    zoneName: String?,
    database: CKDatabase,
    completion: @escaping (Result<Void, Error>) -> Void
  ) {
    fetchShare(recordName: shareRecordName, zoneName: zoneName, database: database) { [weak self] result in
      guard let self = self else { return }

      switch result {
      case .failure(let error):
        completion(.failure(error))

      case .success(let share):
        guard let currentUser = share.currentUserParticipant else {
          completion(.failure(ShareManagerError.participantNotFound("current user")))
          return
        }
        share.removeParticipant(currentUser)
        self.saveShare(share, database: database) { saveResult in
          completion(saveResult.map { _ in () })
        }
      }
    }
  }

  // MARK: - Create Share From Template

  /// Creates a CKShare with pre-configured metadata in a single server round trip.
  ///
  /// Combines the functionality of `createShare`/`createZoneShare` +
  /// `setShareMetadata` + `setDefaultParticipantPermission` + `addParticipant`
  /// into one atomic `CKModifyRecordsOperation`. This avoids 3–4 separate
  /// round trips when you already know the desired share configuration.
  ///
  /// Participant lookup (by email) is performed serially before the save operation.
  /// If any email lookup fails, the entire call fails before touching CloudKit records.
  ///
  /// - Parameters:
  ///   - recordName: When provided, creates a record-level share for this record.
  ///     When nil, creates a zone-level share using a sentinel anchor record.
  ///   - zoneName: Zone name. Required.
  ///   - database: Database to operate on. Typically `privateCloudDatabase`.
  ///   - title: Optional display title for share previews in Messages/Mail.
  ///   - thumbnailBase64: Optional base64-encoded PNG/JPEG thumbnail.
  ///   - publicPermission: Default permission for the share URL. Defaults to `.none`.
  ///   - participantEmails: Optional initial participants to invite (email + permission pairs).
  ///   - completion: Called with a share dictionary on success, or an error.
  func createShareFromTemplate(
    recordName: String?,
    zoneName: String,
    database: CKDatabase,
    title: String?,
    thumbnailBase64: String?,
    publicPermission: CKShare.ParticipantPermission,
    participantEmails: [(email: String, permission: CKShare.ParticipantPermission)],
    completion: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    let zoneID = CKRecordZone.ID(zoneName: zoneName, ownerName: CKCurrentUserDefaultName)

    // Step 1: Look up all participant identities upfront, before touching records.
    // This avoids creating the share only to fail at participant addition.
    lookupParticipants(emails: participantEmails.map { $0.email }) { [weak self] lookupResult in
      guard let self = self else { return }

      switch lookupResult {
      case .failure(let error):
        completion(.failure(error))

      case .success(let participants):
        // Step 2: Fetch or construct the root record.
        if let rootRecordName = recordName {
          let rootRecordID = CKRecord.ID(recordName: rootRecordName, zoneID: zoneID)
          database.fetch(withRecordID: rootRecordID) { record, error in
            if let error = error {
              completion(.failure(error))
              return
            }
            guard let rootRecord = record else {
              completion(.failure(CKError(.unknownItem)))
              return
            }
            self.saveShareFromTemplate(
              rootRecord: rootRecord,
              zoneID: zoneID,
              database: database,
              title: title,
              thumbnailBase64: thumbnailBase64,
              publicPermission: publicPermission,
              participants: participants,
              participantEmails: participantEmails,
              completion: completion
            )
          }
        } else {
          // Zone-level share: create a sentinel anchor record.
          let anchorID = CKRecord.ID(
            recordName: "\(zoneName)_zoneShareAnchor",
            zoneID: zoneID
          )
          let anchorRecord = CKRecord(recordType: "_zoneShare", recordID: anchorID)
          self.saveShareFromTemplate(
            rootRecord: anchorRecord,
            zoneID: zoneID,
            database: database,
            title: title,
            thumbnailBase64: thumbnailBase64,
            publicPermission: publicPermission,
            participants: participants,
            participantEmails: participantEmails,
            completion: completion
          )
        }
      }
    }
  }

  /// Internal helper: builds the share, applies metadata, adds participants, and saves.
  private func saveShareFromTemplate(
    rootRecord: CKRecord,
    zoneID: CKRecordZone.ID,
    database: CKDatabase,
    title: String?,
    thumbnailBase64: String?,
    publicPermission: CKShare.ParticipantPermission,
    participants: [CKShare.Participant],
    participantEmails: [(email: String, permission: CKShare.ParticipantPermission)],
    completion: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    let share = CKShare(rootRecord: rootRecord)
    share.publicPermission = publicPermission

    if let title = title {
      share[CKShare.SystemFieldKey.title] = title as CKRecordValue
    }

    if let thumbnailBase64 = thumbnailBase64,
       let thumbnailData = Data(base64Encoded: thumbnailBase64) {
      share[CKShare.SystemFieldKey.thumbnailImageData] = thumbnailData as CKRecordValue
    }

    // Apply per-participant permissions and add each one.
    for (participant, entry) in zip(participants, participantEmails) {
      participant.permission = entry.permission
      share.addParticipant(participant)
    }

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

  /// Resolves an array of email addresses to `CKShare.Participant` objects.
  /// Calls the completion with `.failure` on the first lookup error.
  private func lookupParticipants(
    emails: [String],
    completion: @escaping (Result<[CKShare.Participant], Error>) -> Void
  ) {
    guard !emails.isEmpty else {
      completion(.success([]))
      return
    }

    var participants: [CKShare.Participant] = []
    var pendingCount = emails.count

    for email in emails {
      ckContainer.fetchShareParticipant(withEmailAddress: email) { participant, error in
        if let error = error {
          completion(.failure(error))
          return
        }
        guard let participant = participant else {
          completion(.failure(ShareManagerError.participantLookupFailed))
          return
        }
        participants.append(participant)
        pendingCount -= 1
        if pendingCount == 0 {
          completion(.success(participants))
        }
      }
    }
  }

  // MARK: - Share Activity Summary

  /// Returns a summary of recent record modifications in the specified zone,
  /// grouped by the last-modifying user.
  ///
  /// Uses a `CKQuery` with `TRUEPREDICATE` sorted by `modificationDate` descending,
  /// limited to `limit` records. Each record's `lastModifiedUserRecordID` is used
  /// to group activity. When `discoverUserIdentity` succeeds for a user, the
  /// display name is included; otherwise `displayName` is nil.
  ///
  /// - Parameters:
  ///   - zoneName: Zone to summarise.
  ///   - database: Database containing the zone.
  ///   - limit: Maximum number of records to scan (capped at 200 for CloudKit limits).
  ///   - completion: Called with an array of `ShareActivityEntry` dictionaries, or an error.
  func getShareActivity(
    zoneName: String,
    database: CKDatabase,
    limit: Int,
    completion: @escaping (Result<[[String: Any]], Error>) -> Void
  ) {
    let zoneID = CKRecordZone.ID(zoneName: zoneName, ownerName: CKCurrentUserDefaultName)
    let predicate = NSPredicate(value: true)
    let query = CKQuery(recordType: "CloudDocument", predicate: predicate)
    query.sortDescriptors = [NSSortDescriptor(key: "modificationDate", ascending: false)]

    let operation = CKQueryOperation(query: query)
    operation.zoneID = zoneID
    operation.resultsLimit = max(1, min(limit, 200))
    // Fetch only the system metadata fields needed — avoid over-fetching user data.
    operation.desiredKeys = []
    operation.qualityOfService = .userInitiated

    // Accumulate { userRecordName → (recordCount, lastModifiedAt, recordTypes) }
    var activityMap: [String: (recordCount: Int, lastModifiedAt: Date, recordTypes: Set<String>)] = [:]

    operation.recordMatchedBlock = { _, result in
      switch result {
      case .success(let record):
        guard let userRecordID = record.lastModifiedUserRecordID else { return }
        let userKey = userRecordID.recordName
        let modDate = record.modificationDate ?? Date.distantPast
        if var entry = activityMap[userKey] {
          entry.recordCount += 1
          if modDate > entry.lastModifiedAt { entry.lastModifiedAt = modDate }
          entry.recordTypes.insert(record.recordType)
          activityMap[userKey] = entry
        } else {
          activityMap[userKey] = (
            recordCount: 1,
            lastModifiedAt: modDate,
            recordTypes: [record.recordType]
          )
        }
      case .failure:
        // Partial record failure — skip and continue accumulating.
        break
      }
    }

    operation.queryResultBlock = { [weak self] result in
      guard let self = self else { return }

      switch result {
      case .failure(let error):
        completion(.failure(error))

      case .success:
        // Attempt to discover display names for each user record ID.
        self.resolveDisplayNames(
          userRecordNames: Array(activityMap.keys)
        ) { displayNames in
          let entries: [[String: Any]] = activityMap.map { userKey, entry in
            [
              "userRecordName": userKey,
              "displayName": displayNames[userKey] as Any,
              "recordCount": entry.recordCount,
              "lastModifiedAt": entry.lastModifiedAt.timeIntervalSince1970 * 1000,
              "recordTypes": Array(entry.recordTypes)
            ]
          }.sorted {
            // Sort by most recent activity descending.
            let a = $0["lastModifiedAt"] as? Double ?? 0
            let b = $1["lastModifiedAt"] as? Double ?? 0
            return a > b
          }
          completion(.success(entries))
        }
      }
    }

    database.add(operation)
  }

  /// Attempts to resolve display names for a list of user record names.
  /// Names are filled in best-effort — any lookup failure leaves the entry nil.
  /// Completes asynchronously once all lookups have resolved or failed.
  private func resolveDisplayNames(
    userRecordNames: [String],
    completion: @escaping ([String: String?]) -> Void
  ) {
    guard !userRecordNames.isEmpty else {
      completion([:])
      return
    }

    var displayNames: [String: String?] = [:]
    var pendingCount = userRecordNames.count

    let lock = NSLock()

    for recordName in userRecordNames {
      let recordID = CKRecord.ID(recordName: recordName)
      ckContainer.discoverUserIdentity(withUserRecordID: recordID) { identity, _ in
        lock.lock()
        defer { lock.unlock() }

        if let identity = identity,
           let components = identity.nameComponents {
          let formatter = PersonNameComponentsFormatter()
          displayNames[recordName] = formatter.string(from: components)
        } else {
          displayNames[recordName] = nil
        }

        pendingCount -= 1
        if pendingCount == 0 {
          completion(displayNames)
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

#if canImport(UIKit)

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
    completion(.success(["outcome": "shared", "share": NSNull()]))
  }
}

#endif // canImport(UIKit)

#if canImport(UIKit)

// MARK: - Zone Share Associated Object Keys

private enum ZoneShareAssociatedKeys {
  static var delegate = "ZoneShareSharingDelegate"
}

// MARK: - UICloudSharingControllerDelegate for createZoneShare

/// Bridges UICloudSharingController delegate callbacks to the `createZoneShare` completion.
/// Also acts as `UIAdaptivePresentationControllerDelegate` to detect swipe-to-dismiss / Cancel.
/// Retained via `objc_setAssociatedObject` on the presented controller.
private final class ZoneShareSharingDelegate: NSObject,
  UICloudSharingControllerDelegate,
  UIAdaptivePresentationControllerDelegate
{

  private let completion: (Result<[String: Any]?, Error>) -> Void
  private var didComplete = false

  init(completion: @escaping (Result<[String: Any]?, Error>) -> Void) {
    self.completion = completion
  }

  // MARK: UICloudSharingControllerDelegate

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
    completion(.success(shareDict))
  }

  func cloudSharingControllerDidStopSharing(_ csc: UICloudSharingController) {
    guard !didComplete else { return }
    didComplete = true
    // User stopped sharing (removed the share). Resolve with nil — not an error.
    completion(.success(nil))
  }

  // MARK: UIAdaptivePresentationControllerDelegate

  /// Called when the sheet is dismissed interactively (swipe down or Cancel button).
  /// `UICloudSharingController` does not fire a sharing delegate method in this case,
  /// so we use the presentation controller callback to resolve the promise with nil.
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    guard !didComplete else { return }
    didComplete = true
    completion(.success(nil))
  }
}

#endif // canImport(UIKit)

// MARK: - Internal Error Types

/// Internal errors from CloudKitShareManager, distinct from CKErrors.
/// These are wrapped into typed Exceptions at the module layer.
enum ShareManagerError: Error {
  case participantNotFound(String)
  /// Returned when `fetchShareParticipant(withEmailAddress:)` fails or returns nil.
  /// The message is deliberately generic — it must NOT reveal whether the email
  /// address corresponds to a valid iCloud account (email enumeration guard).
  case participantLookupFailed

  var localizedDescription: String {
    switch self {
    case .participantNotFound(let name):
      return "Participant with user record name '\(name)' not found on this share."
    case .participantLookupFailed:
      return "Could not find a participant for the provided email address."
    }
  }
}
