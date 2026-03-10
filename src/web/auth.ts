/**
 * Web auth state management for CloudKit.
 *
 * Provides an in-memory store for the current CloudKit JS authentication
 * state, with optional localStorage persistence. Exposes a minimal
 * pub/sub event emitter so `addAccountStatusListener` on web can be
 * notified when auth changes.
 *
 * SSR-safe: localStorage is accessed lazily inside function bodies, never
 * at module scope.
 *
 * No imports from tsl-apple-cloudkit — works with plain JS objects.
 */

import type { AccountStatus } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Internal representation of the web authentication state.
 *
 * `isAuthenticated` tracks whether a valid CloudKit JS session exists.
 * `userRecordName` is the CloudKit record name for the signed-in user, if known.
 */
export interface WebAuthState {
  isAuthenticated: boolean;
  userRecordName: string | undefined;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'expo_cloudkit_web_auth';

let _state: WebAuthState = {
  isAuthenticated: false,
  userRecordName: undefined,
};

let _persistSession = true;

/**
 * Configures whether auth state is persisted to localStorage.
 * Must be called before the first auth state change if persistence is desired.
 */
export function configureAuthPersistence(persist: boolean): void {
  _persistSession = persist;

  // Try to hydrate from localStorage on first configure
  if (persist && typeof localStorage !== 'undefined') {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as WebAuthState;
        _state = {
          isAuthenticated: parsed.isAuthenticated ?? false,
          userRecordName: parsed.userRecordName,
        };
      }
    } catch {
      // Ignore parse errors
    }
  }
}

/**
 * Returns the current web authentication state.
 */
export function getWebAuthState(): WebAuthState {
  return { ..._state };
}

/**
 * Updates the web authentication state and notifies all listeners.
 *
 * Optionally persists to localStorage when `persistSession` is enabled.
 */
export function setWebAuthState(state: WebAuthState): void {
  _state = { ...state };

  // Persist if enabled and localStorage is available (not SSR)
  if (_persistSession && typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_state));
    } catch {
      // Ignore quota errors etc.
    }
  }

  // Notify all listeners
  for (const listener of _listeners) {
    try {
      listener(_state);
    } catch {
      // Swallow listener errors to avoid breaking the whole notification cycle
    }
  }
}

/**
 * Clears the persisted auth session from localStorage and resets in-memory state.
 */
export function clearWebAuthState(): void {
  _state = { isAuthenticated: false, userRecordName: undefined };

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore
    }
  }

  for (const listener of _listeners) {
    try {
      listener(_state);
    } catch {
      // Swallow
    }
  }
}

// ---------------------------------------------------------------------------
// Pub/sub for account status changes
// ---------------------------------------------------------------------------

type AuthStateListener = (state: WebAuthState) => void;

const _listeners = new Set<AuthStateListener>();

/**
 * Subscribe to auth state changes. Returns an unsubscribe function.
 */
export function subscribeToAuthState(listener: AuthStateListener): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Convenience: map WebAuthState → AccountStatus
// ---------------------------------------------------------------------------

/**
 * Returns the `AccountStatus` corresponding to the current web auth state.
 *
 * Mapping:
 * - Not yet configured (never called `configureWeb`) → 'couldNotDetermine'
 * - Configured, no auth session → 'noAccount'
 * - Configured, valid auth session → 'available'
 * - (Expired sessions are detected at request time, not stored as state)
 */
export function webAuthStateToAccountStatus(state: WebAuthState): AccountStatus {
  return state.isAuthenticated ? 'available' : 'noAccount';
}
