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
  ShareMetadata,
  ShareParticipant,
  SharePermission,
  SharingUIResult,
  AcceptedShare,
  ShareAcceptedEvent,
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
  SetDefaultParticipantPermissionOptions,
  SetShareMetadataOptions,
  RemoveParticipantOptions,
  AddParticipantOptions,
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
  SyncStateMap,
  RecordsFetchedEvent,
  RecordsSentEvent,
  SyncErrorEvent,
  SyncCompletedEvent,
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
  // Phase I.3 — Observability
  OperationMetrics,
  SyncHealthEvent,
  // Phase I.1 — Batch Fetch & Rate Limiting
  BatchFetchResult,
  RateLimitedEvent,
} from './types';

// Errors
export {
  CloudKitError,
  CloudKitErrorCode,
  CloudKitNotSupportedError,
  CloudKitUnavailableError,
  CloudKitValidationError,
} from './errors';

// Module availability
export { isNativeModuleAvailable } from './ExpoCloudKit';

// Phase J.2 — Zod schema validation helpers
export { createCloudKitSchema } from './schema';
export type { CloudKitParser } from './schema';

// Phase J.3 — Android sign-in helpers
export { authenticateAndroid, handleAuthRedirect } from './android/auth';

// Phase A — Container & Account
export { configure, getAccountStatus, fetchUserRecordID, addAccountStatusListener, isCloudKitAvailable } from './ExpoCloudKit';

// Web — CloudKit Web Services (exported from the platform barrel so Metro resolves
// ExpoCloudKit.web.ts on web and ExpoCloudKit.native.ts on iOS/native)
export { configureWeb, authenticateWeb, signOutWeb, isWebAuthenticated } from './ExpoCloudKit';

// Phase A — Zone Management
export { createZone, deleteZone, fetchZones, fetchPrivateDatabaseZones } from './ExpoCloudKit';

// Phase A — Record CRUD
export {
  saveRecords,
  fetchRecord,
  queryRecords,
  deleteRecords,
  fetchRecordZoneChanges,
  fetchAllZoneChanges,
  fetchZoneRecords,
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
  createZoneShare,
  deleteShare,
  presentSharingUI,
  fetchShareParticipants,
  updateSharePermission,
  setDefaultParticipantPermission,
  removeShareParticipant,
  addParticipant,
  acceptShare,
  fetchShareMetadata,
  fetchSharedDatabaseZones,
  addShareAcceptedListener,
  setShareMetadata,
  getShareURL,
} from './ExpoCloudKit';

// Phase C — React Hooks
export {
  useCloudKitRecord,
  useCloudKitQuery,
  useCloudKitSync,
  useInfiniteQuery,
} from './hooks';

export type {
  UseCloudKitRecordOptions,
  UseCloudKitRecordReturn,
  UseCloudKitQueryOptions,
  UseCloudKitQueryReturn,
  UseCloudKitSyncOptions,
  UseCloudKitSyncReturn,
  CloudKitHookState,
  UseInfiniteQueryOptions,
  UseInfiniteQueryResult,
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
  drainOfflineQueueForZone,
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

// Phase I — useCloudKitStatus hook
export { useCloudKitStatus } from './useCloudKitStatus';
export type { CloudKitStatus, UseCloudKitStatusOptions } from './useCloudKitStatus';

// Phase I.3 — Observability
export { addSyncHealthListener } from './ExpoCloudKit';

// Phase I.1 — Batch Fetch & Rate Limiting
export { batchFetchRecords, addRateLimitedListener } from './ExpoCloudKit';
export { useSyncHealth } from './hooks/useSyncHealth';
export type { SyncHealthState } from './hooks/useSyncHealth';

// Background Sync — BGTaskScheduler (iOS 13+)
export { registerBackgroundSync, scheduleBackgroundSync } from './ExpoCloudKit';

// Token management — persist CKServerChangeToken across reinstalls
export { getZoneChangeToken, setZoneChangeToken } from './ExpoCloudKit';
