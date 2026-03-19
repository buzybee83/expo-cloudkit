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
  /**
   * CloudKit is temporarily rate limiting requests from this client.
   * If `retryAfterSeconds` is set on the error, wait that long before retrying.
   * CKSyncEngine handles rate limits automatically; only relevant for direct
   * record CRUD operations.
   */
  RATE_LIMITED = 'RATE_LIMITED',
  /** An unexpected error occurred. Check `message` for details. */
  UNKNOWN = 'UNKNOWN',

  /**
   * A CloudKit record failed runtime schema validation.
   * The `zodErrors` field on `CloudKitValidationError` contains the full list
   * of Zod issues describing which fields failed and why.
   */
  VALIDATION_FAILED = 'VALIDATION_FAILED',

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

  // Phase B — Push Subscriptions

  /**
   * The specified subscription ID does not exist on the server.
   * It may have already been deleted or was never created.
   */
  SUBSCRIPTION_NOT_FOUND = 'SUBSCRIPTION_NOT_FOUND',

  // Phase B — CKShare

  /**
   * The record is already shared. A record can only be the root of one CKShare at a time.
   */
  ALREADY_SHARED = 'ALREADY_SHARED',

  /**
   * A participant must verify their identity before they can be added to a share.
   */
  PARTICIPANT_NEEDS_VERIFICATION = 'PARTICIPANT_NEEDS_VERIFICATION',

  /**
   * The operation would violate a CKRecord reference integrity constraint.
   */
  REFERENCE_VIOLATION = 'REFERENCE_VIOLATION',

  /**
   * The specified CKShare record does not exist.
   */
  SHARE_NOT_FOUND = 'SHARE_NOT_FOUND',

  /**
   * The specified participant was not found on the share.
   */
  PARTICIPANT_NOT_FOUND = 'PARTICIPANT_NOT_FOUND',

  /**
   * The sharing UI could not be presented (e.g. no view controller available or
   * UICloudSharingController is unavailable on this OS version).
   */
  SHARING_UI_UNAVAILABLE = 'SHARING_UI_UNAVAILABLE',

  // Phase C — Cross-platform stub

  /**
   * CloudKit is not available on this platform (e.g. Android, web).
   * All API calls on non-iOS platforms reject with this code.
   */
  NOT_SUPPORTED = 'NOT_SUPPORTED',

  /**
   * The native ExpoCloudKit module is not available in this environment.
   * This typically means the app is running in Expo Go, which does not bundle
   * custom native modules. Build a development client with `npx expo run:ios`.
   */
  MODULE_UNAVAILABLE = 'MODULE_UNAVAILABLE',
}

/**
 * Thrown synchronously or as a rejection when expo-cloudkit is called on a
 * non-iOS platform (Android, web, etc.).
 *
 * All exported async functions reject with this error on non-iOS platforms.
 * Event listener helpers return a no-op `Subscription` instead of throwing.
 *
 * @example
 * ```typescript
 * try {
 *   await getAccountStatus();
 * } catch (err) {
 *   if (err instanceof CloudKitNotSupportedError) {
 *     // Running on Android or web — CloudKit is unavailable
 *   }
 * }
 * ```
 */
export class CloudKitNotSupportedError extends Error {
  readonly code = CloudKitErrorCode.NOT_SUPPORTED;

  constructor() {
    super('CloudKit is only available on iOS. This device/platform is not supported.');
    this.name = 'CloudKitNotSupportedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
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
 *     if (err.recoverySuggestion) {
 *       Alert.alert('CloudKit Error', err.recoverySuggestion);
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

  /**
   * A human-readable suggestion for recovering from this error.
   * Suitable for display in UI error messages or developer logs.
   * `undefined` when no specific recovery guidance is available.
   *
   * @example
   * ```typescript
   * if (err instanceof CloudKitError && err.recoverySuggestion) {
   *   Alert.alert('CloudKit Error', err.recoverySuggestion);
   * }
   * ```
   */
  readonly recoverySuggestion: string | undefined;

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
    this.recoverySuggestion = CloudKitError.recoverySuggestionFor(code);

    // Maintain proper prototype chain in transpiled JS
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Returns a human-readable recovery suggestion for a given error code,
   * or `undefined` when no guidance is available.
   */
  private static recoverySuggestionFor(code: CloudKitErrorCode): string | undefined {
    switch (code) {
      case CloudKitErrorCode.NOT_AUTHENTICATED:
        return 'Open Settings → [Your Name] → iCloud and sign in.';
      case CloudKitErrorCode.NETWORK_UNAVAILABLE:
        return 'Check your internet connection and try again.';
      case CloudKitErrorCode.QUOTA_EXCEEDED:
        return 'Free up iCloud storage in Settings → [Your Name] → iCloud → Manage Storage.';
      case CloudKitErrorCode.CONFLICT:
        return 'The record was modified by another device. Fetch the latest version and retry.';
      case CloudKitErrorCode.RATE_LIMITED:
        return 'CloudKit is rate limiting requests. The operation will be retried automatically.';
      case CloudKitErrorCode.ASSET_TOO_LARGE:
        return 'The asset exceeds the CloudKit size limit (250 MB for public databases).';
      case CloudKitErrorCode.VALIDATION_FAILED:
        return 'Check that the CloudKit record fields match the expected schema.';
      default:
        return undefined;
    }
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

/**
 * Thrown when a CloudKit record fails runtime schema validation via
 * `createCloudKitSchema`.
 *
 * The `zodErrors` array contains the raw Zod `ZodIssue` objects (typed as
 * `unknown[]` to avoid a hard runtime dependency on the `zod` package).
 *
 * @example
 * ```typescript
 * const result = NoteSchema.safeParse(record)
 * if (!result.success) {
 *   console.log(result.error.zodErrors) // ZodIssue[]
 * }
 * ```
 */
export class CloudKitValidationError extends CloudKitError {
  /**
   * The raw Zod issues that caused validation to fail.
   * Each element is a `ZodIssue` — typed as `unknown` to avoid a hard
   * compile-time dependency on the `zod` package.
   */
  readonly zodErrors: unknown[];

  constructor(zodErrors: unknown[], record?: import('./types').CloudKitRecord) {
    const issues = zodErrors as Array<{ path: (string | number)[]; message: string }>;
    const summary = issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    super(
      CloudKitErrorCode.VALIDATION_FAILED,
      `CloudKit record validation failed: ${summary}`,
      record != null ? { serverRecord: record } : undefined
    );
    this.name = 'CloudKitValidationError';
    this.zodErrors = zodErrors;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the native ExpoCloudKit module is unavailable in the current
 * runtime environment.
 *
 * This typically means the app is running in Expo Go. Build a development
 * client with `npx expo run:ios` to use CloudKit APIs.
 *
 * Use `isNativeModuleAvailable()` to gate CloudKit UI without try/catch.
 *
 * @example
 * ```typescript
 * import { isNativeModuleAvailable, CloudKitUnavailableError } from 'expo-cloudkit';
 *
 * if (!isNativeModuleAvailable()) {
 *   return <Text>CloudKit requires a development client.</Text>;
 * }
 * ```
 */
export class CloudKitUnavailableError extends CloudKitError {
  constructor() {
    super(
      CloudKitErrorCode.MODULE_UNAVAILABLE,
      'expo-cloudkit requires a custom development client. Build with `npx expo run:ios`.'
    );
    this.name = 'CloudKitUnavailableError';
    // Maintain proper prototype chain in transpiled JS
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
