// expo-cloudkit testing utilities
// Import in test files only: import { createMockCloudKit } from 'expo-cloudkit/src/testing'
// Never import this in production code.

import type {
  AccountStatus,
  CloudKitRecord,
  DatabaseScope,
  QueryResult,
  RecordIdentifier,
  RecordToSave,
  SavedRecord,
  Subscription,
  SyncEngineConfig,
  SyncEngineEvent,
} from './types';
import { CloudKitError, CloudKitErrorCode } from './errors';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Generate a UUID-like string without depending on the `crypto` global. */
function generateRecordName(): string {
  // Use crypto.randomUUID when available (Node 14.17+, browsers, Jest with
  // node test environment). Fall back to a simple pseudo-random string so the
  // mock works in any environment.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: timestamp + random suffix
  return `mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * The in-memory store surface exposed for test-side inspection and setup.
 */
export interface MockCloudKitStore {
  /**
   * Records currently held in the mock store, keyed by `recordName`.
   * Read this in tests to assert state after save / delete operations.
   */
  records: Map<string, CloudKitRecord>;
  /**
   * Inject one or more records into the mock store without going through
   * `saveRecords`. Useful for pre-populating state at the start of a test.
   *
   * @param records - Records to seed. Each must have a `recordName`.
   */
  seed(records: CloudKitRecord[]): void;
  /**
   * Clear all records and reset the internal listener list and sync-engine
   * state. Call this in `afterEach` to avoid cross-test contamination.
   */
  reset(): void;
}

/**
 * A fully in-memory implementation of the expo-cloudkit public API.
 *
 * Returned by `createMockCloudKit`. Implements the same async interface as the
 * native module so component / hook tests can run without an iCloud account or
 * a real iOS device.
 *
 * @example
 * ```typescript
 * import { createMockCloudKit } from 'expo-cloudkit/src/testing';
 *
 * jest.mock('expo-cloudkit', () => createMockCloudKit());
 *
 * test('saves a note', async () => {
 *   const mock = createMockCloudKit();
 *   await mock.saveRecords([{ recordType: 'Note', fields: { title: { type: 'string', value: 'Hi' } } }]);
 *   expect(mock.records.size).toBe(1);
 * });
 * ```
 */
export interface MockCloudKit extends MockCloudKitStore {
  /** No-op. Accepts a container ID string and returns immediately. */
  configure(containerId: string): void;
  /**
   * Always resolves with `'available'`.
   *
   * To test non-available states, replace this method on the mock instance:
   * `mock.getAccountStatus = async () => 'noAccount';`
   */
  getAccountStatus(): Promise<AccountStatus>;
  /**
   * Fetch a record by name from the in-memory store.
   *
   * @throws {CloudKitError} with code `'recordNotFound'` if the record is not present.
   */
  fetchRecord(recordName: string, zoneName?: string, database?: DatabaseScope): Promise<CloudKitRecord>;
  /**
   * Save records to the in-memory store.
   *
   * Each record without a `recordName` receives a generated UUID.
   * Returns a `SavedRecord` for every input record with server-assigned
   * timestamps and a `changeTag`.
   */
  saveRecords(records: RecordToSave[], database?: DatabaseScope): Promise<SavedRecord[]>;
  /**
   * Query records from the in-memory store by `recordType`.
   *
   * The optional `predicate` argument is accepted but ignored in the mock —
   * all records matching `recordType` are returned. Pass `zoneName` as the
   * third argument to filter by zone.
   */
  queryRecords(
    recordType: string,
    predicate?: unknown,
    zoneName?: string,
    database?: DatabaseScope,
  ): Promise<QueryResult>;
  /**
   * Delete records from the in-memory store.
   *
   * Records that do not exist are silently ignored (mirrors CloudKit's
   * batch-delete semantics where individual missing records do not cause
   * the whole operation to fail).
   */
  deleteRecords(recordIds: RecordIdentifier[], database?: DatabaseScope): Promise<void>;
  /**
   * No-op. Marks the sync engine as "started" internally so that
   * `isSyncEngineAvailable()` returns `true`.
   */
  startSyncEngine(config: SyncEngineConfig): Promise<void>;
  /**
   * No-op. Marks the sync engine as "stopped" internally.
   */
  stopSyncEngine(): Promise<void>;
  /**
   * Emit a `syncCompleted` event to all registered `addSyncEngineListener`
   * callbacks, simulating a successful sync cycle.
   *
   * Call this from tests to drive sync-dependent UI states.
   */
  triggerSync(database?: DatabaseScope): Promise<void>;
  /**
   * Register a listener for sync engine events.
   *
   * Returns a `Subscription` whose `remove()` method unregisters the listener.
   * Compatible with the same pattern used by the native module.
   */
  addSyncEngineListener(callback: (event: SyncEngineEvent) => void): Subscription;
  /**
   * Returns a snapshot of the current sync state.
   *
   * When the sync engine has not been started, returns `{}`.
   * When started, returns `{ private: { usesSyncEngine: true, status: 'idle' } }`
   * (or the configured database scope).
   */
  getSyncState(): Record<string, unknown>;
  /**
   * Returns `true` once `startSyncEngine()` has been called and before
   * `stopSyncEngine()` is called.
   */
  isSyncEngineAvailable(): boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fully in-memory CloudKit mock for use in Jest / Vitest tests.
 *
 * The mock stores records in a plain `Map` and resolves all promises
 * synchronously (via `Promise.resolve`), keeping tests fast and deterministic.
 *
 * **Import path for tests only:**
 * ```typescript
 * import { createMockCloudKit } from 'expo-cloudkit/src/testing';
 * ```
 *
 * Never import this in production application code.
 *
 * @example
 * ```typescript
 * const mock = createMockCloudKit();
 *
 * // Seed initial state
 * mock.seed([
 *   {
 *     recordName: 'note-1',
 *     recordType: 'Note',
 *     zoneName: '_defaultZone',
 *     fields: { title: { type: 'string', value: 'Hello' } },
 *   },
 * ]);
 *
 * // Exercise code under test
 * const result = await mock.queryRecords('Note');
 * expect(result.records).toHaveLength(1);
 *
 * // Reset between tests
 * mock.reset();
 * ```
 */
export function createMockCloudKit(): MockCloudKit {
  const store = new Map<string, CloudKitRecord>();
  const syncListeners: Array<(event: SyncEngineEvent) => void> = [];
  let syncEngineRunning = false;
  let activeDatabaseScope: DatabaseScope = 'private';

  // ---------------------------------------------------------------------------
  // Store helpers
  // ---------------------------------------------------------------------------

  function seed(records: CloudKitRecord[]): void {
    for (const record of records) {
      store.set(record.recordName, record);
    }
  }

  function reset(): void {
    store.clear();
    syncListeners.length = 0;
    syncEngineRunning = false;
    activeDatabaseScope = 'private';
  }

  // ---------------------------------------------------------------------------
  // API methods
  // ---------------------------------------------------------------------------

  function configure(_containerId: string): void {
    // no-op
  }

  async function getAccountStatus(): Promise<AccountStatus> {
    return Promise.resolve('available');
  }

  async function fetchRecord(
    recordName: string,
    _zoneName?: string,
    _database?: DatabaseScope,
  ): Promise<CloudKitRecord> {
    const record = store.get(recordName);
    if (!record) {
      throw new CloudKitError(
        CloudKitErrorCode.RECORD_NOT_FOUND,
        `Record not found: ${recordName}`,
      );
    }
    return Promise.resolve(record);
  }

  async function saveRecords(
    records: RecordToSave[],
    _database?: DatabaseScope,
  ): Promise<SavedRecord[]> {
    const now = Date.now();
    const saved: SavedRecord[] = [];

    for (const record of records) {
      const recordName = record.recordName ?? generateRecordName();
      const zoneName = record.zoneName ?? '_defaultZone';
      const existing = store.get(recordName);

      const cloudKitRecord: CloudKitRecord = {
        recordName,
        recordType: record.recordType,
        zoneName,
        ownerName: '__defaultOwner__',
        changeTag: now.toString(36),
        fields: record.fields,
        ...(record.encryptedFields ? { encryptedFields: record.encryptedFields } : {}),
      };
      store.set(recordName, cloudKitRecord);

      const savedRecord: SavedRecord = {
        recordName,
        recordType: record.recordType,
        zoneName,
        ownerName: '__defaultOwner__',
        creationDate: existing ? (now - 1000) : now,
        modificationDate: now,
        changeTag: now.toString(36),
        fields: record.fields,
        ...(record.encryptedFields ? { encryptedFields: record.encryptedFields } : {}),
      };
      saved.push(savedRecord);
    }

    return Promise.resolve(saved);
  }

  async function queryRecords(
    recordType: string,
    _predicate?: unknown,
    zoneName?: string,
    _database?: DatabaseScope,
  ): Promise<QueryResult> {
    const matching: CloudKitRecord[] = [];
    for (const record of store.values()) {
      if (record.recordType !== recordType) continue;
      if (zoneName !== undefined && record.zoneName !== zoneName) continue;
      matching.push(record);
    }
    return Promise.resolve({ records: matching, cursor: undefined });
  }

  async function deleteRecords(
    recordIds: RecordIdentifier[],
    _database?: DatabaseScope,
  ): Promise<void> {
    for (const id of recordIds) {
      store.delete(id.recordName);
    }
    return Promise.resolve();
  }

  async function startSyncEngine(config: SyncEngineConfig): Promise<void> {
    syncEngineRunning = true;
    const db = Array.isArray(config.databases)
      ? config.databases[0]
      : (config.databases ?? config.database ?? 'private');
    activeDatabaseScope = db as DatabaseScope;
    return Promise.resolve();
  }

  async function stopSyncEngine(): Promise<void> {
    syncEngineRunning = false;
    return Promise.resolve();
  }

  async function triggerSync(database?: DatabaseScope): Promise<void> {
    const scope = database ?? activeDatabaseScope;
    const event: SyncEngineEvent = {
      type: 'syncCompleted',
      databaseScope: scope,
      recordCount: store.size,
      zoneNames: ['_defaultZone'],
      isInitialSync: false,
    };
    for (const listener of syncListeners) {
      listener(event);
    }
    return Promise.resolve();
  }

  function addSyncEngineListener(
    callback: (event: SyncEngineEvent) => void,
  ): Subscription {
    syncListeners.push(callback);
    return {
      remove() {
        const idx = syncListeners.indexOf(callback);
        if (idx !== -1) syncListeners.splice(idx, 1);
      },
    };
  }

  function getSyncState(): Record<string, unknown> {
    if (!syncEngineRunning) return {};
    return {
      [activeDatabaseScope]: {
        usesSyncEngine: true,
        status: 'idle',
      },
    };
  }

  function isSyncEngineAvailable(): boolean {
    return syncEngineRunning;
  }

  // ---------------------------------------------------------------------------
  // Assemble and return
  // ---------------------------------------------------------------------------

  return {
    records: store,
    seed,
    reset,
    configure,
    getAccountStatus,
    fetchRecord,
    saveRecords,
    queryRecords,
    deleteRecords,
    startSyncEngine,
    stopSyncEngine,
    triggerSync,
    addSyncEngineListener,
    getSyncState,
    isSyncEngineAvailable,
  };
}
