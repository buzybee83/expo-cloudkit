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

export interface SyncEngineConfig {
  /** Zone names to track with the sync engine. */
  zones: string[];
  database: DatabaseScope;
  /** Whether the engine should schedule syncs automatically. Default: true. */
  automaticallySync?: boolean;
}

export type SyncEngineEventType =
  | 'willFetchChanges'
  | 'fetchedRecordChanges'
  | 'willSendChanges'
  | 'sentRecordChanges'
  | 'accountChanged'
  | 'syncEngineError';

/** Event emitted by the CKSyncEngine listener. */
export interface SyncEngineEvent {
  type: SyncEngineEventType;
  /** Present for 'fetchedRecordChanges'. */
  changedRecords?: CloudKitRecord[];
  /** Present for 'fetchedRecordChanges'. */
  deletedRecordNames?: string[];
  /** Present for 'sentRecordChanges'. */
  savedRecords?: SavedRecord[];
  /** Present for 'sentRecordChanges'. */
  failedRecordNames?: string[];
  /** Present for 'syncEngineError'. */
  error?: {
    code: string;
    message: string;
  };
}

/** A queued change for the sync engine to process. */
export interface PendingRecordChange {
  type: 'save' | 'delete';
  record?: RecordToSave;
  recordIdentifier?: RecordIdentifier;
}
