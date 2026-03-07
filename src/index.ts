/**
 * expo-cloudkit — Public API
 *
 * Import from 'expo-cloudkit' to access all CloudKit operations.
 *
 * @example
 * ```typescript
 * import {
 *   configure,
 *   getAccountStatus,
 *   createZone,
 *   saveRecords,
 *   queryRecords,
 * } from 'expo-cloudkit';
 *
 * configure('iCloud.com.example.myapp');
 * const status = await getAccountStatus();
 * if (status === 'available') {
 *   await createZone('MyZone');
 *   await saveRecords([{ recordType: 'Note', fields: { title: { type: 'string', value: 'Hello' } } }]);
 * }
 * ```
 */

// Types — re-export everything so consumers don't need to import from sub-paths
export type {
  AccountStatus,
  AssetField,
  AssetProgress,
  AssetReadValue,
  CloudKitRecord,
  DatabaseScope,
  LocationValue,
  PendingRecordChange,
  QueryPredicate,
  QueryResult,
  RecordField,
  RecordFieldValue,
  RecordIdentifier,
  RecordToSave,
  ReferenceValue,
  SavedRecord,
  SharedZone,
  Share,
  ShareParticipant,
  SharePermission,
  SharingUIResult,
  AcceptedShare,
  ParticipantAcceptanceStatus,
  ParticipantPermission,
  ParticipantRole,
  SortDescriptor,
  Subscription,
  SyncEngineConfig,
  SyncEngineEvent,
  SyncEngineEventType,
  Zone,
  ZoneChanges,
} from './types';

// Errors
export { CloudKitError, CloudKitErrorCode } from './errors';

// Phase A — Container & Account
export { configure, getAccountStatus, addAccountStatusListener } from './ExpoCloudKit';

// Phase A — Zone Management
export { createZone, deleteZone, fetchZones } from './ExpoCloudKit';

// Phase A — Record CRUD
export {
  saveRecords,
  fetchRecord,
  queryRecords,
  deleteRecords,
  fetchRecordZoneChanges,
} from './ExpoCloudKit';

// Phase B — CKSyncEngine (iOS 17+)
export {
  isSyncEngineAvailable,
  startSyncEngine,
  triggerSync,
  enqueuePendingChange,
  addSyncEngineListener,
  stopSyncEngine,
} from './ExpoCloudKit';

// Phase D — CKAsset
export { downloadAsset, addAssetProgressListener } from './ExpoCloudKit';
