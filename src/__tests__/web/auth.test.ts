/**
 * Unit tests for src/web/auth.ts
 *
 * Tests auth state management: getWebAuthState, setWebAuthState,
 * subscribeToAuthState, clearWebAuthState, and localStorage persistence.
 */

import {
  getWebAuthState,
  setWebAuthState,
  subscribeToAuthState,
  clearWebAuthState,
  configureAuthPersistence,
  webAuthStateToAccountStatus,
  type WebAuthState,
} from '../../web/auth';

// ---------------------------------------------------------------------------
// Reset module state between tests so listeners and _state don't bleed over.
// ---------------------------------------------------------------------------

// auth.ts uses module-level `let _listeners` (a Set) and `let _state`. Jest
// does NOT re-evaluate module-level state between tests in the same file, so
// listeners registered in one test would fire in every subsequent test's
// beforeEach `clearWebAuthState()` call. We track all unsubscribe functions
// and call them in afterEach to keep the listener set clean.

const _unsubscribeFns: Array<() => void> = [];

// Wrap subscribeToAuthState to auto-track unsubscribes.
const trackedSubscribe = (listener: Parameters<typeof subscribeToAuthState>[0]) => {
  const unsub = subscribeToAuthState(listener);
  _unsubscribeFns.push(unsub);
  return unsub;
};

afterEach(() => {
  // Drain all unsubscribe functions so orphaned listeners don't accumulate.
  while (_unsubscribeFns.length > 0) {
    _unsubscribeFns.pop()?.();
  }
});

beforeEach(() => {
  // Clear state and ensure persistence is disabled so localStorage isn't touched
  // unexpectedly in tests that don't opt into it.
  configureAuthPersistence(false);
  clearWebAuthState();
});

// ---------------------------------------------------------------------------
// getWebAuthState
// ---------------------------------------------------------------------------

describe('getWebAuthState', () => {
  it('returns isAuthenticated: false and undefined userRecordName initially', () => {
    const state = getWebAuthState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.userRecordName).toBeUndefined();
  });

  it('returns a copy — mutating the returned object does not affect stored state', () => {
    const state = getWebAuthState();
    state.isAuthenticated = true; // mutate the copy
    expect(getWebAuthState().isAuthenticated).toBe(false); // original unchanged
  });
});

// ---------------------------------------------------------------------------
// setWebAuthState
// ---------------------------------------------------------------------------

describe('setWebAuthState', () => {
  it('updates the state returned by getWebAuthState', () => {
    setWebAuthState({ isAuthenticated: true, userRecordName: '_user_123' });
    const state = getWebAuthState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.userRecordName).toBe('_user_123');
  });

  it('can unset authentication', () => {
    setWebAuthState({ isAuthenticated: true, userRecordName: '_user_123' });
    setWebAuthState({ isAuthenticated: false, userRecordName: undefined });
    const state = getWebAuthState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.userRecordName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// subscribeToAuthState
// ---------------------------------------------------------------------------

describe('subscribeToAuthState', () => {
  it('fires callback immediately when setWebAuthState is called', () => {
    const listener = jest.fn();
    trackedSubscribe(listener);

    setWebAuthState({ isAuthenticated: true, userRecordName: '_me_' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ isAuthenticated: true, userRecordName: '_me_' });
  });

  it('fires callback with the new state on each setWebAuthState call', () => {
    const listener = jest.fn();
    trackedSubscribe(listener);

    setWebAuthState({ isAuthenticated: true, userRecordName: '_a_' });
    setWebAuthState({ isAuthenticated: false, userRecordName: undefined });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, { isAuthenticated: true, userRecordName: '_a_' });
    expect(listener).toHaveBeenNthCalledWith(2, { isAuthenticated: false, userRecordName: undefined });
  });

  it('returned unsubscribe function stops future callbacks', () => {
    const listener = jest.fn();
    const unsubscribe = trackedSubscribe(listener);

    setWebAuthState({ isAuthenticated: true, userRecordName: '_b_' });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();

    setWebAuthState({ isAuthenticated: false, userRecordName: undefined });
    // Should still be 1 — not called again after unsubscribe
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing is idempotent — calling unsubscribe twice does not throw', () => {
    const unsubscribe = trackedSubscribe(jest.fn());
    expect(() => {
      unsubscribe();
      unsubscribe();
    }).not.toThrow();
  });

  it('multiple subscribers all receive updates', () => {
    const listenerA = jest.fn();
    const listenerB = jest.fn();
    const listenerC = jest.fn();

    trackedSubscribe(listenerA);
    trackedSubscribe(listenerB);
    trackedSubscribe(listenerC);

    setWebAuthState({ isAuthenticated: true, userRecordName: '_x_' });

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);
    expect(listenerC).toHaveBeenCalledTimes(1);
  });

  it('removing one subscriber does not affect other subscribers', () => {
    const listenerA = jest.fn();
    const listenerB = jest.fn();

    const unsubscribeA = trackedSubscribe(listenerA);
    trackedSubscribe(listenerB);

    unsubscribeA();

    setWebAuthState({ isAuthenticated: true, userRecordName: '_y_' });

    expect(listenerA).not.toHaveBeenCalled();
    expect(listenerB).toHaveBeenCalledTimes(1);
  });

  it('does not throw when a listener throws — other listeners still fire', () => {
    const badListener = jest.fn().mockImplementation(() => {
      throw new Error('listener error');
    });
    const goodListener = jest.fn();

    trackedSubscribe(badListener);
    trackedSubscribe(goodListener);

    // Should not throw despite badListener throwing
    expect(() => {
      setWebAuthState({ isAuthenticated: true, userRecordName: '_z_' });
    }).not.toThrow();

    expect(goodListener).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// clearWebAuthState
// ---------------------------------------------------------------------------

describe('clearWebAuthState', () => {
  it('resets state to unauthenticated', () => {
    setWebAuthState({ isAuthenticated: true, userRecordName: '_me_' });
    clearWebAuthState();
    const state = getWebAuthState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.userRecordName).toBeUndefined();
  });

  it('notifies subscribers when state is cleared', () => {
    setWebAuthState({ isAuthenticated: true, userRecordName: '_me_' });

    const listener = jest.fn();
    trackedSubscribe(listener);

    clearWebAuthState();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ isAuthenticated: false, userRecordName: undefined });
  });
});

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

describe('localStorage persistence', () => {
  const STORAGE_KEY = 'expo_cloudkit_web_auth';

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    configureAuthPersistence(false);
    clearWebAuthState();
  });

  it('persists state to localStorage when persistSession is true', () => {
    configureAuthPersistence(true);
    setWebAuthState({ isAuthenticated: true, userRecordName: '_persisted_' });

    const stored = localStorage.getItem(STORAGE_KEY);
    expect(stored).not.toBeNull();
    const parsed: WebAuthState = JSON.parse(stored!);
    expect(parsed.isAuthenticated).toBe(true);
    expect(parsed.userRecordName).toBe('_persisted_');
  });

  it('does not persist to localStorage when persistSession is false', () => {
    configureAuthPersistence(false);
    setWebAuthState({ isAuthenticated: true, userRecordName: '_not_persisted_' });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('hydrates state from localStorage on configureAuthPersistence(true)', () => {
    // Pre-seed localStorage
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ isAuthenticated: true, userRecordName: '_hydrated_' })
    );

    configureAuthPersistence(true);

    const state = getWebAuthState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.userRecordName).toBe('_hydrated_');
  });

  it('does not crash when localStorage contains invalid JSON', () => {
    localStorage.setItem(STORAGE_KEY, 'NOT_VALID_JSON{{{');
    expect(() => configureAuthPersistence(true)).not.toThrow();
    // State should remain default
    const state = getWebAuthState();
    expect(state.isAuthenticated).toBe(false);
  });

  it('clears localStorage entry when clearWebAuthState is called', () => {
    configureAuthPersistence(true);
    setWebAuthState({ isAuthenticated: true, userRecordName: '_me_' });
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();

    clearWebAuthState();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SSR safety — simulate localStorage unavailable
// ---------------------------------------------------------------------------

describe('SSR safety (localStorage undefined)', () => {
  let originalLocalStorage: Storage;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    originalLocalStorage = (global as any).localStorage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (global as any).localStorage;
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).localStorage = originalLocalStorage;
  });

  it('does not crash when localStorage is undefined and persistSession is true', () => {
    expect(() => {
      configureAuthPersistence(true);
      setWebAuthState({ isAuthenticated: true, userRecordName: '_ssr_' });
    }).not.toThrow();
  });

  it('still updates in-memory state when localStorage is unavailable', () => {
    configureAuthPersistence(true);
    setWebAuthState({ isAuthenticated: true, userRecordName: '_ssr_user_' });
    const state = getWebAuthState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.userRecordName).toBe('_ssr_user_');
  });

  it('clearWebAuthState does not crash when localStorage is undefined', () => {
    expect(() => clearWebAuthState()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// webAuthStateToAccountStatus
// ---------------------------------------------------------------------------

describe('webAuthStateToAccountStatus', () => {
  it('returns "available" when isAuthenticated is true', () => {
    expect(
      webAuthStateToAccountStatus({ isAuthenticated: true, userRecordName: '_me_' })
    ).toBe('available');
  });

  it('returns "noAccount" when isAuthenticated is false', () => {
    expect(
      webAuthStateToAccountStatus({ isAuthenticated: false, userRecordName: undefined })
    ).toBe('noAccount');
  });
});
