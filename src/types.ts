/**
 * expo-cloudkit — TypeScript type definitions
 *
 * Covers all Phase A–I API surface. Phase B–I types are included here
 * so consumers can import them even before the native implementations ship.
 *
 * ## Platform Support
 *
 * expo-cloudkit targets three platforms. The table below summarises which
 * function groups are available on each:
 *
 * | Function group                              | iOS (native) | Web | Android |
 * |---------------------------------------------|:------------:|:---:|:-------:|
 * | `configure` / `getAccountStatus`            | ✓            | ✓   | ✓       |
 * | `fetchUserRecordID`                         | ✓            | ✓   | ✓       |
 * | `createZone` / `deleteZone` / `fetchZones`  | ✓            | ✓   | ✓       |
 * | `saveRecords` / `fetchRecord` / `queryRecords` / `deleteRecords` | ✓ | ✓ | ✓ |
 * | `fetchRecordZoneChanges`                    | ✓            | ✓   | ✓       |
 * | `configureWeb` / `authenticateWeb`          | no-op        | ✓   | ✓       |
 * | `saveQuerySubscription` / `saveDatabaseSubscription` | ✓   | ✓   | ✓       |
 * | `createShare` / `acceptShare` / `fetchShareParticipants` | ✓ | ✓ | ✓    |
 * | `fetchSharedDatabaseZones`                  | ✓            | ✓   | ✓       |
 * | `fetchRecordWithReferences`                 | ✓            | ✓   | ✓       |
 * | `deleteRecordWithReferences`                | ✓            | stub| stub    |
 * | `presentSharingUI`                          | ✓            | stub| stub    |
 * | `enqueueOfflineOperation` / `drainOfflineQueue` | ✓        | ✓   | ✓       |
 * | `batchFetchRecords`                         | ✓            | ✓   | ✓       |
 * | `downloadAsset`                             | ✓            | stub| stub    |
 * | `startSyncEngine` / `stopSyncEngine`        | ✓ (iOS 17+)  | stub| stub    |
 * | `triggerSync` / `enqueuePendingChange`      | ✓ (iOS 17+)  | stub| stub    |
 * | `resolveSyncConflict`                       | ✓            | —   | throws  |
 * | `addSyncHealthListener`                     | ✓            | —   | no-op   |
 * | `registerBackgroundSync`                    | ✓            | stub| stub    |
 * | `__debug*` helpers                          | ✓            | stub| stub    |
 * | `authenticateAndroid`                       | —            | —   | ✓       |
 * | `handleAuthRedirect`                        | —            | —   | ✓       |
 *
 * **Legend:**
 * - ✓ — full implementation
 * - stub — throws `CloudKitNotSupportedError` at runtime
 * - no-op — returns immediately / returns a no-op Subscription
 * - — — not exported on this platform
 *
 * **Android routing:** On Android, Metro resolves `ExpoCloudKit.android.ts`
 * instead of `ExpoCloudKit.native.ts`. The Android module re-exports
 * everything from `ExpoCloudKit.web.ts` and adds stubs for the two
 * iOS-only operations (`resolveSyncConflict`, `addSyncHealthListener`).
 * CloudKit JS communicates with Apple servers directly via HTTPS — no iOS
 * system APIs are required for the supported operation set.
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
  /**
   * Unix ms timestamp of when the record was created on the server.
   * Absent on unsaved (locally-created) records.
   */
  creationDate?: number;
  /**
   * Unix ms timestamp of when the record was last modified on the server.
   * Absent on unsaved (locally-created) records.
   */
  modificationDate?: number;
  /** CKRecord.recordChangeTag — used for conflict detection. */
  changeTag: string | null;
  /** All fields on the record, keyed by field name. */
  fields: Record<string, RecordField>;
  /**
   * End-to-end encrypted fields stored in CKRecord.encryptedValues (iOS 15+).
   * Only participants of the record's CKShare can decrypt these fields.
   * Uses the same RecordField shape as `fields`. Absent on iOS < 15 or when no
   * encrypted fields are present on the record.
   */
  encryptedFields?: Record<string, RecordField>;
  /** recordName of the iCloud user who created this record. Absent until the record is saved. */
  createdByUserRecordID?: string;
  /** recordName of the iCloud user who last modified this record. Absent until the record is saved. */
  modifiedByUserRecordID?: string;
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
  /**
   * Encrypted fields to store in CKRecord.encryptedValues (iOS 15+).
   * Only share participants can decrypt these fields. Uses the same RecordField
   * shape as `fields`. Silently ignored on iOS < 15 and on web (where
   * CKRecord.encryptedValues is unavailable).
   */
  encryptedFields?: Record<string, RecordField>;
}

/** A record returned after a successful save operation. */
export interface SavedRecord {
  recordType: string;
  recordName: string;
  zoneName: string;
  ownerName: string;
  /** Unix ms timestamp of when the record was created. Always present on a saved record. */
  creationDate: number;
  /** Unix ms timestamp of when the record was last modified. Always present on a saved record. */
  modificationDate: number;
  changeTag: string;
  fields: Record<string, RecordField>;
  /**
   * Encrypted fields reflected back from CKRecord.encryptedValues (iOS 15+).
   * Absent on iOS < 15 or when no encrypted fields were saved.
   */
  encryptedFields?: Record<string, RecordField>;
  /** recordName of the iCloud user who created this record. */
  createdByUserRecordID?: string;
  /** recordName of the iCloud user who last modified this record. */
  modifiedByUserRecordID?: string;
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
  /** Unix ms timestamp of when the share was created. */
  creationDate: number;
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
 * Metadata for a CloudKit share URL, returned by `fetchShareMetadata()`.
 *
 * Describes the share without accepting it — useful for showing a preview
 * screen (owner name, title, permission level) before the user commits to
 * joining.  Call `acceptShare()` to accept the share afterwards.
 */
export interface ShareMetadata {
  /** Canonical share URL, or null if not yet propagated. */
  shareURL: string | null;
  /** iCloud given name of the share owner, if available. */
  ownerFirstName: string | null;
  /** iCloud family name of the share owner, if available. */
  ownerLastName: string | null;
  /** Permission the invitee would receive upon accepting. */
  participantPermission: ParticipantPermission;
  /** Role the invitee would have upon accepting. */
  participantRole: ParticipantRole;
  /**
   * recordName portion of the root record's CKRecord.ID.
   * Note: this is the record *name*, not the record *type* — use it as
   * an opaque identifier rather than a display string.
   */
  rootRecordType: string;
  /** Title set on the share via CKShare.SystemFieldKey.title, or null. */
  title: string | null;
  /** Total number of participants currently on the share (including owner). */
  participantCount: number;
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

/**
 * Event emitted by `addShareAcceptedListener` after the app delegate has
 * forwarded a `CKShareMetadata` via the `CKShareAccepted` notification and
 * `CKAcceptSharesOperation` has completed successfully.
 *
 * Unlike `ShareInvitationEvent`, this event fires *after* acceptance — the
 * shared zone is immediately accessible in the shared database.
 */
export interface ShareAcceptedEvent {
  /** The canonical CloudKit share URL, or null if not yet propagated. */
  shareURL: string | null;
  /** Given name of the share owner, or null if not available. */
  ownerFirstName: string | null;
  /** Family name of the share owner, or null if not available. */
  ownerLastName: string | null;
  /** The zone name now accessible in the shared database. */
  zoneName: string;
  /** The CKRecord.ID.recordName of the root record. */
  rootRecordType: string | null;
}

/**
 * Options for `setShareMetadata`.
 * Updates `CKShare.SystemFieldKey.title` and/or `thumbnailImageData` on an
 * existing CKShare record for richer share previews in Messages and Mail.
 */
export interface SetShareMetadataOptions {
  /** The `CKRecord.ID.recordName` of the existing CKShare record. */
  shareRecordName: string;
  /** Zone containing the share. Defaults to the default zone. */
  zoneName?: string;
  /** Display title shown in Messages/Mail share previews. */
  title?: string;
  /** Base64-encoded PNG or JPEG thumbnail (recommended: 150×150 px). */
  thumbnailData?: string;
  /** Database containing the share. Defaults to `'private'`. */
  database?: DatabaseScope;
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
  /** User's iCloud first name, if available. Null when CloudKit has not resolved name components. */
  firstName: string | null;
  /** User's iCloud last name, if available. Null when CloudKit has not resolved name components. */
  lastName: string | null;
  /**
   * A computed display name derived from firstName and lastName.
   *
   * Fallback logic (computed natively):
   * - Both available  → "First Last"
   * - Only firstName  → "First"
   * - Only lastName   → "Last"
   * - Neither         → "Unknown Participant"
   */
  displayName: string;
  /** True if this participant is the currently signed-in iCloud user. */
  isCurrentUser: boolean;
}

// ---------------------------------------------------------------------------
// Bulk Participant Operations
// ---------------------------------------------------------------------------

/**
 * A single entry in the `participants` array passed to `addParticipants`.
 *
 * Provide `email` (preferred) or `phoneNumber`. At least one must be present per entry.
 * If both are provided, email takes precedence on the native side.
 */
export interface BulkParticipantEntry {
  /** Email address of the person to invite. Preferred over phoneNumber. */
  email?: string;
  /**
   * Phone number of the person to invite.
   * Used only when email is absent. Typically E.164 format (e.g. "+14155551234").
   */
  phoneNumber?: string;
  /** Permission to grant this participant. Default: 'readOnly'. */
  permission?: SharePermission;
}

/**
 * Options for `addParticipants` (bulk invite).
 *
 * Fetches the CKShare once, resolves all participant lookups concurrently via
 * DispatchGroup, then saves the share once — 1 fetch + 1 save regardless of
 * how many participants are invited.
 */
export interface AddParticipantsOptions {
  /** CKRecord.ID.recordName of the CKShare record to modify. */
  shareRecordName: string;
  /**
   * People to invite. Entries whose lookup fails are silently skipped.
   * Compare the returned participant list to the input to detect failures.
   */
  participants: BulkParticipantEntry[];
  /** Zone the share lives in. Defaults to the default zone. */
  zoneName?: string;
  /** Which database contains the share. Default: 'private'. */
  database?: DatabaseScope;
}

// ---------------------------------------------------------------------------
// Participant Change Event
// ---------------------------------------------------------------------------

/**
 * Event emitted on `onParticipantChanged` whenever a participant joins or
 * leaves a share that is tracked by the sync engine.
 *
 * The native module diffs each CKShare record received in `recordsFetched`
 * sync events against a locally cached snapshot. One event is emitted per
 * addition or removal detected.
 *
 * Subscribe via `addParticipantChangeListener`.
 */
export interface ParticipantChangedEvent {
  /** CKRecord.ID.recordName of the share that changed. */
  shareRecordName: string;
  /** Zone the share lives in. */
  zoneName: string;
  /**
   * The participant who joined or left.
   *
   * For `'removed'` events, only `participantRecordName`, `acceptanceStatus: 'removed'`,
   * `displayName: 'Unknown Participant'`, and `isCurrentUser: false` are guaranteed —
   * CloudKit does not retain full identity for departed participants.
   */
  participant: ShareParticipant;
  /**
   * The nature of the change:
   * - `'added'`             — participant joined the share
   * - `'removed'`           — participant left or was removed
   * - `'permissionChanged'` — reserved; not yet emitted by the native module
   */
  changeType: 'added' | 'removed' | 'permissionChanged';
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
 * Options for `setDefaultParticipantPermission()`.
 * Sets `CKShare.publicPermission` — the default permission granted to all
 * participants who join via the share URL.
 */
export interface SetDefaultParticipantPermissionOptions {
  /** recordName of the CKShare record to update. */
  shareRecordName: string;
  /** New default permission for all participants who join via the share URL. */
  permission: SharePermission;
  /** Zone the share lives in. Omit for the default zone. */
  zoneName?: string;
  /** Database the share lives in. Default: 'private'. */
  database?: DatabaseScope;
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
 * Options for `addParticipant()`.
 * Programmatically invites a participant by email without presenting
 * UICloudSharingController. The iCloud user lookup is internal and not
 * exposed separately to prevent email enumeration.
 */
export interface AddParticipantOptions {
  /** recordName of the CKShare record to add the participant to. */
  shareRecordName: string;
  /**
   * Email address of the person to invite.
   * Internally looked up via `CKContainer.fetchShareParticipant(withEmailAddress:)`.
   */
  email: string;
  /** Permission to grant the new participant. Default: 'readOnly'. */
  permission?: SharePermission;
  /** Zone the share lives in. Omit for the default zone. */
  zoneName: string;
  /** Database the share lives in. Default: 'private'. */
  database?: DatabaseScope;
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
 * Determines how write conflicts (CKError.serverRecordChanged) are resolved
 * when the sync engine attempts to push a local record change.
 *
 * - `'serverWins'` (default): accept the server record as-is. The client's
 *   pending change is discarded. Safe and predictable.
 * - `'clientWins'`: copy all client fields onto the server record's changeTag
 *   envelope and re-enqueue. Overwrites any concurrent server-side changes.
 * - `'fieldLevelMerge'`: per-field merge — for each field, prefer whichever
 *   record (client or server) has the more recent `modificationDate`.
 *   Re-enqueues the merged record.
 * - `'manual'`: emit a conflict event (`onSyncConflict`) so the JS caller can
 *   implement custom merge logic. The caller must respond by calling
 *   `resolveSyncConflict(requestId, resolvedRecord)`.
 *   Equivalent to the legacy `resolveConflicts: true` option.
 */
export type ConflictStrategy =
  | 'serverWins'
  | 'clientWins'
  | 'fieldLevelMerge'
  | 'manual';

/**
 * Configuration passed to `startSyncEngine()`.
 *
 * On iOS 17+, `automaticallySync` delegates scheduling to CKSyncEngine.
 * On iOS 16, it starts a timer-based polling loop (default 30s interval).
 */
export interface SyncEngineConfig {
  /** Zone names to track with the sync engine. */
  zones: string[];
  /**
   * Which database scope to sync. Default: 'private'.
   * @deprecated Use `databases` instead. If both `database` and `databases`
   * are set, `databases` takes precedence and `database` is ignored.
   */
  database?: DatabaseScope;
  /**
   * Which database scope(s) to sync. Replaces the singular `database` field.
   *
   * Pass `'private'`, `'shared'`, or `['private', 'shared']`. When multiple
   * scopes are given, the module creates one sync engine per scope internally
   * (one `CKSyncEngine` instance per `CKDatabase`).
   *
   * Note: `'public'` is not supported — `CKSyncEngine` does not support the
   * public database. Use push subscriptions (`saveQuerySubscription`) instead.
   *
   * Default: `'private'`.
   */
  databases?: DatabaseScope | DatabaseScope[];
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
   * @deprecated Prefer `conflictStrategy: 'manual'` for explicit intent.
   * When `conflictStrategy` is also set, it takes precedence and `resolveConflicts`
   * is ignored.
   *
   * Default: `false`.
   */
  resolveConflicts?: boolean;
  /**
   * Built-in strategy for resolving write conflicts detected during a sync cycle.
   *
   * When set, this overrides `resolveConflicts`.
   * Default: `'serverWins'`.
   *
   * @see ConflictStrategy
   */
  conflictStrategy?: ConflictStrategy;
  /**
   * When true and `databases` includes `'shared'`, automatically detects
   * newly-accepted shared zones and adds them to the running sync engine
   * without requiring a full `startSyncEngine` restart.
   *
   * The zone ID is extracted from the `onShareAccepted` event and passed
   * directly to the shared-scope sync provider's `addZone` method.
   *
   * Default: false.
   */
  autoSyncNewShares?: boolean;
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
 * Scope-keyed dictionary returned by `getSyncState()` when multiple sync
 * engines are running.
 *
 * - When a single scope is running, the result has one key.
 * - When no engine is running, returns an empty object `{}`.
 * - When two scopes are running, both keys are present with independent states.
 *
 * @example
 * ```typescript
 * const states = getSyncState();
 * // { private: { usesSyncEngine: true, status: 'idle' },
 * //   shared:  { usesSyncEngine: true, status: 'syncing' } }
 * const privateStatus = states.private?.status;
 * ```
 */
export type SyncStateMap = Partial<Record<DatabaseScope, SyncState>>;

/**
 * Discriminated-union type for all events emitted by `addSyncEngineListener`.
 * Filter by `event.type` to handle each case.
 */
export type SyncEngineEventType =
  | 'stateChanged'
  | 'recordsFetched'
  | 'recordsSent'
  | 'syncError'
  | 'conflict'
  | 'syncCompleted';

/**
 * Event emitted when the sync provider's lifecycle state changes.
 * Fired on transitions such as idle → syncing → idle, or when account changes.
 */
export interface SyncStateChangedEvent {
  type: 'stateChanged';
  /** Which database scope this state change applies to. */
  databaseScope: DatabaseScope;
  /** The updated sync state. */
  state: SyncState;
}

/**
 * Event emitted after records are fetched from the server.
 * One event is emitted per zone per sync cycle.
 */
export interface RecordsFetchedEvent {
  type: 'recordsFetched';
  /** Which database scope these records were fetched from. */
  databaseScope: DatabaseScope;
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
  /** Which database scope these records were sent to. */
  databaseScope: DatabaseScope;
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
  /** Which database scope's engine encountered this error. */
  databaseScope: DatabaseScope;
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
  /** Which database scope's engine detected this conflict. */
  databaseScope: DatabaseScope;
  /** Opaque identifier; pass this to `resolveSyncConflict()`. */
  requestId: string;
  /**
   * The version of the record that was staged locally for upload.
   * Pass directly to `resolveSyncConflict()` or merge fields before passing.
   */
  clientRecord: RecordToSave;
  /**
   * The current server version of the record. Pass directly to
   * `resolveSyncConflict()` or merge fields before passing.
   */
  serverRecord: RecordToSave;
}

/**
 * Event emitted once after a full zone pull cycle completes — the "sync is done"
 * signal apps can use to trigger UI refreshes or analytics.
 *
 * In the iOS 17+ CKSyncEngine path this fires after the `didFetchChanges` delegate
 * callback. In the iOS 16 fallback path it fires after the
 * `CKFetchRecordZoneChangesOperation` completion block returns.
 *
 * One `syncCompleted` event is emitted per sync cycle, regardless of how many
 * `recordsFetched` batch events were emitted during that cycle.
 */
export interface SyncCompletedEvent {
  type: 'syncCompleted';
  /** Which database scope's sync cycle completed. */
  databaseScope: DatabaseScope;
  /** Total number of records received across all batches in this sync cycle. */
  recordCount: number;
  /** Zone names that were synced. */
  zoneNames: string[];
  /** Whether this was the first sync (no prior change token). */
  isInitialSync: boolean;
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
 *   if (event.type === 'syncCompleted') {
 *     console.log(`Sync done: ${event.recordCount} records from ${event.zoneNames.join(', ')}`);
 *   }
 * });
 * ```
 */
export type SyncEngineEvent =
  | SyncStateChangedEvent
  | RecordsFetchedEvent
  | RecordsSentEvent
  | SyncErrorEvent
  | SyncConflictEvent
  | SyncCompletedEvent;

/**
 * A queued change for the sync engine to process on its next send cycle.
 *
 * Discriminated union that makes invalid states unrepresentable at compile time:
 * - `type: 'save'` requires `record` — omitting it is a TypeScript error.
 * - `type: 'delete'` requires `recordIdentifier` — omitting it is a TypeScript error.
 */
export type PendingRecordChange =
  | { type: 'save'; record: RecordToSave; database?: DatabaseScope }
  | { type: 'delete'; recordIdentifier: RecordIdentifier; database?: DatabaseScope };

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
 * All date fields are Unix ms timestamps (number).
 *
 * @internal
 */
export interface RawRecord extends CloudKitRecord {
  /** Unix ms timestamp of record creation. Always non-null on a fetched raw record. */
  creationDate: number;
  /** Unix ms timestamp of last modification. Always non-null on a fetched raw record. */
  modificationDate: number;
  /** recordName of the iCloud user who created the record, if available. */
  createdByUserRecordID?: string;
  /** recordName of the iCloud user who last modified the record, if available. */
  modifiedByUserRecordID?: string;
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
  /** Which database scope this health event applies to. */
  databaseScope: DatabaseScope;
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

// ---------------------------------------------------------------------------
// Share Convenience — leaveShare, createShareFromTemplate, getShareActivity
// ---------------------------------------------------------------------------

/** Options for `leaveShare`. */
export interface LeaveShareOptions {
  /** The `CKRecord.ID.recordName` of the CKShare. */
  shareRecordName: string;
  /** Zone name. Omit to use the default zone. */
  zoneName?: string;
  /**
   * Which database the share lives in.
   * Defaults to `'shared'` — accepted shares appear in the shared database.
   */
  database?: DatabaseScope;
}

/**
 * Options for `createShareFromTemplate`.
 *
 * Combines createShare/createZoneShare + setShareMetadata +
 * setDefaultParticipantPermission + addParticipant into a single round trip.
 */
export interface CreateShareFromTemplateOptions {
  /** Zone to share. Required. */
  zoneName: string;
  /**
   * Record name to share at the record level.
   * When omitted, creates a zone-level share using a sentinel anchor record.
   */
  recordName?: string;
  /** Database to operate on. Default: `'private'`. */
  database?: DatabaseScope;
  /** Display title shown in Messages/Mail share previews. */
  title?: string;
  /** Base64-encoded PNG or JPEG image for share previews. */
  thumbnailData?: string;
  /**
   * Default permission granted to anyone who joins via the share URL.
   * Default: `'none'` (URL-based joining disabled).
   */
  publicPermission?: SharePermission;
  /**
   * Initial participants to invite immediately.
   * Each entry requires an `email` and an optional `permission` (default `'readOnly'`).
   */
  participants?: Array<{
    /** iCloud email address of the person to invite. */
    email: string;
    /** Permission to grant this participant. Default: `'readOnly'`. */
    permission?: SharePermission;
  }>;
}

/**
 * One entry in the array returned by `getShareActivity`.
 *
 * Represents all record modifications made by a single user within
 * the queried zone and time window.
 */
export interface ShareActivityEntry {
  /** CKRecord.ID.recordName for the user who made the changes. */
  userRecordName: string;
  /**
   * Formatted display name (first + last) when CloudKit discoverability
   * is enabled for this user. Null otherwise.
   */
  displayName: string | null;
  /** Number of records this user last modified in the scanned window. */
  recordCount: number;
  /**
   * Unix timestamp (ms) of this user's most recent modification
   * within the scanned window.
   */
  lastModifiedAt: number;
  /** Distinct CKRecord.recordType values this user modified. */
  recordTypes: string[];
}

/** Options for `getShareActivity`. */
export interface GetShareActivityOptions {
  /** Zone to summarise. */
  zoneName: string;
  /**
   * Which database to query.
   * Default: `'shared'` — shared zones appear in the shared database.
   */
  database?: DatabaseScope;
  /**
   * Maximum number of records to scan.
   * Capped to 200 by the native layer (CloudKit per-operation limit).
   * Default: 100.
   */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Batch Fetch (Phase I.1)
// ---------------------------------------------------------------------------

/**
 * The outcome of fetching a single record inside a `batchFetchRecords` call.
 * Either `record` or `error` is set — never both.
 */
export interface BatchFetchResult {
  /** The record name that was requested. */
  recordName: string;
  /** The fetched record, present on success. */
  record?: CloudKitRecord;
  /** Error details, present on failure. */
  error?: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Rate Limiting Events (Phase I.1)
// ---------------------------------------------------------------------------

/**
 * Event emitted on `onRateLimited` when CloudKit rate-limits an operation
 * and the native layer is about to retry automatically.
 */
export interface RateLimitedEvent {
  /** Seconds until the native layer retries. */
  retryAfter: number;
  /** Name of the rate-limited operation (e.g. 'saveRecords'). */
  operationName: string;
  /** Retry attempt number (starts at 1). */
  retryCount: number;
}

// ---------------------------------------------------------------------------
// Encrypted Search (L.2)
// ---------------------------------------------------------------------------

/**
 * Options for `indexEncryptedRecord`.
 *
 * Pass the plaintext strings **before** they are encrypted. The native layer
 * tokenises them and stores only the resulting tokens in a non-encrypted
 * `_SearchIndex` record, so no plaintext reaches the index.
 */
export interface IndexEncryptedRecordOptions {
  /** CKRecord.ID.recordName of the record being indexed. */
  recordName: string;
  /** Zone the record lives in. */
  zoneName: string;
  /** Database scope. Default: `'private'`. */
  database?: DatabaseScope;
  /**
   * Plaintext strings to index (extracted from the encrypted field values
   * before encrypting them). Each string is lowercased, split on whitespace
   * and punctuation, and filtered to tokens of at least 2 characters.
   */
  textValues: string[];
}

/**
 * Options for `deindexRecord`.
 * Removes all index entries that reference `recordName` in the given zone.
 */
export interface DeindexRecordOptions {
  /** CKRecord.ID.recordName of the record to remove from the index. */
  recordName: string;
  /** Zone the record lives in. */
  zoneName: string;
  /** Database scope. Default: `'private'`. */
  database?: DatabaseScope;
}

/**
 * Options for `searchEncrypted`.
 * Runs an AND query: all tokens produced from `query` must appear in the
 * record's index for it to be returned.
 */
export interface SearchEncryptedOptions {
  /**
   * Search query string. Tokenised with the same rules as `indexEncryptedRecord`
   * (lowercase, split on whitespace/punctuation, min 2 characters).
   */
  query: string;
  /** Zone to search within. */
  zoneName: string;
  /** Database scope. Default: `'private'`. */
  database?: DatabaseScope;
}
