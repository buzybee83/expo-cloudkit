/**
 * Unit tests for src/web/database.ts — resolveDatabase
 */

import { resolveDatabase } from '../../web/database';

// ---------------------------------------------------------------------------
// Mock container
// ---------------------------------------------------------------------------

const mockContainer = {
  privateCloudDatabase: 'private-db',
  publicCloudDatabase: 'public-db',
  sharedCloudDatabase: 'shared-db',
};

// ---------------------------------------------------------------------------
// resolveDatabase
// ---------------------------------------------------------------------------

describe('resolveDatabase', () => {
  it('returns the private database for scope "private"', () => {
    expect(resolveDatabase(mockContainer, 'private')).toBe('private-db');
  });

  it('returns the public database for scope "public"', () => {
    expect(resolveDatabase(mockContainer, 'public')).toBe('public-db');
  });

  it('returns the shared database for scope "shared"', () => {
    expect(resolveDatabase(mockContainer, 'shared')).toBe('shared-db');
  });

  it('defaults to the private database when scope is not provided', () => {
    // No second argument — should default to 'private'
    expect(resolveDatabase(mockContainer)).toBe('private-db');
  });

  it('each scope returns a distinct database object', () => {
    const container = {
      privateCloudDatabase: { name: 'private' },
      publicCloudDatabase: { name: 'public' },
      sharedCloudDatabase: { name: 'shared' },
    };

    const priv = resolveDatabase(container, 'private');
    const pub = resolveDatabase(container, 'public');
    const shared = resolveDatabase(container, 'shared');

    expect(priv).not.toBe(pub);
    expect(priv).not.toBe(shared);
    expect(pub).not.toBe(shared);
  });

  it('returns the same reference each call for the same scope', () => {
    const container = {
      privateCloudDatabase: { name: 'private' },
      publicCloudDatabase: { name: 'public' },
      sharedCloudDatabase: { name: 'shared' },
    };

    const first = resolveDatabase(container, 'private');
    const second = resolveDatabase(container, 'private');
    expect(first).toBe(second);
  });

  it('returns the container property value directly (no wrapping)', () => {
    // This verifies the function is a thin pass-through and not copying/cloning.
    const db = { isMock: true, saveRecords: jest.fn() };
    const container = {
      privateCloudDatabase: db,
      publicCloudDatabase: {},
      sharedCloudDatabase: {},
    };
    const result = resolveDatabase(container, 'private');
    expect(result).toBe(db);
    expect(result.isMock).toBe(true);
  });
});
