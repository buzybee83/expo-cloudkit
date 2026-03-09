/**
 * expo-cloudkit — Native module binding
 *
 * Wraps the iOS native ExpoCloudKitModule using expo-modules-core.
 * All async operations reject with CloudKitError on failure.
 *
 * Note: This module is iOS-only. On other platforms, calling any function
 * will throw a CloudKitError with code UNKNOWN and a clear message.
 */

import { EventEmitter, requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

import { CloudKitError, CloudKitErrorCode, CloudKitNotSupportedError } from './errors';
import type {
  AcceptedShare,
  AcceptShareOptions,
  AccountStatus,
  AssetProgress,
  BatchProgress,
  CloudKitRecord,
  CloudKitSubscription,
  CreateShareOptions,
  DatabaseScope,
  DeleteShareOptions,
  FetchParticipantsOptions,
  PendingRecordChange,
  PresentSharingOptions,
  QueryPredicate,
  QueryResult,
  RecordIdentifier,
  RecordToSave,
  RemoveParticipantOptions,
  SavedRecord,
  SaveQuerySubscriptionOptions,
  Share,
  SharedZone,
  ShareInvitationEvent,
  ShareParticipant,
  SharingUIResult,
  SortDescriptor,
  Subscription,
  SubscriptionEvent,
  SyncEngineConfig,
  SyncEngineEvent,
  SyncState,
  UpdatePermissionOptions,
  Zone,
  ZoneChanges,
} from './types';

// ---------------------------------------------------------------------------
// Native module acquisition
// ---------------------------------------------------------------------------

/** True on iOS; false on Android, web, and all other platforms. */
const isIOS = Platform.OS === 'ios';

/**
 * Attempts to acquire the native module. On Android or web this will throw,
 * which we catch and replace with a stub that throws CloudKitNotSupportedError
 * on every call.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let NativeModule: Record<string, any> | null = null;
let emitter: EventEmitter | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = requireNativeModule<Record<string, any>>('ExpoCloudKit');
  NativeModule = mod;
  // EventEmitter expects { __expo_module_name__?, startObserving?, stopObserving?, ... }
  // The return value of requireNativeModule satisfies this at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emitter = new EventEmitter(mod as any);
} catch {
  // Platform does not support CloudKit. All calls will produce a clear error.
}

/**
 * Throws CloudKitNotSupportedError on non-iOS platforms.
 * Throws CloudKitError(UNKNOWN) if the native module failed to load on iOS
 * (should not happen in practice).
 */
function assertNativeAvailable(): void {
  if (!isIOS) {
    throw new CloudKitNotSupportedError();
  }
  if (!NativeModule) {
    throw new CloudKitError(
      CloudKitErrorCode.UNKNOWN,
      'expo-cloudkit native module failed to load. Ensure the iOS build includes the ExpoCloudKit module.'
    );
  }
}

/** No-op Subscription returned by event listener helpers on non-iOS platforms. */
const noopSubscription: Subscription = { remove: () => {} };

/**
 * Wraps a native async call so that native errors are converted to CloudKitError.
 */
async function callAsync<T>(fn: () => Promise<T>): Promise<T> {
  assertNativeAvailable();
  try {
    return await fn();
  } catch (err) {
    throw CloudKitError.fromNativeError(err);
  }
}

// ---------------------------------------------------------------------------
// Container & Account (Phase A)
// ---------------------------------------------------------------------------

/**
 * Configures the module to use the specified CloudKit container.
 * Must be called before any other operation.
 *
 * @param containerId - Your container identifier, e.g. "iCloud.com.example.myapp"
 */
export function configure(containerId: string): void {
  assertNativeAvailable();
  try {
    NativeModule!.configure(containerId);
  } catch (err) {
    throw CloudKitError.fromNativeError(err);
  }
}

/**
 * Returns the current iCloud account status.
 * Rejects if CloudKit is unavailable.
 */
export function getAccountStatus(): Promise<AccountStatus> {
  return callAsync(() => NativeModule!.getAccountStatus());
}

/**
 * Registers a callback that fires whenever the iCloud account status changes.
 * Returns a Subscription handle; call `.remove()` to unsubscribe.
 */
export function addAccountStatusListener(
  callback: (status: AccountStatus) => void
): Subscription {
  if (!isIOS) return noopSubscription;
  assertNativeAvailable();
  const subscription = emitter!.addListener('onAccountStatusChanged', (event: { status: AccountStatus }) => {
    callback(event.status);
  });
  return {
    remove: () => subscription.remove(),
  };
}

// ---------------------------------------------------------------------------
// Zone Management (Phase A)
// ---------------------------------------------------------------------------

/**
 * Creates a custom CKRecordZone in the specified database.
 * Idempotent — safe to call if the zone already exists.
 *
 * @param zoneName  - The name of the zone to create.
 * @param database  - Which database to create the zone in. Default: 'private'.
 */
export function createZone(
  zoneName: string,
  database: DatabaseScope = 'private'
): Promise<Zone> {
  return callAsync(() => NativeModule!.createZone(zoneName, database));
}

/**
 * Deletes a CKRecordZone and all records within it.
 * This action is permanent and cannot be undone.
 *
 * @param zoneName  - The name of the zone to delete.
 * @param database  - Which database the zone lives in. Default: 'private'.
 */
export function deleteZone(
  zoneName: string,
  database: DatabaseScope = 'private'
): Promise<void> {
  return callAsync(() => NativeModule!.deleteZone(zoneName, database));
}

/**
 * Returns all custom zones in the specified database.
 *
 * @param database - Which database to query. Default: 'private'.
 */
export function fetchZones(database: DatabaseScope = 'private'): Promise<Zone[]> {
  return callAsync(() => NativeModule!.fetchZones(database));
}

// ---------------------------------------------------------------------------
// Record CRUD (Phase A)
// ---------------------------------------------------------------------------

/**
 * Saves one or more records to CloudKit.
 * Records with a `recordName` are updated; records without one are inserted
 * with a CloudKit-generated UUID.
 *
 * Provide `changeTag` on each record to opt in to server-side conflict
 * detection. On conflict, rejects with CloudKitError code CONFLICT, with
 * `serverRecord` populated for merge resolution.
 *
 * CloudKit limit: max 400 records per call.
 *
 * @param records   - Records to save.
 * @param database  - Target database. Default: 'private'.
 */
export function saveRecords(
  records: RecordToSave[],
  database: DatabaseScope = 'private'
): Promise<SavedRecord[]> {
  return callAsync(() => NativeModule!.saveRecords(records, database));
}

/**
 * Fetches a single record by its type and ID.
 *
 * @param recordType  - The CKRecord.recordType string.
 * @param recordId    - The CKRecord.ID.recordName string.
 * @param zoneName    - Zone the record lives in. Omit for the default zone.
 * @param database    - Which database to query. Default: 'private'.
 */
export function fetchRecord(
  recordType: string,
  recordId: string,
  zoneName?: string,
  database: DatabaseScope = 'private'
): Promise<CloudKitRecord> {
  return callAsync(() => NativeModule!.fetchRecord(recordType, recordId, zoneName ?? null, database));
}

/**
 * Queries records by type with an optional predicate and sort descriptors.
 * Supports cursor-based pagination via the returned `cursor` field.
 *
 * @param recordType      - CKRecord type to query.
 * @param predicate       - Optional filter predicate.
 * @param sortDescriptors - Optional sort order.
 * @param zoneName        - Zone to query. Omit for the default zone.
 * @param database        - Which database to query. Default: 'private'.
 * @param resultsLimit    - Max records to return (1–200). Default: 100.
 * @param cursor          - Pagination cursor from a previous QueryResult.
 */
export function queryRecords(
  recordType: string,
  predicate?: QueryPredicate,
  sortDescriptors?: SortDescriptor[],
  zoneName?: string,
  database: DatabaseScope = 'private',
  resultsLimit?: number,
  cursor?: string
): Promise<QueryResult> {
  return callAsync(() =>
    NativeModule!.queryRecords(
      recordType,
      predicate ?? null,
      sortDescriptors ?? null,
      zoneName ?? null,
      database,
      resultsLimit ?? 100,
      cursor ?? null
    )
  );
}

/**
 * Deletes one or more records permanently.
 *
 * @param recordIds  - Identifiers of records to delete.
 * @param database   - Which database the records live in. Default: 'private'.
 */
export function deleteRecords(
  recordIds: RecordIdentifier[],
  database: DatabaseScope = 'private'
): Promise<void> {
  return callAsync(() => NativeModule!.deleteRecords(recordIds, database));
}

/**
 * Fetches all record changes in the specified zones since the last sync token.
 * Use the returned `syncToken` on the next call to receive only new changes.
 *
 * If `moreComing` is true in the result, call again with the returned `syncToken`
 * until `moreComing` is false.
 *
 * @param zoneNames - Zones to fetch changes for.
 * @param database  - Which database to query. Default: 'private'.
 */
export function fetchRecordZoneChanges(
  zoneNames: string[],
  database: DatabaseScope = 'private'
): Promise<ZoneChanges> {
  return callAsync(() => NativeModule!.fetchRecordZoneChanges(zoneNames, database));
}

// ---------------------------------------------------------------------------
// CKSyncEngine (Phase B — iOS 17+ only)
// ---------------------------------------------------------------------------

/**
 * Returns true if CKSyncEngine is available on this device (iOS 17+).
 */
export function isSyncEngineAvailable(): boolean {
  if (!NativeModule) return false;
  try {
    return NativeModule.isSyncEngineAvailable() as boolean;
  } catch {
    return false;
  }
}

/**
 * Initializes CKSyncEngine for the specified zones.
 *
 * On iOS 17+, delegates scheduling to CKSyncEngine (automatic, system-managed).
 * On iOS 16, starts a polling timer (default 30s interval) using
 * `CKFetchRecordZoneChangesOperation` as the fallback.
 *
 * @param config - Zones, database scope, and scheduling preferences.
 * @throws {CloudKitError} code NOT_AUTHENTICATED if the user is not signed in.
 */
export function startSyncEngine(config: SyncEngineConfig): Promise<void> {
  return callAsync(() => NativeModule!.startSyncEngine(config));
}

/**
 * Returns the current state of the sync provider.
 *
 * This is a synchronous call that reads in-memory state — it never touches
 * the network. Subscribe to `addSyncEngineListener` for real-time updates
 * via `stateChanged` events.
 *
 * Returns `{ usesSyncEngine: false, status: 'notStarted' }` when
 * `startSyncEngine()` has not been called.
 *
 * @example
 * ```typescript
 * const { status } = getSyncState();
 * if (status === 'syncing') {
 *   // Show a loading indicator
 * }
 * ```
 */
export function getSyncState(): SyncState {
  if (!NativeModule) {
    return { usesSyncEngine: false, status: 'notStarted' };
  }
  try {
    return NativeModule.getSyncState() as SyncState;
  } catch {
    return { usesSyncEngine: false, status: 'notStarted' };
  }
}

/**
 * Manually triggers a sync cycle.
 *
 * On iOS 17+, asks CKSyncEngine to fetch and send changes immediately.
 * On iOS 16, runs one fetch + push cycle synchronously outside the timer.
 *
 * @throws {CloudKitError} code SYNC_ENGINE_NOT_RUNNING if the engine is not started.
 */
export function triggerSync(): Promise<void> {
  return callAsync(() => NativeModule!.triggerSync());
}

/**
 * Queues a record change for CKSyncEngine to process on its next cycle.
 */
export function enqueuePendingChange(change: PendingRecordChange): void {
  assertNativeAvailable();
  try {
    NativeModule!.enqueuePendingChange(change);
  } catch (err) {
    throw CloudKitError.fromNativeError(err);
  }
}

/**
 * Listens for all CKSyncEngine events through the single `onSyncEngineEvent` channel.
 *
 * All sync events are dispatched to all active listeners; filter by `event.type`
 * to handle specific cases. Typically there will be 1–2 active listeners per app.
 *
 * Event types:
 * - `'stateChanged'`   — Sync provider state transitioned (idle/syncing/suspended).
 * - `'recordsFetched'` — New or modified records arrived from the server.
 * - `'recordsSent'`    — Local changes were pushed; includes failures with server versions.
 * - `'syncError'`      — An unrecoverable error occurred.
 *
 * @param callback - Called on the main thread whenever a sync event fires.
 * @returns A Subscription; call `.remove()` to stop receiving events.
 *
 * @example
 * ```typescript
 * const sub = addSyncEngineListener((event) => {
 *   switch (event.type) {
 *     case 'recordsFetched':
 *       applyChanges(event.changedRecords, event.deletedRecordIDs);
 *       break;
 *     case 'recordsSent':
 *       handleFailures(event.failedRecords);
 *       break;
 *   }
 * });
 * // Later:
 * sub.remove();
 * ```
 */
export function addSyncEngineListener(
  callback: (event: SyncEngineEvent) => void
): Subscription {
  if (!isIOS) return noopSubscription;
  assertNativeAvailable();
  const subscription = emitter!.addListener('onSyncEngineEvent', callback);
  return { remove: () => subscription.remove() };
}

/**
 * Stops the sync engine and releases its resources.
 *
 * After this call, `getSyncState()` returns `{ status: 'notStarted' }`.
 * Call `startSyncEngine()` again to resume syncing.
 *
 * @throws {CloudKitError} code SYNC_ENGINE_NOT_RUNNING if the engine is not started.
 */
export function stopSyncEngine(): Promise<void> {
  return callAsync(() => NativeModule!.stopSyncEngine());
}

// ---------------------------------------------------------------------------
// Asset progress (Phase D)
// ---------------------------------------------------------------------------

/**
 * Listens for CKAsset upload/download progress events.
 */
export function addAssetProgressListener(
  callback: (progress: AssetProgress) => void
): Subscription {
  if (!isIOS) return noopSubscription;
  assertNativeAvailable();
  const subscription = emitter!.addListener('onAssetProgress', callback);
  return { remove: () => subscription.remove() };
}

// ---------------------------------------------------------------------------
// Batch progress (Phase C)
// ---------------------------------------------------------------------------

/**
 * Listens for per-record progress events emitted during a `saveRecords` batch.
 *
 * The native side emits `onBatchProgress` once for each record processed by
 * `CKModifyRecordsOperation`, allowing callers to show incremental progress UI
 * during large batch saves.
 *
 * @param callback - Called on the main thread for each record processed.
 * @returns A Subscription handle; call `.remove()` to stop receiving events.
 *
 * @example
 * ```typescript
 * const sub = addBatchProgressListener((progress) => {
 *   console.log(`${progress.completed}/${progress.total} — ${progress.recordName}`);
 * });
 * // Later:
 * sub.remove();
 * ```
 */
export function addBatchProgressListener(
  callback: (progress: BatchProgress) => void
): Subscription {
  if (!isIOS) return noopSubscription;
  assertNativeAvailable();
  const subscription = emitter!.addListener('onBatchProgress', callback);
  return { remove: () => subscription.remove() };
}

/**
 * Downloads a CKAsset field to a local file path.
 *
 * @param recordType      - CKRecord type.
 * @param recordId        - CKRecord recordName.
 * @param fieldName       - Name of the asset field on the record.
 * @param destinationPath - Local file path to write the asset to.
 * @param zoneName        - Zone the record lives in.
 * @param database        - Which database. Default: 'private'.
 * @returns               - The local file path after download completes.
 */
export function downloadAsset(
  recordType: string,
  recordId: string,
  fieldName: string,
  destinationPath: string,
  zoneName?: string,
  database: DatabaseScope = 'private'
): Promise<string> {
  return callAsync(() =>
    NativeModule!.downloadAsset(
      recordType,
      recordId,
      fieldName,
      destinationPath,
      zoneName ?? null,
      database
    )
  );
}

// ---------------------------------------------------------------------------
// Push Subscriptions (Phase B)
// ---------------------------------------------------------------------------

/**
 * Creates a CKQuerySubscription that delivers push notifications when records
 * of the given type are created, updated, or deleted.
 *
 * The subscription is saved to iCloud so it survives app restarts.
 * Duplicate subscriptions for the same `recordType` + `zoneName` are
 * de-duplicated on the server.
 *
 * @param options - Record type, optional predicate, trigger flags, and database.
 * @returns The opaque subscription ID string assigned by CloudKit.
 * @throws {CloudKitError} code NOT_AUTHENTICATED if the user is not signed in.
 * @throws {CloudKitError} code NETWORK_UNAVAILABLE if the device is offline.
 *
 * @example
 * ```typescript
 * const id = await saveQuerySubscription({
 *   recordType: 'Note',
 *   firesOnRecordCreation: true,
 *   firesOnRecordUpdate: true,
 *   firesOnRecordDeletion: false,
 *   zoneName: 'myZone',
 * });
 * ```
 */
export function saveQuerySubscription(
  options: SaveQuerySubscriptionOptions
): Promise<string> {
  return callAsync(() => NativeModule!.saveQuerySubscription(options));
}

/**
 * Creates a CKDatabaseSubscription that delivers a push notification whenever
 * any records change in the specified database.
 *
 * On receiving this notification, call `fetchRecordZoneChanges` to retrieve
 * the actual deltas (the push payload does not include record data).
 *
 * @param database - Which database to monitor. Default: 'private'.
 * @returns The opaque subscription ID string assigned by CloudKit.
 * @throws {CloudKitError} code NOT_AUTHENTICATED if the user is not signed in.
 * @throws {CloudKitError} code NETWORK_UNAVAILABLE if the device is offline.
 *
 * @example
 * ```typescript
 * const id = await saveDatabaseSubscription('private');
 * ```
 */
export function saveDatabaseSubscription(
  database: DatabaseScope = 'private'
): Promise<string> {
  return callAsync(() => NativeModule!.saveDatabaseSubscription(database));
}

/**
 * Deletes an existing subscription by ID.
 *
 * Safe to call if the subscription no longer exists — the native layer maps
 * a missing-subscription server error to CloudKitErrorCode.SUBSCRIPTION_NOT_FOUND.
 *
 * @param subscriptionID - The subscription ID returned by a previous save call.
 * @param database       - The database the subscription belongs to. Default: 'private'.
 * @throws {CloudKitError} code SUBSCRIPTION_NOT_FOUND if the ID does not exist.
 *
 * @example
 * ```typescript
 * await deleteSubscription(id, 'private');
 * ```
 */
export function deleteSubscription(
  subscriptionID: string,
  database: DatabaseScope = 'private'
): Promise<void> {
  return callAsync(() => NativeModule!.deleteSubscription(subscriptionID, database));
}

/**
 * Returns all active subscriptions for the specified database.
 *
 * @param database - Which database to query. Default: 'private'.
 * @returns Array of subscriptions, each with `id`, `type`, optional `recordType`, and `database`.
 * @throws {CloudKitError} code NOT_AUTHENTICATED if the user is not signed in.
 *
 * @example
 * ```typescript
 * const subs = await fetchSubscriptions('private');
 * subs.forEach(sub => console.log(sub.id, sub.type));
 * ```
 */
export function fetchSubscriptions(
  database: DatabaseScope = 'private'
): Promise<CloudKitSubscription[]> {
  return callAsync(() => NativeModule!.fetchSubscriptions(database));
}

/**
 * Registers a listener for push subscription notification events delivered
 * through the `onSubscriptionEvent` native event channel.
 *
 * Events arrive when the app is foregrounded after receiving a silent push
 * from a CloudKit subscription. Filter by `event.type` to handle query vs.
 * database subscription events.
 *
 * @param callback - Called on the main thread when a subscription event fires.
 * @returns A Subscription handle; call `.remove()` to stop receiving events.
 *
 * @example
 * ```typescript
 * const sub = addSubscriptionListener((event) => {
 *   if (event.type === 'query') {
 *     console.log(event.notificationType, event.recordID);
 *   } else {
 *     fetchRecordZoneChanges(['myZone']);
 *   }
 * });
 * // Later:
 * sub.remove();
 * ```
 */
export function addSubscriptionListener(
  callback: (event: SubscriptionEvent) => void
): Subscription {
  if (!isIOS) return noopSubscription;
  assertNativeAvailable();
  const subscription = emitter!.addListener('onSubscriptionEvent', callback);
  return { remove: () => subscription.remove() };
}

// ---------------------------------------------------------------------------
// CKShare (Phase B)
// ---------------------------------------------------------------------------

/**
 * Creates a new CKShare for the specified root record, enabling it to be
 * shared with other iCloud users.
 *
 * Internally calls `CKModifyRecordsOperation` to save the new CKShare record.
 * A record can only be the root of one active share at a time.
 *
 * @param options - Root record identifier, zone, database, and initial public permission.
 * @returns The newly created Share record, including the share URL.
 * @throws {CloudKitError} code ALREADY_SHARED if the record is already shared.
 * @throws {CloudKitError} code NOT_AUTHENTICATED if the user is not signed in.
 * @throws {CloudKitError} code NETWORK_UNAVAILABLE if the device is offline.
 *
 * @example
 * ```typescript
 * const share = await createShare({ recordName: 'abc123', zoneName: 'MyZone' });
 * console.log(share.shareURL); // https://www.icloud.com/share/...
 * ```
 */
export function createShare(options: CreateShareOptions): Promise<Share> {
  return callAsync(() => NativeModule!.createShare(options));
}

/**
 * Deletes an existing CKShare record, revoking access for all participants.
 *
 * The root record is not deleted — only the share relationship is removed.
 *
 * @param options - Share record name, zone, and database.
 * @throws {CloudKitError} code SHARE_NOT_FOUND if the share record does not exist.
 * @throws {CloudKitError} code NOT_AUTHENTICATED if the user is not signed in.
 *
 * @example
 * ```typescript
 * await deleteShare({ shareRecordName: 'share-uuid', zoneName: 'MyZone' });
 * ```
 */
export function deleteShare(options: DeleteShareOptions): Promise<void> {
  return callAsync(() => NativeModule!.deleteShare(options));
}

/**
 * Presents the system `UICloudSharingController` for the specified record.
 *
 * Creates a share if one does not already exist, then shows the sharing sheet.
 * The promise resolves when the user dismisses the controller.
 *
 * @param options - Root record identifier, zone, database, and initial permission.
 * @returns An outcome ('shared' | 'cancelled') plus the current Share state.
 * @throws {CloudKitError} code SHARING_UI_UNAVAILABLE if no view controller is available.
 * @throws {CloudKitError} code NOT_AUTHENTICATED if the user is not signed in.
 *
 * @example
 * ```typescript
 * const result = await presentSharingUI({ recordName: 'abc123', zoneName: 'MyZone' });
 * if (result.outcome === 'shared') {
 *   console.log(result.share?.shareURL);
 * }
 * ```
 */
export function presentSharingUI(options: PresentSharingOptions): Promise<SharingUIResult> {
  return callAsync(() => NativeModule!.presentSharingUI(options));
}

/**
 * Returns the current list of participants on an existing share.
 *
 * Includes the owner and all invited users with their acceptance status
 * and permission levels.
 *
 * @param options - Share record name, zone, and database.
 * @returns Array of ShareParticipant objects.
 * @throws {CloudKitError} code SHARE_NOT_FOUND if the share record does not exist.
 * @throws {CloudKitError} code NOT_AUTHENTICATED if the user is not signed in.
 *
 * @example
 * ```typescript
 * const participants = await fetchShareParticipants({ shareRecordName: 'share-uuid' });
 * participants.forEach(p => console.log(p.participantRecordName, p.acceptanceStatus));
 * ```
 */
export function fetchShareParticipants(
  options: FetchParticipantsOptions
): Promise<ShareParticipant[]> {
  return callAsync(() => NativeModule!.fetchShareParticipants(options));
}

/**
 * Changes the permission level of a specific participant on a share.
 *
 * The owner's permission cannot be changed.
 *
 * @param options - Share record name, participant record name, new permission, and zone.
 * @returns The updated Share record reflecting the new participant permission.
 * @throws {CloudKitError} code SHARE_NOT_FOUND if the share record does not exist.
 * @throws {CloudKitError} code PARTICIPANT_NOT_FOUND if the participant is not on the share.
 * @throws {CloudKitError} code PERMISSION_DENIED if the caller is not the share owner.
 *
 * @example
 * ```typescript
 * const updated = await updateSharePermission({
 *   shareRecordName: 'share-uuid',
 *   participantRecordName: 'participant-uuid',
 *   permission: 'readWrite',
 * });
 * ```
 */
export function updateSharePermission(options: UpdatePermissionOptions): Promise<Share> {
  return callAsync(() => NativeModule!.updateSharePermission(options));
}

/**
 * Removes a participant from a share, revoking their access to the shared zone.
 *
 * @param options - Share record name, participant record name, and zone.
 * @returns The updated Share record after the participant is removed.
 * @throws {CloudKitError} code SHARE_NOT_FOUND if the share record does not exist.
 * @throws {CloudKitError} code PARTICIPANT_NOT_FOUND if the participant is not on the share.
 * @throws {CloudKitError} code PERMISSION_DENIED if the caller is not the share owner.
 *
 * @example
 * ```typescript
 * const updated = await removeShareParticipant({
 *   shareRecordName: 'share-uuid',
 *   participantRecordName: 'participant-uuid',
 * });
 * ```
 */
export function removeShareParticipant(options: RemoveParticipantOptions): Promise<Share> {
  return callAsync(() => NativeModule!.removeShareParticipant(options));
}

/**
 * Accepts a share invitation via its URL, making the shared zone accessible
 * in the current user's shared database.
 *
 * Call `fetchSharedDatabaseZones()` after acceptance to enumerate what was shared.
 *
 * @param options - The share URL from the invitation link.
 * @returns The accepted share metadata including zone name and owner.
 * @throws {CloudKitError} code SHARE_NOT_FOUND if the share URL is invalid or expired.
 * @throws {CloudKitError} code NOT_AUTHENTICATED if the user is not signed in.
 *
 * @example
 * ```typescript
 * const accepted = await acceptShare({ shareURL: 'https://www.icloud.com/share/...' });
 * console.log(accepted.zoneName, accepted.ownerName);
 * ```
 */
export function acceptShare(options: AcceptShareOptions): Promise<AcceptedShare> {
  return callAsync(() => NativeModule!.acceptShare(options));
}

/**
 * Returns all zones currently accessible in the shared database.
 *
 * Each SharedZone includes the zone name, owner, share record name, and
 * the list of participants who have access.
 *
 * @returns Array of SharedZone objects.
 * @throws {CloudKitError} code NOT_AUTHENTICATED if the user is not signed in.
 * @throws {CloudKitError} code NETWORK_UNAVAILABLE if the device is offline.
 *
 * @example
 * ```typescript
 * const zones = await fetchSharedDatabaseZones();
 * zones.forEach(z => console.log(z.zoneName, z.ownerName));
 * ```
 */
export function fetchSharedDatabaseZones(): Promise<SharedZone[]> {
  return callAsync(() => NativeModule!.fetchSharedDatabaseZones());
}

/**
 * Registers a listener for `onShareAccepted` events.
 *
 * Fires when the system routes a CloudKit share URL to the app (e.g. via
 * universal links or the Sharing sheet). At this point the share has NOT yet
 * been accepted — only the URL is available. Pass `event.shareURL` to
 * `acceptShare()` to complete the acceptance flow and gain access to the
 * shared zone.
 *
 * @param callback - Called on the main thread when a share invitation URL arrives.
 * @returns A Subscription handle; call `.remove()` to stop receiving events.
 *
 * @example
 * ```typescript
 * const sub = addShareAcceptedListener((event) => {
 *   acceptShare({ shareURL: event.shareURL }).then((accepted) => {
 *     console.log('Share accepted:', accepted.zoneName, accepted.ownerName);
 *   });
 * });
 * // Later:
 * sub.remove();
 * ```
 */
export function addShareAcceptedListener(
  callback: (event: ShareInvitationEvent) => void
): Subscription {
  if (!isIOS) return noopSubscription;
  assertNativeAvailable();
  const subscription = emitter!.addListener('onShareAccepted', callback);
  return { remove: () => subscription.remove() };
}
