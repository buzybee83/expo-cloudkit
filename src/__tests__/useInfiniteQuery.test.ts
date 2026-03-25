/**
 * Unit tests for useInfiniteQuery hook.
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

import { useInfiniteQuery } from '../hooks';
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
  modificationDate: new Date('2026-01-01T00:00:00.000Z').getTime(),
  creationDate: new Date('2026-01-01T00:00:00.000Z').getTime(),
  changeTag: `tag-${n}`,
  fields: {},
});

const page1Records = [makeRecord(1), makeRecord(2)];
const page2Records = [makeRecord(3), makeRecord(4)];

const page1WithCursor: QueryResult = { records: page1Records, cursor: 'cursor-page2' };
const page1NoCursor: QueryResult = { records: page1Records, cursor: undefined };
const page2NoCursor: QueryResult = { records: page2Records, cursor: undefined };

function getQueryRecordsMock() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../ExpoCloudKit');
  return mod.queryRecords as jest.MockedFunction<() => Promise<QueryResult>>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useInfiniteQuery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('initial fetch populates records', async () => {
    getQueryRecordsMock().mockResolvedValue(page1NoCursor);

    const { result } = renderHook(() => useInfiniteQuery('Note'));

    expect(result.current.isLoading).toBe(true);
    expect(result.current.records).toEqual([]);

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.records).toEqual(page1Records);
    expect(result.current.hasNextPage).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.isFetchingNextPage).toBe(false);
  });

  it('fetchNextPage appends records and advances cursor', async () => {
    getQueryRecordsMock()
      .mockResolvedValueOnce(page1WithCursor)
      .mockResolvedValueOnce(page2NoCursor);

    const { result } = renderHook(() => useInfiniteQuery('Note'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.records).toEqual(page1Records);
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });

    expect(result.current.records).toEqual([...page1Records, ...page2Records]);
    expect(result.current.hasNextPage).toBe(false);
    expect(result.current.isFetchingNextPage).toBe(false);
  });

  it('hasNextPage is false when cursor is null/undefined', async () => {
    getQueryRecordsMock().mockResolvedValue(page1NoCursor);

    const { result } = renderHook(() => useInfiniteQuery('Note'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.hasNextPage).toBe(false);
  });

  it('isFetchingNextPage is true only during page fetch, not initial load', async () => {
    let resolvePage2: (value: QueryResult) => void = () => {};
    const page2Promise = new Promise<QueryResult>((resolve) => {
      resolvePage2 = resolve;
    });

    getQueryRecordsMock()
      .mockResolvedValueOnce(page1WithCursor)
      .mockReturnValueOnce(page2Promise);

    const { result } = renderHook(() => useInfiniteQuery('Note'));

    // During initial load, isFetchingNextPage should be false (isLoading is true instead)
    expect(result.current.isFetchingNextPage).toBe(false);
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // After first page loaded, neither loading state is active
    expect(result.current.isFetchingNextPage).toBe(false);
    expect(result.current.isLoading).toBe(false);

    // Start fetching page 2 — isFetchingNextPage should become true
    act(() => {
      void result.current.fetchNextPage();
    });

    await waitFor(() => expect(result.current.isFetchingNextPage).toBe(true));

    // isLoading remains false during page fetch
    expect(result.current.isLoading).toBe(false);

    // Resolve page 2
    await act(async () => {
      resolvePage2(page2NoCursor);
    });

    await waitFor(() => expect(result.current.isFetchingNextPage).toBe(false));
  });

  it('error is set when queryRecords rejects', async () => {
    const networkError = new CloudKitError(
      CloudKitErrorCode.NETWORK_UNAVAILABLE,
      'No network connection'
    );
    getQueryRecordsMock().mockRejectedValue(networkError);

    const { result } = renderHook(() => useInfiniteQuery('Note'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBeInstanceOf(CloudKitError);
    expect((result.current.error as CloudKitError).code).toBe(
      CloudKitErrorCode.NETWORK_UNAVAILABLE
    );
    expect(result.current.records).toEqual([]);
  });

  it('fetch() resets records and fetches from the beginning', async () => {
    getQueryRecordsMock()
      .mockResolvedValueOnce(page1WithCursor)
      .mockResolvedValueOnce(page2NoCursor)
      .mockResolvedValueOnce(page1NoCursor);

    const { result } = renderHook(() => useInfiniteQuery('Note'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.records).toEqual(page1Records);

    // Load next page
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(result.current.records).toHaveLength(4);

    // Reset by calling fetch()
    await act(async () => {
      await result.current.fetch();
    });

    // Should be back to first page only
    expect(result.current.records).toEqual(page1Records);
    expect(result.current.hasNextPage).toBe(false);
  });
});
