/**
 * Tests for Phase J.3 — Android/web fallback routing.
 *
 * Verifies that:
 *   1. Web-supported functions are re-exported from the android module and callable.
 *   2. Native-only functions (resolveSyncConflict) throw CloudKitNotSupportedError.
 *   3. addSyncHealthListener returns a no-op Subscription instead of throwing.
 *   4. handleAuthRedirect returns true for CloudKit/Apple URLs and false otherwise.
 *   5. The android module exports the same web-compatible functions as the web module.
 */

// Mock react-native before any module under test loads it.
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Linking: {
    canOpenURL: jest.fn().mockResolvedValue(true),
    openURL: jest.fn().mockResolvedValue(undefined),
  },
}));

// The web implementation lazily loads CloudKit JS and calls browser globals.
// Mock it entirely so we can test the android barrel in isolation.
jest.mock('../ExpoCloudKit.web', () => ({
  configure: jest.fn(),
  getAccountStatus: jest.fn().mockResolvedValue('available'),
  fetchUserRecordID: jest.fn().mockResolvedValue('_abc123'),
  addAccountStatusListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
  isCloudKitAvailable: jest.fn().mockReturnValue(true),
  isSyncEngineAvailable: jest.fn().mockReturnValue(false),
  configureWeb: jest.fn().mockResolvedValue(undefined),
  authenticateWeb: jest.fn().mockResolvedValue('available'),
  signOutWeb: jest.fn().mockResolvedValue(undefined),
  isWebAuthenticated: jest.fn().mockReturnValue(false),
  saveRecords: jest.fn().mockResolvedValue([]),
  fetchRecord: jest.fn().mockResolvedValue(null),
  queryRecords: jest.fn().mockResolvedValue({ records: [] }),
  deleteRecords: jest.fn().mockResolvedValue(undefined),
  fetchRecordZoneChanges: jest.fn().mockResolvedValue({ records: [], deletedRecordIDs: [] }),
  createZone: jest.fn().mockResolvedValue({ zoneName: 'test', database: 'private' }),
  deleteZone: jest.fn().mockResolvedValue(undefined),
  fetchZones: jest.fn().mockResolvedValue([]),
  createShare: jest.fn(),
  deleteShare: jest.fn(),
  presentSharingUI: jest.fn(),
  fetchShareParticipants: jest.fn(),
  updateSharePermission: jest.fn(),
  setDefaultParticipantPermission: jest.fn(),
  removeShareParticipant: jest.fn(),
  acceptShare: jest.fn(),
  fetchSharedDatabaseZones: jest.fn().mockResolvedValue([]),
  addShareAcceptedListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
  startSyncEngine: jest.fn().mockResolvedValue(undefined),
  stopSyncEngine: jest.fn().mockResolvedValue(undefined),
  getSyncState: jest.fn().mockReturnValue('idle'),
  triggerSync: jest.fn().mockResolvedValue(undefined),
  enqueuePendingChange: jest.fn(),
  addSyncEngineListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
  saveQuerySubscription: jest.fn(),
  saveDatabaseSubscription: jest.fn(),
  deleteSubscription: jest.fn(),
  fetchSubscriptions: jest.fn().mockResolvedValue([]),
  addSubscriptionListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
  downloadAsset: jest.fn(),
  addAssetProgressListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
  addBatchProgressListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
  fetchRecordWithReferences: jest.fn().mockResolvedValue({ root: null, related: [] }),
  deleteRecordWithReferences: jest.fn().mockResolvedValue(undefined),
  enqueueOfflineOperation: jest.fn(),
  drainOfflineQueue: jest.fn().mockResolvedValue({ succeeded: 0, failed: 0, skipped: 0 }),
  getOfflineQueueStatus: jest.fn().mockResolvedValue({ pendingCount: 0, failedCount: 0 }),
  clearOfflineQueue: jest.fn().mockResolvedValue(undefined),
  retryFailedOperations: jest.fn().mockResolvedValue(undefined),
  addOfflineQueueListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
  createCloudKitClient: jest.fn(),
  clearPersistedCursors: jest.fn().mockResolvedValue(undefined),
  batchFetchRecords: jest.fn().mockResolvedValue([]),
  addRateLimitedListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
  __debugDumpContainerInfo: jest.fn(),
  __debugListZones: jest.fn().mockResolvedValue([]),
  __debugFetchRawRecord: jest.fn(),
  __debugClearZone: jest.fn(),
}));

import * as AndroidModule from '../ExpoCloudKit.android';
import * as WebModule from '../ExpoCloudKit.web';
import { CloudKitNotSupportedError } from '../errors';
import { authenticateAndroid, handleAuthRedirect } from '../android/auth';

// ---------------------------------------------------------------------------
// 1. Web-supported functions are re-exported and callable on Android
// ---------------------------------------------------------------------------

describe('android module — web-supported functions', () => {
  it('exports saveRecords and it is callable', async () => {
    expect(typeof AndroidModule.saveRecords).toBe('function');
    const result = await AndroidModule.saveRecords([]);
    expect(result).toEqual([]);
  });

  it('exports getAccountStatus and it is callable', async () => {
    expect(typeof AndroidModule.getAccountStatus).toBe('function');
    const status = await AndroidModule.getAccountStatus();
    expect(status).toBe('available');
  });

  it('exports queryRecords and it is callable', async () => {
    expect(typeof AndroidModule.queryRecords).toBe('function');
    const result = await AndroidModule.queryRecords('Note');
    expect(result).toEqual({ records: [] });
  });

  it('exports configureWeb and it is callable', async () => {
    expect(typeof AndroidModule.configureWeb).toBe('function');
    await expect(
      AndroidModule.configureWeb('iCloud.com.example.app', { apiToken: 'tok' })
    ).resolves.toBeUndefined();
  });

  it('exports isSyncEngineAvailable', () => {
    expect(typeof AndroidModule.isSyncEngineAvailable).toBe('function');
    expect(AndroidModule.isSyncEngineAvailable()).toBe(false);
  });

  it('exports addAccountStatusListener and returns a removable subscription', () => {
    expect(typeof AndroidModule.addAccountStatusListener).toBe('function');
    const sub = AndroidModule.addAccountStatusListener(() => {});
    expect(typeof sub.remove).toBe('function');
    expect(() => sub.remove()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Native-only function — resolveSyncConflict throws CloudKitNotSupportedError
// ---------------------------------------------------------------------------

describe('android module — resolveSyncConflict (native-only stub)', () => {
  it('throws CloudKitNotSupportedError', () => {
    expect(() => AndroidModule.resolveSyncConflict('req-1', null)).toThrow(
      CloudKitNotSupportedError
    );
  });

  it('thrown error has code NOT_SUPPORTED', () => {
    try {
      AndroidModule.resolveSyncConflict('req-1', null);
      fail('expected throw');
    } catch (err) {
      expect(err instanceof CloudKitNotSupportedError).toBe(true);
      if (err instanceof CloudKitNotSupportedError) {
        expect(err.code).toBe('NOT_SUPPORTED');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. addSyncHealthListener returns a no-op Subscription (does not throw)
// ---------------------------------------------------------------------------

describe('android module — addSyncHealthListener (no-op stub)', () => {
  it('returns a subscription without throwing', () => {
    expect(typeof AndroidModule.addSyncHealthListener).toBe('function');
    const sub = AndroidModule.addSyncHealthListener(() => {});
    expect(sub).toBeDefined();
    expect(typeof sub.remove).toBe('function');
  });

  it('subscription.remove() is a no-op', () => {
    const sub = AndroidModule.addSyncHealthListener(() => {});
    expect(() => sub.remove()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. handleAuthRedirect
// ---------------------------------------------------------------------------

describe('handleAuthRedirect', () => {
  it('returns true for a URL containing "cloudkit"', () => {
    expect(handleAuthRedirect('myapp://cloudkit/callback?token=abc')).toBe(true);
  });

  it('returns true for a URL containing "apple"', () => {
    expect(handleAuthRedirect('https://appleid.apple.com/auth/callback')).toBe(true);
  });

  it('returns false for an unrelated URL', () => {
    expect(handleAuthRedirect('https://example.com/oauth/callback')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(handleAuthRedirect('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Android module exports all web-compatible functions
// ---------------------------------------------------------------------------

describe('android module — parity with web module', () => {
  // Build the list of function names exported from the web module mock.
  const webFunctionNames = Object.keys(WebModule).filter(
    (key) => typeof (WebModule as Record<string, unknown>)[key] === 'function'
  );

  it('exports every function the web module exports', () => {
    const androidKeys = new Set(Object.keys(AndroidModule));
    const missing = webFunctionNames.filter((name) => !androidKeys.has(name));
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. authenticateAndroid — opens browser when not yet authenticated
// ---------------------------------------------------------------------------

describe('authenticateAndroid', () => {
  const TEST_OPTIONS = { apiToken: 'test-token', environment: 'development' as const };

  beforeEach(() => {
    jest.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const webMod = require('../ExpoCloudKit.web') as {
      isWebAuthenticated: jest.Mock;
      configureWeb: jest.Mock;
    };
    webMod.isWebAuthenticated.mockReturnValue(false);
    webMod.configureWeb.mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rn = require('react-native') as {
      Linking: { canOpenURL: jest.Mock; openURL: jest.Mock };
    };
    rn.Linking.canOpenURL.mockResolvedValue(true);
    rn.Linking.openURL.mockResolvedValue(undefined);
  });

  it('calls configureWeb with the containerId and options', async () => {
    await authenticateAndroid('iCloud.com.example.app', TEST_OPTIONS);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const webMod = require('../ExpoCloudKit.web') as { configureWeb: jest.Mock };
    expect(webMod.configureWeb).toHaveBeenCalledWith(
      'iCloud.com.example.app',
      TEST_OPTIONS
    );
  });

  it('skips configureWeb when no options are provided', async () => {
    await authenticateAndroid('iCloud.com.example.app');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const webMod = require('../ExpoCloudKit.web') as { configureWeb: jest.Mock };
    expect(webMod.configureWeb).not.toHaveBeenCalled();
  });

  it('opens the sign-in URL in the system browser when not authenticated', async () => {
    await authenticateAndroid('iCloud.com.example.app', TEST_OPTIONS);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rn = require('react-native') as { Linking: { openURL: jest.Mock } };
    expect(rn.Linking.openURL).toHaveBeenCalledWith(
      expect.stringContaining('identity.apple.com')
    );
  });

  it('does not open the browser when already authenticated', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const webMod = require('../ExpoCloudKit.web') as {
      isWebAuthenticated: jest.Mock;
    };
    webMod.isWebAuthenticated.mockReturnValue(true);
    await authenticateAndroid('iCloud.com.example.app', TEST_OPTIONS);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rn = require('react-native') as { Linking: { openURL: jest.Mock } };
    expect(rn.Linking.openURL).not.toHaveBeenCalled();
  });

  it('passes options through to configureWeb', async () => {
    await authenticateAndroid('iCloud.com.example.app', {
      environment: 'production',
      apiToken: 'tok',
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const webMod = require('../ExpoCloudKit.web') as { configureWeb: jest.Mock };
    expect(webMod.configureWeb).toHaveBeenCalledWith('iCloud.com.example.app', {
      environment: 'production',
      apiToken: 'tok',
    });
  });
});
