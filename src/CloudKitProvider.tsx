/**
 * expo-cloudkit — CloudKitProvider
 *
 * Optional React context that shares container configuration, reactive account
 * status, current sync state, and a QueryCache across all hooks in the tree.
 *
 * Usage is opt-in. All hooks work identically without a Provider.
 * When a Provider is present, hooks gain:
 *   - Automatic defaultDatabase fallback
 *   - Cross-hook cache invalidation via QueryCache
 *   - Reactive account status via useAccountStatus()
 */

import React from 'react';
import { Platform } from 'react-native';

import { configure, getAccountStatus, addAccountStatusListener } from './ExpoCloudKit';
import { QueryCache } from './QueryCache';
import type { AccountStatus, DatabaseScope, WebConfigOptions } from './types';

// ---------------------------------------------------------------------------
// Context value shape (internal)
// ---------------------------------------------------------------------------

/**
 * Internal context value. Not exported directly — consumed via hooks.
 */
export interface CloudKitContextValue {
  /** Container identifier passed to configure(). */
  containerId: string;

  /** Reactive account status. Updates when onAccountStatusChanged fires. */
  accountStatus: AccountStatus | 'loading';

  /** Default database scope for all hooks in the tree. */
  defaultDatabase: DatabaseScope;

  /** The query cache instance shared across all hooks in the tree. */
  queryCache: QueryCache;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const CloudKitContext = React.createContext<CloudKitContextValue | undefined>(undefined);

// ---------------------------------------------------------------------------
// Provider props
// ---------------------------------------------------------------------------

/**
 * Props for the CloudKitProvider component.
 */
export interface CloudKitProviderProps {
  /**
   * CloudKit container identifier, e.g. "iCloud.com.example.myapp".
   * Calls `configure()` on mount and whenever this value changes. Required.
   */
  containerId: string;

  /**
   * Database scope used as the default for all hooks in the tree.
   * Individual hooks can still override this with their own `database` prop.
   * Default: 'private'.
   */
  defaultDatabase?: DatabaseScope;

  /**
   * When `true`, the Provider calls `getAccountStatus()` on mount and
   * subscribes to `onAccountStatusChanged` for live updates.
   * Default: `true`.
   */
  observeAccountStatus?: boolean;

  /**
   * Configuration for CloudKit Web Services.
   * Required when running on web. Ignored on native.
   *
   * Provide an `apiToken` obtained from CloudKit Dashboard to enable web access.
   * The token grants public database read access without user sign-in.
   * Call `authenticateWeb()` separately to enable private database access.
   *
   * @example
   * ```tsx
   * <CloudKitProvider
   *   containerId="iCloud.com.example.myapp"
   *   webConfig={{ apiToken: 'your-token', environment: 'production' }}
   * >
   *   <App />
   * </CloudKitProvider>
   * ```
   */
  webConfig?: WebConfigOptions;

  children: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Provider component
// ---------------------------------------------------------------------------

/**
 * Provides CloudKit container configuration and shared state to all hooks in
 * the component tree.
 *
 * Calls `configure(containerId)` on mount. When `observeAccountStatus` is
 * true (default), fetches the current iCloud account status and subscribes
 * to changes for the lifetime of the Provider.
 *
 * Creates one `QueryCache` instance per Provider. All `useCloudKitQuery` and
 * `useCloudKitRecord` hooks in the tree register themselves in this cache,
 * enabling cross-hook invalidation from `useCloudKitSubscription`.
 *
 * @example
 * ```tsx
 * <CloudKitProvider containerId="iCloud.com.example.myapp">
 *   <App />
 * </CloudKitProvider>
 * ```
 */
export function CloudKitProvider({
  containerId,
  defaultDatabase = 'private',
  observeAccountStatus = true,
  webConfig,
  children,
}: CloudKitProviderProps): React.ReactElement {
  const [accountStatus, setAccountStatus] = React.useState<AccountStatus | 'loading'>('loading');

  // One QueryCache per Provider instance. Recreated if containerId changes.
  const queryCache = React.useMemo(
    () => new QueryCache(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [containerId]
  );

  // configure() + optional account status observation
  React.useEffect(() => {
    let cancelled = false;

    async function setup() {
      // 1. Configure the container (platform-specific)
      if (Platform.OS === 'web' || Platform.OS === 'android') {
        if (webConfig) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { configureWeb } = require('./ExpoCloudKit') as typeof import('./ExpoCloudKit.web');
          try {
            await configureWeb(containerId, webConfig);
          } catch {
            // configureWeb failure surfaces through getAccountStatus() returning couldNotDetermine
          }
        }
      } else {
        try {
          configure(containerId);
        } catch {
          // configure() throws synchronously on non-iOS — swallow so the Provider
          // renders normally (hooks will individually fail with CloudKitNotSupportedError).
        }
      }

      if (!observeAccountStatus || cancelled) return;

      // 2. Reset to loading and fetch current status (after configure completes)
      setAccountStatus('loading');

      try {
        const status = await getAccountStatus();
        if (!cancelled) setAccountStatus(status);
      } catch {
        // leave as 'loading'
      }
    }

    // 3. Subscribe to live updates
    const subscription = addAccountStatusListener((status) => {
      if (!cancelled) setAccountStatus(status);
    });

    void setup();

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [containerId, observeAccountStatus, webConfig]);

  const contextValue = React.useMemo<CloudKitContextValue>(
    () => ({
      containerId,
      accountStatus,
      defaultDatabase,
      queryCache,
    }),
    [containerId, accountStatus, defaultDatabase, queryCache]
  );

  return (
    <CloudKitContext.Provider value={contextValue}>
      {children}
    </CloudKitContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Internal hook (no throw)
// ---------------------------------------------------------------------------

/**
 * Returns the `CloudKitContextValue` from the nearest `CloudKitProvider`,
 * or `undefined` if no Provider exists in the tree.
 *
 * Never throws. Absence of Provider is a valid state — hooks degrade
 * gracefully to standalone mode.
 */
export function useCloudKitContext(): CloudKitContextValue | undefined {
  return React.useContext(CloudKitContext);
}

// ---------------------------------------------------------------------------
// Public convenience hooks
// ---------------------------------------------------------------------------

/**
 * Returns the current iCloud account status from the nearest `CloudKitProvider`.
 *
 * The value is `'loading'` until the first `getAccountStatus()` call resolves.
 *
 * @throws If no `CloudKitProvider` exists in the tree.
 *
 * @example
 * ```tsx
 * const status = useAccountStatus();
 * if (status === 'available') { ... }
 * ```
 */
export function useAccountStatus(): AccountStatus | 'loading' {
  const context = React.useContext(CloudKitContext);
  if (context === undefined) {
    throw new Error(
      'useAccountStatus() requires a <CloudKitProvider> ancestor in the component tree.'
    );
  }
  return context.accountStatus;
}

/**
 * Returns the container ID from the nearest `CloudKitProvider`.
 *
 * @throws If no `CloudKitProvider` exists in the tree.
 *
 * @example
 * ```tsx
 * const containerId = useContainerId();
 * ```
 */
export function useContainerId(): string {
  const context = React.useContext(CloudKitContext);
  if (context === undefined) {
    throw new Error(
      'useContainerId() requires a <CloudKitProvider> ancestor in the component tree.'
    );
  }
  return context.containerId;
}
