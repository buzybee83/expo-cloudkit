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
  | 'syncError';

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
 * Union of all possible sync engine events.
 * Narrowed by the `type` discriminant field.
 *
 * @example
 * ```typescript
 * addSyncEngineListener((event) => {
 *   if (event.type === 'recordsFetched') {
 *     console.log(event.changedRecords);
 *   }
 * });
 * ```
 */
export type SyncEngineEvent =
  | SyncStateChangedEvent
  | RecordsFetchedEvent
  | RecordsSentEvent
  | SyncErrorEvent;

/** A queued change for the sync engine to process on its next send cycle. */
export interface PendingRecordChange {
  type: 'save' | 'delete';
  /** Required when type is 'save'. The record to save. */
  record?: RecordToSave;
  /** Required when type is 'delete'. The record to delete. */
  recordIdentifier?: RecordIdentifier;
}
