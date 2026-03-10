/**
 * CloudKit JS error → CloudKitError mapping.
 *
 * CloudKit JS (tsl-apple-cloudkit) rejects promises with error objects that
 * have a `ckErrorCode` string field (or `serverErrorCode` in REST parlance).
 * This module maps those strings to the `CloudKitErrorCode` enum used throughout
 * expo-cloudkit, then constructs the appropriate `CloudKitError` instance.
 *
 * No imports from tsl-apple-cloudkit — this file works with plain JS objects.
 */

import { CloudKitError, CloudKitErrorCode } from '../errors';
import type { CloudKitRecord } from '../types';

// ---------------------------------------------------------------------------
// Internal: raw CloudKit JS error shape
// ---------------------------------------------------------------------------

/**
 * Minimal shape of an error object returned by CloudKit JS.
 * The real shape has many more fields but we only care about these.
 */
interface CKJSRawError {
  /** The CloudKit Web Services error code string, e.g. "NOT_FOUND". */
  ckErrorCode?: string;
  /** Alias used in some CloudKit JS versions. */
  serverErrorCode?: string;
  /** Human-readable description. */
  reason?: string;
  /** HTTP status code. */
  statusCode?: number;
  /**
   * For THROTTLED / rate-limit responses: seconds to wait before retrying.
   * May appear as `retryAfter` (seconds) in the raw response.
   */
  retryAfter?: number;
  /**
   * For CONFLICT errors: the current server version of the record.
   * Keyed as `serverRecord` in the CloudKit JS error payload.
   */
  serverRecord?: unknown;
  /** Alternative error string format. */
  code?: string;
}

// ---------------------------------------------------------------------------
// Code mapping table
// ---------------------------------------------------------------------------

/**
 * Maps a CloudKit Web Services `serverErrorCode` string to `CloudKitErrorCode`.
 *
 * Sources:
 * - https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/ErrorCodes.html
 * - CloudKit JS runtime observations
 */
function mapCKErrorCode(
  raw: string,
  context?: 'record' | 'zone' | 'share' | 'subscription' | 'general'
): CloudKitErrorCode {
  switch (raw.toUpperCase()) {
    // Authentication
    case 'NOT_AUTHENTICATED':
    case 'AUTHENTICATION_FAILED':
    case 'AUTHENTICATION_REQUIRED':
      return CloudKitErrorCode.NOT_AUTHENTICATED;

    // Network
    case 'NETWORK_FAILURE':
    case 'NETWORK_UNAVAILABLE':
    case 'TRY_AGAIN_LATER':
    case 'SERVICE_UNAVAILABLE':
      return CloudKitErrorCode.NETWORK_UNAVAILABLE;

    // Quota / limits
    case 'QUOTA_EXCEEDED':
      return CloudKitErrorCode.QUOTA_EXCEEDED;

    case 'LIMIT_EXCEEDED':
      return CloudKitErrorCode.LIMIT_EXCEEDED;

    // Not found — context-sensitive
    case 'NOT_FOUND':
    case 'UNKNOWN_ITEM':
    case 'RECORD_NOT_FOUND':
      if (context === 'zone') return CloudKitErrorCode.ZONE_NOT_FOUND;
      if (context === 'share') return CloudKitErrorCode.SHARE_NOT_FOUND;
      return CloudKitErrorCode.RECORD_NOT_FOUND;

    case 'ZONE_NOT_FOUND':
      return CloudKitErrorCode.ZONE_NOT_FOUND;

    // Permissions
    case 'ACCESS_DENIED':
    case 'PERMISSION_FAILURE':
      return CloudKitErrorCode.PERMISSION_DENIED;

    // Server rejection
    case 'SERVER_REJECTED_REQUEST':
    case 'BAD_REQUEST':
    case 'ATOMIC_ERROR':
    case 'INTERNAL_ERROR':
    case 'THROTTLED':
      return CloudKitErrorCode.SERVER_REJECTED;

    // Conflict
    case 'CONFLICT':
      return CloudKitErrorCode.CONFLICT;

    // Already shared
    case 'EXISTS':
      if (context === 'share') return CloudKitErrorCode.ALREADY_SHARED;
      return CloudKitErrorCode.SERVER_REJECTED;

    // Reference integrity
    case 'VALIDATING_REFERENCE_ERROR':
      return CloudKitErrorCode.REFERENCE_VIOLATION;

    // Subscriptions
    case 'SUBSCRIPTION_NOT_FOUND':
      return CloudKitErrorCode.SUBSCRIPTION_NOT_FOUND;

    default:
      return CloudKitErrorCode.UNKNOWN;
  }
}

// ---------------------------------------------------------------------------
// Public: mapCKJSError
// ---------------------------------------------------------------------------

/**
 * Converts a raw CloudKit JS error value into a typed `CloudKitError`.
 *
 * @param err     - The raw error thrown/rejected by a CloudKit JS call.
 * @param context - Optional context hint for disambiguating NOT_FOUND codes.
 */
export function mapCKJSError(
  err: unknown,
  context?: 'record' | 'zone' | 'share' | 'subscription' | 'general'
): CloudKitError {
  if (err instanceof CloudKitError) {
    return err;
  }

  // Check if the error is a missing-package error we threw ourselves
  if (err instanceof Error && err.message.includes('tsl-apple-cloudkit')) {
    return new CloudKitError(CloudKitErrorCode.UNKNOWN, err.message);
  }

  const raw = err as CKJSRawError;

  // Determine raw code string
  const rawCode: string =
    raw?.ckErrorCode ?? raw?.serverErrorCode ?? raw?.code ?? 'UNKNOWN';

  const code = mapCKErrorCode(rawCode, context);

  // Build human-readable message
  const message: string =
    raw?.reason ??
    (err instanceof Error ? err.message : String(err)) ??
    `CloudKit error: ${rawCode}`;

  // Extract retry delay
  const retryAfterSeconds: number | undefined =
    typeof raw?.retryAfter === 'number' ? raw.retryAfter : undefined;

  // Extract server record for CONFLICT errors
  // The server record comes as a raw CloudKit JS record object; we pass it
  // through as-is and let converters.ts handle it at the call site if needed.
  const serverRecord: CloudKitRecord | undefined =
    code === CloudKitErrorCode.CONFLICT && raw?.serverRecord != null
      ? (raw.serverRecord as CloudKitRecord)
      : undefined;

  return new CloudKitError(code, message, {
    retryAfterSeconds,
    serverRecord,
  });
}
