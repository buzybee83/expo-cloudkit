/**
 * expo-cloudkit — useCloudKitSubscription
 *
 * Hook that manages the full lifecycle of a CKQuerySubscription:
 *   - Creates the subscription on mount (when enabled=true)
 *   - Registers a listener filtered to this subscription's ID
 *   - Invalidates the QueryCache when a matching push notification arrives
 *   - Deletes the subscription and removes the listener on unmount
 *
 * Works without a CloudKitProvider — cache invalidation is simply skipped
 * and the onNotification callback still fires.
 */

import { useState, useEffect, useRef } from 'react';

import { useCloudKitContext } from './CloudKitProvider';
import { CloudKitError } from './errors';
import {
  saveQuerySubscription,
  deleteSubscription,
  addSubscriptionListener,
} from './ExpoCloudKit';
import type {
  DatabaseScope,
  QueryPredicate,
  QuerySubscriptionEvent,
  SubscriptionEvent,
} from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for `useCloudKitSubscription`.
 */
export interface UseCloudKitSubscriptionOptions {
  /**
   * Optional predicate filter for the subscription.
   * Maps to a CKQuerySubscription predicate. Omit to match all records.
   */
  predicate?: QueryPredicate;

  /** Zone to scope the subscription to. Omit for the default zone. */
  zoneName?: string;

  /**
   * Database scope. Falls back to the Provider's `defaultDatabase`, then `'private'`.
   */
  database?: DatabaseScope;

  /** Fires on record creation. Default: `true`. */
  firesOnCreation?: boolean;

  /** Fires on record update. Default: `true`. */
  firesOnUpdate?: boolean;

  /** Fires on record deletion. Default: `true`. */
  firesOnDeletion?: boolean;

  /**
   * When `false`, the subscription is not created. Allows conditional activation.
   * Default: `true`.
   */
  enabled?: boolean;

  /**
   * Called when a matching push notification arrives.
   * Fires AFTER any automatic QueryCache invalidation.
   */
  onNotification?: (event: QuerySubscriptionEvent) => void;
}

/**
 * Return value of `useCloudKitSubscription`.
 */
export interface UseCloudKitSubscriptionReturn {
  /**
   * The CloudKit-assigned subscription ID, or `undefined` if not yet created
   * or if `enabled` is `false`.
   */
  subscriptionId: string | undefined;

  /** `true` while the subscription is being saved to or deleted from CloudKit. */
  loading: boolean;

  /** Error from the most recent save or delete attempt. */
  error: CloudKitError | undefined;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of a CKQuerySubscription for a given record type.
 *
 * On mount (when `enabled` is `true`):
 * 1. Calls `saveQuerySubscription()` to register the subscription with CloudKit.
 * 2. Stores the returned `subscriptionId`.
 * 3. Registers an `addSubscriptionListener` filtered by `subscriptionId`.
 * 4. On a matching event: invalidates all `useCloudKitQuery` hooks with the
 *    same `recordType` via `queryCache.invalidateByRecordType()`, then calls
 *    `onNotification` if provided.
 *
 * On unmount: deletes the subscription and removes the listener (fire-and-forget).
 *
 * When `recordType` or `predicate` changes: deletes the old subscription and
 * creates a new one.
 *
 * When `enabled` flips `false`: deletes the subscription and sets
 * `subscriptionId` to `undefined`.
 *
 * Without a `<CloudKitProvider>`, cache invalidation is skipped but the
 * subscription lifecycle and `onNotification` callback still work.
 *
 * @param recordType - The CKRecord type to monitor.
 * @param options    - Predicate, zone, database, trigger flags, enable flag, and callback.
 *
 * @example
 * ```tsx
 * useCloudKitSubscription('Note', {
 *   zoneName: 'MyZone',
 *   onNotification: (event) => console.log('Note changed:', event.notificationType),
 * });
 * ```
 */
export function useCloudKitSubscription(
  recordType: string,
  options?: UseCloudKitSubscriptionOptions
): UseCloudKitSubscriptionReturn {
  const {
    predicate,
    zoneName,
    database,
    firesOnCreation = true,
    firesOnUpdate = true,
    firesOnDeletion = true,
    enabled = true,
    onNotification,
  } = options ?? {};

  const context = useCloudKitContext();
  const effectiveDatabase = database ?? context?.defaultDatabase ?? 'private';

  const [subscriptionId, setSubscriptionId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<CloudKitError | undefined>(undefined);

  // Stable ref for onNotification so the listener effect doesn't re-run on callback change
  const onNotificationRef = useRef(onNotification);
  useEffect(() => {
    onNotificationRef.current = onNotification;
  }, [onNotification]);

  // Stable JSON for predicate so callers don't need to memoize
  const predicateJson = JSON.stringify(predicate);

  // Subscription lifecycle: create on mount, recreate on key changes, delete on unmount
  useEffect(() => {
    if (!enabled) {
      setSubscriptionId((prev) => {
        if (prev !== undefined) {
          void deleteSubscription(prev, effectiveDatabase).catch(() => {});
        }
        return undefined;
      });
      return;
    }

    let cancelled = false;
    let createdId: string | undefined;

    setLoading(true);
    setError(undefined);

    saveQuerySubscription({
      recordType,
      predicate,
      firesOnRecordCreation: firesOnCreation,
      firesOnRecordUpdate: firesOnUpdate,
      firesOnRecordDeletion: firesOnDeletion,
      zoneName,
      database: effectiveDatabase,
    })
      .then((id) => {
        if (cancelled) {
          // Component unmounted before save resolved — delete the subscription
          void deleteSubscription(id, effectiveDatabase).catch(() => {});
          return;
        }
        createdId = id;
        setSubscriptionId(id);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const cloudKitError =
          err instanceof CloudKitError ? err : CloudKitError.fromNativeError(err);
        setError(cloudKitError);
        setLoading(false);
      });

    return () => {
      cancelled = true;
      if (createdId !== undefined) {
        void deleteSubscription(createdId, effectiveDatabase).catch(() => {});
        createdId = undefined;
      }
      setSubscriptionId(undefined);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordType, predicateJson, zoneName, effectiveDatabase, firesOnCreation, firesOnUpdate, firesOnDeletion, enabled]);

  // Push notification listener — filtered to our subscription ID
  useEffect(() => {
    if (subscriptionId === undefined) return;

    const queryCache = context?.queryCache;

    const subscription = addSubscriptionListener((event: SubscriptionEvent) => {
      if (event.type !== 'query') return;
      if (event.subscriptionID !== subscriptionId) return;

      // Invalidate all query hooks watching this record type
      queryCache?.invalidateByRecordType(recordType);

      // Fire the caller's callback after cache invalidation
      onNotificationRef.current?.(event);
    });

    return () => {
      subscription.remove();
    };
  }, [subscriptionId, recordType, context]);

  return { subscriptionId, loading, error };
}
