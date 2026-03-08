/**
 * expo-cloudkit — Error types
 *
 * CloudKitError wraps native CKError codes into a JS-friendly Error subclass.
 * The `code` field maps to CloudKitErrorCode for programmatic handling.
 */

/**
 * String error codes returned by the native module.
 * Maps CKError.Code values to stable, JS-friendly strings.
 */
export enum CloudKitErrorCode {
  /** The user is not signed in to iCloud. */
  NOT_AUTHENTICATED = 'NOT_AUTHENTICATED',
  /** The device has no network connectivity. */
  NETWORK_UNAVAILABLE = 'NETWORK_UNAVAILABLE',
  /** The user has exceeded their iCloud storage quota. */
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  /** The requested zone does not exist. */
  ZONE_NOT_FOUND = 'ZONE_NOT_FOUND',
  /** The requested record does not exist. */
  RECORD_NOT_FOUND = 'RECORD_NOT_FOUND',
  /**
   * A save operation failed because the server's record changed since the
   * client last fetched it. The `serverRecord` field contains the current
   * server version for merge resolution.
   */
  CONFLICT = 'CONFLICT',
  /** The current user does not have permission for this operation. */
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  /** The CloudKit server rejected the request. */
  SERVER_REJECTED = 'SERVER_REJECTED',
  /** The CKAsset file exceeds the CloudKit size limit. */
  ASSET_TOO_LARGE = 'ASSET_TOO_LARGE',
  /**
   * The operation exceeded a CloudKit limit (e.g. >400 records in one batch).
   * Split the operation into smaller chunks.
   */
  LIMIT_EXCEEDED = 'LIMIT_EXCEEDED',
  /** An unexpected error occurred. Check `message` for details. */
  UNKNOWN = 'UNKNOWN',

  // Phase B — CKSyncEngine

  /**
   * `startSyncEngine()` has not been called, or `stopSyncEngine()` was already
   * called. Call `startSyncEngine()` before using sync-engine operations.
   */
  SYNC_ENGINE_NOT_RUNNING = 'SYNC_ENGINE_NOT_RUNNING',

  /**
   * The stored CKServerChangeToken or CKSyncEngine state is no longer valid.
   * The sync provider will automatically perform a full re-sync from the beginning.
   * This code is informational; no action is required by the caller.
   */
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',

  /**
   * The iCloud account changed (user signed out or switched accounts).
   * All local change tokens have been reset. A full re-sync will follow automatically.
   */
  ACCOUNT_CHANGED = 'ACCOUNT_CHANGED',
}

/**
 * Structured error thrown by all expo-cloudkit async operations.
 *
 * @example
 * ```typescript
 * try {
 *   await saveRecords([record]);
 * } catch (err) {
 *   if (err instanceof CloudKitError) {
 *     if (err.code === CloudKitErrorCode.CONFLICT) {
 *       // Use err.serverRecord to resolve the conflict
 *       mergeWithServer(err.serverRecord);
 *     }
 *   }
 * }
 * ```
 */
export class CloudKitError extends Error {
  /** Stable error code for programmatic handling. */
  readonly code: CloudKitErrorCode;

  /**
   * If the server requested a retry-after delay, this contains the number
   * of seconds to wait before retrying. Common for rate limiting.
   */
  readonly retryAfterSeconds: number | undefined;

  /**
   * For CONFLICT errors: the current server version of the record.
   * Use this to perform field-level merge before re-saving.
   */
  readonly serverRecord: import('./types').CloudKitRecord | undefined;

  constructor(
    code: CloudKitErrorCode,
    message: string,
    options?: {
      retryAfterSeconds?: number;
      serverRecord?: import('./types').CloudKitRecord;
    }
  ) {
    super(message);
    this.name = 'CloudKitError';
    this.code = code;
    this.retryAfterSeconds = options?.retryAfterSeconds;
    this.serverRecord = options?.serverRecord;

    // Maintain proper prototype chain in transpiled JS
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Creates a CloudKitError from the raw dictionary the native module throws.
   * The native module always throws with `{ code, message, retryAfterSeconds?, serverRecord? }`.
   */
  static fromNativeError(nativeError: unknown): CloudKitError {
    if (nativeError instanceof CloudKitError) {
      return nativeError;
    }

    const err = nativeError as Record<string, unknown>;
    const code =
      typeof err['code'] === 'string' &&
      Object.values(CloudKitErrorCode).includes(err['code'] as CloudKitErrorCode)
        ? (err['code'] as CloudKitErrorCode)
        : CloudKitErrorCode.UNKNOWN;

    const message =
      typeof err['message'] === 'string' ? err['message'] : 'An unknown CloudKit error occurred';

    return new CloudKitError(code, message, {
      retryAfterSeconds:
        typeof err['retryAfterSeconds'] === 'number' ? err['retryAfterSeconds'] : undefined,
      serverRecord:
        err['serverRecord'] != null
          ? (err['serverRecord'] as import('./types').CloudKitRecord)
          : undefined,
    });
  }
}
