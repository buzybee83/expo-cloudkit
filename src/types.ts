/**
 * expo-cloudkit — TypeScript type definitions
 *
 * Covers all Phase A–E API surface. Phase B–E types are included here
 * so consumers can import them even before the native implementations ship.
 */

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Returned by all `add*Listener` calls. Call `.remove()` to unsubscribe. */
export interface Subscription {
  /** Unregisters the listener from the native event emitter. */
  remove(): void;
}

// ---------------------------------------------------------------------------
// Container & Account
// ---------------------------------------------------------------------------

/**
 * Mirrors CKAccountStatus from CloudKit framework.
 * 'temporarilyUnavailable' was added in iOS 15.
 */
export type AccountStatus =
  | 'available'
  | 'noAccount'
  | 'restricted'
  | 'couldNotDetermine'
  | 'temporarilyUnavailable';

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

/** Which CloudKit database to operate on. Default is 'private'. */
export type DatabaseScope = 'private' | 'shared' | 'public';

/**
 * Represents a CKRecordZone.
 * The default zone has zoneName '_defaultZone' and zoneID.ownerName '__defaultOwner__'.
 */
export interface Zone {
  /** The name of the zone. */
  zoneName: string;
  /** The record name of the zone owner. '__defaultOwner__' for the default zone. */
  ownerName: string;
  /**
   * Capabilities bitmask string from CKRecordZone.Capabilities.
   * e.g. 'fetchChanges', 'atomicChanges', 'sharing'
   */
  capabilities: string[];
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * A typed field value inside a CloudKitRecord.
 *
 * - 'string'     → string
 * - 'number'     → number
 * - 'date'       → ISO 8601 string (e.g. "2026-03-07T00:00:00.000Z")
 * - 'data'       → base64-encoded string
 * - 'location'   → { latitude: number; longitude: number }
 * - 'reference'  → { recordName: string; action: 'none' | 'deleteSelf' }
 * - 'asset'      → local file URI (when saving) or { downloadURL: string; size: number } (when reading)
 * - 'stringList' → string[]
 * - 'numberList' → number[]
 */
export interface RecordField {
  type:
    | 'string'
    | 'number'
    | 'date'
    | 'data'
    | 'location'
    | 'reference'
    | 'asset'
    | 'stringList'
    | 'numberList';
  value: RecordFieldValue;
}

/** Union of all possible field values returned from/sent to CloudKit. */
export type RecordFieldValue =
  | string
  | number
  | string[]
  | number[]
  | LocationValue
  | ReferenceValue
  | AssetReadValue
  | null;

export interface LocationValue {
  latitude: number;
  longitude: number;
}

export interface ReferenceValue {
  recordName: string;
  /** What happens to this record when the referenced record is deleted. */
  action: 'none' | 'deleteSelf';
}

/** Shape of an asset field when reading a saved record back. */
export interface AssetReadValue {
  /** Remote URL (temporary, expires). Use downloadAsset() to fetch the file. */
  downloadURL: string;
  /** File size in bytes. */
  size: number;
  /** Local file URI if the asset has already been downloaded. */
  localPath?: string;
}

/** Asset field type used when specifying a record to save. */
export interface AssetField {
  type: 'asset';
  /** Local file path or file:// URI to upload. */
  fileURL: string;
}

/** A record as read from CloudKit. */
export interface CloudKitRecord {
  /** CKRecord.recordType */
  recordType: string;
  /** CKRecord.recordID.recordName */
  recordName: string;
  /** Zone name the record lives in. */
  zoneName: string;
  /** Record owner name. */
  ownerName: string;
  /** CKRecord modification date as ISO 8601 string. */
  modificationDate: string | null;
  /** CKRecord creation date as ISO 8601 string. */
  creationDate: string | null;
  /** CKRecord.recordChangeTag — used for conflict detection. */
  changeTag: string | null;
  /** All fields on the record, keyed by field name. */
  fields: Record<string, RecordField>;
}

/** A record to save. Provide `recordName` to update an existing record. */
export interface RecordToSave {
  /** CKRecord.recordType */
  recordType: string;
  /**
   * Leave undefined to let CloudKit generate a UUID.
   * Provide to update an existing record.
   */
  recordName?: string;
  /** Zone name. Defaults to the default zone if omitted. */
  zoneName?: string;
  /**
   * Provide the last known changeTag to enable server-side conflict detection.
   * If the server's changeTag differs, the save will fail with CONFLICT.
   */
  changeTag?: string;
  /** Fields to set on the record. */
  fields: Record<string, RecordField>;
}

/** A record returned after a successful save operation. */
export interface SavedRecord {
  recordType: string;
  recordName: string;
  zoneName: string;
  ownerName: string;
  modificationDate: string;
  creationDate: string;
  changeTag: string;
  fields: Record<string, RecordField>;
}

/** Identifies a specific record for delete or fetch operations. */
export interface RecordIdentifier {
  recordName: string;
  zoneName?: string;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * A simple predicate for queryRecords.
 * Maps to NSPredicate format: `field comparator value`.
 *
 * Supported comparators: '=', '!=', '<', '<=', '>', '>=',
 * 'BEGINSWITH', 'CONTAINS', 'IN'
 */
export interface QueryPredicate {
  field: string;
  comparator:
    | '='
    | '!='
    | '<'
    | '<='
    | '>'
    | '>='
    | 'BEGINSWITH'
    | 'CONTAINS'
    | 'IN';
  value: string | number | boolean | null | Array<string | number>;
}

export interface SortDescriptor {
  field: string;
  ascending: boolean;
}

export interface QueryResult {
  records: CloudKitRecord[];
  /**
   * Opaque cursor string for fetching the next page.
   * Undefined when there are no more results.
   */
  cursor: string | undefined;
}

// ---------------------------------------------------------------------------
// Zone Changes (delta fetch)
// ---------------------------------------------------------------------------

export interface ZoneChanges {
  /** Records that were inserted or modified since the last sync token. */
  changedRecords: CloudKitRecord[];
  /** Record names that were deleted since the last sync token. */
  deletedRecordNames: string[];
  /**
   * Opaque token representing the current server state.
   * Store this and pass it on the next fetchRecordZoneChanges call.
   */
  syncToken: string;
  /** True if the server has more changes; call again with the returned syncToken. */
  moreComing: boolean;
}

// ---------------------------------------------------------------------------
// Assets (Phase D)
// ---------------------------------------------------------------------------

/** Progress event emitted during CKAsset upload or download. */
export interface AssetProgress {
  /** Record name the asset belongs to. */
  recordName: string;
  /** Field name of the asset on the record. */
  fieldName: string;
  /** Bytes transferred so far. */
  bytesTransferred: number;
  /** Total bytes. -1 if unknown. */
  totalBytes: number;
  /** 0.0 to 1.0. -1 if unknown. */
  fraction: number;
  /** Whether this is an upload or download. */
  direction: 'upload' | 'download';
}

// ---------------------------------------------------------------------------
// Batch Progress (Phase C)
// ---------------------------------------------------------------------------

/**
 * Progress event emitted during a `saveRecords` batch operation.
 *
 * One event is emitted per record as the underlying
 * `CKModifyRecordsOperation` reports per-record completion.
 *
 * @example
 * ```typescript
 * addBatchProgressListener((progress) => {
 *   console.log(`${progress.completed}/${progress.total} — ${progress.recordName}`);
 * });
 * ```
 */
export interface BatchProgress {
  /** Number of records completed so far in this batch (1-based). */
  completed: number;
  /** Total number of records in this batch. */
  total: number;
  /** The `recordName` of the record that was just processed. */
  recordName: string;
}

// ---------------------------------------------------------------------------
// Sharing — CKShare (Phase C)
// ---------------------------------------------------------------------------

export type SharePermission = 'none' | 'readOnly' | 'readWrite';

/** Mirrors CKShare record fields. */
export interface Share {
  /** recordName of the CKShare record. */
  shareRecordName: string;
  zoneName: string;
  /** URL to share with participants. */
  shareURL: string | null;
  publicPermission: SharePermission;
  /** ISO 8601 creation date. */
  creationDate: string;
}

/** Outcome from presentSharingUI. */
export interface SharingUIResult {
  /** Whether the user completed the sharing flow or cancelled. */
  outcome: 'shared' | 'cancelled';
  share: Share | null;
}

/** Result of accepting a share via URL. */
export interface AcceptedShare {
  /** The zone now accessible in the shared database. */
  zoneName: string;
  ownerName: string;
  shareRecordName: string;
}

/**
 * Event emitted by `addShareAcceptedListener` when the system routes a
 * CloudKit share URL to the app (e.g. via universal link or Sharing sheet).
 *
 * This event fires *before* the share has been accepted — only the URL is
 * available at this point. Pass `shareURL` to `acceptShare()` to complete
 * the acceptance flow and gain access to the shared zone.
 */
export interface ShareInvitationEvent {
  /** The CloudKit share URL the app was opened with. Pass this to acceptShare() to complete the flow. */
  shareURL: string;
}

export type ParticipantRole = 'owner' | 'privateUser' | 'publicUser' | 'unknown';
export type ParticipantPermission = 'none' | 'readOnly' | 'readWrite' | 'unknown';
export type ParticipantAcceptanceStatus =
  | 'unknown'
  | 'pending'
  | 'accepted'
  | 'removed';

export interface ShareParticipant {
  /** CKRecord.ID.recordName for this participant. */
  participantRecordName: string;
  role: ParticipantRole;
  permission: ParticipantPermission;
  acceptanceStatus: ParticipantAcceptanceStatus;
  /** User's iCloud first name, if available. */
  firstName: string | null;
  /** User's iCloud last name, if available. */
  lastName: string | null;
}

/** A zone accessible via the shared database. */
export interface SharedZone {
  zoneName: string;
  ownerName: string;
  shareRecordName: string;
  participants: ShareParticipant[];
}

// ---------------------------------------------------------------------------
// Sharing — CKShare options interfaces (Phase B)
// ---------------------------------------------------------------------------

/**
 * Options for `createShare()`.
 * Creates a new CKShare record for the specified root record, making it
 * eligible for sharing with other iCloud users.
 */
export interface CreateShareOptions {
  /** recordName of the root record to share. */
  recordName: string;
  /** Zone the root record lives in. Omit for the default zone. */
  zoneName?: string;
  /** Database the root record lives in. Default: 'private'. */
  database?: DatabaseScope;
  /**
   * Permission level granted to anyone who joins via the share URL.
   * Default: 'none'.
   */
  publicPermission?: SharePermission;
}

/**
 * Options for `deleteShare()`.
 * Deletes a CKShare record and revokes access for all participants.
 */
export interface DeleteShareOptions {
  /** recordName of the CKShare record to delete. */
  shareRecordName: string;
  /** Zone the share lives in. Omit for the default zone. */
  zoneName?: string;
  /** Database the share lives in. Default: 'private'. */
  database?: DatabaseScope;
}

/**
 * Options for `presentSharingUI()`.
 * Presents the system UICloudSharingController for the specified record.
 */
export interface PresentSharingOptions {
  /** recordName of the root record whose share to manage. */
  recordName: string;
  /** Zone the root record lives in. Omit for the default zone. */
  zoneName?: string;
  /** Database the root record lives in. Default: 'private'. */
  database?: DatabaseScope;
  /**
   * Initial public permission to set on a newly created share.
   * Ignored if a CKShare already exists for the record.
   */
  permission?: SharePermission;
}

/**
 * Options for `fetchShareParticipants()`.
 * Returns the current list of participants on an existing share.
 */
export interface FetchParticipantsOptions {
  /** recordName of the CKShare record to inspect. */
  shareRecordName: string;
  /** Zone the share lives in. Omit for the default zone. */
  zoneName?: string;
  /** Database the share lives in. Default: 'private'. */
  database?: DatabaseScope;
}

/**
 * Options for `updateSharePermission()`.
 * Changes the permission of a specific participant on a share.
 */
export interface UpdatePermissionOptions {
  /** recordName of the CKShare record to update. */
  shareRecordName: string;
  /** recordName of the participant whose permission to change. */
  participantRecordName: string;
  /** New permission level to assign to the participant. */
  permission: ParticipantPermission;
  /** Zone the share lives in. Omit for the default zone. */
  zoneName?: string;
}

/**
 * Options for `removeShareParticipant()`.
 * Removes a participant from a share, revoking their access.
 */
export interface RemoveParticipantOptions {
  /** recordName of the CKShare record to update. */
  shareRecordName: string;
  /** recordName of the participant to remove. */
  participantRecordName: string;
  /** Zone the share lives in. Omit for the default zone. */
  zoneName?: string;
}

/**
 * Options for `acceptShare()`.
 * Accepts a share invitation via its URL, making the shared zone accessible
 * in the current user's shared database.
 */
export interface AcceptShareOptions {
  /** The CKShare URL from the invitation (e.g. `https://www.icloud.com/share/...`). */
  shareURL: string;
}

// ---------------------------------------------------------------------------
// CKSyncEngine (Phase B — iOS 17+)
// ---------------------------------------------------------------------------

/**
 * Configuration passed to `startSyncEngine()`.
 *
 * On iOS 17+, `automaticallySync` delegates scheduling to CKSyncEngine.
 * On iOS 16, it starts a timer-based polling loop (default 30s interval).
 */
export interface SyncEngineConfig {
  /** Zone names to track with the sync engine. */
  zones: string[];
  /** Which database to sync. Default: 'private'. */
  database?: DatabaseScope;
  /**
   * Whether the engine should schedule syncs automatically.
   * On iOS 17+, uses CKSyncEngine's built-in scheduling.
   * On iOS 16, starts a polling timer (default 30s interval).
   * Default: true.
   */
  automaticallySync?: boolean;
  /**
   * When `true`, the module emits `onSyncConflict` events instead of applying
   * server-record-wins automatically whenever a write conflict is detected.
   *
   * The caller MUST listen for these events via `addSyncEngineListener` (filtering
   * for `event.type === 'conflict'`) and call `resolveSyncConflict()` for each
   * emitted conflict. If `resolveSyncConflict()` is never called for a given
   * `requestId`, the sync engine will hang waiting for resolution — no further
   * records will be sent until every pending conflict is resolved.
   *
   * Set to `false` (or omit) to retain the default server-record-wins behavior,
   * in which conflicts are silently resolved by discarding the client version.
   *
   * Default: `false`.
   */
  resolveConflicts?: boolean;
}

/**
 * Current lifecycle state of the sync provider as returned by `getSyncState()`.
 *
 * - `'idle'`       — Running normally, no active sync cycle.
 * - `'syncing'`    — A fetch or send cycle is in progress.
 * - `'suspended'`  — Engine is paused (e.g. account unavailable).
 * - `'notStarted'` — `startSyncEngine()` has not been called.
 */
export type SyncProviderStatus = 'idle' | 'syncing' | 'suspended' | 'notStarted';

/**
 * Snapshot returned by the synchronous `getSyncState()` call.
 *
 * Reflects in-memory state; updated immediately as state transitions occur.
 * Subscribe to `addSyncEngineListener` for real-time state change events.
 */
export interface SyncState {
  /**
   * Whether CKSyncEngine (iOS 17+) is active.
   * `false` means the iOS 16 manual-fetch fallback is running.
   */
  usesSyncEngine: boolean;
  /** Current lifecycle state of the sync provider. */
  status: SyncProviderStatus;
}

/**
 * Discriminated-union type for all events emitted by `addSyncEngineListener`.
 * Filter by `event.type` to handle each case.
 */
export type SyncEngineEventType =
  | 'stateChanged'
  | 'recordsFetched'
  | 'recordsSent'
  | 'syncError'
  | 'conflict';

/**
 * Event emitted when the sync provider's lifecycle state changes.
 * Fired on transitions such as idle → syncing → idle, or when account changes.
 */
export interface SyncStateChangedEvent {
  type: 'stateChanged';
  /** The updated sync state. */
  state: SyncState;
}

/**
 * Event emitted after records are fetched from the server.
 * One event is emitted per zone per sync cycle.
 */
export interface RecordsFetchedEvent {
  type: 'recordsFetched';
  /** The name of the CloudKit record zone this event's records belong to. */
  zoneName: string;
  /** Records that were inserted or modified on the server. */
  changedRecords: CloudKitRecord[];
  /** Identifiers of records deleted on the server since the last sync. */
  deletedRecordIDs: RecordIdentifier[];
}

/**
 * Event emitted after the sync provider attempts to push local changes.
 * Contains both successful saves and any failures with optional server versions.
 */
export interface RecordsSentEvent {
  type: 'recordsSent';
  /** Records successfully saved to the server. */
  savedRecords: SavedRecord[];
  /**
   * Records that failed to save.
   * For CONFLICT failures, `serverRecord` contains the current server version
   * so the caller can perform a custom merge before re-enqueuing.
   */
  failedRecords: Array<{
    recordIdentifier: RecordIdentifier;
    error: { code: string; message: string };
    /** Present for CONFLICT errors — the current server version of the record. */
    serverRecord?: CloudKitRecord;
  }>;
}

/**
 * Event emitted when the sync provider encounters an unrecoverable error.
 * After this event, call `stopSyncEngine()` and inspect `error.code`.
 */
export interface SyncErrorEvent {
  type: 'syncError';
  error: { code: string; message: string };
}

/**
 * Event emitted when CKSyncEngine detects a write conflict and
 * `SyncEngineConfig.resolveConflicts` is `true`.
 *
 * The caller must call `resolveSyncConflict(requestId, resolvedRecord)` to
 * unblock the sync engine. Pass `null` for `resolvedRecord` to accept the
 * server version. If `resolveSyncConflict()` is never called, the sync
 * engine will hang until the app is restarted.
 *
 * Only emitted on iOS 17+ (CKSyncEngine). On iOS 16 the legacy fetch path
 * does not support conflict callbacks; conflicts are silently resolved
 * server-record-wins regardless of this setting.
 */
export interface SyncConflictEvent {
  type: 'conflict';
  /** Opaque identifier; pass this to `resolveSyncConflict()`. */
  requestId: string;
  /** The version of the record that was staged locally for upload. */
  clientRecord: CloudKitRecord;
  /** The current server version of the record that conflicts with the client version. */
  serverRecord: CloudKitRecord;
}

/**
 * Union of all possible sync engine events.
 * Narrowed by the `type` discriminant field.
 *
 * @example
 * ```typescript
 * addSyncEngineListener((event) => {
 *   if (event.type === 'recordsFetched') {
 *     console.log(event.changedRecords);
 *   }
 *   if (event.type === 'conflict') {
 *     // Merge client and server, then resolve
 *     resolveSyncConflict(event.requestId, mergedRecord);
 *   }
 * });
 * ```
 */
export type SyncEngineEvent =
  | SyncStateChangedEvent
  | RecordsFetchedEvent
  | RecordsSentEvent
  | SyncErrorEvent
  | SyncConflictEvent;

/**
 * A queued change for the sync engine to process on its next send cycle.
 *
 * Discriminated union that makes invalid states unrepresentable at compile time:
 * - `type: 'save'` requires `record` — omitting it is a TypeScript error.
 * - `type: 'delete'` requires `recordIdentifier` — omitting it is a TypeScript error.
 */
export type PendingRecordChange =
  | { type: 'save'; record: RecordToSave }
  | { type: 'delete'; recordIdentifier: RecordIdentifier };

// ---------------------------------------------------------------------------
// Push Subscriptions (Phase B)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase C — Debug / Dashboard helpers
// ---------------------------------------------------------------------------

/**
 * Snapshot of the CloudKit container's identity and current account status.
 *
 * Returned by `__debugDumpContainerInfo()`. Intended for use in developer
 * tooling (e.g. a CloudKit Dashboard screen) and should not be surfaced to
 * end users in production builds.
 *
 * @internal
 */
export interface ContainerInfo {
  /** The container identifier, e.g. "iCloud.com.example.myapp". */
  containerID: string;
  /** The current iCloud account status at the time of the call. */
  accountStatus: AccountStatus;
}

/**
 * A CloudKit record with all server-assigned metadata fields included.
 *
 * Extends `CloudKitRecord` with fields that are always present on the server
 * but may be omitted from normal record responses for bandwidth reasons.
 * Returned by `__debugFetchRawRecord()`.
 *
 * All date fields are ISO 8601 strings to match `CloudKitRecord`.
 *
 * @internal
 */
export interface RawRecord extends CloudKitRecord {
  /** ISO 8601 creation date. Alias for `CloudKitRecord.creationDate` — always non-null here. */
  creationDate: string;
  /** ISO 8601 modification date. Alias for `CloudKitRecord.modificationDate` — always non-null here. */
  modificationDate: string;
  /** CKRecord.ID.recordName of the user who created the record, if available. */
  creatorUserRecordID?: string;
  /** CKRecord.ID.recordName of the user who last modified the record, if available. */
  lastModifiedUserRecordID?: string;
  /** CKRecord.recordChangeTag — opaque server version tag used for conflict detection. */
  recordChangeTag?: string;
}

/**
 * Discriminates between a CKQuerySubscription ('query') and a
 * CKDatabaseSubscription ('database').
 */
export type SubscriptionType = 'query' | 'database';

/**
 * A CloudKit push subscription as returned by `fetchSubscriptions()`.
 *
 * - `type: 'query'`    — Tied to a specific `recordType`; fires on record-level changes.
 * - `type: 'database'` — Fires whenever any records change in the database; `recordType` is absent.
 */
export interface CloudKitSubscription {
  /** The opaque subscription identifier generated by CloudKit. */
  id: string;
  /** Whether this is a record-level or database-level subscription. */
  type: SubscriptionType;
  /** Present only for 'query' subscriptions. */
  recordType?: string;
  /** The database this subscription monitors. */
  database: DatabaseScope;
}

/**
 * Options for `saveQuerySubscription()`.
 *
 * Maps to `CKQuerySubscription` with a `CKNotificationInfo` attached.
 * At least one of `firesOnRecordCreation`, `firesOnRecordUpdate`,
 * or `firesOnRecordDeletion` must be true (the default is all three).
 */
export interface SaveQuerySubscriptionOptions {
  /** The CKRecord type to monitor. */
  recordType: string;
  /**
   * Optional filter predicate. Omit to match all records of `recordType`.
   * Uses the same format as `queryRecords`.
   */
  predicate?: QueryPredicate;
  /** Fires when a matching record is created. Default: true. */
  firesOnRecordCreation?: boolean;
  /** Fires when a matching record is updated. Default: true. */
  firesOnRecordUpdate?: boolean;
  /** Fires when a matching record is deleted. Default: true. */
  firesOnRecordDeletion?: boolean;
  /** Zone to scope the subscription to. Omit for the default zone. */
  zoneName?: string;
  /** Target database. Default: 'private'. */
  database?: DatabaseScope;
}

/**
 * The operation that triggered a push notification from a query subscription.
 */
export type SubscriptionNotificationType = 'created' | 'updated' | 'deleted';

/**
 * Event emitted via `addSubscriptionListener` when a CKQuerySubscription fires.
 *
 * `recordFields` is populated only if the subscription's `CKNotificationInfo`
 * was configured with `desiredKeys`; otherwise it is absent.
 */
export interface QuerySubscriptionEvent {
  /** The subscription that triggered this notification. */
  subscriptionID: string;
  type: 'query';
  /** What happened to the record that triggered the notification. */
  notificationType: SubscriptionNotificationType;
  /** The affected record's `recordName`. May be absent for delete notifications. */
  recordID?: string;
  /** Partial field values included in the push payload (if configured). */
  recordFields?: Record<string, unknown>;
}

/**
 * Event emitted via `addSubscriptionListener` when a CKDatabaseSubscription fires.
 *
 * Signals that something changed in the given database. Call
 * `fetchRecordZoneChanges` to retrieve the actual deltas.
 */
export interface DatabaseSubscriptionEvent {
  /** The subscription that triggered this notification. */
  subscriptionID: string;
  type: 'database';
  /** Which database scope was affected. */
  databaseScope: DatabaseScope;
}

/**
 * Discriminated union of all subscription notification events.
 * Narrow by `event.type` to distinguish query from database events.
 *
 * @example
 * ```typescript
 * addSubscriptionListener((event) => {
 *   if (event.type === 'query') {
 *     console.log(event.notificationType, event.recordID);
 *   } else {
 *     fetchRecordZoneChanges(['myZone']);
 *   }
 * });
 * ```
 */
export type SubscriptionEvent = QuerySubscriptionEvent | DatabaseSubscriptionEvent;

// ---------------------------------------------------------------------------
// Phase C — CKRecord.Reference deep linking
// ---------------------------------------------------------------------------

/**
 * Options for `deleteRecordWithReferences()`.
 *
 * Controls how deeply the client-side reference graph walk descends before
 * issuing a batched delete. Each additional depth level requires additional
 * network round-trips to fetch referenced records prior to deletion.
 */
export interface DeleteRecordWithReferencesOptions {
  /**
   * Maximum depth of the reference graph to traverse and delete.
   * - 1: delete only the root record and its direct references
   * - 2: delete root + its references + their references
   * - 3: maximum depth (capped server-side)
   * Default: 1
   */
  maxDepth?: 1 | 2 | 3;
  /** CloudKit database scope. Default: 'private' */
  database?: DatabaseScope;
}

/**
 * Options for `fetchRecordWithReferences()`.
 *
 * Controls which record to fetch and how deeply to follow CKRecord.Reference
 * fields during resolution. Depth 1 resolves direct references; depth 2
 * follows references-of-references; and so on up to the maximum of 3.
 *
 * @example
 * ```typescript
 * const resolved = await fetchRecordWithReferences('abc123', {
 *   recordType: 'Note',
 *   zoneName: 'MyZone',
 *   depth: 2,
 * });
 * ```
 */
export interface FetchWithReferencesOptions {
  /** CKRecord.recordType of the root record to fetch. */
  recordType: string;
  /** Zone the root record lives in. Omit for the default zone. */
  zoneName?: string;
  /** Which database to query. Default: 'private'. */
  database?: DatabaseScope;
  /**
   * Maximum reference resolution depth.
   * 1 resolves the direct reference fields on the root record.
   * 2 also resolves references on those referenced records, and so on.
   * Default: 1. Maximum: 3.
   */
  depth?: number;
}

/**
 * A record returned by `fetchRecordWithReferences()`.
 *
 * Extends `CloudKitRecord` with a `resolvedReferences` map that replaces
 * reference fields with their full nested record data, resolved up to the
 * requested depth.
 *
 * Fields that are NOT reference fields remain in `fields` unchanged.
 * Reference fields whose target record could not be fetched are absent from
 * `resolvedReferences` but their `ReferenceValue` entry remains in `fields`.
 *
 * @example
 * ```typescript
 * const note = await fetchRecordWithReferences('abc123', {
 *   recordType: 'Note',
 *   zoneName: 'MyZone',
 *   depth: 1,
 * });
 * const author = note.resolvedReferences['author']; // ResolvedRecord | undefined
 * ```
 */
export interface ResolvedRecord extends CloudKitRecord {
  /**
   * Map of field name to fully resolved record for each CKRecord.Reference
   * field that was successfully resolved at the requested depth.
   *
   * Keys match the field names in `CloudKitRecord.fields`. Each value is
   * itself a ResolvedRecord, so nested references are recursively resolved
   * up to the depth specified in `FetchWithReferencesOptions.depth`.
   */
  resolvedReferences: Record<string, ResolvedRecord>;
}

// ---------------------------------------------------------------------------
// Phase C — Offline Queue
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a single entry in the offline operation queue.
 *
 * - `'pending'`  — Waiting for connectivity or the next drain cycle.
 * - `'retrying'` — A previous attempt failed; will be retried automatically.
 * - `'failed'`   — Exhausted all retry attempts; manual intervention required.
 */
export type OfflineQueueEntryStatus = 'pending' | 'retrying' | 'failed';

/**
 * A single operation persisted in the offline queue.
 *
 * Entries are created by `enqueueOfflineOperation()` and are processed
 * automatically on the next `drainOfflineQueue()` call or when connectivity
 * is restored.
 */
export interface OfflineQueueEntry {
  /** Opaque identifier for this queued operation. */
  queueId: string;
  /** Whether this entry is a record save or delete operation. */
  operation: 'save' | 'delete';
  /** The database scope this operation targets. */
  database: DatabaseScope;
  /** Current lifecycle status of the entry. */
  status: OfflineQueueEntryStatus;
  /** Number of failed attempts so far (0 on first enqueue). */
  retryCount: number;
  /** ISO 8601 timestamp when the entry was first enqueued. */
  createdAt: string;
  /** ISO 8601 timestamp of the next scheduled retry attempt. */
  nextRetryAt: string;
  /** CloudKitErrorCode string from the most recent failed attempt, if any. */
  lastErrorCode?: string;
  /**
   * The record data for this operation.
   * `RecordToSave` for 'save' operations; `RecordIdentifier` for 'delete' operations.
   */
  recordData: RecordToSave | RecordIdentifier;
}

/**
 * Aggregate status snapshot of the offline operation queue.
 *
 * Returned by `getOfflineQueueStatus()`. Pass `{ includeEntries: true }` to
 * populate the `entries` array with full entry details.
 */
export interface OfflineQueueStatus {
  /** Number of entries currently waiting to be attempted. */
  pending: number;
  /** Number of entries that are being retried after a failed attempt. */
  retrying: number;
  /** Number of entries that have exhausted all retry attempts. */
  failed: number;
  /** Total number of entries across all statuses. */
  total: number;
  /**
   * Full list of queue entries, populated only when
   * `getOfflineQueueStatus({ includeEntries: true })` is called.
   */
  entries?: OfflineQueueEntry[];
}

/**
 * Summary of a completed `drainOfflineQueue()` run.
 *
 * Reports how many operations succeeded, failed, or were skipped
 * (e.g. due to being gated behind failed prerequisites).
 */
export interface OfflineQueueDrainResult {
  /** Number of operations that completed successfully in this drain. */
  succeeded: number;
  /** Number of operations that failed and remain in the queue for retry. */
  failed: number;
  /** Number of operations that were skipped (e.g. dependency not resolved). */
  skipped: number;
}

/**
 * Returned by `enqueueOfflineOperation()` to confirm the operation was
 * persisted to the queue.
 */
export interface QueuedResult {
  /** Confirms the operation was queued (always `true`). */
  queued: true;
  /** Opaque identifier for the newly created queue entry. */
  queueId: string;
}

// ---------------------------------------------------------------------------
// Multi-container (H.3)
// ---------------------------------------------------------------------------

/**
 * A scoped CloudKit client bound to a specific container.
 * Returned by `createCloudKitClient()`. All methods operate on the
 * container specified at creation time, independently of the module-level
 * singleton configured by `configure()`.
 *
 * Remember to call `client.destroy()` when done to release native resources.
 *
 * @example
 * ```typescript
 * const client = await createCloudKitClient('iCloud.com.example.secondary');
 * const results = await client.queryRecords('Note', undefined, undefined, 'MyZone');
 * await client.destroy();
 * ```
 */
export interface CloudKitClient {
  /** The CloudKit container identifier this client is bound to. */
  readonly containerId: string;
  /** Opaque client ID used internally to route calls to the correct native instance. */
  readonly clientId: string;

  /**
   * Saves one or more records to the specified database in this client's container.
   *
   * @param records         - Records to save. Provide `recordName` to update an existing record.
   * @param database        - Target database. Default: 'private'.
   * @param operationConfig - Optional QoS and timeout configuration.
   */
  saveRecords(
    records: RecordToSave[],
    database?: DatabaseScope,
    operationConfig?: OperationConfig
  ): Promise<SavedRecord[]>;

  /**
   * Queries records by type with optional predicate and sort descriptors.
   *
   * @param recordType      - CKRecord type to query.
   * @param predicate       - Optional filter predicate.
   * @param sortDescriptors - Optional sort order.
   * @param zoneName        - Zone to query. Omit for the default zone.
   * @param database        - Target database. Default: 'private'.
   * @param resultsLimit    - Max records to return. Default: 200.
   * @param cursor          - Pagination cursor from a previous QueryResult.
   * @param desiredKeys     - Field names to fetch. Omit to fetch all fields.
   * @param operationConfig - Optional QoS and timeout configuration.
   */
  queryRecords(
    recordType: string,
    predicate?: QueryPredicate,
    sortDescriptors?: SortDescriptor[],
    zoneName?: string,
    database?: DatabaseScope,
    resultsLimit?: number,
    cursor?: string,
    desiredKeys?: string[],
    operationConfig?: OperationConfig
  ): Promise<QueryResult>;

  /**
   * Deletes one or more records from the specified database in this client's container.
   *
   * @param recordIds       - Record identifiers to delete.
   * @param database        - Target database. Default: 'private'.
   * @param operationConfig - Optional QoS and timeout configuration.
   */
  deleteRecords(
    recordIds: RecordIdentifier[],
    database?: DatabaseScope,
    operationConfig?: OperationConfig
  ): Promise<void>;

  /** Releases native resources associated with this client. */
  destroy(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Operation Configuration (G.3)
// ---------------------------------------------------------------------------

/**
 * Optional CKOperation configuration. Controls quality-of-service scheduling
 * and network timeout for individual CloudKit operations.
 *
 * On native (iOS), these values map directly to `CKOperationConfiguration.qualityOfService`
 * and `CKOperationConfiguration.timeoutIntervalForRequest`.
 *
 * On web, CloudKit JS does not expose QoS or timeout controls — this parameter
 * is accepted but silently ignored.
 */
export interface OperationConfig {
  /**
   * Quality of service for the underlying CKOperation.
   * - 'userInitiated': Highest priority. Use for operations triggered directly by user interaction.
   * - 'utility': Lower priority. Use for background sync or prefetch.
   * - 'background': Lowest priority. Use for bulk imports or non-time-sensitive work.
   * - 'default': System default (equivalent to 'utility' in most contexts).
   * Default: 'userInitiated'
   */
  qos?: 'userInitiated' | 'utility' | 'background' | 'default';
  /**
   * Timeout in seconds for the network request. When omitted, the system default is used.
   */
  timeout?: number;
  /**
   * When true, the operation records its wall-clock duration and retry count.
   * The metrics are available on the result where applicable, or emitted via
   * the corresponding event listener.
   *
   * Default: false.
   */
  collectMetrics?: boolean;
}

// ---------------------------------------------------------------------------
// Web — CloudKit Web Services configuration
// ---------------------------------------------------------------------------

/**
 * Configuration options for `configureWeb()`.
 *
 * These options are only relevant on web. On iOS/native, `configureWeb()` is
 * a no-op and these values are ignored.
 */
export interface WebConfigOptions {
  /**
   * API token from CloudKit Dashboard.
   * Required for any web access — grants public database read access without
   * user sign-in, and is included in all authenticated requests.
   *
   * Obtain at: https://developer.apple.com/documentation/cloudkit/obtaining-an-api-token-for-an-icloud-container
   */
  apiToken: string;

  /**
   * CloudKit environment to connect to.
   * Use 'development' during development and 'production' for shipping apps.
   * Default: 'production'.
   */
  environment?: 'development' | 'production';

  /**
   * When `true`, the CloudKit JS auth session (ckWebAuthToken) is persisted
   * to `localStorage` so it survives page reloads.
   *
   * Expiry is controlled by Apple: ~30 minutes for normal sessions, up to 2
   * weeks when the user chooses "Keep me signed in".
   *
   * Default: `true`.
   */
  persistSession?: boolean;
}

// ---------------------------------------------------------------------------
// Phase D — Optimistic updates
// ---------------------------------------------------------------------------

/**
 * Status of an optimistic mutation on a single record.
 *
 * State machine:
 *   idle → pending (update called) → committed (save succeeded) → idle
 *                                  → rolled-back (save failed)  → idle
 *
 * The status resets to `'idle'` on the next `update()` or `refetch()` call.
 */
export type OptimisticStatus = 'idle' | 'pending' | 'committed' | 'rolled-back';

// ---------------------------------------------------------------------------

/**
 * Discriminated union of all events emitted by `addOfflineQueueListener`.
 *
 * Filter by `event.type` to handle individual event kinds:
 *
 * - `'operationCompleted'`     — An operation drained successfully.
 * - `'operationFailed'`        — An operation attempt failed; may be retried.
 * - `'operationMovedToFailed'` — An operation exhausted all retries and is now `'failed'`.
 * - `'queueDrained'`           — A full drain cycle completed.
 * - `'queueStatusChanged'`     — The aggregate queue counts changed.
 *
 * @example
 * ```typescript
 * addOfflineQueueListener((event) => {
 *   if (event.type === 'operationCompleted') {
 *     console.log('Saved:', event.queueId, event.result);
 *   } else if (event.type === 'operationMovedToFailed') {
 *     console.warn('Permanently failed:', event.queueId, event.errorCode);
 *   }
 * });
 * ```
 */
export type OfflineQueueEvent =
  | {
      type: 'operationCompleted';
      /** The queue entry that completed. */
      queueId: string;
      /** The saved records returned by CloudKit, or `null` for delete operations. */
      result: SavedRecord[] | null;
    }
  | {
      type: 'operationFailed';
      /** The queue entry that failed this attempt. */
      queueId: string;
      /** CloudKitErrorCode string for the failure reason. */
      errorCode: string;
      /** How many total attempts have been made (including this one). */
      retryCount: number;
      /** Whether the queue will schedule another retry automatically. */
      willRetry: boolean;
    }
  | {
      type: 'operationMovedToFailed';
      /** The queue entry that permanently failed. */
      queueId: string;
      /** CloudKitErrorCode string for the last failure reason. */
      errorCode: string;
      /** Total number of attempts made before giving up. */
      retryCount: number;
    }
  | {
      type: 'queueDrained';
      /** Number of operations that succeeded in this drain cycle. */
      succeeded: number;
      /** Number of operations that failed in this drain cycle. */
      failed: number;
      /** Number of operations that were skipped in this drain cycle. */
      skipped: number;
    }
  | {
      type: 'queueStatusChanged';
      /** The updated aggregate queue status after the change. */
      status: OfflineQueueStatus;
    };

// ---------------------------------------------------------------------------
// Observability (Phase I.3)
// ---------------------------------------------------------------------------

/**
 * Timing and retry metrics for a single CloudKit operation.
 * Only populated when `OperationConfig.collectMetrics` is `true`.
 */
export interface OperationMetrics {
  /** Wall-clock duration of the operation in milliseconds. */
  durationMs: number;
  /**
   * Number of times the operation was automatically retried before succeeding
   * or ultimately failing. 0 means it succeeded on the first attempt.
   */
  retryCount: number;
}

/**
 * Health snapshot emitted by the sync engine at the end of each sync cycle
 * via the `onSyncHealth` native event.
 *
 * Subscribe with `useSyncHealth()` to receive these events in real time.
 *
 * The event is emitted on both iOS 17+ (CKSyncEngine) and iOS 16 (fallback
 * polling path). Use the `syncEngine` field to distinguish the two.
 */
export interface SyncHealthEvent {
  /**
   * Number of local records successfully sent to the server in this cycle.
   */
  sentCount: number;
  /**
   * Number of records fetched from the server in this cycle.
   */
  receivedCount: number;
  /**
   * Number of records that failed to save or fetch in this cycle.
   * A non-zero value does not stop the engine; individual failures are
   * surfaced separately via `RecordsSentEvent.failedRecords`.
   */
  failedCount: number;
  /**
   * Wall-clock duration of the complete sync cycle in milliseconds,
   * measured from the first operation start to the last operation end.
   */
  durationMs: number;
  /**
   * `true` when the sync cycle was driven by CKSyncEngine (iOS 17+).
   * `false` when the iOS 16 fallback polling path was used.
   */
  syncEngine: boolean;
}
