/**
 * expo-cloudkit — useCloudKitStatus hook
 *
 * Reactive hook that tracks iCloud account status and CloudKit availability.
 * Updates automatically when the account status changes and optionally on a
 * polling interval (useful when network connectivity may change).
 */

import { useEffect, useRef, useState } from 'react';

import {
  addAccountStatusListener,
  getAccountStatus,
  isCloudKitAvailable,
  isWebAuthenticated,
} from './ExpoCloudKit';
import { CloudKitError } from './errors';
import type { AccountStatus, Subscription } from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Snapshot of CloudKit reachability and iCloud account state.
 *
 * - `accountStatus`      — Raw CKAccountStatus string, or null while loading.
 * - `isAvailable`        — Whether the CloudKit native module is loaded on
 *                          this platform. Always false on Android.
 * - `isWebAuthenticated` — Whether the CloudKit Web Services session is active.
 *                          Always false on native iOS.
 * - `ready`              — Shorthand: `accountStatus === 'available' && isAvailable`.
 * - `loading`            — True during the initial `getAccountStatus()` call.
 * - `error`              — Set if `getAccountStatus()` rejected with a CloudKitError.
 */
export interface CloudKitStatus {
  /** The raw CKAccountStatus, or null while the initial check is in flight. */
  accountStatus: AccountStatus | null;
  /** True when the CloudKit native module is present on this platform (iOS only). */
  isAvailable: boolean;
  /**
   * True when the CloudKit Web Services sign-in flow has been completed.
   * Always false on native iOS — use `accountStatus` instead.
   */
  isWebAuthenticated: boolean;
  /**
   * Convenience flag: true when CloudKit is ready for use.
   * Equivalent to `accountStatus === 'available' && isAvailable`.
   */
  ready: boolean;
  /** True during the initial `getAccountStatus()` call. */
  loading: boolean;
  /** Set to the CloudKitError from `getAccountStatus()` if the call rejects. */
  error: CloudKitError | null;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface UseCloudKitStatusOptions {
  /**
   * If provided, re-checks account status every `pollInterval` milliseconds.
   * Useful in environments where network or account state can change without
   * firing the `onAccountStatusChanged` native event (e.g. backgrounded apps
   * or web sessions).
   *
   * Pass `undefined` or omit to disable polling (event-driven only).
   */
  pollInterval?: number;
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

/**
 * Reactive hook that tracks iCloud account status and CloudKit availability.
 *
 * On mount it calls `getAccountStatus()` and subscribes to the
 * `onAccountStatusChanged` native event. When `options.pollInterval` is set,
 * it re-checks on the specified interval as well.
 *
 * Works on both native iOS and web:
 * - Native: monitors `getAccountStatus()` + `onAccountStatusChanged` events.
 * - Web: additionally reflects `isWebAuthenticated()` state from the
 *   CloudKit JS sign-in flow.
 *
 * @param options - Optional configuration (polling interval).
 * @returns A `CloudKitStatus` snapshot, updated reactively.
 *
 * @example
 * ```typescript
 * function App() {
 *   const { ready, loading, accountStatus, error } = useCloudKitStatus();
 *
 *   if (loading) return <ActivityIndicator />;
 *   if (error) return <Text>{error.recoverySuggestion ?? error.message}</Text>;
 *   if (!ready) return <Text>iCloud not available ({accountStatus})</Text>;
 *   return <CloudKitContent />;
 * }
 * ```
 *
 * @example Polling (useful after returning from background)
 * ```typescript
 * const status = useCloudKitStatus({ pollInterval: 30_000 });
 * ```
 */
export function useCloudKitStatus(options?: UseCloudKitStatusOptions): CloudKitStatus {
  const [accountStatus, setAccountStatus] = useState<AccountStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<CloudKitError | null>(null);

  // Stable values derived once — these don't change at runtime on a given platform.
  const [available] = useState<boolean>(() => isCloudKitAvailable());
  const [webAuth, setWebAuth] = useState<boolean>(() => isWebAuthenticated());

  // Keep a ref to the latest pollInterval so the effect can read it without
  // needing to re-register the interval on every render.
  const pollIntervalRef = useRef<number | undefined>(options?.pollInterval);
  pollIntervalRef.current = options?.pollInterval;

  useEffect(() => {
    let cancelled = false;

    async function fetchStatus(): Promise<void> {
      try {
        const status = await getAccountStatus();
        if (!cancelled) {
          setAccountStatus(status);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof CloudKitError ? err : CloudKitError.fromNativeError(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          // Refresh web auth state on each fetch (web target may update this).
          setWebAuth(isWebAuthenticated());
        }
      }
    }

    // Initial fetch
    void fetchStatus();

    // Subscribe to native account-change events
    let subscription: Subscription | null = null;
    if (available) {
      subscription = addAccountStatusListener((status: AccountStatus) => {
        if (!cancelled) {
          setAccountStatus(status);
          setError(null);
          setWebAuth(isWebAuthenticated());
        }
      });
    }

    // Optional polling
    let timerId: ReturnType<typeof setInterval> | null = null;
    if (pollIntervalRef.current !== undefined && pollIntervalRef.current > 0) {
      timerId = setInterval(() => {
        void fetchStatus();
      }, pollIntervalRef.current);
    }

    return () => {
      cancelled = true;
      subscription?.remove();
      if (timerId !== null) clearInterval(timerId);
    };
    // `available` is stable (determined once on mount); re-run only when the
    // pollInterval changes between renders.
  }, [available, options?.pollInterval]);

  const ready = accountStatus === 'available' && available;

  return {
    accountStatus,
    isAvailable: available,
    isWebAuthenticated: webAuth,
    ready,
    loading,
    error,
  };
}
