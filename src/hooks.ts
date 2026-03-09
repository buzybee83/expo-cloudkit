/**
 * expo-cloudkit — React Hooks (Phase C)
 *
 * Provides idiomatic React hooks for the three main CloudKit access patterns:
 *   - `useCloudKitRecord`  — fetch and subscribe to a single record
 *   - `useCloudKitQuery`   — query records with predicates, sorting, and pagination
 *   - `useCloudKitSync`    — manage the CKSyncEngine lifecycle
 *
 * All hooks handle loading/error/refetch states, stale fetch guards, and
 * listener cleanup on unmount.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

import { CloudKitError } from './errors';
import {
  fetchRecord,
  queryRecords,
  startSyncEngine,
  getSyncState,
  stopSyncEngine,
  triggerSync as imperativeTriggerSync,
  enqueuePendingChange as imperativeEnqueuePendingChange,
  addSyncEngineListener,
  addSubscriptionListener,
} from './ExpoCloudKit';
import type {
  CloudKitRecord,
  DatabaseScope,
  PendingRecordChange,
  QueryPredicate,
  RecordsFetchedEvent,
  RecordsSentEvent,
  SortDescriptor,
  SyncErrorEvent,
  SyncState,
  SubscriptionEvent,
} from './types';

// ---------------------------------------------------------------------------
// Shared internal type
// ---------------------------------------------------------------------------

/**
 * Common loading/fetching/error envelope returned by data-fetching hooks.
 *
 * - `loading`  — `true` only on the initial fetch (before `data` has ever been set).
 * - `fetching` — `true` during any in-flight fetch, including re-fetches.
 * - `error`    — set when the most recent fetch failed; previous `data` is preserved.
 */
export interface CloudKitHookState<T> {
  /** The most recently fetched data, or `undefined` before the first successful fetch. */
  data: T | undefined;
  /** `true` only on the initial fetch, before `data` has ever been populated. */
  loading: boolean;
  /** `true` during any in-flight fetch (initial or refetch). */
  fetching: boolean;
  /** The error from the most recent failed fetch. `undefined` when healthy. */
  error: CloudKitError | undefined;
}

// ---------------------------------------------------------------------------
// Hook 1: useCloudKitRecord
// ---------------------------------------------------------------------------

/**
 * Options for `useCloudKitRecord`.
 */
export interface UseCloudKitRecordOptions {
  /** CKRecord.recordType string — required to resolve the native fetch. */
  recordType: string;
  /** Zone the record lives in. Omit for the default zone. */
  zoneName?: string;
  /** Database to query. Default: `'private'`. */
  database?: DatabaseScope;
  /**
   * When `false`, the hook does not fetch and returns an inert state.
   * Default: `true`.
   */
  enabled?: boolean;
  /**
   * When `true`, register a subscription listener and call `refetch()`
   * whenever an event matching `recordName` arrives.
   * Default: `false`.
   */
  subscribe?: boolean;
}

/**
 * Return value of `useCloudKitRecord`.
 */
export interface UseCloudKitRecordReturn extends CloudKitHookState<CloudKitRecord> {
  /**
   * Manually trigger a re-fetch.
   * Sets `fetching: true`, fetches, updates state, and returns the record or
   * `undefined` if the fetch fails.
   */
  refetch: () => Promise<CloudKitRecord | undefined>;
}

const inertRecordState: CloudKitHookState<CloudKitRecord> = {
  data: undefined,
  loading: false,
  fetching: false,
  error: undefined,
};

/**
 * Fetches a single CloudKit record by ID and keeps it up to date.
 *
 * Calls `fetchRecord(recordType, recordName, zoneName, database)` on mount
 * and whenever `recordName`, `recordType`, `zoneName`, or `database` change.
 * When `subscribe` is `true`, registers a push subscription listener and
 * calls `refetch()` when a matching event arrives.
 *
 * Preserves previous `data` on refetch errors (stale-while-revalidate).
 * Uses a version counter to discard results from superseded fetches.
 *
 * @param recordName - The CKRecord.ID.recordName to fetch. Pass `undefined` to suspend fetching.
 * @param options    - Record type, zone, database, enable flag, and subscription toggle.
 *
 * @example
 * ```typescript
 * const { data, loading, error, refetch } = useCloudKitRecord('abc-123', {
 *   recordType: 'Note',
 *   zoneName: 'MyZone',
 *   subscribe: true,
 * });
 * ```
 */
export function useCloudKitRecord(
  recordName: string | undefined,
  options: UseCloudKitRecordOptions
): UseCloudKitRecordReturn {
  const { recordType, zoneName, database, enabled = true, subscribe = false } = options;

  const [state, setState] = useState<CloudKitHookState<CloudKitRecord>>(inertRecordState);
  const versionRef = useRef(0);
  const hasDataRef = useRef(false);

  const refetch = useCallback(async (): Promise<CloudKitRecord | undefined> => {
    if (!recordName || !enabled) return undefined;

    const version = ++versionRef.current;
    setState((prev) => ({ ...prev, fetching: true, error: undefined }));

    try {
      const record = await fetchRecord(recordType, recordName, zoneName, database);
      if (versionRef.current !== version) return undefined;
      hasDataRef.current = true;
      setState({ data: record, loading: false, fetching: false, error: undefined });
      return record;
    } catch (err) {
      if (versionRef.current !== version) return undefined;
      const cloudKitError =
        err instanceof CloudKitError ? err : CloudKitError.fromNativeError(err);
      setState((prev) => ({
        ...prev,
        fetching: false,
        loading: false,
        error: cloudKitError,
      }));
      return undefined;
    }
  }, [recordName, recordType, zoneName, database, enabled]);

  // Initial fetch (and re-fetch on key changes)
  useEffect(() => {
    if (!recordName || !enabled) {
      // Cancel any in-flight fetch and return to inert state
      versionRef.current++;
      hasDataRef.current = false;
      setState(inertRecordState);
      return;
    }

    // Show loading spinner only before data has ever arrived
    setState((prev) => ({
      ...prev,
      loading: !hasDataRef.current,
      fetching: true,
      error: undefined,
    }));

    const version = ++versionRef.current;

    fetchRecord(recordType, recordName, zoneName, database)
      .then((record) => {
        if (versionRef.current !== version) return;
        hasDataRef.current = true;
        setState({ data: record, loading: false, fetching: false, error: undefined });
      })
      .catch((err: unknown) => {
        if (versionRef.current !== version) return;
        const cloudKitError =
          err instanceof CloudKitError ? err : CloudKitError.fromNativeError(err);
        setState((prev) => ({
          ...prev,
          loading: false,
          fetching: false,
          error: cloudKitError,
        }));
      });
  }, [recordName, recordType, zoneName, database, enabled]);

  // Subscription listener
  useEffect(() => {
    if (!subscribe || !recordName || !enabled) return;

    const subscription = addSubscriptionListener((event: SubscriptionEvent) => {
      if (event.type === 'query' && event.recordID === recordName) {
        void refetch();
      }
    });

    return () => {
      subscription.remove();
    };
  }, [subscribe, recordName, enabled, refetch]);

  return {
    data: state.data,
    loading: state.loading,
    fetching: state.fetching,
    error: state.error,
    refetch,
  };
}

// ---------------------------------------------------------------------------
// Hook 2: useCloudKitQuery
// ---------------------------------------------------------------------------

/**
 * Options for `useCloudKitQuery`.
 */
export interface UseCloudKitQueryOptions {
  /** Optional filter predicate — maps to NSPredicate format. */
  predicate?: QueryPredicate;
  /** Sort descriptors applied server-side. */
  sortDescriptors?: SortDescriptor[];
  /** Zone to query. Omit for the default zone. */
  zoneName?: string;
  /** Database to query. Default: `'private'`. */
  database?: DatabaseScope;
  /** Maximum records to return per page. Default: `100`. */
  resultsLimit?: number;
  /**
   * When `false`, the hook does not fetch and returns an inert state.
   * Default: `true`.
   */
  enabled?: boolean;
  /**
   * When `true`, register a subscription listener and call `refetch()` on any
   * matching event. Default: `false`.
   */
  subscribe?: boolean;
}

/**
 * Return value of `useCloudKitQuery`.
 */
export interface UseCloudKitQueryReturn extends CloudKitHookState<CloudKitRecord[]> {
  /**
   * Re-fetches the query from the beginning, replacing `data`.
   * Resets cursor state.
   */
  refetch: () => Promise<CloudKitRecord[] | undefined>;
  /**
   * Fetches the next page of results and appends them to `data`.
   * No-op when `hasMore` is `false`.
   */
  fetchMore: () => Promise<void>;
  /** `true` when the server has more pages available. */
  hasMore: boolean;
}

const inertQueryState: CloudKitHookState<CloudKitRecord[]> = {
  data: undefined,
  loading: false,
  fetching: false,
  error: undefined,
};

/**
 * Queries CloudKit records with predicates, sorting, and cursor-based pagination.
 *
 * On mount, calls `queryRecords(recordType, predicate, sortDescriptors, zoneName,
 * database, resultsLimit)`. Uses `JSON.stringify` on `predicate` and
 * `sortDescriptors` in the dependency array — callers do not need to memoize them.
 *
 * When `subscribe` is `true`, registers a push subscription listener and calls
 * `refetch()` on any matching event.
 *
 * Preserves previous `data` on refetch errors (stale-while-revalidate).
 *
 * @param recordType - The CKRecord.recordType to query. Pass `undefined` to suspend.
 * @param options    - Predicate, sort, zone, database, page size, enable, subscribe.
 *
 * @example
 * ```typescript
 * const { data, loading, hasMore, fetchMore, refetch } = useCloudKitQuery('Note', {
 *   predicate: { field: 'archived', comparator: '=', value: false },
 *   sortDescriptors: [{ field: 'createdAt', ascending: false }],
 *   zoneName: 'MyZone',
 *   resultsLimit: 25,
 * });
 * ```
 */
export function useCloudKitQuery(
  recordType: string | undefined,
  options?: UseCloudKitQueryOptions
): UseCloudKitQueryReturn {
  const {
    predicate,
    sortDescriptors,
    zoneName,
    database,
    resultsLimit = 100,
    enabled = true,
    subscribe = false,
  } = options ?? {};

  const [state, setState] = useState<CloudKitHookState<CloudKitRecord[]>>(inertQueryState);
  const [hasMore, setHasMore] = useState(false);
  const versionRef = useRef(0);
  const hasDataRef = useRef(false);
  const cursorRef = useRef<string | undefined>(undefined);

  // Stable JSON strings for effect dependency arrays so callers need not memoize
  const predicateJson = JSON.stringify(predicate);
  const sortDescriptorsJson = JSON.stringify(sortDescriptors);

  const refetch = useCallback(async (): Promise<CloudKitRecord[] | undefined> => {
    if (!recordType || !enabled) return undefined;

    cursorRef.current = undefined;
    const version = ++versionRef.current;
    setState((prev) => ({ ...prev, fetching: true, error: undefined }));

    try {
      const result = await queryRecords(
        recordType,
        predicate,
        sortDescriptors,
        zoneName,
        database ?? 'private',
        resultsLimit,
        undefined
      );
      if (versionRef.current !== version) return undefined;
      hasDataRef.current = true;
      cursorRef.current = result.cursor;
      setHasMore(result.cursor !== undefined);
      setState({ data: result.records, loading: false, fetching: false, error: undefined });
      return result.records;
    } catch (err) {
      if (versionRef.current !== version) return undefined;
      const cloudKitError =
        err instanceof CloudKitError ? err : CloudKitError.fromNativeError(err);
      setState((prev) => ({
        ...prev,
        loading: false,
        fetching: false,
        error: cloudKitError,
      }));
      return undefined;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordType, predicateJson, sortDescriptorsJson, zoneName, database, resultsLimit, enabled]);

  const fetchMore = useCallback(async (): Promise<void> => {
    if (!recordType || !enabled || !hasMore || cursorRef.current === undefined) return;

    const version = ++versionRef.current;
    setState((prev) => ({ ...prev, fetching: true, error: undefined }));

    try {
      const result = await queryRecords(
        recordType,
        predicate,
        sortDescriptors,
        zoneName,
        database ?? 'private',
        resultsLimit,
        cursorRef.current
      );
      if (versionRef.current !== version) return;
      cursorRef.current = result.cursor;
      setHasMore(result.cursor !== undefined);
      setState((prev) => ({
        data: [...(prev.data ?? []), ...result.records],
        loading: false,
        fetching: false,
        error: undefined,
      }));
    } catch (err) {
      if (versionRef.current !== version) return;
      const cloudKitError =
        err instanceof CloudKitError ? err : CloudKitError.fromNativeError(err);
      setState((prev) => ({
        ...prev,
        loading: false,
        fetching: false,
        error: cloudKitError,
      }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordType, predicateJson, sortDescriptorsJson, zoneName, database, resultsLimit, enabled, hasMore]);

  // Initial fetch (and re-fetch on key changes)
  useEffect(() => {
    if (!recordType || !enabled) {
      versionRef.current++;
      hasDataRef.current = false;
      cursorRef.current = undefined;
      setHasMore(false);
      setState(inertQueryState);
      return;
    }

    setState((prev) => ({
      ...prev,
      loading: !hasDataRef.current,
      fetching: true,
      error: undefined,
    }));

    cursorRef.current = undefined;
    const version = ++versionRef.current;

    queryRecords(
      recordType,
      predicate,
      sortDescriptors,
      zoneName,
      database ?? 'private',
      resultsLimit,
      undefined
    )
      .then((result) => {
        if (versionRef.current !== version) return;
        hasDataRef.current = true;
        cursorRef.current = result.cursor;
        setHasMore(result.cursor !== undefined);
        setState({ data: result.records, loading: false, fetching: false, error: undefined });
      })
      .catch((err: unknown) => {
        if (versionRef.current !== version) return;
        const cloudKitError =
          err instanceof CloudKitError ? err : CloudKitError.fromNativeError(err);
        setState((prev) => ({
          ...prev,
          loading: false,
          fetching: false,
          error: cloudKitError,
        }));
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordType, predicateJson, sortDescriptorsJson, zoneName, database, resultsLimit, enabled]);

  // Subscription listener
  useEffect(() => {
    if (!subscribe || !recordType || !enabled) return;

    const subscription = addSubscriptionListener(() => {
      void refetch();
    });

    return () => {
      subscription.remove();
    };
  }, [subscribe, recordType, enabled, refetch]);

  return {
    data: state.data,
    loading: state.loading,
    fetching: state.fetching,
    error: state.error,
    refetch,
    fetchMore,
    hasMore,
  };
}

// ---------------------------------------------------------------------------
// Hook 3: useCloudKitSync
// ---------------------------------------------------------------------------

/**
 * Options for `useCloudKitSync`.
 */
export interface UseCloudKitSyncOptions {
  /** Zone names the sync engine should track. */
  zones: string[];
  /** Database to sync. Default: `'private'`. */
  database?: DatabaseScope;
  /**
   * Whether the engine should schedule syncs automatically.
   * On iOS 17+, delegates to CKSyncEngine's built-in scheduler.
   * On iOS 16, starts a polling timer.
   * Default: `true`.
   */
  automaticallySync?: boolean;
  /**
   * When `false`, the sync engine is not started and the hook returns an inert state.
   * When flipped from `false` to `true`, the engine is started.
   * When flipped from `true` to `false`, the engine is stopped.
   * Default: `true`.
   */
  enabled?: boolean;
  /** Called when records are fetched from the server. */
  onRecordsFetched?: (event: RecordsFetchedEvent) => void;
  /** Called when local changes are successfully pushed to the server. */
  onRecordsSent?: (event: RecordsSentEvent) => void;
  /** Called when an unrecoverable sync error occurs. */
  onSyncError?: (event: SyncErrorEvent) => void;
}

/**
 * Return value of `useCloudKitSync`.
 */
export interface UseCloudKitSyncReturn {
  /** Current sync provider state snapshot. */
  state: SyncState;
  /** `true` when the sync engine has been started (`state.status !== 'notStarted'`). */
  isRunning: boolean;
  /** Manually trigger a sync cycle. Catches errors into `error`. */
  triggerSync: () => Promise<void>;
  /** Queue a record change for the engine to process on its next cycle. */
  enqueuePendingChange: (change: PendingRecordChange) => void;
  /** The most recent unrecoverable sync error, if any. */
  error: CloudKitError | undefined;
}

/**
 * Manages the CKSyncEngine lifecycle inside a React component.
 *
 * Calls `startSyncEngine({ zones, database, automaticallySync })` on mount
 * (when `enabled` is `true`). Registers an `addSyncEngineListener` to keep
 * `state` current and forward sub-events to `onRecordsFetched`, `onRecordsSent`,
 * and `onSyncError`. Calls `stopSyncEngine()` on unmount.
 *
 * `isRunning` is derived: `state.status !== 'notStarted'`.
 * `triggerSync` and `enqueuePendingChange` are stable imperative escapes.
 *
 * Uses `JSON.stringify(options.zones)` in the dependency array — callers do
 * not need to memoize the `zones` array.
 *
 * @param options - Zones, database, scheduling, enable flag, and event callbacks.
 *
 * @example
 * ```typescript
 * const { state, isRunning, triggerSync } = useCloudKitSync({
 *   zones: ['MyZone'],
 *   onRecordsFetched: (event) => applyChanges(event.changedRecords),
 * });
 * ```
 */
export function useCloudKitSync(options: UseCloudKitSyncOptions): UseCloudKitSyncReturn {
  const {
    zones,
    database,
    automaticallySync,
    enabled = true,
    onRecordsFetched,
    onRecordsSent,
    onSyncError,
  } = options;

  // Initialize synchronously — getSyncState() reads in-memory state without I/O
  const [syncState, setSyncState] = useState<SyncState>(() => getSyncState());
  const [error, setError] = useState<CloudKitError | undefined>(undefined);

  const zonesJson = JSON.stringify(zones);

  // Stable refs for callbacks so we don't need to restart the engine on change
  const onRecordsFetchedRef = useRef(onRecordsFetched);
  const onRecordsSentRef = useRef(onRecordsSent);
  const onSyncErrorRef = useRef(onSyncError);

  useEffect(() => { onRecordsFetchedRef.current = onRecordsFetched; }, [onRecordsFetched]);
  useEffect(() => { onRecordsSentRef.current = onRecordsSent; }, [onRecordsSent]);
  useEffect(() => { onSyncErrorRef.current = onSyncError; }, [onSyncError]);

  // Engine lifecycle: start on mount, stop on unmount or when enabled flips false
  useEffect(() => {
    if (!enabled) {
      // Stop if already running
      void stopSyncEngine().catch(() => {
        // Ignore SYNC_ENGINE_NOT_RUNNING — it was already stopped
      });
      setSyncState(getSyncState());
      return;
    }

    setError(undefined);

    void startSyncEngine({ zones, database, automaticallySync }).catch((err: unknown) => {
      const cloudKitError =
        err instanceof CloudKitError ? err : CloudKitError.fromNativeError(err);
      setError(cloudKitError);
    });

    // Refresh state snapshot after starting
    setSyncState(getSyncState());

    const subscription = addSyncEngineListener((event) => {
      switch (event.type) {
        case 'stateChanged':
          setSyncState(event.state);
          break;
        case 'recordsFetched':
          onRecordsFetchedRef.current?.(event);
          break;
        case 'recordsSent':
          onRecordsSentRef.current?.(event);
          break;
        case 'syncError': {
          const syncError = new CloudKitError(
            CloudKitError.fromNativeError({ code: event.error.code, message: event.error.message }).code,
            event.error.message
          );
          setError(syncError);
          onSyncErrorRef.current?.(event);
          break;
        }
      }
    });

    return () => {
      subscription.remove();
      void stopSyncEngine().catch(() => {
        // Ignore SYNC_ENGINE_NOT_RUNNING — already stopped
      });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, zonesJson, database, automaticallySync]);

  const triggerSync = useCallback(async (): Promise<void> => {
    try {
      await imperativeTriggerSync();
    } catch (err) {
      const cloudKitError =
        err instanceof CloudKitError ? err : CloudKitError.fromNativeError(err);
      setError(cloudKitError);
    }
  }, []);

  const enqueuePendingChange = useCallback((change: PendingRecordChange): void => {
    imperativeEnqueuePendingChange(change);
  }, []);

  return {
    state: syncState,
    isRunning: syncState.status !== 'notStarted',
    triggerSync,
    enqueuePendingChange,
    error,
  };
}
