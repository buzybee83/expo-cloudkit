/**
 * Unit tests for src/web/errors.ts — mapCKJSError
 */

import { mapCKJSError } from '../../web/errors';
import { CloudKitError, CloudKitErrorCode } from '../../errors';

describe('mapCKJSError', () => {
  // ---------------------------------------------------------------------------
  // Returns existing CloudKitError unchanged
  // ---------------------------------------------------------------------------

  it('returns a CloudKitError instance unchanged when passed one', () => {
    const original = new CloudKitError(CloudKitErrorCode.CONFLICT, 'pre-built');
    const result = mapCKJSError(original);
    expect(result).toBe(original);
  });

  // ---------------------------------------------------------------------------
  // Known serverErrorCode mappings
  // ---------------------------------------------------------------------------

  describe('authentication codes', () => {
    it('maps NOT_AUTHENTICATED → NOT_AUTHENTICATED', () => {
      const err = mapCKJSError({ serverErrorCode: 'NOT_AUTHENTICATED', reason: 'not authed' });
      expect(err).toBeInstanceOf(CloudKitError);
      expect(err.code).toBe(CloudKitErrorCode.NOT_AUTHENTICATED);
      expect(err.message).toBe('not authed');
    });

    it('maps AUTHENTICATION_FAILED → NOT_AUTHENTICATED', () => {
      const err = mapCKJSError({ serverErrorCode: 'AUTHENTICATION_FAILED' });
      expect(err.code).toBe(CloudKitErrorCode.NOT_AUTHENTICATED);
    });

    it('maps AUTHENTICATION_REQUIRED → NOT_AUTHENTICATED', () => {
      const err = mapCKJSError({ serverErrorCode: 'AUTHENTICATION_REQUIRED' });
      expect(err.code).toBe(CloudKitErrorCode.NOT_AUTHENTICATED);
    });
  });

  describe('network codes', () => {
    it('maps NETWORK_FAILURE → NETWORK_UNAVAILABLE', () => {
      const err = mapCKJSError({ serverErrorCode: 'NETWORK_FAILURE' });
      expect(err.code).toBe(CloudKitErrorCode.NETWORK_UNAVAILABLE);
    });

    it('maps NETWORK_UNAVAILABLE → NETWORK_UNAVAILABLE', () => {
      const err = mapCKJSError({ serverErrorCode: 'NETWORK_UNAVAILABLE' });
      expect(err.code).toBe(CloudKitErrorCode.NETWORK_UNAVAILABLE);
    });

    it('maps TRY_AGAIN_LATER → NETWORK_UNAVAILABLE', () => {
      const err = mapCKJSError({ serverErrorCode: 'TRY_AGAIN_LATER' });
      expect(err.code).toBe(CloudKitErrorCode.NETWORK_UNAVAILABLE);
    });

    it('maps SERVICE_UNAVAILABLE → NETWORK_UNAVAILABLE', () => {
      const err = mapCKJSError({ serverErrorCode: 'SERVICE_UNAVAILABLE' });
      expect(err.code).toBe(CloudKitErrorCode.NETWORK_UNAVAILABLE);
    });
  });

  describe('quota / limits', () => {
    it('maps QUOTA_EXCEEDED → QUOTA_EXCEEDED', () => {
      const err = mapCKJSError({ serverErrorCode: 'QUOTA_EXCEEDED' });
      expect(err.code).toBe(CloudKitErrorCode.QUOTA_EXCEEDED);
    });

    it('maps LIMIT_EXCEEDED → LIMIT_EXCEEDED', () => {
      const err = mapCKJSError({ serverErrorCode: 'LIMIT_EXCEEDED' });
      expect(err.code).toBe(CloudKitErrorCode.LIMIT_EXCEEDED);
    });
  });

  describe('not-found codes — record context (default)', () => {
    it('maps ZONE_NOT_FOUND → ZONE_NOT_FOUND', () => {
      const err = mapCKJSError({ serverErrorCode: 'ZONE_NOT_FOUND' });
      expect(err.code).toBe(CloudKitErrorCode.ZONE_NOT_FOUND);
    });

    it('maps UNKNOWN_ITEM → RECORD_NOT_FOUND in default (record) context', () => {
      const err = mapCKJSError({ serverErrorCode: 'UNKNOWN_ITEM' });
      expect(err.code).toBe(CloudKitErrorCode.RECORD_NOT_FOUND);
    });

    it('maps NOT_FOUND → RECORD_NOT_FOUND in default context', () => {
      const err = mapCKJSError({ serverErrorCode: 'NOT_FOUND' });
      expect(err.code).toBe(CloudKitErrorCode.RECORD_NOT_FOUND);
    });

    it('maps RECORD_NOT_FOUND → RECORD_NOT_FOUND', () => {
      const err = mapCKJSError({ serverErrorCode: 'RECORD_NOT_FOUND' });
      expect(err.code).toBe(CloudKitErrorCode.RECORD_NOT_FOUND);
    });
  });

  describe('not-found codes — context disambiguation', () => {
    it('maps NOT_FOUND → ZONE_NOT_FOUND when context is zone', () => {
      const err = mapCKJSError({ serverErrorCode: 'NOT_FOUND' }, 'zone');
      expect(err.code).toBe(CloudKitErrorCode.ZONE_NOT_FOUND);
    });

    it('maps UNKNOWN_ITEM → ZONE_NOT_FOUND when context is zone', () => {
      const err = mapCKJSError({ serverErrorCode: 'UNKNOWN_ITEM' }, 'zone');
      expect(err.code).toBe(CloudKitErrorCode.ZONE_NOT_FOUND);
    });

    it('maps NOT_FOUND → SHARE_NOT_FOUND when context is share', () => {
      const err = mapCKJSError({ serverErrorCode: 'NOT_FOUND' }, 'share');
      expect(err.code).toBe(CloudKitErrorCode.SHARE_NOT_FOUND);
    });

    it('maps NOT_FOUND → RECORD_NOT_FOUND when context is record', () => {
      const err = mapCKJSError({ serverErrorCode: 'NOT_FOUND' }, 'record');
      expect(err.code).toBe(CloudKitErrorCode.RECORD_NOT_FOUND);
    });

    it('maps NOT_FOUND → RECORD_NOT_FOUND when context is general', () => {
      const err = mapCKJSError({ serverErrorCode: 'NOT_FOUND' }, 'general');
      expect(err.code).toBe(CloudKitErrorCode.RECORD_NOT_FOUND);
    });
  });

  describe('permissions', () => {
    it('maps ACCESS_DENIED → PERMISSION_DENIED', () => {
      const err = mapCKJSError({ serverErrorCode: 'ACCESS_DENIED' });
      expect(err.code).toBe(CloudKitErrorCode.PERMISSION_DENIED);
    });

    it('maps PERMISSION_FAILURE → PERMISSION_DENIED', () => {
      const err = mapCKJSError({ serverErrorCode: 'PERMISSION_FAILURE' });
      expect(err.code).toBe(CloudKitErrorCode.PERMISSION_DENIED);
    });
  });

  describe('server rejected codes', () => {
    it('maps SERVER_REJECTED_REQUEST → SERVER_REJECTED', () => {
      const err = mapCKJSError({ serverErrorCode: 'SERVER_REJECTED_REQUEST' });
      expect(err.code).toBe(CloudKitErrorCode.SERVER_REJECTED);
    });

    it('maps BAD_REQUEST → SERVER_REJECTED', () => {
      const err = mapCKJSError({ serverErrorCode: 'BAD_REQUEST' });
      expect(err.code).toBe(CloudKitErrorCode.SERVER_REJECTED);
    });

    it('maps ATOMIC_ERROR → SERVER_REJECTED', () => {
      const err = mapCKJSError({ serverErrorCode: 'ATOMIC_ERROR' });
      expect(err.code).toBe(CloudKitErrorCode.SERVER_REJECTED);
    });

    it('maps INTERNAL_ERROR → SERVER_REJECTED', () => {
      const err = mapCKJSError({ serverErrorCode: 'INTERNAL_ERROR' });
      expect(err.code).toBe(CloudKitErrorCode.SERVER_REJECTED);
    });

    it('maps THROTTLED → SERVER_REJECTED', () => {
      const err = mapCKJSError({ serverErrorCode: 'THROTTLED' });
      expect(err.code).toBe(CloudKitErrorCode.SERVER_REJECTED);
    });
  });

  describe('conflict', () => {
    it('maps CONFLICT → CONFLICT', () => {
      const err = mapCKJSError({ serverErrorCode: 'CONFLICT' });
      expect(err.code).toBe(CloudKitErrorCode.CONFLICT);
    });

    it('attaches serverRecord for CONFLICT errors when present', () => {
      const fakeServerRecord = {
        recordName: 'rec-1',
        recordType: 'Note',
        zoneName: '_defaultZone',
        ownerName: '__defaultOwner__',
        creationDate: null,
        modificationDate: null,
        changeTag: null,
        fields: {},
      };
      const err = mapCKJSError({
        serverErrorCode: 'CONFLICT',
        serverRecord: fakeServerRecord,
        reason: 'Version conflict',
      });
      expect(err.code).toBe(CloudKitErrorCode.CONFLICT);
      expect(err.serverRecord).toEqual(fakeServerRecord);
    });

    it('does not attach serverRecord for non-CONFLICT errors', () => {
      const err = mapCKJSError({
        serverErrorCode: 'NOT_AUTHENTICATED',
        serverRecord: { recordName: 'rec-1' },
      });
      expect(err.serverRecord).toBeUndefined();
    });
  });

  describe('share-specific codes', () => {
    it('maps EXISTS → ALREADY_SHARED when context is share', () => {
      const err = mapCKJSError({ serverErrorCode: 'EXISTS' }, 'share');
      expect(err.code).toBe(CloudKitErrorCode.ALREADY_SHARED);
    });

    it('maps EXISTS → SERVER_REJECTED in non-share context', () => {
      const err = mapCKJSError({ serverErrorCode: 'EXISTS' });
      expect(err.code).toBe(CloudKitErrorCode.SERVER_REJECTED);
    });
  });

  describe('reference / subscription codes', () => {
    it('maps VALIDATING_REFERENCE_ERROR → REFERENCE_VIOLATION', () => {
      const err = mapCKJSError({ serverErrorCode: 'VALIDATING_REFERENCE_ERROR' });
      expect(err.code).toBe(CloudKitErrorCode.REFERENCE_VIOLATION);
    });

    it('maps SUBSCRIPTION_NOT_FOUND → SUBSCRIPTION_NOT_FOUND', () => {
      const err = mapCKJSError({ serverErrorCode: 'SUBSCRIPTION_NOT_FOUND' });
      expect(err.code).toBe(CloudKitErrorCode.SUBSCRIPTION_NOT_FOUND);
    });
  });

  // ---------------------------------------------------------------------------
  // Unknown / unrecognized codes
  // ---------------------------------------------------------------------------

  it('maps unknown serverErrorCode → UNKNOWN', () => {
    const err = mapCKJSError({ serverErrorCode: 'SOME_FUTURE_CODE' });
    expect(err.code).toBe(CloudKitErrorCode.UNKNOWN);
  });

  it('maps empty serverErrorCode string → UNKNOWN', () => {
    const err = mapCKJSError({ serverErrorCode: '' });
    expect(err.code).toBe(CloudKitErrorCode.UNKNOWN);
  });

  // ---------------------------------------------------------------------------
  // Code field fallback chain (ckErrorCode → serverErrorCode → code)
  // ---------------------------------------------------------------------------

  it('uses ckErrorCode when serverErrorCode is absent', () => {
    const err = mapCKJSError({ ckErrorCode: 'NETWORK_FAILURE' });
    expect(err.code).toBe(CloudKitErrorCode.NETWORK_UNAVAILABLE);
  });

  it('prefers ckErrorCode over serverErrorCode', () => {
    const err = mapCKJSError({ ckErrorCode: 'QUOTA_EXCEEDED', serverErrorCode: 'NOT_AUTHENTICATED' });
    expect(err.code).toBe(CloudKitErrorCode.QUOTA_EXCEEDED);
  });

  it('falls back to code field when ckErrorCode and serverErrorCode are absent', () => {
    const err = mapCKJSError({ code: 'CONFLICT', reason: 'fallback code' });
    expect(err.code).toBe(CloudKitErrorCode.CONFLICT);
  });

  // ---------------------------------------------------------------------------
  // Non-object errors
  // ---------------------------------------------------------------------------

  it('handles a plain string error with UNKNOWN code', () => {
    const err = mapCKJSError('Something went wrong');
    expect(err).toBeInstanceOf(CloudKitError);
    expect(err.code).toBe(CloudKitErrorCode.UNKNOWN);
  });

  it('handles null with UNKNOWN code', () => {
    const err = mapCKJSError(null);
    expect(err).toBeInstanceOf(CloudKitError);
    expect(err.code).toBe(CloudKitErrorCode.UNKNOWN);
  });

  it('handles undefined with UNKNOWN code', () => {
    const err = mapCKJSError(undefined);
    expect(err).toBeInstanceOf(CloudKitError);
    expect(err.code).toBe(CloudKitErrorCode.UNKNOWN);
  });

  it('handles a plain Error object with UNKNOWN code', () => {
    const plainError = new Error('plain JS error');
    const err = mapCKJSError(plainError);
    expect(err).toBeInstanceOf(CloudKitError);
    expect(err.code).toBe(CloudKitErrorCode.UNKNOWN);
    // message comes from the Error.message
    expect(err.message).toBe('plain JS error');
  });

  it('wraps an Error mentioning tsl-apple-cloudkit in UNKNOWN', () => {
    const pkgError = new Error('Cannot find module tsl-apple-cloudkit');
    const err = mapCKJSError(pkgError);
    expect(err.code).toBe(CloudKitErrorCode.UNKNOWN);
    expect(err.message).toContain('tsl-apple-cloudkit');
  });

  // ---------------------------------------------------------------------------
  // retryAfter propagation
  // ---------------------------------------------------------------------------

  it('propagates retryAfter as retryAfterSeconds', () => {
    const err = mapCKJSError({ serverErrorCode: 'THROTTLED', retryAfter: 30 });
    expect(err.retryAfterSeconds).toBe(30);
  });

  it('omits retryAfterSeconds when retryAfter is absent', () => {
    const err = mapCKJSError({ serverErrorCode: 'NETWORK_FAILURE' });
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Case insensitivity
  // ---------------------------------------------------------------------------

  it('is case-insensitive on serverErrorCode', () => {
    const err = mapCKJSError({ serverErrorCode: 'not_authenticated' });
    expect(err.code).toBe(CloudKitErrorCode.NOT_AUTHENTICATED);
  });

  it('is case-insensitive — mixed case', () => {
    const err = mapCKJSError({ serverErrorCode: 'Quota_Exceeded' });
    expect(err.code).toBe(CloudKitErrorCode.QUOTA_EXCEEDED);
  });

  // ---------------------------------------------------------------------------
  // Message construction
  // ---------------------------------------------------------------------------

  it('uses reason as the error message when present', () => {
    const err = mapCKJSError({ serverErrorCode: 'ACCESS_DENIED', reason: 'Read-only' });
    expect(err.message).toBe('Read-only');
  });

  it('falls back to stringifying the error when reason is absent', () => {
    const err = mapCKJSError({ serverErrorCode: 'CONFLICT' });
    // No reason — falls through to String(err) which is '[object Object]'
    expect(typeof err.message).toBe('string');
    expect(err.message.length).toBeGreaterThan(0);
  });
});
