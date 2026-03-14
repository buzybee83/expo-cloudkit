/**
 * expo-cloudkit — useSyncHealth hook (Phase I.3)
 *
 * Subscribes to `onSyncHealth` native events emitted by the sync engine at
 * the end of each sync cycle and exposes an up-to-date health snapshot.
 *
 * The hook is safe to mount before `startSyncEngine()` is called — it will
 * reflect the zero-state until the first event arrives. On non-iOS platforms
 * (web, Android), the state remains at its initial zero values because the
 * sync engine is not available and the native event is never emitted.
 */

import { useEffect, useState } from 'react';

import { addSyncHealthListener } from '../ExpoCloudKit';
import type { SyncHealthEvent } from '../types';

/**
 * Real-time health state derived from `onSyncHealth` events.
 *
 * All count fields are reset to 0 on mount and updated atomically after each
 * sync cycle event. `lastSyncAt` reflects the wall-clock time at which the
 * most recent event was received by the JS thread.
 */
export interface SyncHealthState {
  /**
   * Timestamp of the most recent `onSyncHealth` event, or `null` if no sync
   * has occurred since the hook was mounted.
   */
  lastSyncAt: Date | null;
  /**
   * Number of records successfully sent to the server in the last sync cycle.
   * 0 before the first event.
   */
  sentCount: number;
  /**
   * Number of records fetched from the server in the last sync cycle.
   * 0 before the first event.
   */
  receivedCount: number;
  /**
   * Number of records that failed during the last sync cycle.
   * 0 before the first event.
   */
  failedCount: number;
  /**
   * Wall-clock duration of the last sync cycle in milliseconds.
   * `null` before the first event.
   */
  lastDurationMs: number | null;
  /**
   * `true` when `failedCount` was 0 on the most recent sync cycle.
   * `null` before the first event (no data to evaluate).
   */
  isHealthy: boolean | null;
  /**
   * `true` if the last cycle was driven by CKSyncEngine (iOS 17+).
   * `false` for the iOS 16 fallback path.
   * `null` before the first event.
   */
  syncEngine: boolean | null;
}

const initialState: SyncHealthState = {
  lastSyncAt: null,
  sentCount: 0,
  receivedCount: 0,
  failedCount: 0,
  lastDurationMs: null,
  isHealthy: null,
  syncEngine: null,
};

/**
 * Returns a live health snapshot updated after each sync cycle.
 *
 * Internally subscribes to the `onSyncHealth` native event via
 * `addSyncHealthListener`. The subscription is cleaned up automatically
 * when the component unmounts.
 *
 * @example
 * ```typescript
 * function SyncStatusBadge() {
 *   const { isHealthy, lastSyncAt, failedCount } = useSyncHealth();
 *
 *   if (isHealthy === null) return <Text>No sync yet</Text>;
 *
 *   return (
 *     <Text style={{ color: isHealthy ? 'green' : 'red' }}>
 *       {isHealthy ? 'Healthy' : `${failedCount} failed`}
 *     </Text>
 *   );
 * }
 * ```
 */
export function useSyncHealth(): SyncHealthState {
  const [state, setState] = useState<SyncHealthState>(initialState);

  useEffect(() => {
    const subscription = addSyncHealthListener((event: SyncHealthEvent) => {
      setState({
        lastSyncAt: new Date(),
        sentCount: event.sentCount,
        receivedCount: event.receivedCount,
        failedCount: event.failedCount,
        lastDurationMs: event.durationMs,
        isHealthy: event.failedCount === 0,
        syncEngine: event.syncEngine,
      });
    });

    return () => {
      subscription.remove();
    };
  }, []);

  return state;
}
