/**
 * Shared mock helpers for expo-cloudkit hook tests.
 *
 * Usage in each test file:
 *
 *   jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
 *   jest.mock('../ExpoCloudKit', () => ExpoCloudKitMockFactory());
 *
 *   import { getMocks } from './mocks';
 *
 * Then in beforeEach:
 *   const mocks = getMocks();
 */

import type * as ExpoCloudKitModule from '../ExpoCloudKit';

/**
 * Returns a factory object suitable for use as a jest.mock() factory.
 * All exported functions are replaced with jest.fn().
 *
 * NOTE: This function is referenced inside jest.mock() factories which are
 * hoisted by Jest — it must only use identifiers available at hoist time.
 */
export function ExpoCloudKitMockFactory() {
  return {
    fetchRecord: jest.fn(),
    queryRecords: jest.fn(),
    startSyncEngine: jest.fn(),
    stopSyncEngine: jest.fn(),
    triggerSync: jest.fn(),
    enqueuePendingChange: jest.fn(),
    getSyncState: jest.fn(),
    addSyncEngineListener: jest.fn(),
    addSubscriptionListener: jest.fn(),
    configure: jest.fn(),
    getAccountStatus: jest.fn(),
    addAccountStatusListener: jest.fn(),
    createZone: jest.fn(),
    deleteZone: jest.fn(),
    fetchZones: jest.fn(),
    saveRecords: jest.fn(),
    deleteRecords: jest.fn(),
    fetchRecordZoneChanges: jest.fn(),
    isSyncEngineAvailable: jest.fn(),
    addAssetProgressListener: jest.fn(),
    downloadAsset: jest.fn(),
    saveQuerySubscription: jest.fn(),
    saveDatabaseSubscription: jest.fn(),
    deleteSubscription: jest.fn(),
    fetchSubscriptions: jest.fn(),
    createShare: jest.fn(),
    deleteShare: jest.fn(),
    presentSharingUI: jest.fn(),
    fetchShareParticipants: jest.fn(),
    updateSharePermission: jest.fn(),
    removeShareParticipant: jest.fn(),
    acceptShare: jest.fn(),
    fetchSharedDatabaseZones: jest.fn(),
    addShareAcceptedListener: jest.fn(),
  };
}

/**
 * Returns typed references to the auto-mocked ExpoCloudKit module functions.
 * Call after jest.mock('../ExpoCloudKit', ...) has been declared.
 */
export function getMocks() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../ExpoCloudKit') as jest.Mocked<typeof ExpoCloudKitModule>;
  return {
    mockFetchRecord: mod.fetchRecord as jest.MockedFunction<typeof mod.fetchRecord>,
    mockQueryRecords: mod.queryRecords as jest.MockedFunction<typeof mod.queryRecords>,
    mockStartSyncEngine: mod.startSyncEngine as jest.MockedFunction<typeof mod.startSyncEngine>,
    mockStopSyncEngine: mod.stopSyncEngine as jest.MockedFunction<typeof mod.stopSyncEngine>,
    mockTriggerSync: mod.triggerSync as jest.MockedFunction<typeof mod.triggerSync>,
    mockEnqueuePendingChange: mod.enqueuePendingChange as jest.MockedFunction<typeof mod.enqueuePendingChange>,
    mockGetSyncState: mod.getSyncState as jest.MockedFunction<typeof mod.getSyncState>,
    mockAddSyncEngineListener: mod.addSyncEngineListener as jest.MockedFunction<typeof mod.addSyncEngineListener>,
    mockAddSubscriptionListener: mod.addSubscriptionListener as jest.MockedFunction<typeof mod.addSubscriptionListener>,
  };
}
