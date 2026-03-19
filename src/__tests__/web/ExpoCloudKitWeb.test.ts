/**
 * Unit tests for src/ExpoCloudKit.web.ts
 *
 * Tests stub functions (sync engine, offline queue, etc.) and verifies
 * that configureWeb / authenticateWeb interact correctly with tsl-apple-cloudkit.
 *
 * tsl-apple-cloudkit is mocked with { virtual: true } because it is an optional
 * peer dependency not installed in this repo's devDependencies.
 */

// ---------------------------------------------------------------------------
// Mock tsl-apple-cloudkit before any imports so the module loader sees it.
// Must be declared before the import of the module under test.
// ---------------------------------------------------------------------------

const mockConfigure = jest.fn();
const mockSetUpAuth = jest.fn();
const mockWhenUserSignsIn = jest.fn();
const mockFetchUserRecordName = jest.fn();

const mockContainer = {
  setUpAuth: mockSetUpAuth,
  whenUserSignsIn: mockWhenUserSignsIn,
  fetchUserRecordName: mockFetchUserRecordName,
  privateCloudDatabase: {
    saveRecordZones: jest.fn(),
    deleteRecordZones: jest.fn(),
    fetchAllRecordZones: jest.fn(),
    saveRecords: jest.fn(),
    fetchRecords: jest.fn(),
    deleteRecords: jest.fn(),
    performQuery: jest.fn(),
    saveSubscriptions: jest.fn(),
    deleteSubscriptions: jest.fn(),
    fetchAllSubscriptions: jest.fn(),
  },
  publicCloudDatabase: { saveRecords: jest.fn() },
  sharedCloudDatabase: { fetchAllRecordZones: jest.fn() },
};

// mockConfigure returns the configured instance; we make getDefaultContainer
// available on the returned value so requireContainer() can resolve it.
const mockConfiguredCloudKit = {
  getDefaultContainer: jest.fn().mockReturnValue(mockContainer),
};

mockConfigure.mockReturnValue(mockConfiguredCloudKit);

jest.mock(
  'tsl-apple-cloudkit',
  () => ({
    default: {
      configure: mockConfigure,
    },
  }),
  { virtual: true }
);

// Also mock src/web/cloudkit-loader so it returns our mock CloudKit module
// without performing a real dynamic import. This gives us deterministic control.
jest.mock('../../web/cloudkit-loader', () => ({
  loadCloudKit: jest.fn().mockResolvedValue({
    default: {
      configure: mockConfigure,
    },
  }),
  getContainer: jest.fn(),
}));

// Mock auth state module to keep tests isolated from localStorage / module state.
// We import and re-export the real implementations here so we can spy on them.
jest.mock('../../web/auth', () => {
  const real = jest.requireActual('../../web/auth');
  return {
    ...real,
    configureAuthPersistence: jest.fn(real.configureAuthPersistence),
    setWebAuthState: jest.fn(real.setWebAuthState),
    clearWebAuthState: jest.fn(real.clearWebAuthState),
    getWebAuthState: jest.fn(real.getWebAuthState),
    subscribeToAuthState: jest.fn(real.subscribeToAuthState),
    webAuthStateToAccountStatus: jest.fn(real.webAuthStateToAccountStatus),
  };
});

import {
  isCloudKitAvailable,
  isSyncEngineAvailable,
  getSyncState,
  configure,
  startSyncEngine,
  stopSyncEngine,
  triggerSync,
  enqueuePendingChange,
  addSyncEngineListener,
  addAssetProgressListener,
  addBatchProgressListener,
  addAccountStatusListener,
  addSubscriptionListener,
  addShareAcceptedListener,
  addOfflineQueueListener,
  configureWeb,
  authenticateWeb,
  signOutWeb,
  isWebAuthenticated,
  downloadAsset,
  presentSharingUI,
  updateSharePermission,
  removeShareParticipant,
  enqueueOfflineOperation,
  drainOfflineQueue,
  getOfflineQueueStatus,
  clearOfflineQueue,
  retryFailedOperations,
  __debugDumpContainerInfo,
  __debugListZones,
  __debugFetchRawRecord,
  __debugClearZone,
} from '../../ExpoCloudKit.web';
import { CloudKitError, CloudKitErrorCode, CloudKitNotSupportedError } from '../../errors';
import { setWebAuthState, clearWebAuthState } from '../../web/auth';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function configureAndAuthenticate() {
  await configureWeb('iCloud.com.example.test', {
    apiToken: 'test-api-token',
    environment: 'development',
  });
}

// ---------------------------------------------------------------------------
// beforeEach — reset container state by reconfiguring or clearing
// ---------------------------------------------------------------------------

beforeEach(async () => {
  jest.clearAllMocks();

  // Reset mockConfigure return value
  mockConfigure.mockReturnValue(mockConfiguredCloudKit);
  mockConfiguredCloudKit.getDefaultContainer.mockReturnValue(mockContainer);

  // whenUserSignsIn returns a promise that never resolves by default
  // (sign-in doesn't happen automatically during configure)
  mockWhenUserSignsIn.mockReturnValue(new Promise(() => {}));

  // Clear auth state
  clearWebAuthState();

  // Re-configure so _container and _configured are set for tests that
  // exercise non-configureWeb functions.
  const { loadCloudKit } = await import('../../web/cloudkit-loader');
  (loadCloudKit as jest.Mock).mockResolvedValue({ default: { configure: mockConfigure } });

  await configureAndAuthenticate();
});

// ---------------------------------------------------------------------------
// isCloudKitAvailable
// ---------------------------------------------------------------------------

describe('isCloudKitAvailable', () => {
  it('returns true after configureWeb has been called successfully', () => {
    expect(isCloudKitAvailable()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isSyncEngineAvailable
// ---------------------------------------------------------------------------

describe('isSyncEngineAvailable', () => {
  it('always returns false on web', () => {
    expect(isSyncEngineAvailable()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getSyncState
// ---------------------------------------------------------------------------

describe('getSyncState', () => {
  it('returns an empty object on web (no engines running)', () => {
    expect(getSyncState()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// configure (native no-op on web)
// ---------------------------------------------------------------------------

describe('configure', () => {
  it('is a no-op and does not throw', () => {
    expect(() => configure('iCloud.com.example.test')).not.toThrow();
  });

  it('returns void (undefined)', () => {
    expect(configure('iCloud.com.example.test')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// add*Listener stubs — must return { remove: Function }
// ---------------------------------------------------------------------------

describe('listener stubs return Subscription with remove', () => {
  it('addSyncEngineListener returns { remove: Function }', () => {
    const sub = addSyncEngineListener(jest.fn());
    expect(typeof sub.remove).toBe('function');
    expect(() => sub.remove()).not.toThrow();
  });

  it('addAssetProgressListener returns { remove: Function }', () => {
    const sub = addAssetProgressListener(jest.fn());
    expect(typeof sub.remove).toBe('function');
  });

  it('addBatchProgressListener returns { remove: Function }', () => {
    const sub = addBatchProgressListener(jest.fn());
    expect(typeof sub.remove).toBe('function');
  });

  it('addAccountStatusListener returns { remove: Function }', () => {
    const sub = addAccountStatusListener(jest.fn());
    expect(typeof sub.remove).toBe('function');
  });

  it('addSubscriptionListener returns { remove: Function }', () => {
    const sub = addSubscriptionListener(jest.fn());
    expect(typeof sub.remove).toBe('function');
  });

  it('addShareAcceptedListener returns { remove: Function }', () => {
    const sub = addShareAcceptedListener(jest.fn());
    expect(typeof sub.remove).toBe('function');
  });

  it('addOfflineQueueListener returns { remove: Function }', () => {
    const sub = addOfflineQueueListener(jest.fn());
    expect(typeof sub.remove).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// addAccountStatusListener — functional: fires when auth state changes
// ---------------------------------------------------------------------------

describe('addAccountStatusListener functional', () => {
  it('fires callback with "available" when setWebAuthState marks authenticated', () => {
    const callback = jest.fn();
    addAccountStatusListener(callback);
    setWebAuthState({ isAuthenticated: true, userRecordName: '_u_' });
    expect(callback).toHaveBeenCalledWith('available');
  });

  it('fires callback with "noAccount" when setWebAuthState marks unauthenticated', () => {
    const callback = jest.fn();
    addAccountStatusListener(callback);
    setWebAuthState({ isAuthenticated: false, userRecordName: undefined });
    expect(callback).toHaveBeenCalledWith('noAccount');
  });

  it('remove() stops the callback from firing', () => {
    const callback = jest.fn();
    const sub = addAccountStatusListener(callback);
    sub.remove();
    setWebAuthState({ isAuthenticated: true, userRecordName: '_v_' });
    expect(callback).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CKSyncEngine stubs — reject with CloudKitNotSupportedError
// ---------------------------------------------------------------------------

describe('sync engine stubs reject with CloudKitNotSupportedError', () => {
  it('startSyncEngine rejects with CloudKitNotSupportedError', async () => {
    await expect(
      startSyncEngine({ zones: ['_defaultZone'] })
    ).rejects.toBeInstanceOf(CloudKitNotSupportedError);
  });

  it('stopSyncEngine rejects with CloudKitNotSupportedError', async () => {
    await expect(stopSyncEngine()).rejects.toBeInstanceOf(CloudKitNotSupportedError);
  });

  it('triggerSync rejects with CloudKitNotSupportedError', async () => {
    await expect(triggerSync()).rejects.toBeInstanceOf(CloudKitNotSupportedError);
  });

  it('startSyncEngine rejection code is NOT_SUPPORTED', async () => {
    const err = await startSyncEngine({ zones: ['_defaultZone'] }).catch((e) => e);
    expect(err.code).toBe(CloudKitErrorCode.NOT_SUPPORTED);
  });
});

// ---------------------------------------------------------------------------
// enqueuePendingChange — throws CloudKitNotSupportedError synchronously
// ---------------------------------------------------------------------------

describe('enqueuePendingChange', () => {
  it('throws CloudKitNotSupportedError synchronously', () => {
    expect(() =>
      enqueuePendingChange({
        type: 'save',
        record: { recordType: 'Note', fields: {} },
      })
    ).toThrow(CloudKitNotSupportedError);
  });
});

// ---------------------------------------------------------------------------
// downloadAsset stub
// ---------------------------------------------------------------------------

describe('downloadAsset', () => {
  it('rejects with CloudKitNotSupportedError', async () => {
    await expect(
      downloadAsset('Note', 'rec-1', 'photo', '/tmp/photo.jpg')
    ).rejects.toBeInstanceOf(CloudKitNotSupportedError);
  });
});

// ---------------------------------------------------------------------------
// presentSharingUI stub
// ---------------------------------------------------------------------------

describe('presentSharingUI', () => {
  it('rejects with CloudKitNotSupportedError', async () => {
    await expect(
      presentSharingUI({ recordName: 'root-record-1', zoneName: '_defaultZone' })
    ).rejects.toBeInstanceOf(CloudKitNotSupportedError);
  });
});

// ---------------------------------------------------------------------------
// Share participant mutation stubs
// ---------------------------------------------------------------------------

describe('updateSharePermission and removeShareParticipant stubs', () => {
  it('updateSharePermission rejects with CloudKitNotSupportedError', async () => {
    await expect(
      updateSharePermission({
        shareRecordName: 'share-1',
        participantRecordName: 'p1',
        permission: 'readWrite',
      })
    ).rejects.toBeInstanceOf(CloudKitNotSupportedError);
  });

  it('removeShareParticipant rejects with CloudKitNotSupportedError', async () => {
    await expect(
      removeShareParticipant({
        shareRecordName: 'share-1',
        participantRecordName: 'p1',
      })
    ).rejects.toBeInstanceOf(CloudKitNotSupportedError);
  });
});

// ---------------------------------------------------------------------------
// Debug helper stubs
// ---------------------------------------------------------------------------

describe('debug helper stubs', () => {
  it('__debugDumpContainerInfo rejects with CloudKitNotSupportedError', async () => {
    await expect(__debugDumpContainerInfo()).rejects.toBeInstanceOf(CloudKitNotSupportedError);
  });

  it('__debugListZones rejects with CloudKitNotSupportedError', async () => {
    await expect(__debugListZones('private')).rejects.toBeInstanceOf(CloudKitNotSupportedError);
  });

  it('__debugFetchRawRecord rejects with CloudKitNotSupportedError', async () => {
    await expect(
      __debugFetchRawRecord({ recordName: 'r1', recordType: 'Note' })
    ).rejects.toBeInstanceOf(CloudKitNotSupportedError);
  });

  it('__debugClearZone rejects with CloudKitNotSupportedError', async () => {
    await expect(
      __debugClearZone({ zoneName: 'TestZone' })
    ).rejects.toBeInstanceOf(CloudKitNotSupportedError);
  });
});

// ---------------------------------------------------------------------------
// Offline Queue stubs
// ---------------------------------------------------------------------------

describe('offline queue stubs', () => {
  it('enqueueOfflineOperation rejects with CloudKitNotSupportedError', async () => {
    await expect(
      enqueueOfflineOperation({ type: 'save', record: { recordType: 'Note', fields: {} } })
    ).rejects.toBeInstanceOf(CloudKitNotSupportedError);
  });

  it('drainOfflineQueue rejects with CloudKitNotSupportedError', async () => {
    await expect(drainOfflineQueue()).rejects.toBeInstanceOf(CloudKitNotSupportedError);
  });

  it('getOfflineQueueStatus rejects with CloudKitNotSupportedError', async () => {
    await expect(getOfflineQueueStatus()).rejects.toBeInstanceOf(CloudKitNotSupportedError);
  });

  it('clearOfflineQueue rejects with CloudKitNotSupportedError', async () => {
    await expect(clearOfflineQueue()).rejects.toBeInstanceOf(CloudKitNotSupportedError);
  });

  it('retryFailedOperations rejects with CloudKitNotSupportedError', async () => {
    await expect(retryFailedOperations()).rejects.toBeInstanceOf(CloudKitNotSupportedError);
  });
});

// ---------------------------------------------------------------------------
// configureWeb
// ---------------------------------------------------------------------------

describe('configureWeb', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfigure.mockReturnValue(mockConfiguredCloudKit);
    mockConfiguredCloudKit.getDefaultContainer.mockReturnValue(mockContainer);
    mockWhenUserSignsIn.mockReturnValue(new Promise(() => {}));
  });

  it('calls CloudKit.configure with the correct container identifier and API token', async () => {
    await configureWeb('iCloud.com.example.myapp', {
      apiToken: 'my-api-token',
      environment: 'production',
    });

    expect(mockConfigure).toHaveBeenCalledWith({
      containers: [
        {
          containerIdentifier: 'iCloud.com.example.myapp',
          apiTokenAuth: {
            apiToken: 'my-api-token',
            persist: true, // default persistSession
          },
          environment: 'production',
        },
      ],
    });
  });

  it('uses "production" environment by default', async () => {
    await configureWeb('iCloud.com.example.myapp', { apiToken: 'tok' });

    expect(mockConfigure).toHaveBeenCalledWith(
      expect.objectContaining({
        containers: expect.arrayContaining([
          expect.objectContaining({ environment: 'production' }),
        ]),
      })
    );
  });

  it('passes persistSession false when specified', async () => {
    await configureWeb('iCloud.com.example.myapp', {
      apiToken: 'tok',
      persistSession: false,
    });

    expect(mockConfigure).toHaveBeenCalledWith(
      expect.objectContaining({
        containers: expect.arrayContaining([
          expect.objectContaining({
            apiTokenAuth: expect.objectContaining({ persist: false }),
          }),
        ]),
      })
    );
  });

  it('makes isCloudKitAvailable() return true after successful configure', async () => {
    await configureWeb('iCloud.com.example.myapp', { apiToken: 'tok' });
    expect(isCloudKitAvailable()).toBe(true);
  });

  it('throws CloudKitError (UNKNOWN) when loadCloudKit fails', async () => {
    const { loadCloudKit } = await import('../../web/cloudkit-loader');
    (loadCloudKit as jest.Mock).mockRejectedValueOnce(
      new Error('Cannot find module tsl-apple-cloudkit')
    );

    await expect(
      configureWeb('iCloud.com.example.myapp', { apiToken: 'tok' })
    ).rejects.toBeInstanceOf(CloudKitError);
  });

  it('throws CloudKitError when CloudKit.configure() throws', async () => {
    mockConfigure.mockImplementationOnce(() => {
      throw new Error('configure failed');
    });

    await expect(
      configureWeb('iCloud.com.example.myapp', { apiToken: 'tok' })
    ).rejects.toBeInstanceOf(CloudKitError);
  });
});

// ---------------------------------------------------------------------------
// authenticateWeb
// ---------------------------------------------------------------------------

describe('authenticateWeb', () => {
  it('returns "available" when setUpAuth resolves with a user identity', async () => {
    mockSetUpAuth.mockResolvedValue({ userRecordName: '_user_abc' });

    const status = await authenticateWeb();
    expect(status).toBe('available');
  });

  it('updates auth state to authenticated when setUpAuth succeeds', async () => {
    mockSetUpAuth.mockResolvedValue({ userRecordName: '_user_xyz' });

    await authenticateWeb();

    // Verify isWebAuthenticated reflects the updated state
    expect(isWebAuthenticated()).toBe(true);
  });

  it('returns "noAccount" when setUpAuth resolves with null and whenUserSignsIn rejects (user dismissed)', async () => {
    mockSetUpAuth.mockResolvedValue(null);
    mockWhenUserSignsIn.mockRejectedValue(new Error('User dismissed'));
    clearWebAuthState();

    const status = await authenticateWeb();
    expect(status).toBe('noAccount');
  });

  it('returns "noAccount" when setUpAuth rejects', async () => {
    mockSetUpAuth.mockRejectedValue(new Error('User cancelled'));

    const status = await authenticateWeb();
    expect(status).toBe('noAccount');
  });

  it('returns "noAccount" when setUpAuth rejects with an unexpected error', async () => {
    // authenticateWeb is designed to never throw — any setUpAuth rejection is
    // caught and returned as noAccount so the caller always gets a usable status.
    mockSetUpAuth.mockRejectedValue(new Error('Unexpected internal error'));

    const status = await authenticateWeb();
    expect(status).toBe('noAccount');
  });
});

// ---------------------------------------------------------------------------
// signOutWeb
// ---------------------------------------------------------------------------

describe('signOutWeb', () => {
  it('resolves without throwing', async () => {
    await expect(signOutWeb()).resolves.toBeUndefined();
  });

  it('sets isWebAuthenticated to false after sign out', async () => {
    setWebAuthState({ isAuthenticated: true, userRecordName: '_me_' });
    expect(isWebAuthenticated()).toBe(true);

    await signOutWeb();

    expect(isWebAuthenticated()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isWebAuthenticated
// ---------------------------------------------------------------------------

describe('isWebAuthenticated', () => {
  it('returns false when not authenticated', () => {
    clearWebAuthState();
    expect(isWebAuthenticated()).toBe(false);
  });

  it('returns true after auth state set to authenticated', () => {
    setWebAuthState({ isAuthenticated: true, userRecordName: '_me_' });
    expect(isWebAuthenticated()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Operations without container — error guard
// ---------------------------------------------------------------------------

describe('requireContainer guard', () => {
  it('createZone throws a structured CloudKitError when container is not set', async () => {
    // Use isolateModules to get a fresh, unconfigured module instance.
    // We check the error's `name` and `code` properties instead of `instanceof`
    // because isolateModules creates a separate class registry, making
    // cross-boundary instanceof checks unreliable.
    let createZoneFn: typeof import('../../ExpoCloudKit.web').createZone;

    await jest.isolateModulesAsync(async () => {
      jest.mock('../../web/cloudkit-loader', () => ({
        loadCloudKit: jest.fn().mockRejectedValue(new Error('not loaded')),
        getContainer: jest.fn(),
      }));
      jest.mock('../../web/auth', () => jest.requireActual('../../web/auth'));
      const mod = await import('../../ExpoCloudKit.web');
      createZoneFn = mod.createZone;
    });

    // createZone requires a configured container — verify it throws with the
    // CloudKitError shape: name === 'CloudKitError' and code === 'UNKNOWN'.
    const err = await createZoneFn!('TestZone').catch((e) => e);
    expect(err.name).toBe('CloudKitError');
    expect(err.code).toBe('UNKNOWN');
  });
});
