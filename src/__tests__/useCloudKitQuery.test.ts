/**
 * Unit tests for useCloudKitQuery hook.
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

import { useCloudKitQuery } from '../hooks';
import { getMocks } from './mocks';
import { CloudKitError, CloudKitErrorCode } from '../errors';
import type { CloudKitRecord, QueryResult } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeRecord = (n: number): CloudKitRecord => ({
  recordType: 'Note',
  recordName: `rec-${n}`,
  zoneName: '_defaultZone',
  ownerName: '__defaultOwner__',
  modificationDate: '2026-01-01T00:00:00.000Z',
  creationDate: '2026-01-01T00:00:00.000Z',
  changeTag: `tag-${n}`,
  fields: {},
});

const page1Records = [makeRecord(1), makeRecord(2)];
const page2Records = [makeRecord(3), makeRecord(4)];

const page1Result: QueryResult = { records: page1Records, cursor: 'cursor-page2' };
const page1LastResult: QueryResult = { records: page1Records, cursor: undefined };
const page2Result: QueryResult = { records: page2Records, cursor: undefined };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useCloudKitQuery', () => {
  let mocks: ReturnType<typeof getMocks>;

  beforeEach(() => {
    jest.clearAllMocks();
    mocks = getMocks();
  });

  it('queries records on mount — happy path', async () => {
    mocks.mockQueryRecords.mockResolvedValue(page1LastResult);

    const { result } = renderHook(() => useCloudKitQuery('Note'));

    expect(result.current.loading).toBe(true);
    expect(result.current.fetching).toBe(true);
    expect(result.current.data).toBeUndefined();

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toEqual(page1Records);
    expect(result.current.fetching).toBe(false);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  it('sets hasMore when cursor is present', async () => {
    mocks.mockQueryRecords.mockResolvedValue(page1Result);

    const { result } = renderHook(() => useCloudKitQuery('Note'));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.hasMore).toBe(true);
  });

  it('fetchMore appends results and clears hasMore when cursor is exhausted', async () => {
    mocks.mockQueryRecords
      .mockResolvedValueOnce(page1Result)
      .mockResolvedValueOnce(page2Result);

    const { result } = renderHook(() => useCloudKitQuery('Note'));

    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(async () => {
      await result.current.fetchMore();
    });

    expect(result.current.data).toEqual([...page1Records, ...page2Records]);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.fetching).toBe(false);
    expect(mocks.mockQueryRecords).toHaveBeenCalledTimes(2);

    // Second call must pass the cursor
    const secondCall = mocks.mockQueryRecords.mock.calls[1];
    expect(secondCall[6]).toBe('cursor-page2');
  });

  it('fetchMore is a no-op when hasMore is false', async () => {
    mocks.mockQueryRecords.mockResolvedValue(page1LastResult);

    const { result } = renderHook(() => useCloudKitQuery('Note'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(false);

    await act(async () => {
      await result.current.fetchMore();
    });

    // No additional calls beyond the initial fetch
    expect(mocks.mockQueryRecords).toHaveBeenCalledTimes(1);
  });

  it('refetch resets cursor and replaces data with fresh results', async () => {
    const freshRecords = [makeRecord(10)];
    mocks.mockQueryRecords
      .mockResolvedValueOnce(page1LastResult)                               // initial
      .mockResolvedValueOnce({ records: freshRecords, cursor: undefined }); // refetch

    const { result } = renderHook(() => useCloudKitQuery('Note'));

    await waitFor(() => expect(result.current.data).toEqual(page1Records));

    await act(async () => {
      await result.current.refetch();
    });

    // After refetch, data is replaced (not appended)
    expect(result.current.data).toEqual(freshRecords);
    expect(result.current.hasMore).toBe(false);

    // cursor arg on the refetch call should be undefined (reset)
    const refetchCall = mocks.mockQueryRecords.mock.calls[1];
    expect(refetchCall[6]).toBeUndefined();
  });

  it('sets error and preserves previous data on failure', async () => {
    mocks.mockQueryRecords.mockResolvedValue(page1LastResult);

    const { result } = renderHook(() => useCloudKitQuery('Note'));

    await waitFor(() => expect(result.current.data).toEqual(page1Records));

    const fetchError = new CloudKitError(CloudKitErrorCode.NETWORK_UNAVAILABLE, 'Offline');
    mocks.mockQueryRecords.mockRejectedValue(fetchError);

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.error).toBeInstanceOf(CloudKitError);
    expect(result.current.error?.code).toBe(CloudKitErrorCode.NETWORK_UNAVAILABLE);
    // Previous data preserved (stale-while-revalidate)
    expect(result.current.data).toEqual(page1Records);
    expect(result.current.loading).toBe(false);
    expect(result.current.fetching).toBe(false);
  });

  it('is inert when recordType is undefined', () => {
    const { result } = renderHook(() => useCloudKitQuery(undefined));

    expect(result.current.loading).toBe(false);
    expect(result.current.fetching).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(result.current.hasMore).toBe(false);
    expect(mocks.mockQueryRecords).not.toHaveBeenCalled();
  });

  it('is inert when enabled is false', () => {
    const { result } = renderHook(() =>
      useCloudKitQuery('Note', { enabled: false })
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.fetching).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(mocks.mockQueryRecords).not.toHaveBeenCalled();
  });

  it('re-fetches when predicate changes', async () => {
    mocks.mockQueryRecords.mockResolvedValue(page1LastResult);

    const { rerender } = renderHook(
      ({ field }: { field: string }) =>
        useCloudKitQuery('Note', {
          predicate: { field, comparator: '=', value: 'test' },
        }),
      { initialProps: { field: 'title' } }
    );

    await waitFor(() => expect(mocks.mockQueryRecords).toHaveBeenCalledTimes(1));
    expect(mocks.mockQueryRecords.mock.calls[0][1]).toEqual({
      field: 'title',
      comparator: '=',
      value: 'test',
    });

    rerender({ field: 'body' });

    await waitFor(() => expect(mocks.mockQueryRecords).toHaveBeenCalledTimes(2));
    expect(mocks.mockQueryRecords.mock.calls[1][1]).toEqual({
      field: 'body',
      comparator: '=',
      value: 'test',
    });
  });

  it('passes all options to queryRecords correctly', async () => {
    mocks.mockQueryRecords.mockResolvedValue(page1LastResult);

    const { result } = renderHook(() =>
      useCloudKitQuery('Note', {
        predicate: { field: 'title', comparator: '=', value: 'Hello' },
        sortDescriptors: [{ field: 'creationDate', ascending: false }],
        zoneName: 'MyZone',
        database: 'private',
        resultsLimit: 25,
      })
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mocks.mockQueryRecords).toHaveBeenCalledWith(
      'Note',
      { field: 'title', comparator: '=', value: 'Hello' },
      [{ field: 'creationDate', ascending: false }],
      'MyZone',
      'private',
      25,
      undefined
    );
  });

  it('returns to inert state when enabled flips to false', async () => {
    mocks.mockQueryRecords.mockResolvedValue(page1LastResult);

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useCloudKitQuery('Note', { enabled }),
      { initialProps: { enabled: true } }
    );

    await waitFor(() => expect(result.current.data).toEqual(page1Records));

    rerender({ enabled: false });

    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(false);
    expect(result.current.fetching).toBe(false);
    expect(result.current.hasMore).toBe(false);
  });
});
