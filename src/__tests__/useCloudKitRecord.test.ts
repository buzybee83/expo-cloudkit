/**
 * Unit tests for useCloudKitRecord hook.
 */

import { renderHook, act, waitFor } from '@testing-library/react';

// jest.mock calls are hoisted above imports by Jest — explicit factories avoid
// loading the real module (which requires expo-modules-core native bridge).
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

import { useCloudKitRecord } from '../hooks';
import { getMocks } from './mocks';
import { CloudKitError, CloudKitErrorCode } from '../errors';
import type { CloudKitRecord } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockRecord: CloudKitRecord = {
  recordType: 'Note',
  recordName: 'rec-1',
  zoneName: '_defaultZone',
  ownerName: '__defaultOwner__',
  modificationDate: new Date('2026-01-01T00:00:00.000Z').getTime(),
  creationDate: new Date('2026-01-01T00:00:00.000Z').getTime(),
  changeTag: 'abc',
  fields: {},
};

const mockRecord2: CloudKitRecord = {
  ...mockRecord,
  recordName: 'rec-2',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useCloudKitRecord', () => {
  let mocks: ReturnType<typeof getMocks>;

  beforeEach(() => {
    jest.clearAllMocks();
    mocks = getMocks();
  });

  it('fetches a record on mount — happy path', async () => {
    mocks.mockFetchRecord.mockResolvedValue(mockRecord);

    const { result } = renderHook(() =>
      useCloudKitRecord('rec-1', { recordType: 'Note' })
    );

    // Initial state: loading before first fetch completes
    expect(result.current.loading).toBe(true);
    expect(result.current.fetching).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeUndefined();

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toEqual(mockRecord);
    expect(result.current.fetching).toBe(false);
    expect(result.current.error).toBeUndefined();
    expect(mocks.mockFetchRecord).toHaveBeenCalledTimes(1);
    // hook defaults database to 'private' when not specified
    expect(mocks.mockFetchRecord).toHaveBeenCalledWith('Note', 'rec-1', undefined, 'private');
  });

  it('passes zoneName and database to fetchRecord', async () => {
    mocks.mockFetchRecord.mockResolvedValue(mockRecord);

    const { result } = renderHook(() =>
      useCloudKitRecord('rec-1', {
        recordType: 'Note',
        zoneName: 'MyZone',
        database: 'private',
      })
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mocks.mockFetchRecord).toHaveBeenCalledWith('Note', 'rec-1', 'MyZone', 'private');
  });

  it('sets error state when fetch rejects and preserves previous data', async () => {
    mocks.mockFetchRecord.mockResolvedValue(mockRecord);

    const { result } = renderHook(() =>
      useCloudKitRecord('rec-1', { recordType: 'Note' })
    );

    await waitFor(() => expect(result.current.data).toEqual(mockRecord));

    // Second call rejects
    const fetchError = new CloudKitError(CloudKitErrorCode.NETWORK_UNAVAILABLE, 'Offline');
    mocks.mockFetchRecord.mockRejectedValue(fetchError);

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.error).toBeInstanceOf(CloudKitError);
    expect(result.current.error?.code).toBe(CloudKitErrorCode.NETWORK_UNAVAILABLE);
    // Previous data is preserved (stale-while-revalidate)
    expect(result.current.data).toEqual(mockRecord);
    expect(result.current.loading).toBe(false);
    expect(result.current.fetching).toBe(false);
  });

  it('wraps unknown native errors in CloudKitError', async () => {
    mocks.mockFetchRecord.mockRejectedValue({ code: 'RECORD_NOT_FOUND', message: 'Not found' });

    const { result } = renderHook(() =>
      useCloudKitRecord('rec-1', { recordType: 'Note' })
    );

    await waitFor(() => expect(result.current.error).toBeInstanceOf(CloudKitError));
    expect(result.current.error?.code).toBe(CloudKitErrorCode.RECORD_NOT_FOUND);
  });

  it('is inert when recordName is undefined — no fetch, inert state', () => {
    const { result } = renderHook(() =>
      useCloudKitRecord(undefined, { recordType: 'Note' })
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.fetching).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeUndefined();
    expect(mocks.mockFetchRecord).not.toHaveBeenCalled();
  });

  it('is inert when enabled is false — no fetch, inert state', () => {
    const { result } = renderHook(() =>
      useCloudKitRecord('rec-1', { recordType: 'Note', enabled: false })
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.fetching).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeUndefined();
    expect(mocks.mockFetchRecord).not.toHaveBeenCalled();
  });

  it('refetch() triggers a new fetch and updates data', async () => {
    mocks.mockFetchRecord.mockResolvedValue(mockRecord);

    const { result } = renderHook(() =>
      useCloudKitRecord('rec-1', { recordType: 'Note' })
    );

    await waitFor(() => expect(result.current.data).toEqual(mockRecord));

    // Update mock to return a different record on next call
    mocks.mockFetchRecord.mockResolvedValue(mockRecord2);

    let returnedRecord: CloudKitRecord | undefined;
    await act(async () => {
      returnedRecord = await result.current.refetch();
    });

    expect(returnedRecord).toEqual(mockRecord2);
    expect(result.current.data).toEqual(mockRecord2);
    expect(mocks.mockFetchRecord).toHaveBeenCalledTimes(2);
  });

  it('refetch() returns undefined when enabled is false', async () => {
    const { result } = renderHook(() =>
      useCloudKitRecord('rec-1', { recordType: 'Note', enabled: false })
    );

    let returnValue: CloudKitRecord | undefined;
    await act(async () => {
      returnValue = await result.current.refetch();
    });

    expect(returnValue).toBeUndefined();
    expect(mocks.mockFetchRecord).not.toHaveBeenCalled();
  });

  it('re-fetches when recordName changes', async () => {
    mocks.mockFetchRecord.mockResolvedValue(mockRecord);

    const { result, rerender } = renderHook(
      ({ recordName }: { recordName: string }) =>
        useCloudKitRecord(recordName, { recordType: 'Note' }),
      { initialProps: { recordName: 'rec-1' } }
    );

    await waitFor(() => expect(result.current.data).toEqual(mockRecord));
    // hook defaults database to 'private' when not specified
    expect(mocks.mockFetchRecord).toHaveBeenCalledWith('Note', 'rec-1', undefined, 'private');

    mocks.mockFetchRecord.mockResolvedValue(mockRecord2);
    rerender({ recordName: 'rec-2' });

    await waitFor(() => expect(result.current.data).toEqual(mockRecord2));
    expect(mocks.mockFetchRecord).toHaveBeenCalledWith('Note', 'rec-2', undefined, 'private');
    expect(mocks.mockFetchRecord).toHaveBeenCalledTimes(2);
  });

  it('discards stale fetch result when recordName changes before first resolves', async () => {
    let resolveFirst!: (value: CloudKitRecord) => void;
    const firstPromise = new Promise<CloudKitRecord>((resolve) => { resolveFirst = resolve; });
    mocks.mockFetchRecord
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce(mockRecord2);

    const { result, rerender } = renderHook(
      ({ recordName }: { recordName: string }) =>
        useCloudKitRecord(recordName, { recordType: 'Note' }),
      { initialProps: { recordName: 'rec-1' } }
    );

    // Immediately change recordName before first fetch resolves
    rerender({ recordName: 'rec-2' });

    // Second fetch resolves immediately
    await waitFor(() => expect(result.current.data).toEqual(mockRecord2));

    // Resolving the stale first fetch — its result should be discarded
    await act(async () => {
      resolveFirst(mockRecord);
    });

    // Data should still be mockRecord2, not mockRecord
    expect(result.current.data).toEqual(mockRecord2);
  });

  it('returns to inert state when enabled flips to false after having data', async () => {
    mocks.mockFetchRecord.mockResolvedValue(mockRecord);

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useCloudKitRecord('rec-1', { recordType: 'Note', enabled }),
      { initialProps: { enabled: true } }
    );

    await waitFor(() => expect(result.current.data).toEqual(mockRecord));

    rerender({ enabled: false });

    // Inert state is restored
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(false);
    expect(result.current.fetching).toBe(false);
  });

  it('loading is false on refetch after data has already been fetched', async () => {
    mocks.mockFetchRecord.mockResolvedValue(mockRecord);

    const { result } = renderHook(() =>
      useCloudKitRecord('rec-1', { recordType: 'Note' })
    );

    await waitFor(() => expect(result.current.data).toEqual(mockRecord));

    // Start refetch — loading should remain false (data already populated)
    let refetchPromise!: Promise<CloudKitRecord | undefined>;
    act(() => {
      refetchPromise = result.current.refetch();
    });

    // fetching should be true, but loading should stay false
    expect(result.current.fetching).toBe(true);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      await refetchPromise;
    });
  });
});
