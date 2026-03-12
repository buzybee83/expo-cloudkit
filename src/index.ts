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
  OptimisticStatus,
  // Web
  WebConfigOptions,
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
  ShareInvitationEvent,
  ParticipantAcceptanceStatus,
  ParticipantPermission,
  ParticipantRole,
  // Phase B — CKShare options
  CreateShareOptions,
  DeleteShareOptions,
  PresentSharingOptions,
  FetchParticipantsOptions,
  UpdatePermissionOptions,
  RemoveParticipantOptions,
  AcceptShareOptions,
  SortDescriptor,
  Subscription,
  // Phase B — CKSyncEngine
  SyncEngineConfig,
  SyncConflictEvent,
  SyncEngineEvent,
  SyncEngineEventType,
  SyncProviderStatus,
  SyncState,
  SyncStateChangedEvent,
  RecordsFetchedEvent,
  RecordsSentEvent,
  SyncErrorEvent,
  Zone,
  ZoneChanges,
  // Phase B — Push Subscriptions
  SubscriptionType,
  CloudKitSubscription,
  SaveQuerySubscriptionOptions,
  SubscriptionNotificationType,
  QuerySubscriptionEvent,
  DatabaseSubscriptionEvent,
  SubscriptionEvent,
  // Phase C — Batch Progress
  BatchProgress,
  // Phase C — Debug / Dashboard helpers
  ContainerInfo,
  RawRecord,
  // Phase C — CKRecord.Reference deep linking
  FetchWithReferencesOptions,
  ResolvedRecord,
  // H.4 — deleteRecordWithReferences
  DeleteRecordWithReferencesOptions,
  // Phase C — Offline Queue
  OfflineQueueEntryStatus,
  OfflineQueueEntry,
  OfflineQueueStatus,
  OfflineQueueDrainResult,
  QueuedResult,
  OfflineQueueEvent,
  // G.3 — Operation configuration
  OperationConfig,
  // H.3 — Multi-container
  CloudKitClient,
} from './types';

// Errors
export { CloudKitError, CloudKitErrorCode, CloudKitNotSupportedError } from './errors';

// Phase A — Container & Account
export { configure, getAccountStatus, fetchUserRecordID, addAccountStatusListener, isCloudKitAvailable } from './ExpoCloudKit';

// Web — CloudKit Web Services (exported from the platform barrel so Metro resolves
// ExpoCloudKit.web.ts on web and ExpoCloudKit.native.ts on iOS/native)
export { configureWeb, authenticateWeb, signOutWeb, isWebAuthenticated } from './ExpoCloudKit';

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
  getSyncState,
  triggerSync,
  enqueuePendingChange,
  addSyncEngineListener,
  stopSyncEngine,
  resolveSyncConflict,
} from './ExpoCloudKit';

// Phase C — Batch Progress
export { addBatchProgressListener } from './ExpoCloudKit';

// Phase D — CKAsset
export { downloadAsset, addAssetProgressListener } from './ExpoCloudKit';

// Phase B — Push Subscriptions
export {
  saveQuerySubscription,
  saveDatabaseSubscription,
  deleteSubscription,
  fetchSubscriptions,
  addSubscriptionListener,
} from './ExpoCloudKit';

// Phase B — CKShare
export {
  createShare,
  deleteShare,
  presentSharingUI,
  fetchShareParticipants,
  updateSharePermission,
  removeShareParticipant,
  acceptShare,
  fetchSharedDatabaseZones,
  addShareAcceptedListener,
} from './ExpoCloudKit';

// Phase C — React Hooks
export {
  useCloudKitRecord,
  useCloudKitQuery,
  useCloudKitSync,
} from './hooks';

export type {
  UseCloudKitRecordOptions,
  UseCloudKitRecordReturn,
  UseCloudKitQueryOptions,
  UseCloudKitQueryReturn,
  UseCloudKitSyncOptions,
  UseCloudKitSyncReturn,
  CloudKitHookState,
} from './hooks';

// Phase C — Debug Helpers (dev-only, prefixed __debug)
export {
  __debugDumpContainerInfo,
  __debugListZones,
  __debugFetchRawRecord,
  __debugClearZone,
} from './ExpoCloudKit';

// Phase C — CKRecord.Reference deep linking
export { fetchRecordWithReferences, deleteRecordWithReferences } from './ExpoCloudKit';

// Phase C — Offline Queue
export {
  enqueueOfflineOperation,
  drainOfflineQueue,
  getOfflineQueueStatus,
  clearOfflineQueue,
  retryFailedOperations,
  addOfflineQueueListener,
} from './ExpoCloudKit';

// H.3 — Multi-container support
export { createCloudKitClient } from './ExpoCloudKit';

// H.5 — Cursor persistence
export { clearPersistedCursors } from './ExpoCloudKit';

// Phase D — DX Improvements
export { CloudKitProvider, useAccountStatus, useContainerId } from './CloudKitProvider';
export type { CloudKitProviderProps } from './CloudKitProvider';
export { useCloudKitSubscription } from './useCloudKitSubscription';
export type {
  UseCloudKitSubscriptionOptions,
  UseCloudKitSubscriptionReturn,
} from './useCloudKitSubscription';
