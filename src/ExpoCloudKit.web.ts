/**
 * expo-cloudkit — Web implementation via CloudKit JS (tsl-apple-cloudkit)
 *
 * This file is the Metro/bundler `.web.ts` platform override. When building
 * for web, imports of `./ExpoCloudKit` resolve here instead of the native
 * module binding.
 *
 * Architecture:
 * - CloudKit JS is lazily loaded via `src/web/cloudkit-loader.ts`
 * - Type conversions live in `src/web/converters.ts`
 * - Error mapping lives in `src/web/errors.ts`
 * - Auth state lives in `src/web/auth.ts`
 * - Database scope resolution lives in `src/web/database.ts`
 *
 * NO imports from `expo-modules-core` or `react-native`. This file is
 * deliberately import-free from native dependencies so it can build in web
 * environments.
 *
 * SSR-safe: browser globals (window, localStorage) are only accessed inside
 * function bodies, never at module scope.
 */

import { CloudKitError, CloudKitErrorCode, CloudKitNotSupportedError } from './errors';
import type {
  AccountStatus,
  AcceptShareOptions,
  AcceptedShare,
  AssetProgress,
  BatchProgress,
  CloudKitRecord,
  CloudKitSubscription,
  ContainerInfo,
  CreateShareOptions,
  DatabaseScope,
  DeleteShareOptions,
  FetchParticipantsOptions,
  FetchWithReferencesOptions,
  OfflineQueueDrainResult,
  OfflineQueueEntryStatus,
  OfflineQueueEvent,
  OfflineQueueStatus,
  PendingRecordChange,
  PresentSharingOptions,
  QueryPredicate,
  QueryResult,
  RawRecord,
  RecordIdentifier,
  RecordToSave,
  RemoveParticipantOptions,
  ResolvedRecord,
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
  WebConfigOptions,
  Zone,
  ZoneChanges,
} from './types';
import {
  configureAuthPersistence,
  getWebAuthState,
  setWebAuthState,
  clearWebAuthState,
  subscribeToAuthState,
  webAuthStateToAccountStatus,
} from './web/auth';
import { ckjsRecordToCloudKitRecord, ckjsSavedRecordToSavedRecord, recordToSaveToCKJS } from './web/converters';
import { resolveDatabase } from './web/database';
import { mapCKJSError } from './web/errors';
import { loadCloudKit } from './web/cloudkit-loader';

// ---------------------------------------------------------------------------
// Module-level container state
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _container: any | null = null;
let _configured = false;

/** No-op Subscription for stubs that cannot produce events on web. */
const noopSubscription: Subscription = { remove: () => {} };

// ---------------------------------------------------------------------------
// Container helpers
// ---------------------------------------------------------------------------

/**
 * Returns the configured container or throws if `configureWeb()` was not called.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function requireContainer(): any {
  if (!_container) {
    throw new CloudKitError(
      CloudKitErrorCode.UNKNOWN,
      'expo-cloudkit web: call configureWeb() before any CloudKit operation.'
    );
  }
  return _container;
}

// ---------------------------------------------------------------------------
// Web-only: configureWeb
// ---------------------------------------------------------------------------

/**
 * Configures CloudKit for web access using CloudKit JS (tsl-apple-cloudkit).
 *
 * Must be called before any CloudKit operation on web. Loads the CloudKit JS
 * bundle lazily, then calls `CloudKit.configure()` with the container and
 * API token settings.
 *
 * On iOS/native, this is a no-op that resolves immediately.
 *
 * @param containerId - CloudKit container identifier, e.g. "iCloud.com.example.myapp"
 * @param options     - Web-specific configuration including the required `apiToken`
 */
export async function configureWeb(
  containerId: string,
  options: WebConfigOptions
): Promise<void> {
  const { apiToken, environment = 'production', persistSession = true } = options;

  configureAuthPersistence(persistSession);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ck: any;
  try {
    ck = await loadCloudKit();
  } catch (err) {
    throw mapCKJSError(err, 'general');
  }

  // tsl-apple-cloudkit exposes CloudKit via default export or named export
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CloudKit: any = ck.default ?? ck.CloudKit ?? ck;

  try {
    const configured = CloudKit.configure({
      containers: [
        {
          containerIdentifier: containerId,
          apiTokenAuth: {
            apiToken,
            persist: persistSession,
          },
          environment,
        },
      ],
    });

    // CloudKit.configure() returns the configured CloudKit instance or container
    // The default container is accessible via getDefaultContainer() or containers[0]
    _container =
      configured?.getDefaultContainer?.() ??
      configured?.containers?.[0] ??
      (typeof CloudKit.getDefaultContainer === 'function'
        ? CloudKit.getDefaultContainer()
        : CloudKit);

    _configured = true;

    // Wire up CloudKit JS auth events so `addAccountStatusListener` callbacks fire
    if (_container && typeof _container.whenUserSignsIn === 'function') {
      _container.whenUserSignsIn().then((userIdentity: unknown) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const identity = userIdentity as any;
        setWebAuthState({
          isAuthenticated: true,
          userRecordName: identity?.userRecordName,
        });
      }).catch(() => {
        // Sign-in did not happen during this configure() call — that's fine
      });
    }
  } catch (err) {
    throw mapCKJSError(err, 'general');
  }
}

// ---------------------------------------------------------------------------
// Web-only: authenticateWeb
// ---------------------------------------------------------------------------

/**
 * Triggers the Apple ID sign-in popup via CloudKit JS, allowing the user to
 * authenticate for private database access.
 *
 * On iOS/native, resolves immediately with the current account status
 * (the user is always authenticated through the OS).
 *
 * @returns The account status after the authentication attempt.
 */
export async function authenticateWeb(): Promise<AccountStatus> {
  if (!_configured || !_container) {
    throw new CloudKitError(
      CloudKitErrorCode.UNKNOWN,
      'expo-cloudkit web: call configureWeb() before authenticateWeb().'
    );
  }

  try {
    if (typeof _container.setUpAuth === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const userIdentity: any = await _container.setUpAuth();
      if (userIdentity) {
        // Already signed in
        setWebAuthState({
          isAuthenticated: true,
          userRecordName: userIdentity?.userRecordName,
        });
        return 'available';
      }

      // Not yet signed in — wait for the user to complete sign-in.
      // CloudKit JS injects its own sign-in button into the DOM element with
      // id="apple-sign-in-button" (or the id passed in configureWeb's signInButton).
      // whenUserSignsIn() resolves when that button is clicked and auth completes.
      if (typeof _container.whenUserSignsIn === 'function') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const identity: any = await _container.whenUserSignsIn();
        setWebAuthState({
          isAuthenticated: true,
          userRecordName: identity?.userRecordName,
        });
        return 'available';
      }
    }

    // Fall back to checking the current auth state
    return webAuthStateToAccountStatus(getWebAuthState());
  } catch (err) {
    setWebAuthState({ isAuthenticated: false, userRecordName: undefined });
    throw mapCKJSError(err, 'general');
  }
}

// ---------------------------------------------------------------------------
// Web-only: signOutWeb
// ---------------------------------------------------------------------------

/**
 * Signs out of CloudKit on web, clearing the auth session.
 *
 * On iOS/native, this is a no-op (iCloud sign-out is done through Settings).
 */
export async function signOutWeb(): Promise<void> {
  clearWebAuthState();
  // CloudKit JS does not expose a programmatic sign-out; clearing local state
  // is the best we can do without reloading the page.
}

// ---------------------------------------------------------------------------
// Web-only: isWebAuthenticated
// ---------------------------------------------------------------------------

/**
 * Synchronous check: returns `true` if a valid CloudKit JS auth session exists.
 *
 * On iOS/native, delegates to checking whether the account status is 'available'.
 */
export function isWebAuthenticated(): boolean {
  return getWebAuthState().isAuthenticated;
}

// ---------------------------------------------------------------------------
// Container & Account
// ---------------------------------------------------------------------------

/**
 * No-op on web — use `configureWeb()` instead.
 *
 * Kept for API parity with the native module so existing call sites that
 * call `configure()` unconditionally do not throw.
 */
export function configure(_containerId: string): void {
  // Intentional no-op on web: configureWeb() is the web entry point.
  // The CloudKitProvider uses platform detection to call the right one.
}

/**
 * Returns `true` on web if `configureWeb()` has been called successfully.
 */
export function isCloudKitAvailable(): boolean {
  return _configured;
}

/**
 * Returns `false` on web — CKSyncEngine is an iOS-only kernel scheduler.
 */
export function isSyncEngineAvailable(): boolean {
  return false;
}

/**
 * Returns the current CloudKit auth state as an `AccountStatus`.
 *
 * `'available'` when the user is signed in via `authenticateWeb()`.
 * `'noAccount'` when configured but not authenticated.
 * `'couldNotDetermine'` when `configureWeb()` has not been called.
 */
export async function getAccountStatus(): Promise<AccountStatus> {
  if (!_configured) {
    return 'couldNotDetermine';
  }

  // Try to confirm auth state from the CloudKit JS container
  if (_container && typeof _container.fetchUserRecordName === 'function') {
    try {
      const userRecordName = await _container.fetchUserRecordName();
      setWebAuthState({ isAuthenticated: true, userRecordName });
      return 'available';
    } catch {
      // 401/not authenticated — fall through to stored state
    }
  }

  return webAuthStateToAccountStatus(getWebAuthState());
}

/**
 * Subscribes to CloudKit auth state changes on web.
 *
 * Fires when `setWebAuthState()` is called (i.e. after sign-in/sign-out).
 * Returns a Subscription; call `.remove()` to unsubscribe.
 */
export function addAccountStatusListener(
  callback: (status: AccountStatus) => void
): Subscription {
  const unsubscribe = subscribeToAuthState((state) => {
    callback(webAuthStateToAccountStatus(state));
  });
  return { remove: unsubscribe };
}

// ---------------------------------------------------------------------------
// Zone Management
// ---------------------------------------------------------------------------

/**
 * Creates a custom record zone in the specified CloudKit database.
 *
 * @param zoneName - Name of the zone to create.
 * @param database - Target database scope. Default: 'private'.
 */
export async function createZone(
  zoneName: string,
  database: DatabaseScope = 'private'
): Promise<Zone> {
  const container = requireContainer();
  const db = resolveDatabase(container, database);

  try {
    const response = await db.saveRecordZones([{ zoneName }]);
    const savedZone = response?.zones?.[0] ?? response?.[0];
    return {
      zoneName: savedZone?.zoneID?.zoneName ?? zoneName,
      ownerName: savedZone?.zoneID?.ownerRecordName ?? '__defaultOwner__',
      capabilities: savedZone?.zoneID?.capabilities ?? [],
    };
  } catch (err) {
    throw mapCKJSError(err, 'zone');
  }
}

/**
 * Deletes a custom record zone and all records within it.
 *
 * @param zoneName - Name of the zone to delete.
 * @param database - Target database scope. Default: 'private'.
 */
export async function deleteZone(
  zoneName: string,
  database: DatabaseScope = 'private'
): Promise<void> {
  const container = requireContainer();
  const db = resolveDatabase(container, database);

  try {
    await db.deleteRecordZones([{ zoneName }]);
  } catch (err) {
    throw mapCKJSError(err, 'zone');
  }
}

/**
 * Returns all custom record zones in the specified CloudKit database.
 *
 * @param database - Target database scope. Default: 'private'.
 */
export async function fetchZones(database: DatabaseScope = 'private'): Promise<Zone[]> {
  const container = requireContainer();
  const db = resolveDatabase(container, database);

  try {
    const response = await db.fetchAllRecordZones();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const zones: any[] = response?.zones ?? response ?? [];
    return zones.map((z) => ({
      zoneName: z?.zoneID?.zoneName ?? z?.zoneName ?? '_defaultZone',
      ownerName: z?.zoneID?.ownerRecordName ?? '__defaultOwner__',
      capabilities: z?.capabilities ?? [],
    }));
  } catch (err) {
    throw mapCKJSError(err, 'zone');
  }
}

// ---------------------------------------------------------------------------
// Record CRUD
// ---------------------------------------------------------------------------

/**
 * Saves one or more records to CloudKit via CloudKit JS.
 *
 * Records with a `recordName` are updated; records without are inserted with
 * a server-generated UUID. Provide `changeTag` to opt in to conflict detection.
 *
 * Asset fields in `RecordToSave` are not supported on web in this release.
 *
 * @param records  - Records to save.
 * @param database - Target database. Default: 'private'.
 */
export async function saveRecords(
  records: RecordToSave[],
  database: DatabaseScope = 'private'
): Promise<SavedRecord[]> {
  const container = requireContainer();
  const db = resolveDatabase(container, database);

  // Group by zone for correct zoneID context in requests
  // For simplicity, we save all records in one batch using the first record's zoneName
  // (CloudKit JS handles mixed zones internally in the records array)
  const ckjsRecords = records.map((r) => {
    const body = recordToSaveToCKJS(r);
    // Attach zoneID to the record body for CloudKit JS
    body['zoneID'] = {
      zoneName: r.zoneName ?? '_defaultZone',
      ownerRecordName: '__defaultOwner__',
    };
    return body;
  });

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await db.saveRecords(ckjsRecords as any[]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const savedRaw: any[] = response?.records ?? response ?? [];
    return savedRaw.map((raw, i) => {
      const originalRecord = records[i];
      const zoneName = originalRecord?.zoneName ?? '_defaultZone';
      return ckjsSavedRecordToSavedRecord(raw, zoneName);
    });
  } catch (err) {
    throw mapCKJSError(err, 'record');
  }
}

/**
 * Fetches a single record by type and ID from CloudKit.
 *
 * @param recordType - CKRecord type string.
 * @param recordId   - CKRecord.ID.recordName string.
 * @param zoneName   - Zone name. Omit for default zone.
 * @param database   - Target database. Default: 'private'.
 */
export async function fetchRecord(
  _recordType: string,
  recordId: string,
  zoneName?: string,
  database: DatabaseScope = 'private'
): Promise<CloudKitRecord> {
  const container = requireContainer();
  const db = resolveDatabase(container, database);

  const resolvedZone = zoneName ?? '_defaultZone';
  const recordID = {
    recordName: recordId,
    zoneID: { zoneName: resolvedZone, ownerRecordName: '__defaultOwner__' },
  };

  try {
    const response = await db.fetchRecords([recordID]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const records: any[] = response?.records ?? response ?? [];
    const raw = records[0];
    if (!raw) {
      throw new CloudKitError(
        CloudKitErrorCode.RECORD_NOT_FOUND,
        `Record '${recordId}' not found in zone '${resolvedZone}'.`
      );
    }
    return ckjsRecordToCloudKitRecord(raw, resolvedZone);
  } catch (err) {
    if (err instanceof CloudKitError) throw err;
    throw mapCKJSError(err, 'record');
  }
}

/**
 * Queries records by type with optional predicate and sort descriptors.
 * Supports cursor-based pagination.
 *
 * @param recordType      - CKRecord type to query.
 * @param predicate       - Optional filter predicate.
 * @param sortDescriptors - Optional sort order.
 * @param zoneName        - Zone to query. Omit for default zone.
 * @param database        - Target database. Default: 'private'.
 * @param resultsLimit    - Max records to return. Default: 100.
 * @param cursor          - Pagination cursor from a previous QueryResult.
 */
export async function queryRecords(
  recordType: string,
  predicate?: QueryPredicate,
  sortDescriptors?: SortDescriptor[],
  zoneName?: string,
  database: DatabaseScope = 'private',
  resultsLimit?: number,
  cursor?: string
): Promise<QueryResult> {
  const container = requireContainer();
  const db = resolveDatabase(container, database);

  const resolvedZone = zoneName ?? '_defaultZone';

  // Build CloudKit JS query filter
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filterBy: any[] = [];
  if (predicate) {
    filterBy.push({
      fieldName: predicate.field,
      comparator: predicate.comparator,
      fieldValue: { value: predicate.value },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sortBy: any[] = (sortDescriptors ?? []).map((sd) => ({
    fieldName: sd.field,
    ascending: sd.ascending,
  }));

  const query = {
    recordType,
    filterBy,
    sortBy,
  };

  const options: Record<string, unknown> = {
    zoneID: { zoneName: resolvedZone, ownerRecordName: '__defaultOwner__' },
    resultsLimit: resultsLimit ?? 100,
  };

  if (cursor) {
    options['continuationMarker'] = cursor;
  }

  try {
    const response = await db.performQuery(query, options);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const records: any[] = response?.records ?? response ?? [];
    return {
      records: records.map((r) => ckjsRecordToCloudKitRecord(r, resolvedZone)),
      cursor: response?.continuationMarker ?? undefined,
    };
  } catch (err) {
    throw mapCKJSError(err, 'record');
  }
}

/**
 * Deletes one or more records permanently from CloudKit.
 *
 * @param recordIds - Record identifiers to delete.
 * @param database  - Target database. Default: 'private'.
 */
export async function deleteRecords(
  recordIds: RecordIdentifier[],
  database: DatabaseScope = 'private'
): Promise<void> {
  const container = requireContainer();
  const db = resolveDatabase(container, database);

  const recordIDs = recordIds.map((r) => ({
    recordName: r.recordName,
    zoneID: {
      zoneName: r.zoneName ?? '_defaultZone',
      ownerRecordName: '__defaultOwner__',
    },
  }));

  try {
    await db.deleteRecords(recordIDs);
  } catch (err) {
    throw mapCKJSError(err, 'record');
  }
}

/**
 * Fetches record zone changes since the last sync token.
 *
 * CloudKit JS does not directly expose `fetchRecordZoneChanges`. If the
 * underlying database object has a `fetchRecordZoneChanges` method, it will
 * be called. Otherwise, an empty result is returned (no crash) and callers
 * should fall back to a full query.
 *
 * @param zoneNames - Zone names to fetch changes for.
 * @param database  - Target database. Default: 'private'.
 */
export async function fetchRecordZoneChanges(
  zoneNames: string[],
  database: DatabaseScope = 'private'
): Promise<ZoneChanges> {
  const container = requireContainer();
  const db = resolveDatabase(container, database);

  // CloudKit JS may or may not expose fetchRecordZoneChanges
  if (typeof db.fetchRecordZoneChanges !== 'function') {
    // Graceful degradation: return empty result rather than crashing
    return {
      changedRecords: [],
      deletedRecordNames: [],
      syncToken: '',
      moreComing: false,
    };
  }

  try {
    const zoneIDs = zoneNames.map((zoneName) => ({
      zoneID: { zoneName, ownerRecordName: '__defaultOwner__' },
    }));

    const response = await db.fetchRecordZoneChanges(zoneIDs, {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const changedRaw: any[] = response?.records ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deletedRaw: any[] = response?.deletedRecords ?? [];

    return {
      changedRecords: changedRaw.map((r) => {
        const zoneName = r?.zoneID?.zoneName ?? zoneNames[0] ?? '_defaultZone';
        return ckjsRecordToCloudKitRecord(r, zoneName);
      }),
      deletedRecordNames: deletedRaw.map(
        (r) => r?.recordID?.recordName ?? r?.recordName ?? ''
      ),
      syncToken: response?.syncToken ?? response?.moreComing?.syncToken ?? '',
      moreComing: response?.moreComing ?? false,
    };
  } catch (err) {
    throw mapCKJSError(err, 'record');
  }
}

// ---------------------------------------------------------------------------
// CKSyncEngine — stubs (not available on web)
// ---------------------------------------------------------------------------

/**
 * Returns `{ usesSyncEngine: false, status: 'notStarted' }` on web.
 * CKSyncEngine is an iOS-only system scheduler.
 */
export function getSyncState(): SyncState {
  return { usesSyncEngine: false, status: 'notStarted' };
}

/**
 * Throws `CloudKitNotSupportedError` — CKSyncEngine is not available on web.
 */
export function startSyncEngine(_config: SyncEngineConfig): Promise<void> {
  return Promise.reject(new CloudKitNotSupportedError());
}

/**
 * Throws `CloudKitNotSupportedError` — CKSyncEngine is not available on web.
 */
export function stopSyncEngine(): Promise<void> {
  return Promise.reject(new CloudKitNotSupportedError());
}

/**
 * Throws `CloudKitNotSupportedError` — CKSyncEngine is not available on web.
 */
export function triggerSync(): Promise<void> {
  return Promise.reject(new CloudKitNotSupportedError());
}

/**
 * Throws `CloudKitNotSupportedError` — CKSyncEngine is not available on web.
 */
export function enqueuePendingChange(_change: PendingRecordChange): void {
  throw new CloudKitNotSupportedError();
}

/**
 * Returns a no-op Subscription — CKSyncEngine events are not available on web.
 */
export function addSyncEngineListener(
  _callback: (event: SyncEngineEvent) => void
): Subscription {
  return noopSubscription;
}

// ---------------------------------------------------------------------------
// Asset progress — no-op on web
// ---------------------------------------------------------------------------

/**
 * Returns a no-op Subscription — native asset progress events are not
 * available on web. Asset download URLs can be accessed directly from
 * `AssetReadValue.downloadURL` in fetched records.
 */
export function addAssetProgressListener(
  _callback: (progress: AssetProgress) => void
): Subscription {
  return noopSubscription;
}

/**
 * Throws `CloudKitNotSupportedError` — native asset download is not available on web.
 * Access `AssetReadValue.downloadURL` directly to download assets on web.
 */
export function downloadAsset(
  _recordType: string,
  _recordId: string,
  _fieldName: string,
  _destinationPath: string,
  _zoneName?: string,
  _database: DatabaseScope = 'private'
): Promise<string> {
  return Promise.reject(new CloudKitNotSupportedError());
}

// ---------------------------------------------------------------------------
// Batch progress — no-op on web
// ---------------------------------------------------------------------------

/**
 * Returns a no-op Subscription — per-record batch progress events are not
 * available on web (CloudKit JS does not emit per-record progress callbacks).
 */
export function addBatchProgressListener(
  _callback: (progress: BatchProgress) => void
): Subscription {
  return noopSubscription;
}

// ---------------------------------------------------------------------------
// Push Subscriptions
// ---------------------------------------------------------------------------

/**
 * Creates a CKQuerySubscription on the server via CloudKit JS.
 *
 * Note: Push delivery (APNs) does not work on web. The subscription is
 * stored on the server but you will not receive push notifications.
 */
export async function saveQuerySubscription(
  options: SaveQuerySubscriptionOptions
): Promise<string> {
  const container = requireContainer();
  const db = resolveDatabase(container, options.database ?? 'private');

  const zoneID = options.zoneName
    ? { zoneName: options.zoneName, ownerRecordName: '__defaultOwner__' }
    : undefined;

  const subscription = {
    subscriptionType: 'query',
    recordType: options.recordType,
    firesOnRecordCreation: options.firesOnRecordCreation ?? true,
    firesOnRecordUpdate: options.firesOnRecordUpdate ?? true,
    firesOnRecordDeletion: options.firesOnRecordDeletion ?? true,
    notificationInfo: {},
    ...(zoneID ? { zoneID } : {}),
    ...(options.predicate
      ? {
          filterBy: [
            {
              fieldName: options.predicate.field,
              comparator: options.predicate.comparator,
              fieldValue: { value: options.predicate.value },
            },
          ],
        }
      : {}),
  };

  try {
    const response = await db.saveSubscriptions([subscription]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const saved: any[] = response?.subscriptions ?? response ?? [];
    return saved[0]?.subscriptionID ?? saved[0]?.id ?? '';
  } catch (err) {
    throw mapCKJSError(err, 'subscription');
  }
}

/**
 * Creates a CKDatabaseSubscription on the server via CloudKit JS.
 *
 * Note: Push delivery does not work on web.
 */
export async function saveDatabaseSubscription(
  database: DatabaseScope = 'private'
): Promise<string> {
  const container = requireContainer();
  const db = resolveDatabase(container, database);

  const subscription = {
    subscriptionType: 'database',
    notificationInfo: {},
    databaseScope: database,
  };

  try {
    const response = await db.saveSubscriptions([subscription]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const saved: any[] = response?.subscriptions ?? response ?? [];
    return saved[0]?.subscriptionID ?? saved[0]?.id ?? '';
  } catch (err) {
    throw mapCKJSError(err, 'subscription');
  }
}

/**
 * Deletes an existing subscription by ID via CloudKit JS.
 *
 * @param subscriptionID - Subscription ID from a previous save call.
 * @param database       - Database the subscription belongs to. Default: 'private'.
 */
export async function deleteSubscription(
  subscriptionID: string,
  database: DatabaseScope = 'private'
): Promise<void> {
  const container = requireContainer();
  const db = resolveDatabase(container, database);

  try {
    await db.deleteSubscriptions([subscriptionID]);
  } catch (err) {
    throw mapCKJSError(err, 'subscription');
  }
}

/**
 * Returns all active subscriptions for the specified database via CloudKit JS.
 *
 * @param database - Target database. Default: 'private'.
 */
export async function fetchSubscriptions(
  database: DatabaseScope = 'private'
): Promise<CloudKitSubscription[]> {
  const container = requireContainer();
  const db = resolveDatabase(container, database);

  try {
    const response = await db.fetchAllSubscriptions();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subs: any[] = response?.subscriptions ?? response ?? [];
    return subs.map((s) => ({
      id: s?.subscriptionID ?? s?.id ?? '',
      type: s?.subscriptionType === 'database' ? 'database' : 'query',
      recordType: s?.recordType,
      database,
    }));
  } catch (err) {
    throw mapCKJSError(err, 'subscription');
  }
}

/**
 * Returns a no-op Subscription — APNs push notifications do not reach web.
 * Subscriptions can be saved/deleted but events will not be delivered.
 */
export function addSubscriptionListener(
  _callback: (event: SubscriptionEvent) => void
): Subscription {
  return noopSubscription;
}

// ---------------------------------------------------------------------------
// CKShare — data operations
// ---------------------------------------------------------------------------

/**
 * Creates a CKShare for the specified root record via CloudKit JS.
 */
export async function createShare(options: CreateShareOptions): Promise<Share> {
  const container = requireContainer();
  const db = resolveDatabase(container, options.database ?? 'private');

  const shareRecord = {
    recordType: 'cloudkit.share',
    fields: {
      publicPermission: {
        value: options.publicPermission ?? 'none',
        type: 'STRING',
      },
    },
    zoneID: {
      zoneName: options.zoneName ?? '_defaultZone',
      ownerRecordName: '__defaultOwner__',
    },
  };

  try {
    const response = await db.saveRecords([shareRecord]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const saved: any[] = response?.records ?? response ?? [];
    const raw = saved[0];
    return {
      shareRecordName: raw?.recordName ?? '',
      zoneName: raw?.zoneID?.zoneName ?? options.zoneName ?? '_defaultZone',
      shareURL: raw?.fields?.shareURL?.value ?? null,
      publicPermission: options.publicPermission ?? 'none',
      creationDate: raw?.created?.timestamp
        ? new Date(raw.created.timestamp).toISOString()
        : new Date().toISOString(),
    };
  } catch (err) {
    throw mapCKJSError(err, 'share');
  }
}

/**
 * Deletes a CKShare record via CloudKit JS.
 */
export async function deleteShare(options: DeleteShareOptions): Promise<void> {
  const container = requireContainer();
  const db = resolveDatabase(container, options.database ?? 'private');

  const recordID = {
    recordName: options.shareRecordName,
    zoneID: {
      zoneName: options.zoneName ?? '_defaultZone',
      ownerRecordName: '__defaultOwner__',
    },
  };

  try {
    await db.deleteRecords([recordID]);
  } catch (err) {
    throw mapCKJSError(err, 'share');
  }
}

/**
 * Throws `CloudKitNotSupportedError` — `UICloudSharingController` is not
 * available on web. Use `createShare()` to create a share record directly
 * and share the resulting URL through your own UI.
 */
export function presentSharingUI(_options: PresentSharingOptions): Promise<SharingUIResult> {
  return Promise.reject(new CloudKitNotSupportedError());
}

/**
 * Fetches the participants on an existing CKShare via CloudKit JS.
 */
export async function fetchShareParticipants(
  options: FetchParticipantsOptions
): Promise<ShareParticipant[]> {
  const container = requireContainer();
  const db = resolveDatabase(container, options.database ?? 'private');

  const recordID = {
    recordName: options.shareRecordName,
    zoneID: {
      zoneName: options.zoneName ?? '_defaultZone',
      ownerRecordName: '__defaultOwner__',
    },
  };

  try {
    const response = await db.fetchRecords([recordID]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const records: any[] = response?.records ?? response ?? [];
    const shareRecord = records[0];
    // Participants are embedded in the share record's fields
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const participants: any[] = shareRecord?.participants ?? shareRecord?.fields?.participants?.value ?? [];
    return participants.map((p) => ({
      participantRecordName: p?.userIdentity?.userRecordName ?? p?.participantRecordName ?? '',
      role: p?.role ?? 'unknown',
      permission: p?.permission ?? 'unknown',
      acceptanceStatus: p?.acceptanceStatus ?? 'unknown',
      firstName: p?.userIdentity?.nameComponents?.givenName ?? null,
      lastName: p?.userIdentity?.nameComponents?.familyName ?? null,
    }));
  } catch (err) {
    throw mapCKJSError(err, 'share');
  }
}

/**
 * Throws `CloudKitNotSupportedError` — CKShare participant mutation is not
 * exposed in CloudKit JS.
 */
export function updateSharePermission(_options: UpdatePermissionOptions): Promise<Share> {
  return Promise.reject(new CloudKitNotSupportedError());
}

/**
 * Throws `CloudKitNotSupportedError` — CKShare participant mutation is not
 * exposed in CloudKit JS.
 */
export function removeShareParticipant(_options: RemoveParticipantOptions): Promise<Share> {
  return Promise.reject(new CloudKitNotSupportedError());
}

/**
 * Accepts a CloudKit share via its URL using `container.acceptShares()`.
 */
export async function acceptShare(options: AcceptShareOptions): Promise<AcceptedShare> {
  const container = requireContainer();

  // CloudKit JS accepts shares via a short GUID, not the full URL.
  // We extract the last path component as the share short GUID.
  const shareURL = options.shareURL;
  const shortGUID = shareURL.split('/').pop() ?? shareURL;

  try {
    let response: unknown;
    if (typeof container.acceptShares === 'function') {
      response = await container.acceptShares([shortGUID]);
    } else {
      // Some CloudKit JS versions use a different method name
      response = await container.acceptShare(shortGUID);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw: any = Array.isArray(response) ? response[0] : response;
    return {
      zoneName: raw?.zoneID?.zoneName ?? '_defaultZone',
      ownerName: raw?.zoneID?.ownerRecordName ?? '__defaultOwner__',
      shareRecordName: raw?.shareRecordName ?? raw?.recordName ?? shortGUID,
    };
  } catch (err) {
    throw mapCKJSError(err, 'share');
  }
}

/**
 * Returns all zones in the shared database via CloudKit JS.
 */
export async function fetchSharedDatabaseZones(): Promise<SharedZone[]> {
  const container = requireContainer();
  const db = resolveDatabase(container, 'shared');

  try {
    const response = await db.fetchAllRecordZones();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const zones: any[] = response?.zones ?? response ?? [];
    return zones.map((z) => ({
      zoneName: z?.zoneID?.zoneName ?? '_defaultZone',
      ownerName: z?.zoneID?.ownerRecordName ?? '__defaultOwner__',
      shareRecordName: z?.shareRecordName ?? '',
      participants: z?.participants ?? [],
    }));
  } catch (err) {
    throw mapCKJSError(err, 'share');
  }
}

/**
 * Returns a no-op Subscription — universal link / intent handling is not
 * available on web.
 */
export function addShareAcceptedListener(
  _callback: (event: ShareInvitationEvent) => void
): Subscription {
  return noopSubscription;
}

// ---------------------------------------------------------------------------
// CKRecord.Reference deep linking
// ---------------------------------------------------------------------------

/**
 * Fetches a record and recursively resolves its reference fields on web.
 *
 * Implemented as multiple `fetchRecord` calls in JS. A depth of 1 requires
 * at most 2 round trips; depth 2 requires at most 3 round trips.
 */
export async function fetchRecordWithReferences(
  recordName: string,
  options: FetchWithReferencesOptions
): Promise<ResolvedRecord> {
  const { recordType, zoneName, database = 'private', depth = 1 } = options;

  const rootRecord = await fetchRecord(recordType, recordName, zoneName, database);

  async function resolveReferences(
    record: CloudKitRecord,
    remainingDepth: number
  ): Promise<ResolvedRecord> {
    if (remainingDepth <= 0) {
      return { ...record, resolvedReferences: {} };
    }

    const resolvedReferences: Record<string, ResolvedRecord> = {};

    for (const [fieldName, field] of Object.entries(record.fields)) {
      if (field.type === 'reference' && field.value != null) {
        const ref = field.value as import('./types').ReferenceValue;
        try {
          const refRecord = await fetchRecord(
            // We don't know the recordType of the referenced record from the
            // reference alone — we fetch without specifying type and let the
            // server return it.
            // CloudKit JS accepts recordName-only lookups with any recordType.
            recordType,
            ref.recordName,
            record.zoneName,
            database
          );
          resolvedReferences[fieldName] = await resolveReferences(refRecord, remainingDepth - 1);
        } catch {
          // Unresolvable reference — leave out of resolvedReferences
        }
      }
    }

    return { ...record, resolvedReferences };
  }

  return resolveReferences(rootRecord, depth);
}

// ---------------------------------------------------------------------------
// Debug helpers — stubs on web
// ---------------------------------------------------------------------------

/**
 * Throws `CloudKitNotSupportedError` — debug helpers are not implemented on web.
 */
export function __debugDumpContainerInfo(): Promise<ContainerInfo> {
  return Promise.reject(new CloudKitNotSupportedError());
}

/**
 * Throws `CloudKitNotSupportedError` — debug helpers are not implemented on web.
 */
export function __debugListZones(_database: DatabaseScope = 'private'): Promise<Zone[]> {
  return Promise.reject(new CloudKitNotSupportedError());
}

/**
 * Throws `CloudKitNotSupportedError` — debug helpers are not implemented on web.
 */
export function __debugFetchRawRecord(_options: {
  recordName: string;
  recordType: string;
  zoneName?: string;
  database?: DatabaseScope;
}): Promise<RawRecord> {
  return Promise.reject(new CloudKitNotSupportedError());
}

/**
 * Throws `CloudKitNotSupportedError` — debug helpers are not implemented on web.
 */
export function __debugClearZone(_options: {
  zoneName: string;
  database?: DatabaseScope;
}): Promise<void> {
  return Promise.reject(new CloudKitNotSupportedError());
}

// ---------------------------------------------------------------------------
// Offline Queue — stubs on web
// ---------------------------------------------------------------------------

/**
 * Throws `CloudKitNotSupportedError` — offline queue is not available on web.
 */
export function enqueueOfflineOperation(_options: {
  type: 'save' | 'delete';
  record?: RecordToSave;
  recordIdentifier?: RecordIdentifier;
  database?: DatabaseScope;
}): Promise<{ queueId: string }> {
  return Promise.reject(new CloudKitNotSupportedError());
}

/**
 * Throws `CloudKitNotSupportedError` — offline queue is not available on web.
 */
export function drainOfflineQueue(): Promise<OfflineQueueDrainResult> {
  return Promise.reject(new CloudKitNotSupportedError());
}

/**
 * Throws `CloudKitNotSupportedError` — offline queue is not available on web.
 */
export function getOfflineQueueStatus(_options?: {
  includeEntries?: boolean;
}): Promise<OfflineQueueStatus> {
  return Promise.reject(new CloudKitNotSupportedError());
}

/**
 * Throws `CloudKitNotSupportedError` — offline queue is not available on web.
 */
export function clearOfflineQueue(_options?: {
  status?: OfflineQueueEntryStatus | 'all';
}): Promise<void> {
  return Promise.reject(new CloudKitNotSupportedError());
}

/**
 * Throws `CloudKitNotSupportedError` — offline queue is not available on web.
 */
export function retryFailedOperations(): Promise<void> {
  return Promise.reject(new CloudKitNotSupportedError());
}

/**
 * Returns a no-op Subscription — offline queue events are not available on web.
 */
export function addOfflineQueueListener(
  _callback: (event: OfflineQueueEvent) => void
): Subscription {
  return noopSubscription;
}
