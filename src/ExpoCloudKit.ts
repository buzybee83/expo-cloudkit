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

import { CloudKitError, CloudKitErrorCode } from './errors';
import type {
  AccountStatus,
  AssetProgress,
  CloudKitRecord,
  DatabaseScope,
  IncrementCRDTCounterOptions,
  LWWSetOptions,
  ORSetMutationOptions,
  PendingRecordChange,
  QueryPredicate,
  QueryResult,
  RecordIdentifier,
  RecordToSave,
  SavedRecord,
  SortDescriptor,
  Subscription,
  SyncEngineConfig,
  SyncEngineEvent,
  SyncState,
  Zone,
  ZoneChanges,
} from './types';

// ---------------------------------------------------------------------------
// Native module acquisition
// ---------------------------------------------------------------------------

/**
 * Attempts to acquire the native module. On Android or web this will throw,
 * which we catch and replace with a stub that throws CloudKitError on every call.
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

function assertNativeAvailable(): void {
  if (!NativeModule) {
    throw new CloudKitError(
      CloudKitErrorCode.UNKNOWN,
      'expo-cloudkit is only supported on iOS. This device/platform does not have CloudKit.'
    );
  }
}

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
// Phase K.2 — CRDT Mutations
// ---------------------------------------------------------------------------

/**
 * Increments a `gcounter` or `pncounter` field by `delta`.
 *
 * The record is fetched, the mutation is applied to the local CRDT state,
 * and the result is enqueued through the sync engine (not a direct save).
 *
 * - For `gcounter`: `delta` must be ≥ 1.
 * - For `pncounter`: negative `delta` values are valid (decrement).
 *
 * @throws {CloudKitError} CRDT_NOT_CONFIGURED if no `crdtSchema` was passed to `startSyncEngine`.
 * @throws {CloudKitError} SYNC_ENGINE_NOT_RUNNING if the sync engine is not active.
 */
export function incrementCRDTCounter(options: IncrementCRDTCounterOptions): Promise<CloudKitRecord> {
  return callAsync(() => NativeModule!.incrementCRDTCounter({ delta: 1, ...options }));
}

/**
 * Adds a string value to an `orset` field.
 *
 * Uses add-wins semantics: if a concurrent remove arrives from another device,
 * this add will survive after the next merge.
 *
 * @throws {CloudKitError} CRDT_NOT_CONFIGURED if no `crdtSchema` was passed to `startSyncEngine`.
 * @throws {CloudKitError} SYNC_ENGINE_NOT_RUNNING if the sync engine is not active.
 */
export function addToORSet(options: ORSetMutationOptions): Promise<CloudKitRecord> {
  return callAsync(() => NativeModule!.addToORSet(options));
}

/**
 * Removes a string value from an `orset` field.
 *
 * Uses observed-remove semantics: only UUIDs observed before the remove are
 * retracted. Concurrent adds from other devices will survive.
 *
 * @throws {CloudKitError} CRDT_NOT_CONFIGURED if no `crdtSchema` was passed to `startSyncEngine`.
 * @throws {CloudKitError} SYNC_ENGINE_NOT_RUNNING if the sync engine is not active.
 */
export function removeFromORSet(options: ORSetMutationOptions): Promise<CloudKitRecord> {
  return callAsync(() => NativeModule!.removeFromORSet(options));
}

/**
 * Sets an `lww` (last-writer-wins) register field to a new value.
 *
 * The write is timestamped with the current wall clock. On merge, the write
 * with the highest timestamp wins. When timestamps are equal, a deterministic
 * node-ID tiebreak is applied.
 *
 * @throws {CloudKitError} CRDT_NOT_CONFIGURED if no `crdtSchema` was passed to `startSyncEngine`.
 * @throws {CloudKitError} SYNC_ENGINE_NOT_RUNNING if the sync engine is not active.
 */
export function setLWWRegister(options: LWWSetOptions): Promise<CloudKitRecord> {
  return callAsync(() => NativeModule!.setLWWRegister(options));
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
  assertNativeAvailable();
  const subscription = emitter!.addListener('onAssetProgress', callback);
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
