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

import { useState, useEffect, useCallback, useRef, useId } from 'react';

import { useCloudKitContext } from './CloudKitProvider';
import { CloudKitError } from './errors';
import {
  fetchRecord,
  queryRecords,
  saveRecords,
  deleteRecords,
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
  OptimisticStatus,
  PendingRecordChange,
  QueryPredicate,
  RecordField,
  RecordsFetchedEvent,
  RecordsSentEvent,
  RecordToSave,
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

  /**
   * Optimistically updates the record's fields in local state, then persists
   * to CloudKit via `saveRecords()`. On error, rolls back to the previous
   * local state and sets `optimisticError`.
   *
   * Only the provided fields are merged — omitted fields are untouched.
   * Requires `data` to be loaded (`data !== undefined`).
   *
   * @returns The saved record on success, or `undefined` on failure.
   */
  update: (fields: Record<string, RecordField>) => Promise<CloudKitRecord | undefined>;

  /** Current optimistic update status. */
  optimisticStatus: OptimisticStatus;

  /**
   * Error from the most recent failed optimistic update.
   * Cleared on the next successful update or refetch.
   */
  optimisticError: CloudKitError | undefined;
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
  const { recordType, zoneName, enabled = true, subscribe = false } = options;

  const context = useCloudKitContext();
  const database = options.database ?? context?.defaultDatabase ?? 'private';

  const [state, setState] = useState<CloudKitHookState<CloudKitRecord>>(inertRecordState);
  const versionRef = useRef(0);
  const hasDataRef = useRef(false);

  // Phase D: optimistic update state
  const [optimisticStatus, setOptimisticStatus] = useState<OptimisticStatus>('idle');
  const [optimisticError, setOptimisticError] = useState<CloudKitError | undefined>(undefined);

  // Phase D: stable unique ID for cache registration
  const hookId = useId();

  const refetch = useCallback(async (): Promise<CloudKitRecord | undefined> => {
    if (!recordName || !enabled) return undefined;

    // Reset optimistic state on refetch
    setOptimisticStatus('idle');
    setOptimisticError(undefined);

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

  // Phase D: register in QueryCache so cross-hook updates can patch this record
  useEffect(() => {
    const queryCache = context?.queryCache;
    if (!queryCache || !recordName || !enabled) return;

    const unregister = queryCache.register({
      id: hookId,
      recordType: undefined, // single-record hooks don't watch a type
      refetch: () => { void refetch(); },
      patchRecord: (record: CloudKitRecord) => {
        if (record.recordName !== recordName) return false;
        setState((prev) => ({ ...prev, data: record }));
        return true;
      },
    });

    return unregister;
  }, [hookId, recordName, enabled, context, refetch]);

  // Phase D: optimistic update method
  const update = useCallback(async (
    fields: Record<string, RecordField>
  ): Promise<CloudKitRecord | undefined> => {
    if (!state.data) return undefined;

    const previousData = state.data;
    const mergedFields = { ...previousData.fields, ...fields };

    // 1. Optimistic: update local state immediately
    setState((prev) => ({
      ...prev,
      data: { ...previousData, fields: mergedFields },
    }));
    setOptimisticStatus('pending');
    setOptimisticError(undefined);

    try {
      // 2. Persist to CloudKit
      const recordToSave: RecordToSave = {
        recordType: previousData.recordType,
        recordName: previousData.recordName,
        zoneName: previousData.zoneName,
        changeTag: previousData.changeTag ?? undefined,
        fields: mergedFields,
      };
      const [saved] = await saveRecords([recordToSave], database);

      // 3. Commit: replace local data with server response (has updated changeTag)
      const committed: CloudKitRecord = {
        ...previousData,
        ...saved,
        fields: saved.fields,
      };
      setState((prev) => ({
        ...prev,
        data: committed,
      }));
      setOptimisticStatus('committed');

      // Propagate to other hooks via QueryCache
      context?.queryCache.updateRecord(committed);

      return committed;
    } catch (err) {
      // 4. Rollback: restore previous data
      setState((prev) => ({
        ...prev,
        data: previousData,
      }));
      const cloudKitError =
        err instanceof CloudKitError ? err : CloudKitError.fromNativeError(err);
      setOptimisticError(cloudKitError);
      setOptimisticStatus('rolled-back');
      return undefined;
    }
  }, [state.data, database, context]);

  return {
    data: state.data,
    loading: state.loading,
    fetching: state.fetching,
    error: state.error,
    refetch,
    update,
    optimisticStatus,
    optimisticError,
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

  /**
   * Optimistically prepends a record to the local result set, then saves it
   * to CloudKit. On failure, removes it from the local set.
   *
   * If no `recordName` is provided, a temporary ID is assigned locally and
   * replaced with the server-assigned name on commit.
   *
   * @returns The saved record on success, or `undefined` on failure.
   */
  optimisticAdd: (record: RecordToSave) => Promise<CloudKitRecord | undefined>;

  /**
   * Optimistically removes a record from the local result set, then deletes
   * it from CloudKit. On failure, restores it to its original position.
   *
   * @returns `true` on success, `false` on failure (record is restored).
   */
  optimisticRemove: (recordName: string) => Promise<boolean>;

  /**
   * Number of records currently in a pending optimistic state (being saved or deleted).
   * `0` means all displayed records are committed.
   */
  pendingCount: number;

  /**
   * Set of recordNames currently in a pending optimistic state.
   * Use this to render per-record "saving..." indicators.
   */
  pendingRecordNames: ReadonlySet<string>;

  /**
   * Errors from failed optimistic operations, keyed by recordName.
   * Cleared on the next successful operation or refetch.
   */
  optimisticErrors: ReadonlyMap<string, CloudKitError>;
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
    resultsLimit = 100,
    enabled = true,
    subscribe = false,
  } = options ?? {};

  const context = useCloudKitContext();
  const database = options?.database ?? context?.defaultDatabase ?? 'private';

  const [state, setState] = useState<CloudKitHookState<CloudKitRecord[]>>(inertQueryState);
  const [hasMore, setHasMore] = useState(false);
  const versionRef = useRef(0);
  const hasDataRef = useRef(false);
  const cursorRef = useRef<string | undefined>(undefined);

  // Phase D: optimistic state
  const [pendingRecordNames, setPendingRecordNames] = useState<ReadonlySet<string>>(new Set());
  const [optimisticErrors, setOptimisticErrors] = useState<ReadonlyMap<string, CloudKitError>>(new Map());

  // Phase D: stable unique ID for cache registration
  const hookId = useId();

  // Stable JSON strings for effect dependency arrays so callers need not memoize
  const predicateJson = JSON.stringify(predicate);
  const sortDescriptorsJson = JSON.stringify(sortDescriptors);

  const refetch = useCallback(async (): Promise<CloudKitRecord[] | undefined> => {
    if (!recordType || !enabled) return undefined;

    // Reset optimistic state on refetch so stale errors don't persist
    setPendingRecordNames(new Set());
    setOptimisticErrors(new Map());

    cursorRef.current = undefined;
    const version = ++versionRef.current;
    setState((prev) => ({ ...prev, fetching: true, error: undefined }));

    try {
      const result = await queryRecords(
        recordType,
        predicate,
        sortDescriptors,
        zoneName,
        database,
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
        database,
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
      database,
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

  // Phase D: register in QueryCache for cross-hook invalidation and patching
  useEffect(() => {
    const queryCache = context?.queryCache;
    if (!queryCache || !recordType || !enabled) return;

    const unregister = queryCache.register({
      id: hookId,
      recordType,
      refetch: () => { void refetch(); },
      patchRecord: (record: CloudKitRecord) => {
        if (record.recordType !== recordType) return false;
        let found = false;
        setState((prev) => {
          if (!prev.data) return prev;
          const idx = prev.data.findIndex((r) => r.recordName === record.recordName);
          if (idx === -1) return prev;
          found = true;
          const updated = [...prev.data];
          updated[idx] = record;
          return { ...prev, data: updated };
        });
        return found;
      },
      removeRecord: (recordName: string) => {
        let found = false;
        setState((prev) => {
          if (!prev.data) return prev;
          const idx = prev.data.findIndex((r) => r.recordName === recordName);
          if (idx === -1) return prev;
          found = true;
          return { ...prev, data: prev.data.filter((r) => r.recordName !== recordName) };
        });
        return found;
      },
    });

    return unregister;
  }, [hookId, recordType, enabled, context, refetch]);

  // Phase D: optimisticAdd
  const optimisticAdd = useCallback(async (
    record: RecordToSave
  ): Promise<CloudKitRecord | undefined> => {
    if (!recordType) return undefined;

    // 1. Assign temp recordName if not provided
    const tempName = record.recordName ?? `__temp_${Math.random().toString(36).slice(2)}`;

    // 2. Build a temporary CloudKitRecord
    const tempRecord: CloudKitRecord = {
      recordType: record.recordType,
      recordName: tempName,
      zoneName: record.zoneName ?? '',
      ownerName: '',
      modificationDate: null,
      creationDate: null,
      changeTag: null,
      fields: record.fields,
    };

    // 3. Optimistically prepend to local state
    setState((prev) => ({
      ...prev,
      data: [tempRecord, ...(prev.data ?? [])],
    }));
    setPendingRecordNames((prev) => new Set([...prev, tempName]));

    try {
      // 4. Save to CloudKit
      const [saved] = await saveRecords([{ ...record, recordName: tempName }], database);

      // 5. Replace temp record with server response
      setState((prev) => ({
        ...prev,
        data: prev.data?.map((r) => r.recordName === tempName ? saved : r),
      }));
      setPendingRecordNames((prev) => {
        const next = new Set(prev);
        next.delete(tempName);
        return next;
      });

      // Propagate to other hooks
      context?.queryCache.updateRecord(saved);

      return saved;
    } catch (err) {
      // 6. Rollback: remove temp record
      setState((prev) => ({
        ...prev,
        data: (prev.data ?? []).filter((r) => r.recordName !== tempName),
      }));
      setPendingRecordNames((prev) => {
        const next = new Set(prev);
        next.delete(tempName);
        return next;
      });
      const cloudKitError =
        err instanceof CloudKitError ? err : CloudKitError.fromNativeError(err);
      setOptimisticErrors((prev) => new Map([...prev, [tempName, cloudKitError]]));
      return undefined;
    }
  }, [recordType, database, context]);

  // Phase D: optimisticRemove
  const optimisticRemove = useCallback(async (
    recordName: string
  ): Promise<boolean> => {
    const current = state.data;
    if (!current) return false;

    const removedIndex = current.findIndex((r) => r.recordName === recordName);
    if (removedIndex === -1) return false;
    const removedRecord = current[removedIndex];

    // Optimistically remove from local state
    setState((prev) => ({
      ...prev,
      data: prev.data?.filter((r) => r.recordName !== recordName),
    }));
    setPendingRecordNames((prev) => new Set([...prev, recordName]));

    try {
      await deleteRecords([{ recordName, zoneName: removedRecord.zoneName || undefined }], database);
      setPendingRecordNames((prev) => {
        const next = new Set(prev);
        next.delete(recordName);
        return next;
      });
      if (recordType) {
        context?.queryCache.removeRecord(recordType, recordName);
      }
      return true;
    } catch (err) {
      // Restore record at its original position
      setState((prev) => {
        const updated = [...(prev.data ?? [])];
        updated.splice(removedIndex, 0, removedRecord);
        return { ...prev, data: updated };
      });
      setPendingRecordNames((prev) => {
        const next = new Set(prev);
        next.delete(recordName);
        return next;
      });
      const cloudKitError = err instanceof CloudKitError ? err : CloudKitError.fromNativeError(err);
      setOptimisticErrors((prev) => new Map([...prev, [recordName, cloudKitError]]));
      return false;
    }
  }, [state.data, database, recordType, context]);

  return {
    data: state.data,
    loading: state.loading,
    fetching: state.fetching,
    error: state.error,
    refetch,
    fetchMore,
    hasMore,
    optimisticAdd,
    optimisticRemove,
    pendingCount: pendingRecordNames.size,
    pendingRecordNames,
    optimisticErrors,
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
/** Extracts the `SyncState` for a single scope from the new `SyncStateMap`. */
const notStartedState: SyncState = { usesSyncEngine: false, status: 'notStarted' };
function getScopeState(scope: DatabaseScope): SyncState {
  const map = getSyncState();
  return map[scope] ?? notStartedState;
}

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

  const scope: DatabaseScope = database ?? 'private';

  // Initialize synchronously — getScopeState() reads in-memory state without I/O
  const [syncState, setSyncState] = useState<SyncState>(() => getScopeState(scope));
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
      void stopSyncEngine(scope).catch(() => {
        // Ignore SYNC_ENGINE_NOT_RUNNING — it was already stopped
      });
      setSyncState(getScopeState(scope));
      return;
    }

    setError(undefined);

    void startSyncEngine({ zones, database, automaticallySync }).catch((err: unknown) => {
      const cloudKitError =
        err instanceof CloudKitError ? err : CloudKitError.fromNativeError(err);
      setError(cloudKitError);
    });

    // Refresh state snapshot after starting
    setSyncState(getScopeState(scope));

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
          const syncError = CloudKitError.fromNativeError(event.error);
          setError(syncError);
          onSyncErrorRef.current?.(event);
          break;
        }
      }
    });

    return () => {
      subscription.remove();
      void stopSyncEngine(scope).catch(() => {
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
