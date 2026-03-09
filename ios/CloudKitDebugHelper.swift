import CloudKit
import Foundation

/// Dev-time debug utilities for CloudKit introspection.
///
/// All methods in this class are intended for development and QA use only.
/// They should not be called from production code paths. The `__debug` prefix
/// on the corresponding JS methods signals this intent.
///
/// Threading: completion handlers are called from whatever queue CloudKit
/// uses internally — callers are responsible for dispatching to the
/// appropriate queue if needed.
final class CloudKitDebugHelper {

  // MARK: - Properties

  let container: CKContainer

  // MARK: - Init

  init(container: CKContainer) {
    self.container = container
  }

  // MARK: - dumpContainerInfo

  /// Returns a dictionary with:
  ///   - `containerID`: the container's identifier string
  ///   - `accountStatus`: current iCloud account status as a string
  ///   - `environments`: array of strings indicating the CloudKit environment(s)
  ///     detectable at runtime. CloudKit's public API does not expose a direct
  ///     "development vs. production" flag; we report what can be inferred.
  func dumpContainerInfo(completion: @escaping (Result<[String: Any], Error>) -> Void) {
    container.accountStatus { [weak self] status, error in
      guard let self = self else { return }

      if let error = error {
        completion(.failure(error))
        return
      }

      let statusString: String
      switch status {
      case .available:               statusString = "available"
      case .noAccount:               statusString = "noAccount"
      case .restricted:              statusString = "restricted"
      case .couldNotDetermine:       statusString = "couldNotDetermine"
      case .temporarilyUnavailable:  statusString = "temporarilyUnavailable"
      @unknown default:              statusString = "couldNotDetermine"
      }

      // CloudKit does not expose which server environment (development /
      // production) the container is targeting at runtime. The environment
      // is determined by the entitlement baked into the app's provisioning
      // profile. We report "development" when running in the Simulator or a
      // Debug build, and "production" otherwise, to give callers a useful hint.
      var environments: [String] = []
      #if targetEnvironment(simulator)
      environments.append("development")
      #else
        #if DEBUG
        environments.append("development")
        #else
        environments.append("production")
        #endif
      #endif

      let result: [String: Any] = [
        "containerID": self.container.containerIdentifier ?? "(default)",
        "accountStatus": statusString,
        "environments": environments
      ]

      completion(.success(result))
    }
  }

  // MARK: - listZones

  /// Queries all zones in the private and shared databases.
  ///
  /// Returns an array of zone dictionaries produced by `Converters.toZoneDictionary(_:)`,
  /// each augmented with a `"database"` key (`"private"` or `"shared"`).
  ///
  /// The public database does not support custom zones; it is intentionally
  /// excluded from this listing.
  func listZones(completion: @escaping (Result<[[String: Any]], Error>) -> Void) {
    let group = DispatchGroup()
    var privateZones: [CKRecordZone] = []
    var sharedZones: [CKRecordZone] = []
    var firstError: Error? = nil
    let errorLock = NSLock()

    // Fetch private database zones
    group.enter()
    let privateOp = CKFetchRecordZonesOperation.fetchAllRecordZonesOperation()
    privateOp.fetchRecordZonesResultBlock = { result in
      switch result {
      case .success(let zonesByID):
        privateZones = Array(zonesByID.values)
      case .failure(let error):
        errorLock.lock()
        if firstError == nil { firstError = error }
        errorLock.unlock()
      }
      group.leave()
    }
    container.privateCloudDatabase.add(privateOp)

    // Fetch shared database zones
    group.enter()
    let sharedOp = CKFetchRecordZonesOperation.fetchAllRecordZonesOperation()
    sharedOp.fetchRecordZonesResultBlock = { result in
      switch result {
      case .success(let zonesByID):
        sharedZones = Array(zonesByID.values)
      case .failure(let error):
        errorLock.lock()
        if firstError == nil { firstError = error }
        errorLock.unlock()
      }
      group.leave()
    }
    container.sharedCloudDatabase.add(sharedOp)

    group.notify(queue: .global()) {
      if let error = firstError {
        completion(.failure(error))
        return
      }

      var results: [[String: Any]] = []

      for zone in privateZones {
        var dict = Converters.toZoneDictionary(zone)
        dict["database"] = "private"
        results.append(dict)
      }
      for zone in sharedZones {
        var dict = Converters.toZoneDictionary(zone)
        dict["database"] = "shared"
        results.append(dict)
      }

      completion(.success(results))
    }
  }

  // MARK: - fetchRawRecord

  /// Fetches a single record with ALL user-defined fields plus all available
  /// system metadata fields.
  ///
  /// Metadata included in the result beyond the standard `Converters.toDictionary` output:
  ///   - `creationDate`: ISO 8601 string
  ///   - `modificationDate`: ISO 8601 string
  ///   - `recordChangeTag`: opaque server version tag
  ///   - `creatorUserRecordID`: record name of the creating user (if available)
  ///   - `lastModifiedUserRecordID`: record name of the last modifier (if available)
  ///
  /// - Parameters:
  ///   - recordName: The `CKRecord.ID.recordName` to fetch.
  ///   - zoneName: Optional zone name. Defaults to `CKRecordZone.ID.default` when nil.
  ///   - database: The `CKDatabase` to fetch from (private, shared, or public).
  func fetchRawRecord(
    recordName: String,
    zoneName: String?,
    database: CKDatabase,
    completion: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    let zoneID: CKRecordZone.ID
    if let zoneName = zoneName {
      zoneID = CKRecordZone.ID(zoneName: zoneName, ownerName: CKCurrentUserDefaultName)
    } else {
      zoneID = CKRecordZone.ID.default
    }

    let recordID = CKRecord.ID(recordName: recordName, zoneID: zoneID)

    // Use CKFetchRecordsOperation so we can request desiredKeys = nil (all keys)
    // and still get all system fields via the operation's per-record result block.
    let operation = CKFetchRecordsOperation(recordIDs: [recordID])
    // nil desiredKeys means "fetch all user-defined keys"
    operation.desiredKeys = nil

    operation.perRecordResultBlock = { _, result in
      switch result {
      case .success(let record):
        // Start with the standard converter output (all user fields + common metadata).
        var dict = Converters.toDictionary(record)

        // Augment with the full set of system metadata fields not included by default.
        let isoFormatter = ISO8601DateFormatter()

        if let creatorID = record.creatorUserRecordID {
          dict["creatorUserRecordID"] = creatorID.recordName
        }
        if let modifierID = record.lastModifiedUserRecordID {
          dict["lastModifiedUserRecordID"] = modifierID.recordName
        }
        // creationDate and modificationDate are already in the standard dict,
        // but we re-emit them here under explicit names for clarity.
        if let creationDate = record.creationDate {
          dict["creationDate"] = isoFormatter.string(from: creationDate)
        }
        if let modificationDate = record.modificationDate {
          dict["modificationDate"] = isoFormatter.string(from: modificationDate)
        }
        if let changeTag = record.recordChangeTag {
          dict["recordChangeTag"] = changeTag
        }

        completion(.success(dict))

      case .failure(let error):
        completion(.failure(error))
      }
    }

    // fetchRecordsResultBlock fires after all per-record blocks. We only have
    // one record, so the per-record block handles resolution. We still need
    // to handle operation-level failures (e.g. network error before any record
    // block fires).
    operation.fetchRecordsResultBlock = { result in
      if case .failure(let error) = result {
        // Only call completion if the per-record block hasn't already.
        // Guard: per-record block for a single record always fires before this
        // block on success, so this path is only reached on operation-level errors.
        completion(.failure(error))
      }
    }

    database.add(operation)
  }

  // MARK: - clearZone

  /// Deletes all records in the named zone, then immediately recreates the
  /// empty zone so callers have a clean slate without needing a separate
  /// `createZone` call.
  ///
  /// This is implemented as:
  ///   1. Delete the zone (which CloudKit makes atomic — all records go with it).
  ///   2. Recreate the zone using a new `CKModifyRecordZonesOperation`.
  ///
  /// - Warning: This operation is destructive and permanent. Use only in
  ///   test/dev environments.
  func clearZone(
    zoneName: String,
    database: CKDatabase,
    completion: @escaping (Result<Void, Error>) -> Void
  ) {
    let zoneID = CKRecordZone.ID(zoneName: zoneName, ownerName: CKCurrentUserDefaultName)

    // Step 1: Delete the zone.
    let deleteOp = CKModifyRecordZonesOperation(
      recordZonesToSave: nil,
      recordZoneIDsToDelete: [zoneID]
    )
    deleteOp.modifyRecordZonesResultBlock = { [weak self] result in
      guard let self = self else { return }

      switch result {
      case .failure(let error):
        completion(.failure(error))

      case .success:
        // Step 2: Recreate the zone so it is ready for use immediately.
        let newZone = CKRecordZone(zoneID: zoneID)
        let recreateOp = CKModifyRecordZonesOperation(
          recordZonesToSave: [newZone],
          recordZoneIDsToDelete: nil
        )
        recreateOp.modifyRecordZonesResultBlock = { result in
          switch result {
          case .success:
            completion(.success(()))
          case .failure(let error):
            completion(.failure(error))
          }
        }
        database.add(recreateOp)
      }
    }

    database.add(deleteOp)
  }
}
