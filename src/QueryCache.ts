/**
 * expo-cloudkit — QueryCache (internal)
 *
 * A lightweight pub/sub registry that lets active query hooks register
 * themselves so they can be invalidated by subscriptions or optimistic
 * mutations. This is NOT a full data cache — the hooks own their data via
 * useState. The QueryCache only enables cross-hook invalidation.
 *
 * One instance is created per CloudKitProvider. It is not part of the
 * public API and is not exported from index.ts.
 */

import type { CloudKitRecord } from './types';

/**
 * Registration entry for an active query hook.
 * Created inside a useEffect and cleaned up when the hook unmounts.
 */
export interface QueryCacheEntry {
  /** Unique key for this hook instance (generated via useId or useRef). */
  id: string;
  /**
   * The record type this query watches.
   * `undefined` for single-record hooks (useCloudKitRecord).
   */
  recordType: string | undefined;
  /** Trigger a full refetch of this hook's data. */
  refetch: () => void;
  /**
   * Directly patch a single record in the hook's data without refetching.
   * Used for optimistic update propagation across hooks.
   * Returns `false` if the record is not in this hook's data.
   */
  patchRecord?: (record: CloudKitRecord) => boolean;
  /**
   * Directly remove a record from the hook's data without refetching.
   * Returns `false` if the record was not found.
   */
  removeRecord?: (recordName: string) => boolean;
}

/**
 * Internal pub/sub registry created once per CloudKitProvider.
 *
 * Registered hooks receive invalidation calls from:
 * - `useCloudKitSubscription` (push notifications from CloudKit)
 * - `useCloudKitRecord.update()` (optimistic update propagation)
 * - `useCloudKitQuery.optimisticAdd()` / `optimisticRemove()` (optimistic mutation propagation)
 */
export class QueryCache {
  private readonly entries = new Map<string, QueryCacheEntry>();

  /**
   * Register an active query hook.
   *
   * Call this inside a `useEffect`. The returned function removes the entry
   * and should be used as the effect cleanup.
   *
   * @param entry - The hook's registration data.
   * @returns A cleanup function that removes the entry from the registry.
   */
  register(entry: QueryCacheEntry): () => void {
    this.entries.set(entry.id, entry);
    return () => {
      this.entries.delete(entry.id);
    };
  }

  /**
   * Triggers `refetch()` on all registered hooks watching `recordType`.
   * Called by `useCloudKitSubscription` when a matching push notification arrives.
   *
   * @param recordType - The CKRecord type to invalidate.
   */
  invalidateByRecordType(recordType: string): void {
    for (const entry of this.entries.values()) {
      if (entry.recordType === recordType) {
        entry.refetch();
      }
    }
  }

  /**
   * Triggers `refetch()` on all registered hooks regardless of record type.
   * Called for database-level subscription events.
   */
  invalidateAll(): void {
    for (const entry of this.entries.values()) {
      entry.refetch();
    }
  }

  /**
   * Notifies all registered hooks that a specific record was updated.
   *
   * Calls `patchRecord()` on each entry. This allows query hooks to update
   * a single item in their result set without a full network refetch.
   *
   * @param record - The updated CloudKitRecord to propagate.
   */
  updateRecord(record: CloudKitRecord): void {
    for (const entry of this.entries.values()) {
      if (entry.patchRecord) {
        entry.patchRecord(record);
      }
    }
  }

  /**
   * Notifies all registered hooks watching `recordType` that a record was deleted.
   *
   * Calls `removeRecord()` on each entry with matching recordType. This allows
   * query hooks to remove a single item from their result set without a refetch.
   *
   * @param recordType - The record type of the deleted record.
   * @param recordName - The recordName of the deleted record.
   */
  removeRecord(recordType: string, recordName: string): void {
    for (const entry of this.entries.values()) {
      if (entry.recordType === recordType && entry.removeRecord) {
        entry.removeRecord(recordName);
      }
    }
  }
}
