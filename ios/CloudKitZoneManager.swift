import CloudKit
import Foundation

/// Manages CKRecordZone operations: create, delete, and list.
///
/// All operations are performed via CKModifyRecordZonesOperation or
/// CKFetchRecordZonesOperation for batching and error granularity.
final class CloudKitZoneManager {

  // MARK: - Properties

  private let ckContainer: CKContainer

  // MARK: - Init

  init(ckContainer: CKContainer) {
    self.ckContainer = ckContainer
  }

  // MARK: - Zone CRUD

  /// Creates a CKRecordZone with the given name.
  /// Idempotent — CloudKit returns success if the zone already exists.
  func createZone(
    named zoneName: String,
    in scope: CKDatabase.Scope,
    completion: @escaping (Result<CKRecordZone, Error>) -> Void
  ) {
    let zoneID = CKRecordZone.ID(zoneName: zoneName, ownerName: CKCurrentUserDefaultName)
    let zone = CKRecordZone(zoneID: zoneID)
    let db = database(for: scope)

    let operation = CKModifyRecordZonesOperation(
      recordZonesToSave: [zone],
      recordZoneIDsToDelete: nil
    )
    operation.qualityOfService = .userInitiated

    operation.modifyRecordZonesResultBlock = { result in
      switch result {
      case .success:
        break
      case .failure(let error):
        completion(.failure(error))
        return
      }
    }

    operation.perRecordZoneSaveBlock = { zoneID, result in
      switch result {
      case .success(let savedZone):
        completion(.success(savedZone))
      case .failure(let error):
        completion(.failure(error))
      }
    }

    db.add(operation)
  }

  /// Deletes the zone with the given name. All records in the zone are deleted.
  func deleteZone(
    named zoneName: String,
    in scope: CKDatabase.Scope,
    completion: @escaping (Result<Void, Error>) -> Void
  ) {
    let zoneID = CKRecordZone.ID(zoneName: zoneName, ownerName: CKCurrentUserDefaultName)
    let db = database(for: scope)

    let operation = CKModifyRecordZonesOperation(
      recordZonesToSave: nil,
      recordZoneIDsToDelete: [zoneID]
    )
    operation.qualityOfService = .userInitiated

    operation.modifyRecordZonesResultBlock = { result in
      switch result {
      case .success:
        completion(.success(()))
      case .failure(let error):
        completion(.failure(error))
      }
    }

    db.add(operation)
  }

  /// Fetches all custom zones in the specified database.
  /// Does not include the default zone.
  func fetchZones(
    in scope: CKDatabase.Scope,
    completion: @escaping (Result<[CKRecordZone], Error>) -> Void
  ) {
    let db = database(for: scope)
    let operation = CKFetchRecordZonesOperation.fetchAllRecordZonesOperation()
    operation.qualityOfService = .userInitiated

    // Use perRecordZoneResultBlock to collect zones (iOS 18: fetchRecordZonesResultBlock
    // returns Result<Void, Error> so individual zones are reported per-zone).
    let zonesLock = NSLock()
    var collectedZones: [CKRecordZone] = []

    operation.perRecordZoneResultBlock = { (zoneID: CKRecordZone.ID, result: Result<CKRecordZone, Error>) in
      if case .success(let zone) = result {
        zonesLock.lock()
        collectedZones.append(zone)
        zonesLock.unlock()
      }
    }

    operation.fetchRecordZonesResultBlock = { (result: Result<Void, Error>) in
      switch result {
      case .success:
        // Filter out the default zone — callers can assume it always exists
        let customZones = collectedZones.filter { $0.zoneID.zoneName != CKRecordZone.ID.default.zoneName }
        completion(.success(customZones))
      case .failure(let error):
        completion(.failure(error))
      }
    }

    db.add(operation)
  }

  // MARK: - Helpers

  private func database(for scope: CKDatabase.Scope) -> CKDatabase {
    switch scope {
    case .private:
      return ckContainer.privateCloudDatabase
    case .shared:
      return ckContainer.sharedCloudDatabase
    case .public:
      return ckContainer.publicCloudDatabase
    @unknown default:
      return ckContainer.privateCloudDatabase
    }
  }
}
