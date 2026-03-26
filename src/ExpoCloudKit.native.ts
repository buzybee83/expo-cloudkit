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

import { CloudKitError, CloudKitNotSupportedError, CloudKitUnavailableError } from './errors';
import type {
  AcceptedShare,
  AcceptShareOptions,
  AccountStatus,
  AssetProgress,
  AddParticipantsOptions,
  BatchProgress,
  CloudKitClient,
  CloudKitRecord,
  CloudKitSubscription,
  ContainerInfo,
  CreateShareOptions,
  DatabaseScope,
  DeleteShareOptions,
  FetchParticipantsOptions,
  ParticipantChangedEvent,
  PendingRecordChange,
  PresentSharingOptions,
  QueryPredicate,
  QueryResult,
  RawRecord,
  RecordIdentifier,
  RecordToSave,
  AddParticipantOptions,
  RemoveParticipantOptions,
  SavedRecord,
  SaveQuerySubscriptionOptions,
  Share,
  SharedZone,
  ShareAcceptedEvent,
  ShareParticipant,
  SetShareMetadataOptions,
  SharingUIResult,
  SortDescriptor,
  Subscription,
  SubscriptionEvent,
  SyncEngineConfig,
  SyncEngineEvent,
  SyncStateMap,
  SetDefaultParticipantPermissionOptions,
  UpdatePermissionOptions,
  WebConfigOptions,
  Zone,
  ZoneChanges,
  DeleteRecordWithReferencesOptions,
  FetchWithReferencesOptions,
  OfflineQueueDrainResult,
  OfflineQueueEntryStatus,
  OfflineQueueEvent,
  OfflineQueueStatus,
  OperationConfig,
  ResolvedRecord,
  SyncHealthEvent,
  BatchFetchResult,
  RateLimitedEvent,
  ShareMetadata,
  LeaveShareOptions,
  CreateShareFromTemplateOptions,
  GetShareActivityOptions,
  ShareActivityEntry,
  IndexEncryptedRecordOptions,
  DeindexRecordOptions,
  SearchEncryptedOptions,
  // Phase K.3 — Live Activities / Widgets
  ConfigureExtensionBridgeOptions,
  RegisterWidgetBindingOptions,
  RegisterLiveActivityBindingOptions,
  LiveActivityUpdateEvent,
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
 * Throws CloudKitUnavailableError if the native module failed to load on iOS
 * (e.g. running in Expo Go without a custom dev client).
 */
function assertNativeAvailable(): void {
  if (!isIOS) {
    throw new CloudKitNotSupportedError();
  }
  if (!NativeModule) {
    throw new CloudKitUnavailableError();
  }
}

/**
 * Returns `true` on iOS when the native module loaded successfully.
 * Returns `false` on Android, web, and all other non-iOS platforms.
 */
export function isCloudKitAvailable(): boolean {
  return isIOS && NativeModule !== null;
}

/**
 * Returns `true` when the native ExpoCloudKit module loaded successfully.
 * Returns `false` in Expo Go, on Android, on web, and whenever the native
 * module is unavailable. Use this to gate CloudKit UI without try/catch.
 */
export function isNativeModuleAvailable(): boolean {
  return NativeModule !== null;
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
 * Returns the current user's CloudKit record name (CKRecord.ID.recordName).
 *
 * This is a stable, opaque identifier for the signed-in iCloud account.
 * Use it to associate CloudKit data with the current user without storing
 * any personally identifiable information.
 *
 * @returns A string record name, e.g. "_abc123def456..."
 * @throws {CloudKitError} code NOT_AUTHENTICATED if no iCloud account is signed in.
 */
export function fetchUserRecordID(): Promise<string> {
  return callAsync(() => NativeModule!.fetchUserRecordID());
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

/**
 * Returns all custom zones in the private database.
 *
 * Symmetric counterpart to `fetchSharedDatabaseZones()`. Use this on reinstall
 * or new-device install to rediscover existing private zones (e.g. per-account
 * zones created by a previous install) before starting the sync engine.
 *
 * Equivalent to `fetchZones('private')`.
 */
export function fetchPrivateDatabaseZones(): Promise<Zone[]> {
  return fetchZones('private');
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
  database: DatabaseScope = 'private',
  operationConfig?: OperationConfig
): Promise<SavedRecord[]> {
  return callAsync(() => NativeModule!.saveRecords(records, database, operationConfig ?? null));
}

/**
 * Fetches a single record by its type and ID.
 *
 * @param recordType  - The CKRecord.recordType string.
 * @param recordId    - The CKRecord.ID.recordName string.
 * @param zoneName    - Zone the record lives in. Omit for the default zone.
 * @param database    - Which database to query. Default: 'private'.
 * @param desiredKeys - Field names to fetch. Omit to fetch all fields.
 */
export function fetchRecord(
  recordType: string,
  recordId: string,
  zoneName?: string,
  database: DatabaseScope = 'private',
  desiredKeys?: string[],
  operationConfig?: OperationConfig
): Promise<CloudKitRecord> {
  return callAsync(() => NativeModule!.fetchRecord(recordType, recordId, zoneName ?? null, database, desiredKeys ?? null, operationConfig ?? null));
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
 * @param desiredKeys     - Field names to fetch. Omit to fetch all fields.
 * @param operationConfig - Optional QoS and timeout configuration.
 * @param persistCursor   - When `true`, the native layer persists the returned
 *                          cursor to device storage keyed by `recordType` and
 *                          `zoneName`. On subsequent calls with the same key,
 *                          if `cursor` is omitted the persisted cursor is used
 *                          automatically. Call `clearPersistedCursors()` to
 *                          reset all persisted cursors. Default: `false`.
 */
export function queryRecords(
  recordType: string,
  predicate?: QueryPredicate,
  sortDescriptors?: SortDescriptor[],
  zoneName?: string,
  database: DatabaseScope = 'private',
  resultsLimit?: number,
  cursor?: string,
  desiredKeys?: string[],
  operationConfig?: OperationConfig,
  persistCursor?: boolean
): Promise<QueryResult> {
  return callAsync(() =>
    NativeModule!.queryRecords(
      recordType,
      predicate ?? null,
      sortDescriptors ?? null,
      zoneName ?? null,
      database,
      resultsLimit ?? 100,
      cursor ?? null,
      desiredKeys ?? null,
      operationConfig ?? null,
      persistCursor ?? false
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
  database: DatabaseScope = 'private',
  operationConfig?: OperationConfig
): Promise<void> {
  return callAsync(() => NativeModule!.deleteRecords(recordIds, database, operationConfig ?? null));
}

/**
 * Fetches all record changes in the specified zones since the last sync token.
 * Use the returned `syncToken` on the next call to receive only new changes.
 *
 * If `moreComing` is true in the result, call again with the returned `syncToken`
 * until `moreComing` is false.
 *
 * @param zoneNames   - Zones to fetch changes for.
 * @param database    - Which database to query. Default: 'private'.
 * @param desiredKeys - Field names to include on changed records. Omit to fetch all fields.
 */
export function fetchRecordZoneChanges(
  zoneNames: string[],
  database: DatabaseScope = 'private',
  desiredKeys?: string[],
  operationConfig?: OperationConfig
): Promise<ZoneChanges> {
  return callAsync(() => NativeModule!.fetchRecordZoneChanges(zoneNames, database, desiredKeys ?? null, operationConfig ?? null));
}

/**
 * Fetches ALL records currently in a zone without requiring a record type.
 *
 * Uses `CKFetchRecordZoneChangesOperation` with no prior change token — a one-shot
 * full zone dump. Does NOT persist the resulting change token, making it safe
 * to call independently of the sync engine.
 *
 * Ideal for:
 * - Reinstall / new-device: reconstruct local DB from cloud state
 * - First shared-zone sync after accepting an invitation
 * - Full zone import before starting the sync engine
 *
 * Unlike `queryRecords`, this does not require a `recordType` and therefore
 * works on mixed-type zones. Unlike `fetchRecordZoneChanges`, it does not track
 * deletions or persist change tokens — it simply returns all live records.
 *
 * @param zoneName  - Zone to fetch all records from.
 * @param predicate - Optional client-side field equality filter `{ field, value }`.





 * @param database  - Which database scope. Default: `'private'`.
 * @returns `{ records: CloudKitRecord[], count: number }` with all current records in the zone.
 *
 * @throws {CloudKitError} code `NOT_AUTHENTICATED` if the user is not signed in.
 * @throws {CloudKitError} code `ZONE_NOT_FOUND` if the zone does not exist.
 * @throws {CloudKitError} code `NETWORK_UNAVAILABLE` if the device is offline.
 *
 * @example
 * ```typescript
 * const { records } = await fetchZoneRecords('MyZone');
 * applyToLocalDB(records);
 * ```
 */
export function fetchZoneRecords(
  zoneName: string,
  predicate?: QueryPredicate,
  database: DatabaseScope = 'private'
): Promise<{ records: CloudKitRecord[]; count: number }> {
  const options: Record<string, unknown> = { zoneName, database };
  if (predicate) {
    options['predicate'] = predicate;
  }
  return callAsync(() => NativeModule!.fetchZoneRecords(options));
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
  // Normalize `database`/`databases` into a single `databases` array before
  // passing to native. `databases` takes precedence over the deprecated
  // `database` field when both are present.
  const databases: DatabaseScope[] = config.databases
    ? Array.isArray(config.databases)
      ? config.databases
      : [config.databases]
    : config.database
      ? [config.database]
      : ['private'];
  const normalized: SyncEngineConfig & { databases: DatabaseScope[] } = {
    ...config,
    databases,
  };
  return callAsync(() => NativeModule!.startSyncEngine(normalized));
}

/**
 * Returns the current state of all running sync engines, keyed by database scope.
 *
 * This is a synchronous call that reads in-memory state — it never touches
 * the network. Subscribe to `addSyncEngineListener` for real-time updates
 * via `stateChanged` events.
 *
 * Returns an empty object `{}` when `startSyncEngine()` has not been called.
 * When a single scope is running, one key is present. When two scopes are
 * running, both keys are present with independent states.
 *
 * @example
 * ```typescript
 * const states = getSyncState();
 * const privateStatus = states.private?.status;
 * if (privateStatus === 'syncing') {
 *   // Show a loading indicator
 * }
 * ```
 */
export function getSyncState(): SyncStateMap {
  if (!NativeModule) {
    return {};
  }
  try {
    return NativeModule.getSyncState() as SyncStateMap;
  } catch {
    return {};
  }
}

/**
 * Manually triggers a sync cycle.
 *
 * On iOS 17+, asks CKSyncEngine to fetch and send changes immediately.
 * On iOS 16, runs one fetch + push cycle synchronously outside the timer.
 *
 * @param database - Optional scope to target. When omitted, triggers sync on
 *   all running engines (fan-out). Pass `'private'` or `'shared'` to trigger
 *   only that scope's engine.
 * @throws {CloudKitError} code SYNC_ENGINE_NOT_RUNNING if the engine is not started.
 */
export function triggerSync(database?: DatabaseScope): Promise<void> {
  return callAsync(() =>
    NativeModule!.triggerSync(database ? { database } : {})
  );
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
 * After this call, `getSyncState()` returns `{}` (empty) if all engines
 * are stopped, or omits the stopped scope's key if a specific scope was stopped.
 * Call `startSyncEngine()` again to resume syncing.
 *
 * @param database - Optional scope to stop. When omitted, stops all running
 *   engines. Pass `'private'` or `'shared'` to stop only that scope's engine.
 * @throws {CloudKitError} code SYNC_ENGINE_NOT_RUNNING if the engine (or the
 *   specified scope's engine) is not started.
 */
export function stopSyncEngine(database?: DatabaseScope): Promise<void> {
  return callAsync(() =>
    NativeModule!.stopSyncEngine(database ? { database } : {})
  );
}

/**
 * Resolves a pending sync conflict previously emitted via an `onSyncEngineEvent`
 * event with `type === 'conflict'`.
 *
 * Must only be called when `SyncEngineConfig.resolveConflicts` is `true`.
 * Each `requestId` must be resolved exactly once; resolving an unknown or
 * already-resolved `requestId` is a no-op on the native side.
 *
 * @param requestId - The `requestId` from the `conflict` sync engine event.
 * @param resolvedRecord - The merged record to save, or `null` to accept
 *   the server version and discard the client version.
 *
 * @example
 * ```typescript
 * addSyncEngineListener((event) => {
 *   if (event.type === 'conflict') {
 *     const merged = mergeRecords(event.clientRecord, event.serverRecord);
 *     resolveSyncConflict(event.requestId, merged ?? null);
 *   }
 * });
 * ```
 */
export function resolveSyncConflict(
  requestId: string,
  resolvedRecord: RecordToSave | null
): void {
  assertNativeAvailable();
  try {
    NativeModule!.resolveSyncConflict(requestId, resolvedRecord);
  } catch (err) {
    throw CloudKitError.fromNativeError(err);
  }
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
 * Creates a zone-level CKShare without requiring a pre-existing anchor record.
 * Internally creates a `_zoneShare` anchor record and presents UICloudSharingController.
 *
 * This is a convenience wrapper over `createShare()` for the common case of sharing
 * an entire zone with other iCloud users.
 *
 * If a share already exists for the zone's anchor record, returns the existing share
 * immediately without presenting any UI.
 *
 * @param zoneName  - The zone to share.
 * @param database  - Which database. Default: 'private'.
 * @returns The share details, or null if the user cancelled the sharing UI.
 * @throws {CloudKitError} code NOT_AUTHENTICATED if the user is not signed in.
 * @throws {CloudKitError} code NETWORK_UNAVAILABLE if the device is offline.
 *
 * @example
 * ```typescript
 * const share = await createZoneShare('MyZone');
 * if (share) {
 *   console.log(share.shareURL); // https://www.icloud.com/share/...
 * }
 * ```
 */
export function createZoneShare(
  zoneName: string,
  database: DatabaseScope = 'private'
): Promise<Share | null> {
  return callAsync(() => NativeModule!.createZoneShare({ zoneName, database }));
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
 * Sets the default permission for all participants who join via the share URL
 * (`CKShare.publicPermission`). This applies to every future participant who
 * accepts the invitation link; existing participants retain their individually-set
 * permissions.
 *
 * Use this instead of `updateSharePermission` when you want to enforce a role at
 * the share level rather than per-participant. Eliminates the extra round-trip of
 * calling `updateSharePermission` for each participant as they accept.
 *
 * @param shareRecordName - recordName of the CKShare record to update.
 * @param permission      - New default permission: 'none' | 'readOnly' | 'readWrite'.
 * @param zoneName        - Zone the share lives in. Omit for the default zone.
 * @param database        - Which database scope. Default: 'private'.
 * @returns Updated Share with the new publicPermission reflected.
 * @throws {CloudKitError} code SHARE_NOT_FOUND if the share record does not exist.
 * @throws {CloudKitError} code PERMISSION_DENIED if the caller is not the share owner.
 *
 * @example
 * ```typescript
 * const share = await setDefaultParticipantPermission({
 *   shareRecordName: 'share-uuid',
 *   permission: 'readOnly',
 *   zoneName: 'MyZone',
 * });
 * console.log(share.publicPermission); // 'readOnly'
 * ```
 */
export function setDefaultParticipantPermission(
  options: SetDefaultParticipantPermissionOptions
): Promise<Share> {
  return callAsync(() => NativeModule!.setDefaultParticipantPermission(options));
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
 * Programmatically invites a participant to a share by email address.
 *
 * Internally looks up the iCloud user associated with the email via
 * `CKContainer.fetchShareParticipant(withEmailAddress:)`, sets their permission,
 * and saves the updated share — all without presenting UICloudSharingController.
 *
 * Use this for custom invitation flows where you want full control over the UX.
 * The participant lookup is not exposed as a separate API to prevent email enumeration.
 *
 * @param options.shareRecordName - recordName of the CKShare to add the participant to.
 * @param options.email           - Email address of the person to invite.
 * @param options.permission      - Permission to grant: 'readOnly' | 'readWrite'. Default: 'readOnly'.
 * @param options.zoneName        - Zone the share lives in.
 * @param options.database        - Which database scope. Default: 'private'.
 * @returns Updated participant list after adding the new participant.
 * @throws {CloudKitError} code PARTICIPANT_LOOKUP_FAILED if the email could not be resolved.
 * @throws {CloudKitError} code PARTICIPANT_NEEDS_VERIFICATION if the account needs email verification.
 * @throws {CloudKitError} code SHARE_NOT_FOUND if the share record does not exist.
 * @throws {CloudKitError} code PERMISSION_DENIED if the caller is not the share owner.
 *
 * @example
 * ```typescript
 * const participants = await addParticipant({
 *   shareRecordName: 'share-uuid',
 *   email: 'invitee@example.com',
 *   permission: 'readWrite',
 *   zoneName: 'MyZone',
 * });
 * participants.forEach(p => console.log(p.participantRecordName, p.acceptanceStatus));
 * ```
 */
export function addParticipant(options: AddParticipantOptions): Promise<ShareParticipant[]> {
  return callAsync(() => NativeModule!.addParticipant(options));
}

/**
 * Adds multiple participants to an existing CKShare in a single efficient operation.
 *
 * Fetches the share once, resolves all participant lookups (email or phone) concurrently
 * via DispatchGroup, then saves the share once. This is significantly more efficient
 * than calling `addParticipant` N times, which would require N fetches + N saves.
 *
 * Participants whose lookup fails are silently skipped — the operation succeeds for the
 * remaining valid entries. Compare the returned participant list to the input array to
 * detect any lookup failures.
 *
 * @param options - Share record name, participants array, optional zone and database.
 * @returns The full participant list on the share after all resolved participants are added.
 * @throws {CloudKitError} code SHARE_NOT_FOUND if the share record does not exist.
 * @throws {CloudKitError} code NOT_CONFIGURED if `configure()` has not been called.
 *
 * @example
 * ```typescript
 * const participants = await addParticipants({
 *   shareRecordName: 'share-uuid',
 *   zoneName: 'MyZone',
 *   participants: [
 *     { email: 'alice@example.com', permission: 'readWrite' },
 *     { phoneNumber: '+14155551234', permission: 'readOnly' },
 *   ],
 * });
 * console.log(`Share now has ${participants.length} participants`);
 * ```
 */
export function addParticipants(options: AddParticipantsOptions): Promise<ShareParticipant[]> {
  return callAsync(() => NativeModule!.addParticipants(options));
}

/**
 * Registers a callback that fires whenever a participant joins or leaves a CKShare
 * owned by the current user that is being tracked by the sync engine.
 *
 * Detection works by diffing the participant set from each CKShare record received
 * in `recordsFetched` sync events. One event is emitted per addition or removal.
 *
 * Requires the sync engine to be running (`startSyncEngine()`) and tracking the
 * zone containing the share.
 *
 * @param callback - Receives a `ParticipantChangedEvent` for each change detected.
 * @returns A Subscription; call `.remove()` to unsubscribe.
 *
 * @example
 * ```typescript
 * const sub = addParticipantChangeListener((event) => {
 *   if (event.changeType === 'added') {
 *     console.log(`${event.participant.displayName} joined the share`);
 *   } else if (event.changeType === 'removed') {
 *     console.log(`Participant ${event.participant.participantRecordName} left`);
 *   }
 * });
 * // Later:
 * sub.remove();
 * ```
 */
export function addParticipantChangeListener(
  callback: (event: ParticipantChangedEvent) => void
): Subscription {
  if (!isIOS) return noopSubscription;
  assertNativeAvailable();
  const subscription = emitter!.addListener('onParticipantChanged', callback);
  return { remove: () => subscription.remove() };
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
 * Fetches metadata for a share URL without accepting it.
 *
 * Lets you preview a share before the user commits to joining — owner name,
 * share title, the permission level they would receive, and the current
 * participant count.  Calls `CKFetchShareMetadataOperation` with
 * `shouldFetchRootRecord: false` so no record payload is downloaded.
 *
 * @param shareURL - The full iCloud share URL (e.g. from a deep link or QR code).
 * @returns A `ShareMetadata` object describing the share.
 * @throws {CloudKitError} code SHARE_NOT_FOUND if the URL is invalid or expired.
 * @throws {CloudKitError} code NOT_AUTHENTICATED if the user is not signed in.
 * @throws {CloudKitError} code NETWORK_UNAVAILABLE if the device is offline.
 *
 * @example
 * ```typescript
 * const meta = await fetchShareMetadata('https://www.icloud.com/share/...');
 * console.log(`${meta.ownerFirstName} ${meta.ownerLastName} invited you`);
 * console.log(`Permission: ${meta.participantPermission}`);
 * ```
 */
export function fetchShareMetadata(shareURL: string): Promise<ShareMetadata> {
  return callAsync(() => NativeModule!.fetchShareMetadata(shareURL));
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
 * Returns the URL of an existing CKShare for the given record without
 * re-presenting UICloudSharingController. Useful for "Copy invite link" flows.
 *
 * @param recordName - The CKRecord.ID.recordName of the shared record.
 * @param zoneName   - The zone the record lives in.
 * @param database   - Which database. Default: 'private'.
 * @returns The share URL string, e.g. "https://www.icloud.com/iclouddrive/..."
 * @throws {CloudKitError} RECORD_NOT_FOUND if the record doesn't exist.
 * @throws {CloudKitError} SHARE_NOT_FOUND if no share is attached to the record.
 *
 * @example
 * ```typescript
 * const url = await getShareURL('my-record-name', 'MyZone');
 * Clipboard.setStringAsync(url);
 * ```
 */
export function getShareURL(
  recordName: string,
  zoneName: string,
  database: DatabaseScope = 'private'
): Promise<string> {
  return callAsync(() => NativeModule!.getShareURL({ recordName, zoneName, database }));
}

/**
 * Registers a listener for `onShareAccepted` events.
 *
 * Fires *after* the native module has called `CKAcceptSharesOperation` in
 * response to `application(_:userDidAcceptCloudKitShareWith:)` being posted
 * as a `CKShareAccepted` notification from the app delegate.
 *
 * The shared zone is accessible in the shared CloudKit database by the time
 * this callback fires. The event payload includes the owner's name, the zone
 * name, and the share URL.
 *
 * @param callback - Called on the main thread after the share is accepted.
 * @returns A Subscription handle; call `.remove()` to stop receiving events.
 *
 * @example
 * ```typescript
 * const sub = addShareAcceptedListener((event) => {
 *   console.log('Share accepted from', event.ownerFirstName, 'in zone', event.zoneName);
 *   // Refresh your UI — the shared zone is now accessible
 * });
 * // Later:
 * sub.remove();
 * ```
 */
export function addShareAcceptedListener(
  callback: (event: ShareAcceptedEvent) => void
): Subscription {
  if (!isIOS) return noopSubscription;
  assertNativeAvailable();
  const subscription = emitter!.addListener('onShareAccepted', callback);
  return { remove: () => subscription.remove() };
}

/**
 * Sets `CKShare.SystemFieldKey.title` and optionally `thumbnailImageData` on an
 * existing CKShare record to enable richer share previews in Messages and Mail.
 *
 * Fetches the share by `shareRecordName`, applies the metadata updates, then
 * saves it back via `CKModifyRecordsOperation` with `savePolicy: .changedKeys`
 * so only changed fields are transmitted to CloudKit.
 *
 * @param options - Share record identifier plus optional `title` and `thumbnailData`.
 * @returns The updated Share object (same shape as `createShare` resolves with).
 * @throws {CloudKitError} code NOT_CONFIGURED if `configure()` has not been called.
 * @throws {CloudKitError} code SHARE_NOT_FOUND if no CKShare exists at the given record name.
 * @throws {CloudKitError} code NOT_AUTHENTICATED if the user is not signed in to iCloud.
 *
 * @example
 * ```typescript
 * const share = await setShareMetadata({
 *   shareRecordName: 'abc123-share',
 *   zoneName: 'MyZone',
 *   title: 'Project Alpha',
 *   thumbnailData: base64PNG,
 * });
 * console.log('Updated share URL:', share.url);
 * ```
 */
export function setShareMetadata(options: SetShareMetadataOptions): Promise<Share> {
  return callAsync(() => NativeModule!.setShareMetadata(options));
}

// ---------------------------------------------------------------------------
// Phase C — CKRecord.Reference deep linking
// ---------------------------------------------------------------------------

/**
 * Fetches a single record by its ID and recursively resolves all
 * CKRecord.Reference fields up to the specified depth.
 *
 * Resolved references are returned in `resolvedReferences`, keyed by field
 * name. Unresolvable references remain as `ReferenceValue` entries in `fields`
 * and are absent from `resolvedReferences`.
 *
 * Internally issues a `CKFetchRecordsOperation` for each depth level,
 * collecting all referenced record IDs from the previous level's reference
 * fields and batch-fetching them. A depth of 1 requires at most 2 round trips
 * (root + referenced records); depth 2 requires at most 3 round trips.
 *
 * @param recordName - The `CKRecord.ID.recordName` of the root record to fetch.
 * @param options    - Record type, zone, database scope, and resolution depth.
 * @returns The root record with `resolvedReferences` populated up to `options.depth`.
 * @throws {CloudKitNotSupportedError} On non-iOS platforms.
 * @throws {CloudKitError} code NOT_AUTHENTICATED if the user is not signed in.
 * @throws {CloudKitError} code NETWORK_UNAVAILABLE if the device is offline.
 * @throws {CloudKitError} code RECORD_NOT_FOUND if the root record does not exist.
 *
 * @example
 * ```typescript
 * const note = await fetchRecordWithReferences('abc123', {
 *   recordType: 'Note',
 *   zoneName: 'MyZone',
 *   depth: 2,
 * });
 * const author = note.resolvedReferences['author'];
 * const authorOrg = author?.resolvedReferences['organization'];
 * ```
 */
export function fetchRecordWithReferences(
  recordName: string,
  options: FetchWithReferencesOptions
): Promise<ResolvedRecord> {
  return callAsync(() =>
    NativeModule!.fetchRecordWithReferences(recordName, options)
  );
}

/**
 * Fetches a record, walks its CKRecord.Reference fields up to `maxDepth` levels,
 * and deletes all records in the graph in a single batched operation.
 *
 * **Warning:** This is a client-side graph walk. Each depth level requires
 * additional network round-trips. Large graphs may hit CloudKit rate limits.
 * Use `maxDepth: 1` for most cases.
 *
 * @param recordName - The `CKRecord.ID.recordName` of the root record to delete.
 * @param recordType - The `CKRecord.recordType` of the root record.
 * @param zoneName   - The zone the root record lives in. Pass `undefined` for the default zone.
 * @param options    - Controls graph traversal depth and database scope.
 * @returns Array of deleted record names, including the root and all traversed references.
 * @throws {CloudKitNotSupportedError} On non-iOS platforms.
 * @throws {CloudKitError} code NOT_AUTHENTICATED if the user is not signed in.
 * @throws {CloudKitError} code NETWORK_UNAVAILABLE if the device is offline.
 * @throws {CloudKitError} code RECORD_NOT_FOUND if the root record does not exist.
 *
 * @example
 * ```typescript
 * const deleted = await deleteRecordWithReferences('abc123', 'Note', 'MyZone', {
 *   maxDepth: 2,
 *   database: 'private',
 * });
 * console.log('Deleted records:', deleted);
 * ```
 */
export function deleteRecordWithReferences(
  recordName: string,
  recordType: string,
  zoneName: string | undefined,
  options?: DeleteRecordWithReferencesOptions
): Promise<string[]> {
  const { maxDepth = 1, database = 'private' } = options ?? {};
  return callAsync(() =>
    NativeModule!.deleteRecordWithReferences(recordName, recordType, zoneName ?? null, database, maxDepth)
  );
}

// ---------------------------------------------------------------------------
// Phase C — Debug / Dashboard helpers
// ---------------------------------------------------------------------------

/**
 * Returns the container identifier and current account status.
 *
 * Intended for use in developer tooling and CloudKit Dashboard screens.
 * Do not call in production user-facing code.
 *
 * @internal
 * @returns A snapshot of the container's identity and iCloud account state.
 * @throws {CloudKitError} code NOT_AUTHENTICATED if the user is not signed in.
 * @throws {CloudKitNotSupportedError} on non-iOS platforms.
 *
 * @example
 * ```typescript
 * const info = await __debugDumpContainerInfo();
 * console.log(info.containerID, info.accountStatus);
 * ```
 */
export function __debugDumpContainerInfo(): Promise<ContainerInfo> {
  return callAsync(() => NativeModule!.__debugDumpContainerInfo());
}

/**
 * Lists all custom zones in the specified database, bypassing the in-memory
 * zone cache used by fetchZones().
 *
 * Useful for inspecting zone state directly from the server in dashboard tools.
 *
 * @internal
 * @param database - Which database to inspect. Default: 'private'.
 * @returns Array of Zone objects currently on the server.
 * @throws {CloudKitError} code NOT_AUTHENTICATED if the user is not signed in.
 * @throws {CloudKitNotSupportedError} on non-iOS platforms.
 */
export function __debugListZones(database: DatabaseScope = 'private'): Promise<Zone[]> {
  return callAsync(() => NativeModule!.__debugListZones(database));
}

/**
 * Fetches a single record with all server-assigned metadata fields included.
 *
 * @internal
 * @param options.recordName - CKRecord.ID.recordName of the record to fetch.
 * @param options.recordType - CKRecord.recordType string.
 * @param options.zoneName   - Zone the record lives in. Omit for the default zone.
 * @param options.database   - Which database to query. Default: 'private'.
 * @returns The full record with all metadata populated.
 * @throws {CloudKitError} code RECORD_NOT_FOUND if no matching record exists.
 * @throws {CloudKitError} code NOT_AUTHENTICATED if the user is not signed in.
 * @throws {CloudKitNotSupportedError} on non-iOS platforms.
 */
export function __debugFetchRawRecord(options: {
  recordName: string;
  recordType: string;
  zoneName?: string;
  database?: DatabaseScope;
}): Promise<RawRecord> {
  return callAsync(() => NativeModule!.__debugFetchRawRecord(options));
}

/**
 * Deletes all records within the specified zone without deleting the zone itself.
 *
 * WARNING: This is a destructive, permanent operation. All records in the zone
 * are deleted from the server immediately. There is no undo.
 *
 * @internal
 * @param options.zoneName  - The zone to clear.
 * @param options.database  - Which database the zone lives in. Default: 'private'.
 * @returns Resolves when all records have been deleted.
 * @throws {CloudKitError} code ZONE_NOT_FOUND if the zone does not exist.
 * @throws {CloudKitError} code NOT_AUTHENTICATED if the user is not signed in.
 * @throws {CloudKitNotSupportedError} on non-iOS platforms.
 */
export function __debugClearZone(options: {
  zoneName: string;
  database?: DatabaseScope;
}): Promise<void> {
  return callAsync(() => NativeModule!.__debugClearZone(options));
}

// ---------------------------------------------------------------------------
// Phase C — Offline Queue
// ---------------------------------------------------------------------------

/**
 * Persists a CloudKit operation to the offline queue for deferred execution.
 *
 * The operation is durably stored and will be retried automatically when
 * connectivity is restored or `drainOfflineQueue()` is called. Use this
 * instead of `saveRecords` / `deleteRecords` when the device may be offline.
 *
 * @param options.type             - The kind of operation: 'save' or 'delete'.
 * @param options.record           - The record to save. Required when `type` is 'save'.
 * @param options.recordIdentifier - The record to delete. Required when `type` is 'delete'.
 * @param options.database         - Target database. Default: 'private'.
 * @returns An object containing the assigned `queueId`.
 * @throws {CloudKitError} code QUEUE_FULL if the queue is at capacity.
 * @throws {CloudKitNotSupportedError} on non-iOS platforms.
 *
 * @example
 * ```typescript
 * const { queueId } = await enqueueOfflineOperation({
 *   type: 'save',
 *   record: { recordType: 'Note', fields: { title: { type: 'string', value: 'Hello' } } },
 * });
 * console.log('Queued as:', queueId);
 * ```
 */
export function enqueueOfflineOperation(options: {
  type: 'save' | 'delete';
  record?: RecordToSave;
  recordIdentifier?: RecordIdentifier;
  database?: DatabaseScope;
}): Promise<{ queueId: string }> {
  return callAsync(() => NativeModule!.enqueueOfflineOperation(options));
}

/**
 * Attempts to flush all pending and retrying entries in the offline queue.
 *
 * Processes entries sequentially; failures are left in the queue for the
 * next drain cycle. Returns a summary of how many operations succeeded,
 * failed, or were skipped.
 *
 * @returns A drain result with `succeeded`, `failed`, and `skipped` counts.
 * @throws {CloudKitNotSupportedError} on non-iOS platforms.
 *
 * @example
 * ```typescript
 * const result = await drainOfflineQueue();
 * console.log(`${result.succeeded} saved, ${result.failed} failed`);
 * ```
 */
export function drainOfflineQueue(): Promise<OfflineQueueDrainResult> {
  return callAsync(() => NativeModule!.drainOfflineQueue());
}

/**
 * Drains pending offline queue entries for a specific zone only.
 *
 * Unlike `drainOfflineQueue()` which processes all pending entries,
 * this variant filters to entries whose record's `zoneName` matches
 * the given zone. Entries for other zones are left in the queue.
 *
 * Useful when a zone's subscription comes back online and you want
 * to flush only that zone's backlog without unnecessary network
 * activity on other zones.
 *
 * Implementation note: the native offline queue has no zone-scoped drain
 * API, so this function is implemented entirely in TypeScript. It reads all
 * queue entries via `getOfflineQueueStatus({ includeEntries: true })`,
 * filters to entries belonging to the requested zone, and invokes
 * `saveRecords` / `deleteRecords` directly for each matching entry.
 * Processed entries remain in the queue and will be skipped on the next
 * full `drainOfflineQueue()` call once CloudKit has accepted them (CloudKit
 * saves and deletes are idempotent).
 *
 * @param zoneName - Only process entries whose records belong to this zone.
 * @param database - Which database scope. Default: 'private'.
 * @returns Summary of processed entries for the specified zone.
 * @throws {CloudKitNotSupportedError} on non-iOS platforms.
 *
 * @example
 * ```typescript
 * // When 'MyZone' comes back online, flush only its backlog:
 * const result = await drainOfflineQueueForZone('MyZone');
 * console.log(`${result.succeeded} saved, ${result.failed} failed`);
 * ```
 */
export async function drainOfflineQueueForZone(
  zoneName: string,
  database: DatabaseScope = 'private'
): Promise<OfflineQueueDrainResult> {
  const status = await getOfflineQueueStatus({ includeEntries: true });
  const entries = status.entries ?? [];

  const nonFailed = entries.filter((entry) => entry.status !== 'failed');
  const matching = nonFailed.filter((entry) => {
    if (entry.database !== database) return false;
    const recordZone = (entry.recordData as RecordToSave | RecordIdentifier).zoneName;
    return recordZone === zoneName;
  });

  let succeeded = 0;
  let failed = 0;
  // Entries that are non-failed but belong to a different zone or database are skipped.
  const skipped = nonFailed.length - matching.length;

  for (const entry of matching) {
    try {
      if (entry.operation === 'save') {
        await saveRecords([entry.recordData as RecordToSave], database);
      } else {
        await deleteRecords([entry.recordData as RecordIdentifier], database);
      }
      succeeded++;
    } catch {
      failed++;
    }
  }

  return { succeeded, failed, skipped };
}

/**
 * Returns the current aggregate status of the offline operation queue.
 *
 * Pass `{ includeEntries: true }` to also receive the full list of queue
 * entries in the `entries` field of the result. Omit for a lightweight
 * count-only snapshot.
 *
 * @param options.includeEntries - If `true`, populates `status.entries`. Default: `false`.
 * @returns The current queue counts and, optionally, the full entries list.
 * @throws {CloudKitNotSupportedError} on non-iOS platforms.
 *
 * @example
 * ```typescript
 * const { pending, failed } = await getOfflineQueueStatus();
 * if (failed > 0) {
 *   console.warn(`${failed} operations permanently failed`);
 * }
 * ```
 */
export function getOfflineQueueStatus(options?: {
  includeEntries?: boolean;
}): Promise<OfflineQueueStatus> {
  return callAsync(() => NativeModule!.getOfflineQueueStatus(options ?? {}));
}

/**
 * Removes entries from the offline queue by status.
 *
 * Pass `{ status: 'failed' }` to clear only permanently-failed entries.
 * Pass `{ status: 'all' }` (or omit `status`) to clear the entire queue,
 * including pending and retrying entries.
 *
 * WARNING: Clearing pending or retrying entries permanently discards those
 * operations — they will not be sent to CloudKit.
 *
 * @param options.status - Which entries to remove. Default: 'all'.
 * @throws {CloudKitNotSupportedError} on non-iOS platforms.
 *
 * @example
 * ```typescript
 * // Clear only permanently failed entries
 * await clearOfflineQueue({ status: 'failed' });
 * ```
 */
export function clearOfflineQueue(options?: {
  status?: OfflineQueueEntryStatus | 'all';
}): Promise<void> {
  return callAsync(() => NativeModule!.clearOfflineQueue(options ?? {}));
}

/**
 * Immediately reschedules all permanently-failed entries for retry.
 *
 * Resets each `'failed'` entry's `retryCount` to 0 and moves it back to
 * `'pending'` so the next `drainOfflineQueue()` call will attempt it again.
 *
 * @throws {CloudKitNotSupportedError} on non-iOS platforms.
 *
 * @example
 * ```typescript
 * await retryFailedOperations();
 * const { pending } = await getOfflineQueueStatus();
 * console.log(`${pending} operations rescheduled`);
 * ```
 */
export function retryFailedOperations(): Promise<void> {
  return callAsync(() => NativeModule!.retryFailedOperations());
}

/**
 * Registers a listener for all offline queue lifecycle events.
 *
 * All event types are dispatched on the single `onOfflineQueueEvent` channel.
 * Filter by `event.type` to handle specific cases.
 *
 * Event types:
 * - `'operationCompleted'`     — An operation drained successfully.
 * - `'operationFailed'`        — An attempt failed; `willRetry` indicates if another will follow.
 * - `'operationMovedToFailed'` — An entry exhausted all retries and became permanently failed.
 * - `'queueDrained'`           — A full drain cycle completed with totals.
 * - `'queueStatusChanged'`     — The aggregate counts changed.
 *
 * @param callback - Called on the main thread whenever a queue event fires.
 * @returns A Subscription; call `.remove()` to stop receiving events.
 *
 * @example
 * ```typescript
 * const sub = addOfflineQueueListener((event) => {
 *   switch (event.type) {
 *     case 'queueDrained':
 *       console.log(`Drain: ${event.succeeded} ok, ${event.failed} failed`);
 *       break;
 *     case 'operationMovedToFailed':
 *       console.warn('Permanent failure:', event.queueId, event.errorCode);
 *       break;
 *   }
 * });
 * // Later:
 * sub.remove();
 * ```
 */
export function addOfflineQueueListener(
  callback: (event: OfflineQueueEvent) => void
): Subscription {
  if (!isIOS) return noopSubscription;
  assertNativeAvailable();
  const subscription = emitter!.addListener('onOfflineQueueEvent', callback);
  return { remove: () => subscription.remove() };
}

// ---------------------------------------------------------------------------
// Web-only stubs (native/iOS side)
// These functions exist so callers can import them from 'expo-cloudkit'
// without platform guards. On iOS, configureWeb is a no-op; authenticateWeb
// immediately returns the current account status; signOutWeb is a no-op;
// isWebAuthenticated checks whether the account is available.
// On web, these resolve to their real CloudKit JS implementations via
// ExpoCloudKit.web.ts (the .web.ts Metro extension takes priority).
// ---------------------------------------------------------------------------

/**
 * No-op on iOS/native. On web, configures CloudKit JS with the API token.
 *
 * `CloudKitProvider` calls this automatically on web based on `Platform.OS`.
 * If you configure CloudKit manually, prefer calling `configure(containerId)`
 * on iOS and `configureWeb(containerId, options)` on web using a platform check.
 *
 * @param containerId - CloudKit container identifier.
 * @param _options    - Web-specific options. Ignored on native.
 */
export async function configureWeb(
  _containerId: string,
  _options: WebConfigOptions
): Promise<void> {
  // No-op on native: the native module is configured via configure()
}

/**
 * On iOS/native, resolves immediately with the current account status.
 * On web, triggers the Apple ID sign-in popup via CloudKit JS.
 *
 * @returns Promise resolving to the current `AccountStatus`.
 */
export async function authenticateWeb(): Promise<AccountStatus> {
  return getAccountStatus();
}

/**
 * No-op on iOS/native. On web, clears the CloudKit JS auth session.
 */
export async function signOutWeb(): Promise<void> {
  // No-op on native
}

/**
 * On iOS/native, returns `true` if the account status is 'available'.
 * On web, returns `true` if a valid CloudKit JS session exists.
 */
export function isWebAuthenticated(): boolean {
  // On native there is no CloudKit JS auth session; always false.
  // Auth is handled by the OS — use getAccountStatus() to check account availability.
  return false;
}

// ---------------------------------------------------------------------------
// H.3 — Multi-container support
// ---------------------------------------------------------------------------

/**
 * Creates an isolated CloudKit client bound to the specified container.
 *
 * Use this when your app needs to operate on multiple CloudKit containers
 * simultaneously without conflicting with the module-level singleton
 * configured by `configure()`. Each client holds its own native
 * `CKContainer` reference and routes all calls through it.
 *
 * Remember to call `client.destroy()` when done to release native resources.
 *
 * @param containerId - CloudKit container identifier, e.g. "iCloud.com.example.secondary".
 * @returns A `CloudKitClient` scoped to the specified container.
 * @throws {CloudKitNotSupportedError} On non-iOS platforms.
 * @throws {CloudKitError} If the container identifier is invalid.
 *
 * @example
 * ```typescript
 * const client = await createCloudKitClient('iCloud.com.example.secondary');
 * try {
 *   const results = await client.queryRecords('Note', undefined, undefined, 'MyZone');
 *   console.log(results.records);
 * } finally {
 *   await client.destroy();
 * }
 * ```
 */
export async function createCloudKitClient(containerId: string): Promise<CloudKitClient> {
  const clientId: string = await callAsync(() => NativeModule!.createClient(containerId));

  return {
    containerId,
    clientId,
    saveRecords: (records, database = 'private', operationConfig) =>
      callAsync(() =>
        NativeModule!.clientSaveRecords(clientId, records, database, operationConfig ?? null)
      ),
    queryRecords: (
      recordType,
      predicate,
      sortDescriptors,
      zoneName,
      database = 'private',
      resultsLimit = 200,
      cursor,
      desiredKeys,
      operationConfig
    ) =>
      callAsync(() =>
        NativeModule!.clientQueryRecords(clientId, {
          recordType,
          predicate: predicate ?? null,
          sortDescriptors: sortDescriptors ?? null,
          zoneName: zoneName ?? null,
          database,
          resultsLimit,
          cursor: cursor ?? null,
          desiredKeys: desiredKeys ?? null,
          operationConfig: operationConfig ?? null,
        })
      ),
    deleteRecords: (recordIds, database = 'private', operationConfig) =>
      callAsync(() =>
        NativeModule!.clientDeleteRecords(clientId, recordIds, database, operationConfig ?? null)
      ),
    destroy: () => callAsync(() => NativeModule!.destroyClient(clientId)),
  };
}

// ---------------------------------------------------------------------------
// H.5 — Cursor persistence
// ---------------------------------------------------------------------------

/**
 * Removes all persisted query cursors from device storage.
 *
 * Persisted cursors are written by `queryRecords()` when called with
 * `persistCursor: true`. Calling this function resets all of them so that
 * the next paginated query starts from the beginning.
 *
 * @throws {CloudKitNotSupportedError} On non-iOS platforms.
 *
 * @example
 * ```typescript
 * await clearPersistedCursors();
 * // Next queryRecords call with persistCursor: true starts fresh
 * ```
 */
export function clearPersistedCursors(): Promise<void> {
  return callAsync(() => NativeModule!.clearPersistedCursors());
}

// ---------------------------------------------------------------------------
// Phase I.3 — Observability
// ---------------------------------------------------------------------------

/**
 * Subscribes to sync-cycle health snapshots emitted by the sync engine.
 *
 * The native side emits `onSyncHealth` once at the end of every sync cycle —
 * both on iOS 17+ (CKSyncEngine) and on the iOS 16 fallback polling path.
 * The event is NOT emitted on web; this listener is a no-op on that platform.
 *
 * Prefer the `useSyncHealth()` React hook for component-level subscriptions;
 * use this function directly when you need to subscribe outside of a component.
 *
 * @param callback - Invoked on the JS thread after each completed sync cycle.
 * @returns A Subscription; call `.remove()` to stop receiving events.
 *
 * @example
 * ```typescript
 * const sub = addSyncHealthListener((event) => {
 *   console.log(`Sync done — sent: ${event.sentCount}, failed: ${event.failedCount}`);
 * });
 * // Later:
 * sub.remove();
 * ```
 */
export function addSyncHealthListener(
  callback: (event: SyncHealthEvent) => void
): Subscription {
  if (!isIOS) return { remove: () => {} };
  assertNativeAvailable();
  const subscription = emitter!.addListener('onSyncHealth', callback);
  return { remove: () => subscription.remove() };
}

// ---------------------------------------------------------------------------
// Phase I.1 — Batch Fetch & Rate Limiting
// ---------------------------------------------------------------------------

/**
 * Fetches multiple records in a single `CKFetchRecordsOperation`.
 *
 * Each element of the returned array corresponds to one requested record.
 * Failed records have the `error` field set instead of `record`; the call
 * itself does not reject unless the operation cannot be started at all.
 *
 * @param recordIDs       - Array of record identifiers to fetch.
 * @param database        - Target database. Default: `'private'`.
 * @param desiredKeys     - Field names to fetch. Omit to fetch all fields.
 * @param operationConfig - Optional timeout and quality-of-service overrides.
 * @returns Array of per-record results, one per requested record ID.
 */
export function batchFetchRecords(
  recordIDs: Array<{ recordName: string; zoneName?: string; zoneOwner?: string }>,
  database?: DatabaseScope,
  desiredKeys?: string[],
  operationConfig?: OperationConfig
): Promise<BatchFetchResult[]> {
  return callAsync(() =>
    NativeModule!.batchFetchRecords(
      recordIDs,
      database ?? 'private',
      desiredKeys ?? null,
      operationConfig ?? null
    )
  );
}

/**
 * Registers a callback that fires whenever CloudKit rate-limits an operation
 * and the native layer is about to retry automatically.
 *
 * Returns a Subscription handle; call `.remove()` to unsubscribe.
 *
 * @param callback - Invoked with the rate-limit details before each retry.
 * @returns A Subscription; call `.remove()` to stop receiving events.
 *
 * @example
 * ```typescript
 * const sub = addRateLimitedListener((event) => {
 *   console.warn(`Rate limited on ${event.operationName}, retrying in ${event.retryAfter}s`);
 * });
 * // Later:
 * sub.remove();
 * ```
 */
export function addRateLimitedListener(
  callback: (event: RateLimitedEvent) => void
): Subscription {
  if (!isIOS) return { remove: () => {} };
  assertNativeAvailable();
  const subscription = emitter!.addListener('onRateLimited', callback);
  return { remove: () => subscription.remove() };
}

// ---------------------------------------------------------------------------
// Background Sync — BGTaskScheduler (iOS 13+)
// ---------------------------------------------------------------------------

/**
 * Registers the BGAppRefreshTask handler and schedules the first background
 * refresh. Must be called early in the app lifecycle (e.g. root component
 * `useEffect`) so the registration is in place before the app first backgrounds.
 *
 * The `taskIdentifier` must match the value set in the `backgroundSyncTaskIdentifier`
 * config plugin option, which adds it to `BGTaskSchedulerPermittedIdentifiers`
 * in Info.plist. If they do not match the system silently ignores background launches.
 *
 * @param taskIdentifier - BGTask identifier, e.g. `"com.example.myapp.cloudkit-sync"`.
 * @returns Promise that resolves once the handler is registered.
 * @throws {CloudKitNotSupportedError} On Android/web (background tasks are iOS-only).
 *
 * @example
 * ```typescript
 * useEffect(() => {
 *   registerBackgroundSync('com.example.myapp.cloudkit-sync');
 * }, []);
 * ```
 */
export function registerBackgroundSync(taskIdentifier: string): Promise<void> {
  return callAsync(() => NativeModule!.registerBackgroundSync(taskIdentifier));
}

/**
 * Asks the system to schedule a background refresh as soon as conditions allow.
 *
 * The system already reschedules automatically after each completed background
 * task. Call this if you want to proactively request a refresh — for example,
 * after the user makes a change that you know the widget or Watch app needs.
 *
 * @returns Promise that resolves once the request has been submitted.
 * @throws {CloudKitNotSupportedError} On Android/web.
 *
 * @example
 * ```typescript
 * await saveRecords([note]);
 * await scheduleBackgroundSync(); // hint to the system to sync soon
 * ```
 */
export function scheduleBackgroundSync(): Promise<void> {
  return callAsync(() => NativeModule!.scheduleBackgroundSync());
}

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

/**
 * Fetches ALL record changes across the specified zones, automatically paginating
 * until `moreComing` is false.
 *
 * Internally calls `fetchRecordZoneChanges` repeatedly, accumulating changed and
 * deleted record names across all pages. The final `syncToken` is from the last page.
 *
 * The native module stores the sync token internally between calls, so each
 * subsequent invocation of `fetchRecordZoneChanges` automatically continues from
 * where the last call left off.
 *
 * @param zoneNames - Zones to fetch changes for.
 * @param database  - Which database to query. Default: `'private'`.
 * @returns Merged `ZoneChanges` with all records across all pages, `moreComing: false`.
 *
 * @throws {CloudKitError} code `NOT_AUTHENTICATED` if the user is not signed in.
 * @throws {CloudKitError} code `NETWORK_UNAVAILABLE` if the device is offline.
 *
 * @example
 * ```typescript
 * const changes = await fetchAllZoneChanges(['MyZone']);
 * applyChanges(changes.changedRecords);
 * markDeleted(changes.deletedRecordNames);
 * ```
 */
export async function fetchAllZoneChanges(
  zoneNames: string[],
  database: DatabaseScope = 'private'
): Promise<ZoneChanges> {
  const allChanged: CloudKitRecord[] = [];
  const allDeleted: string[] = [];
  let result = await fetchRecordZoneChanges(zoneNames, database);
  allChanged.push(...result.changedRecords);
  allDeleted.push(...result.deletedRecordNames);
  while (result.moreComing) {
    result = await fetchRecordZoneChanges(zoneNames, database);
    allChanged.push(...result.changedRecords);
    allDeleted.push(...result.deletedRecordNames);
  }
  return {
    changedRecords: allChanged,
    deletedRecordNames: allDeleted,
    syncToken: result.syncToken,
    moreComing: false,
  };
}

// ---------------------------------------------------------------------------
// Token Management — change token read/write for cross-reinstall persistence
// ---------------------------------------------------------------------------

/**
 * Returns the persisted CKServerChangeToken for the given zone as a base64 string,
 * or null if no token has been stored (zone has never been synced).
 *
 * Use this to persist the token in your own storage (e.g. AsyncStorage) across
 * reinstalls. On a fresh install, call `setZoneChangeToken()` to seed the token
 * before starting the sync engine — this avoids a full zone re-fetch.
 *
 * @param zoneName - The zone to get the token for.
 * @param database - Which database scope. Default: 'private'.
 * @returns Base64-encoded CKServerChangeToken, or null if not synced yet.
 */
export function getZoneChangeToken(
  zoneName: string,
  database: DatabaseScope = 'private'
): string | null {
  if (!NativeModule) return null;
  return NativeModule.getZoneChangeToken(zoneName, database) ?? null;
}

/**
 * Seeds a previously-persisted CKServerChangeToken for the given zone.
 * Pass null to clear the token and force a full re-sync for that zone.
 *
 * @param zoneName    - The zone to set the token for.
 * @param database    - Which database scope. Default: 'private'.
 * @param tokenBase64 - Base64 token from `getZoneChangeToken()`, or null to clear.
 */
export function setZoneChangeToken(
  zoneName: string,
  database: DatabaseScope = 'private',
  tokenBase64: string | null
): void {
  if (!NativeModule) return;
  NativeModule.setZoneChangeToken(zoneName, database, tokenBase64);
}

// ---------------------------------------------------------------------------
// Share Convenience — leaveShare, createShareFromTemplate, getShareActivity
// ---------------------------------------------------------------------------

/**
 * Lets the current user leave a CKShare they previously accepted.
 *
 * Fetches the share, removes the current user's participant entry, and saves
 * the modified share back. The owner cannot leave their own share — call
 * `deleteShare` instead when you are the owner.
 *
 * @param options - `shareRecordName`, optional `zoneName`, optional `database`
 *   (defaults to `'shared'` since accepted shares live in the shared database).
 *
 * @throws {CloudKitError} code `PARTICIPANT_NOT_FOUND` if the current user is
 *   not a participant on this share (e.g. already removed, or fetched from the
 *   wrong database).
 * @throws {CloudKitError} code `PERMISSION_DENIED` if the current user is the owner.
 */
export function leaveShare(options: LeaveShareOptions): Promise<void> {
  return callAsync(() => NativeModule!.leaveShare(options));
}

/**
 * Creates a CKShare with pre-configured metadata in a single server round trip.
 *
 * Equivalent to calling `createShare` (or `createZoneShare`) followed by
 * `setShareMetadata`, `setDefaultParticipantPermission`, and one `addParticipant`
 * per email — but batched into a single `CKModifyRecordsOperation`.
 *
 * When `recordName` is omitted, a zone-level share is created using a sentinel
 * anchor record (`_zoneShare` record type), mirroring `createZoneShare` behaviour.
 *
 * @param options - Zone, optional record name, metadata, and initial participants.
 * @returns The created `Share` record including the share URL.
 *
 * @throws {CloudKitError} code `PARTICIPANT_LOOKUP_FAILED` if any email cannot
 *   be resolved to an iCloud account. The share is NOT created in this case.
 * @throws {CloudKitError} code `RECORD_NOT_FOUND` if `recordName` is provided
 *   but the record does not exist.
 */
export function createShareFromTemplate(
  options: CreateShareFromTemplateOptions
): Promise<Share> {
  return callAsync(() => NativeModule!.createShareFromTemplate(options));
}

/**
 * Returns a summary of recent record modifications in a shared zone,
 * grouped by the user who made each change.
 *
 * Scans up to `limit` records (default 100, capped at 200) sorted by
 * `modificationDate` descending. Display names are resolved via
 * `CKContainer.discoverUserIdentity` and are only available when the user
 * has opted into iCloud discoverability — otherwise `displayName` is null.
 *
 * @param options - `zoneName`, optional `database` (default `'shared'`), optional `limit`.
 * @returns Array of activity entries sorted by `lastModifiedAt` descending.
 *
 * @throws {CloudKitError} code `ZONE_NOT_FOUND` if the zone does not exist.
 * @throws {CloudKitError} code `NOT_AUTHENTICATED` if the user is not signed in.
 */
export function getShareActivity(
  options: GetShareActivityOptions
): Promise<ShareActivityEntry[]> {
  return callAsync(() => NativeModule!.getShareActivity(options));
}

// ---------------------------------------------------------------------------
// Phase L — On-Device ML (Core ML bridge, iOS 14+)
// ---------------------------------------------------------------------------

import type { MLPredictOptions, MLBatchPredictOptions, MLPredictResult } from './types';

export function mlPredict(options: MLPredictOptions): Promise<MLPredictResult> {
  return callAsync(() => NativeModule!.mlPredict(options));
}

export function mlBatchPredict(options: MLBatchPredictOptions): Promise<MLPredictResult[]> {
  return callAsync(() => NativeModule!.mlBatchPredict(options));
}

export function mlModelSchema(modelPath: string): Promise<Record<string, string>> {
  return callAsync(() => NativeModule!.mlModelSchema(modelPath));
}

// Encrypted Search (L.2)
/**
 * Indexes the extracted plaintext content of a record's encrypted fields.
 *
 * Call this after saving a record whose encrypted fields you want to be
 * searchable. Pass the plaintext values **before** encrypting them; the native
 * layer tokenises the strings and writes only opaque tokens (lowercase words
 * of 2+ characters) to a non-encrypted `_SearchIndex` CloudKit record in the
 * same zone.
 *
 * @param options - `recordName`, `zoneName`, optional `database`, `textValues`.
 */
export function indexEncryptedRecord(options: IndexEncryptedRecordOptions): Promise<void> {
  return callAsync(() => NativeModule!.indexEncryptedRecord(options));
}

/**
 * Removes a record from the encrypted search index.
 *
 * Call this when a record is deleted, or when you no longer want it to appear
 * in search results. Safe to call even if the record was never indexed.
 *
 * @param options - `recordName`, `zoneName`, optional `database`.
 */
export function deindexRecord(options: DeindexRecordOptions): Promise<void> {
  return callAsync(() => NativeModule!.deindexRecord(options));
}

/**
 * Searches the client-side encrypted index for records matching a query.
 *
 * The query is tokenised with the same rules as `indexEncryptedRecord` and an
 * AND match is applied: all tokens must appear in the record's index for it to
 * be returned. Returns an empty array for empty or all-stopword queries.
 *
 * Because the index lives in CloudKit (not on-device), this requires a network
 * round-trip to fetch the `_SearchIndex` record on the first call per zone per
 * session.
 *
 * @param options - `query`, `zoneName`, optional `database`.
 * @returns Array of `recordName` strings for matching records.
 */
export function searchEncrypted(options: SearchEncryptedOptions): Promise<string[]> {
  return callAsync(() => NativeModule!.searchEncrypted(options));
}

// ---------------------------------------------------------------------------
// Phase K.1 — Presence & Cursors
// ---------------------------------------------------------------------------

import type { PresenceEntry, PresenceChangedEvent, StartPresenceOptions } from './types';

export function startPresence(options: StartPresenceOptions): Promise<void> {
  return callAsync(() => NativeModule!.startPresence(options));
}

export function stopPresence(options: { zoneName: string; database?: string }): Promise<void> {
  return callAsync(() => NativeModule!.stopPresence(options));
}

export function updatePresenceCursor(options: { zoneName: string; cursor: Record<string, unknown> }): Promise<void> {
  return callAsync(() => NativeModule!.updatePresenceCursor(options));
}

export function updatePresenceStatus(options: { zoneName: string; status: 'active' | 'idle' | 'editing' }): Promise<void> {
  return callAsync(() => NativeModule!.updatePresenceStatus(options));
}

export function getPresence(options: { zoneName: string; database?: string }): Promise<PresenceEntry[]> {
  return callAsync(() => NativeModule!.getPresence(options));
}

export function addPresenceListener(callback: (event: PresenceChangedEvent) => void): { remove: () => void } {
  const subscription = emitter!.addListener('onPresenceChanged', callback);
  return { remove: () => subscription.remove() };
}

// ---------------------------------------------------------------------------
// Phase K.3 — Live Activities / Widgets Integration
// ---------------------------------------------------------------------------

export function configureExtensionBridge(
  options: ConfigureExtensionBridgeOptions
): Promise<void> {
  return callAsync(() => NativeModule!.configureExtensionBridge(options));
}

export function registerWidgetBinding(
  options: RegisterWidgetBindingOptions
): Promise<void> {
  return callAsync(() => NativeModule!.registerWidgetBinding(options));
}

export function removeWidgetBinding(id: string): Promise<void> {
  return callAsync(() => NativeModule!.removeWidgetBinding({ id }));
}

export function registerLiveActivityBinding(
  options: RegisterLiveActivityBindingOptions
): Promise<void> {
  return callAsync(() => NativeModule!.registerLiveActivityBinding(options));
}

export function removeLiveActivityBinding(id: string): Promise<void> {
  return callAsync(() => NativeModule!.removeLiveActivityBinding({ id }));
}

export function reloadWidgetTimeline(widgetKind: string): Promise<void> {
  return callAsync(() => NativeModule!.reloadWidgetTimeline({ widgetKind }));
}

export function addLiveActivityListener(
  callback: (event: LiveActivityUpdateEvent) => void
): { remove: () => void } {
  const subscription = emitter!.addListener('onLiveActivityUpdate', callback);
  return { remove: () => subscription.remove() };
}
