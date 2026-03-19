/**
 * Tests for graceful fallback when the native ExpoCloudKit module is unavailable.
 *
 * Covers the Expo Go scenario where requireNativeModule throws because the
 * custom native module is not bundled in the runtime.
 */

// ---------------------------------------------------------------------------
// Static class-level tests that don't require module resets
// ---------------------------------------------------------------------------

describe('CloudKitUnavailableError (static class checks)', () => {
  // Import once at the top level — no module resets in this describe block.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { CloudKitUnavailableError, CloudKitError, CloudKitErrorCode } = require('../errors') as typeof import('../errors');

  it('is an instance of CloudKitUnavailableError', () => {
    const err = new CloudKitUnavailableError();
    expect(err).toBeInstanceOf(CloudKitUnavailableError);
  });

  it('is an instance of the base CloudKitError', () => {
    const err = new CloudKitUnavailableError();
    expect(err).toBeInstanceOf(CloudKitError);
  });

  it('has the MODULE_UNAVAILABLE code', () => {
    const err = new CloudKitUnavailableError();
    expect(err.code).toBe(CloudKitErrorCode.MODULE_UNAVAILABLE);
  });

  it('has the correct name', () => {
    const err = new CloudKitUnavailableError();
    expect(err.name).toBe('CloudKitUnavailableError');
  });

  it('includes a helpful message referencing npx expo run:ios', () => {
    const err = new CloudKitUnavailableError();
    expect(err.message).toContain('npx expo run:ios');
  });

  it('has MODULE_UNAVAILABLE in CloudKitErrorCode enum', () => {
    expect(CloudKitErrorCode.MODULE_UNAVAILABLE).toBe('MODULE_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sets up expo-modules-core mock so that requireNativeModule succeeds,
 * then loads a fresh ExpoCloudKit module and errors module.
 * Call inside a beforeEach that has jest.resetModules().
 */
function loadModulesWithNativeAvailable() {
  jest.mock('expo-modules-core', () => ({
    requireNativeModule: () => ({
      configure: jest.fn(),
      getAccountStatus: jest.fn(),
      createZone: jest.fn(),
      deleteZone: jest.fn(),
      fetchZones: jest.fn(),
      saveRecords: jest.fn(),
      fetchRecord: jest.fn(),
      queryRecords: jest.fn(),
      deleteRecords: jest.fn(),
      fetchRecordZoneChanges: jest.fn(),
      isSyncEngineAvailable: jest.fn().mockReturnValue(true),
      getSyncState: jest.fn().mockReturnValue({ usesSyncEngine: true, status: 'idle' }),
      startSyncEngine: jest.fn(),
      stopSyncEngine: jest.fn(),
      triggerSync: jest.fn(),
      enqueuePendingChange: jest.fn(),
      downloadAsset: jest.fn(),
    }),
    EventEmitter: jest.fn().mockImplementation(() => ({
      addListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
    })),
  }));
  return {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod: require('../ExpoCloudKit') as typeof import('../ExpoCloudKit'),
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    errors: require('../errors') as typeof import('../errors'),
  };
}

/**
 * Sets up expo-modules-core mock so that requireNativeModule throws (Expo Go scenario),
 * then loads a fresh ExpoCloudKit module and errors module.
 * Call inside a beforeEach that has jest.resetModules().
 */
function loadModulesWithNativeUnavailable() {
  jest.mock('expo-modules-core', () => ({
    requireNativeModule: () => {
      throw new Error('Native module ExpoCloudKit not found.');
    },
    EventEmitter: jest.fn().mockImplementation(() => ({
      addListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
    })),
  }));
  return {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod: require('../ExpoCloudKit') as typeof import('../ExpoCloudKit'),
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    errors: require('../errors') as typeof import('../errors'),
  };
}

// ---------------------------------------------------------------------------
// isNativeModuleAvailable
// ---------------------------------------------------------------------------

describe('isNativeModuleAvailable() — native available', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('returns true when requireNativeModule succeeds', () => {
    const { mod } = loadModulesWithNativeAvailable();
    expect(mod.isNativeModuleAvailable()).toBe(true);
  });
});

describe('isNativeModuleAvailable() — native unavailable', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('returns false when requireNativeModule throws', () => {
    const { mod } = loadModulesWithNativeUnavailable();
    expect(mod.isNativeModuleAvailable()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Function calls when native module is unavailable
// ---------------------------------------------------------------------------

describe('API functions when native module is unavailable', () => {
  let mod: typeof import('../ExpoCloudKit');
  let CloudKitUnavailableError: typeof import('../errors').CloudKitUnavailableError;
  let CloudKitErrorCode: typeof import('../errors').CloudKitErrorCode;

  beforeEach(() => {
    jest.resetModules();
    const loaded = loadModulesWithNativeUnavailable();
    mod = loaded.mod;
    CloudKitUnavailableError = loaded.errors.CloudKitUnavailableError;
    CloudKitErrorCode = loaded.errors.CloudKitErrorCode;
  });

  async function expectUnavailableError(fn: () => unknown): Promise<void> {
    try {
      await Promise.resolve(fn());
      throw new Error('SENTINEL: Expected CloudKitUnavailableError but no error was thrown');
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith('SENTINEL:')) {
        throw err;
      }
      expect(err).toBeInstanceOf(CloudKitUnavailableError);
      expect((err as InstanceType<typeof CloudKitUnavailableError>).code).toBe(
        CloudKitErrorCode.MODULE_UNAVAILABLE
      );
    }
  }

  it('configure() throws CloudKitUnavailableError', () => {
    expect(() => mod.configure('iCloud.com.test')).toThrow(CloudKitUnavailableError);
  });

  it('getAccountStatus() rejects with CloudKitUnavailableError', async () => {
    await expectUnavailableError(() => mod.getAccountStatus());
  });

  it('createZone() rejects with CloudKitUnavailableError', async () => {
    await expectUnavailableError(() => mod.createZone('TestZone'));
  });

  it('deleteZone() rejects with CloudKitUnavailableError', async () => {
    await expectUnavailableError(() => mod.deleteZone('TestZone'));
  });

  it('fetchZones() rejects with CloudKitUnavailableError', async () => {
    await expectUnavailableError(() => mod.fetchZones());
  });

  it('saveRecords() rejects with CloudKitUnavailableError', async () => {
    await expectUnavailableError(() =>
      mod.saveRecords([{ recordType: 'Note', fields: {} }])
    );
  });

  it('fetchRecord() rejects with CloudKitUnavailableError', async () => {
    await expectUnavailableError(() => mod.fetchRecord('Note', 'rec-123'));
  });

  it('queryRecords() rejects with CloudKitUnavailableError', async () => {
    await expectUnavailableError(() => mod.queryRecords('Note'));
  });

  it('deleteRecords() rejects with CloudKitUnavailableError', async () => {
    await expectUnavailableError(() =>
      mod.deleteRecords([{ recordName: 'rec-123' }])
    );
  });

  it('fetchRecordZoneChanges() rejects with CloudKitUnavailableError', async () => {
    await expectUnavailableError(() => mod.fetchRecordZoneChanges(['TestZone']));
  });

  it('startSyncEngine() rejects with CloudKitUnavailableError', async () => {
    await expectUnavailableError(() => mod.startSyncEngine({ zones: ['TestZone'] }));
  });

  it('triggerSync() rejects with CloudKitUnavailableError', async () => {
    await expectUnavailableError(() => mod.triggerSync());
  });

  it('stopSyncEngine() rejects with CloudKitUnavailableError', async () => {
    await expectUnavailableError(() => mod.stopSyncEngine());
  });

  it('enqueuePendingChange() throws CloudKitUnavailableError', () => {
    expect(() =>
      mod.enqueuePendingChange({ type: 'delete', recordIdentifier: { recordName: 'rec-1' } })
    ).toThrow(CloudKitUnavailableError);
  });

  it('downloadAsset() rejects with CloudKitUnavailableError', async () => {
    await expectUnavailableError(() =>
      mod.downloadAsset('Photo', 'rec-123', 'image', '/tmp/photo.jpg')
    );
  });

  it('addAccountStatusListener() throws CloudKitUnavailableError', () => {
    expect(() => mod.addAccountStatusListener(() => {})).toThrow(CloudKitUnavailableError);
  });

  it('addSyncEngineListener() throws CloudKitUnavailableError', () => {
    expect(() => mod.addSyncEngineListener(() => {})).toThrow(CloudKitUnavailableError);
  });

  it('addAssetProgressListener() throws CloudKitUnavailableError', () => {
    expect(() => mod.addAssetProgressListener(() => {})).toThrow(CloudKitUnavailableError);
  });

  it('getSyncState() returns notStarted sentinel instead of throwing', () => {
    // getSyncState is intentionally non-throwing when native is unavailable —
    // it returns a safe default so callers can read state without try/catch.
    const state = mod.getSyncState();
    expect(state).toEqual({ usesSyncEngine: false, status: 'notStarted' });
  });

  it('isSyncEngineAvailable() returns false instead of throwing', () => {
    expect(mod.isSyncEngineAvailable()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Function calls when native module IS available — verify no regression
// ---------------------------------------------------------------------------

describe('API functions when native module is available', () => {
  let mod: typeof import('../ExpoCloudKit');

  beforeEach(() => {
    jest.resetModules();
    mod = loadModulesWithNativeAvailable().mod;
  });

  it('isNativeModuleAvailable() returns true', () => {
    expect(mod.isNativeModuleAvailable()).toBe(true);
  });

  it('configure() does not throw', () => {
    expect(() => mod.configure('iCloud.com.test')).not.toThrow();
  });

  it('isSyncEngineAvailable() returns native value', () => {
    expect(mod.isSyncEngineAvailable()).toBe(true);
  });

  it('getSyncState() returns native value', () => {
    expect(mod.getSyncState()).toEqual({ usesSyncEngine: true, status: 'idle' });
  });
});
