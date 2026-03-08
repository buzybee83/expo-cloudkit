/**
 * Unit tests for useCloudKitSync hook.
 */

import { renderHook, act, waitFor } from '@testing-library/react';

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('../ExpoCloudKit', () => ({
  fetchRecord: jest.fn(),
  queryRecords: jest.fn(),
  startSyncEngine: jest.fn(),
  stopSyncEngine: jest.fn(),
  triggerSync: jest.fn(),
  enqueuePendingChange: jest.fn(),
  getSyncState: jest.fn(),
  addSyncEngineListener: jest.fn(),
  addSubscriptionListener: jest.fn(),
}));

import { useCloudKitSync } from '../hooks';
import { getMocks } from './mocks';
import { CloudKitError, CloudKitErrorCode } from '../errors';
import type {
  SyncState,
  SyncEngineEvent,
  RecordsFetchedEvent,
  RecordsSentEvent,
  SyncErrorEvent,
} from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const notStartedState: SyncState = { usesSyncEngine: false, status: 'notStarted' };
const idleState: SyncState = { usesSyncEngine: true, status: 'idle' };
const syncingState: SyncState = { usesSyncEngine: true, status: 'syncing' };

function makeNoopSubscription() {
  return { remove: jest.fn() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useCloudKitSync', () => {
  let mocks: ReturnType<typeof getMocks>;
  let capturedSyncListener: ((event: SyncEngineEvent) => void) | undefined;
  let mockSubscription: ReturnType<typeof makeNoopSubscription>;

  beforeEach(() => {
    jest.clearAllMocks();
    mocks = getMocks();
    capturedSyncListener = undefined;
    mockSubscription = makeNoopSubscription();

    // getSyncState is called synchronously in useState initializer — must return SyncState
    mocks.mockGetSyncState.mockReturnValue(notStartedState);

    // Default successful resolutions
    mocks.mockStartSyncEngine.mockResolvedValue(undefined);
    mocks.mockStopSyncEngine.mockResolvedValue(undefined);
    mocks.mockTriggerSync.mockResolvedValue(undefined);

    // Capture the listener callback so tests can fire events
    mocks.mockAddSyncEngineListener.mockImplementation(
      (cb: (event: SyncEngineEvent) => void) => {
        capturedSyncListener = cb;
        return mockSubscription;
      }
    );
  });

  it('starts the sync engine on mount with correct config', async () => {
    renderHook(() =>
      useCloudKitSync({ zones: ['MyZone'], database: 'private', automaticallySync: true })
    );

    await waitFor(() => expect(mocks.mockStartSyncEngine).toHaveBeenCalledTimes(1));
    expect(mocks.mockStartSyncEngine).toHaveBeenCalledWith({
      zones: ['MyZone'],
      database: 'private',
      automaticallySync: true,
    });
  });

  it('registers a sync engine listener on mount', async () => {
    renderHook(() => useCloudKitSync({ zones: ['MyZone'] }));

    await waitFor(() => expect(mocks.mockAddSyncEngineListener).toHaveBeenCalledTimes(1));
    expect(capturedSyncListener).toBeDefined();
  });

  it('stops sync engine and removes listener on unmount', async () => {
    const { unmount } = renderHook(() => useCloudKitSync({ zones: ['MyZone'] }));

    await waitFor(() => expect(capturedSyncListener).toBeDefined());

    unmount();

    expect(mockSubscription.remove).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mocks.mockStopSyncEngine).toHaveBeenCalled());
  });

  it('reflects getSyncState() return value as initial state', () => {
    mocks.mockGetSyncState.mockReturnValue(idleState);

    const { result } = renderHook(() => useCloudKitSync({ zones: ['MyZone'] }));

    expect(result.current.state).toEqual(idleState);
  });

  it('isRunning is false when status is notStarted', () => {
    mocks.mockGetSyncState.mockReturnValue(notStartedState);

    const { result } = renderHook(() => useCloudKitSync({ zones: ['MyZone'] }));

    expect(result.current.isRunning).toBe(false);
  });

  it('isRunning is true when status is idle', () => {
    mocks.mockGetSyncState.mockReturnValue(idleState);

    const { result } = renderHook(() => useCloudKitSync({ zones: ['MyZone'] }));

    expect(result.current.isRunning).toBe(true);
  });

  it('stateChanged event updates state', async () => {
    const { result } = renderHook(() => useCloudKitSync({ zones: ['MyZone'] }));

    await waitFor(() => expect(capturedSyncListener).toBeDefined());

    act(() => {
      capturedSyncListener?.({ type: 'stateChanged', state: syncingState });
    });

    expect(result.current.state).toEqual(syncingState);
    expect(result.current.isRunning).toBe(true);
  });

  it('stateChanged event with idle state marks isRunning true', async () => {
    const { result } = renderHook(() => useCloudKitSync({ zones: ['MyZone'] }));

    await waitFor(() => expect(capturedSyncListener).toBeDefined());

    act(() => {
      capturedSyncListener?.({ type: 'stateChanged', state: idleState });
    });

    expect(result.current.state).toEqual(idleState);
    expect(result.current.isRunning).toBe(true);
  });

  it('onRecordsFetched callback is called when recordsFetched event fires', async () => {
    const onRecordsFetched = jest.fn();

    renderHook(() =>
      useCloudKitSync({ zones: ['MyZone'], onRecordsFetched })
    );

    await waitFor(() => expect(capturedSyncListener).toBeDefined());

    const event: RecordsFetchedEvent = {
      type: 'recordsFetched',
      zoneName: 'MyZone',
      changedRecords: [],
      deletedRecordIDs: [],
    };

    act(() => {
      capturedSyncListener?.(event);
    });

    expect(onRecordsFetched).toHaveBeenCalledTimes(1);
    expect(onRecordsFetched).toHaveBeenCalledWith(event);
  });

  it('onRecordsSent callback is called when recordsSent event fires', async () => {
    const onRecordsSent = jest.fn();

    renderHook(() =>
      useCloudKitSync({ zones: ['MyZone'], onRecordsSent })
    );

    await waitFor(() => expect(capturedSyncListener).toBeDefined());

    const event: RecordsSentEvent = {
      type: 'recordsSent',
      savedRecords: [],
      failedRecords: [],
    };

    act(() => {
      capturedSyncListener?.(event);
    });

    expect(onRecordsSent).toHaveBeenCalledTimes(1);
    expect(onRecordsSent).toHaveBeenCalledWith(event);
  });

  it('onSyncError callback fires and error state is set on syncError event', async () => {
    const onSyncError = jest.fn();

    const { result } = renderHook(() =>
      useCloudKitSync({ zones: ['MyZone'], onSyncError })
    );

    await waitFor(() => expect(capturedSyncListener).toBeDefined());

    const errorEvent: SyncErrorEvent = {
      type: 'syncError',
      error: { code: CloudKitErrorCode.NETWORK_UNAVAILABLE, message: 'Network error' },
    };

    act(() => {
      capturedSyncListener?.(errorEvent);
    });

    expect(onSyncError).toHaveBeenCalledTimes(1);
    expect(onSyncError).toHaveBeenCalledWith(errorEvent);
    expect(result.current.error).toBeInstanceOf(CloudKitError);
  });

  it('triggerSync calls the imperative function', async () => {
    const { result } = renderHook(() => useCloudKitSync({ zones: ['MyZone'] }));

    await act(async () => {
      await result.current.triggerSync();
    });

    expect(mocks.mockTriggerSync).toHaveBeenCalledTimes(1);
  });

  it('triggerSync captures errors into the error state', async () => {
    const syncError = new CloudKitError(
      CloudKitErrorCode.SYNC_ENGINE_NOT_RUNNING,
      'Not running'
    );
    mocks.mockTriggerSync.mockRejectedValue(syncError);

    const { result } = renderHook(() => useCloudKitSync({ zones: ['MyZone'] }));

    await act(async () => {
      await result.current.triggerSync();
    });

    expect(result.current.error).toBeInstanceOf(CloudKitError);
    expect(result.current.error?.code).toBe(CloudKitErrorCode.SYNC_ENGINE_NOT_RUNNING);
  });

  it('enabled: false — engine is not started, no listener registered', async () => {
    renderHook(() => useCloudKitSync({ zones: ['MyZone'], enabled: false }));

    // Wait a tick to let any async effects settle
    await act(async () => {});

    expect(mocks.mockStartSyncEngine).not.toHaveBeenCalled();
    expect(mocks.mockAddSyncEngineListener).not.toHaveBeenCalled();
  });

  it('enabled: false — stopSyncEngine is called to guard against already-running state', async () => {
    renderHook(() => useCloudKitSync({ zones: ['MyZone'], enabled: false }));

    await waitFor(() => expect(mocks.mockStopSyncEngine).toHaveBeenCalled());
  });

  it('enabled toggle from false to true starts the engine', async () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useCloudKitSync({ zones: ['MyZone'], enabled }),
      { initialProps: { enabled: false } }
    );

    expect(mocks.mockStartSyncEngine).not.toHaveBeenCalled();

    rerender({ enabled: true });

    await waitFor(() =>
      expect(mocks.mockStartSyncEngine).toHaveBeenCalledTimes(1)
    );
  });

  it('enabled toggle from true to false stops the engine', async () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useCloudKitSync({ zones: ['MyZone'], enabled }),
      { initialProps: { enabled: true } }
    );

    await waitFor(() => expect(mocks.mockStartSyncEngine).toHaveBeenCalledTimes(1));

    rerender({ enabled: false });

    // Cleanup of the previous effect + new effect with enabled=false both stop the engine
    await waitFor(() => expect(mocks.mockStopSyncEngine).toHaveBeenCalled());
  });

  it('zones change triggers engine restart', async () => {
    const { rerender } = renderHook(
      ({ zones }: { zones: string[] }) => useCloudKitSync({ zones }),
      { initialProps: { zones: ['Zone1'] } }
    );

    await waitFor(() =>
      expect(mocks.mockStartSyncEngine).toHaveBeenCalledWith(
        expect.objectContaining({ zones: ['Zone1'] })
      )
    );

    rerender({ zones: ['Zone1', 'Zone2'] });

    await waitFor(() =>
      expect(mocks.mockStartSyncEngine).toHaveBeenCalledWith(
        expect.objectContaining({ zones: ['Zone1', 'Zone2'] })
      )
    );

    expect(mocks.mockStartSyncEngine).toHaveBeenCalledTimes(2);
  });
});
