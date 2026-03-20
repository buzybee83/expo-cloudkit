/**
 * Bidirectional conversion between CloudKit JS record shapes and expo-cloudkit types.
 *
 * CloudKit JS returns records in the format:
 *   {
 *     recordName, recordType, recordChangeTag,
 *     created: { timestamp, userRecordName, deviceID },
 *     modified: { timestamp, userRecordName, deviceID },
 *     fields: { fieldName: { value, type? } }
 *     // Zone info is NOT on the record itself — it comes from the request context
 *   }
 *
 * Our CloudKitRecord uses:
 *   {
 *     recordName, recordType, zoneName, ownerName,
 *     creationDate?: number,       // Unix ms timestamp (absent on unsaved records)
 *     modificationDate?: number,   // Unix ms timestamp (absent on unsaved records)
 *     changeTag: string | null,
 *     createdByUserRecordID?: string,
 *     modifiedByUserRecordID?: string,
 *     fields: Record<string, RecordField>
 *   }
 *
 * No imports from tsl-apple-cloudkit — this file works with plain JS objects.
 */

import type {
  CloudKitRecord,
  RecordField,
  RecordFieldValue,
  LocationValue,
  ReferenceValue,
  AssetReadValue,
  RecordToSave,
  SavedRecord,
} from '../types';

// ---------------------------------------------------------------------------
// Internal types — raw CloudKit JS shapes
// ---------------------------------------------------------------------------

/** Raw field value as returned by CloudKit JS. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CKJSFieldValue = any;

/** A single field in a CloudKit JS record response. */
interface CKJSField {
  value: CKJSFieldValue;
  type?: string;
}

/** CloudKit JS record response shape. */
interface CKJSRecord {
  recordName: string;
  recordType: string;
  recordChangeTag?: string;
  created?: { timestamp?: number; userRecordName?: string };
  modified?: { timestamp?: number; userRecordName?: string };
  fields?: Record<string, CKJSField>;
  zoneID?: { zoneName?: string; ownerRecordName?: string };
}

// ---------------------------------------------------------------------------
// Reference action mapping
// ---------------------------------------------------------------------------

/**
 * Maps CloudKit JS reference action strings (uppercase) to expo-cloudkit
 * action strings (camelCase). VALIDATE has no direct equivalent so maps to 'none'.
 */
function mapReferenceActionFromCKJS(action: string): 'none' | 'deleteSelf' {
  switch (action?.toUpperCase()) {
    case 'DELETE_SELF':
      return 'deleteSelf';
    case 'VALIDATE':
    case 'NONE':
    default:
      return 'none';
  }
}

/**
 * Maps expo-cloudkit reference action to CloudKit JS uppercase string.
 */
function mapReferenceActionToCKJS(action: 'none' | 'deleteSelf'): string {
  switch (action) {
    case 'deleteSelf':
      return 'DELETE_SELF';
    case 'none':
    default:
      return 'NONE';
  }
}

// ---------------------------------------------------------------------------
// Per-field conversion: CloudKit JS → expo-cloudkit RecordField
// ---------------------------------------------------------------------------

/**
 * Converts a single CloudKit JS field `{ value, type? }` to a `RecordField`.
 *
 * CloudKit JS field types are uppercase strings (e.g. 'STRING', 'INT64').
 * When `type` is absent, we infer from the JS value shape.
 */
function ckjsFieldToRecordField(field: CKJSField): RecordField {
  const { value, type } = field;
  const ckType = type?.toUpperCase() ?? '';

  // DATE / TIMESTAMP
  if (ckType === 'TIMESTAMP' || (ckType === '' && typeof value === 'number' && value > 1e12)) {
    return {
      type: 'date',
      value: new Date(value as number).toISOString(),
    };
  }

  // LOCATION
  if (
    ckType === 'LOCATION' ||
    (ckType === '' && value != null && typeof value === 'object' && 'latitude' in value)
  ) {
    const loc = value as { latitude: number; longitude: number };
    return {
      type: 'location',
      value: { latitude: loc.latitude, longitude: loc.longitude } satisfies LocationValue,
    };
  }

  // REFERENCE
  if (
    ckType === 'REFERENCE' ||
    (ckType === '' && value != null && typeof value === 'object' && 'recordName' in value && 'zoneID' in value)
  ) {
    const ref = value as {
      recordName: string;
      zoneID?: { zoneName?: string };
      action?: string;
    };
    return {
      type: 'reference',
      value: {
        recordName: ref.recordName,
        action: mapReferenceActionFromCKJS(ref.action ?? 'NONE'),
      } satisfies ReferenceValue,
    };
  }

  // ASSET — has downloadURL or fileChecksum
  if (
    ckType === 'ASSET' ||
    (ckType === '' && value != null && typeof value === 'object' && ('downloadURL' in value || 'fileChecksum' in value))
  ) {
    const asset = value as { downloadURL?: string; size?: number; fileChecksum?: string };
    return {
      type: 'asset',
      value: {
        downloadURL: asset.downloadURL ?? '',
        size: asset.size ?? 0,
      } satisfies AssetReadValue,
    };
  }

  // BYTES / DATA (base64 string)
  if (ckType === 'BYTES') {
    return { type: 'data', value: String(value) };
  }

  // List of strings
  if (
    ckType === 'STRING_LIST' ||
    (ckType === '' && Array.isArray(value) && value.every((v: unknown) => typeof v === 'string'))
  ) {
    return { type: 'stringList', value: value as string[] };
  }

  // List of numbers
  if (
    ckType === 'NUMBER_LIST' ||
    (ckType === '' && Array.isArray(value) && value.every((v: unknown) => typeof v === 'number'))
  ) {
    return { type: 'numberList', value: value as number[] };
  }

  // INT64 / DOUBLE / number
  if (ckType === 'INT64' || ckType === 'DOUBLE' || (ckType === '' && typeof value === 'number')) {
    return { type: 'number', value: value as number };
  }

  // STRING / default
  return { type: 'string', value: String(value ?? '') };
}

// ---------------------------------------------------------------------------
// Per-field conversion: expo-cloudkit RecordField → CloudKit JS field
// ---------------------------------------------------------------------------

/**
 * Converts an expo-cloudkit `RecordField` to CloudKit JS field format `{ value, type }`.
 */
function recordFieldToCKJS(field: RecordField): CKJSField {
  switch (field.type) {
    case 'date': {
      const ms = Date.parse(field.value as string);
      return { value: Number.isNaN(ms) ? 0 : ms, type: 'TIMESTAMP' };
    }

    case 'location': {
      const loc = field.value as LocationValue;
      return { value: { latitude: loc.latitude, longitude: loc.longitude }, type: 'LOCATION' };
    }

    case 'reference': {
      const ref = field.value as ReferenceValue;
      return {
        value: {
          recordName: ref.recordName,
          action: mapReferenceActionToCKJS(ref.action),
          // zoneID is required by CloudKit JS for REFERENCE fields; we use a
          // placeholder default zone since expo-cloudkit's ReferenceValue does
          // not carry zone context. Callers saving cross-zone references must
          // construct the raw CKRecord themselves.
          zoneID: { zoneName: '_defaultZone', ownerRecordName: '__defaultOwner__' },
        },
        type: 'REFERENCE',
      };
    }

    case 'asset': {
      // Asset upload on web is not yet supported. On read, the value is AssetReadValue.
      // On save attempts with an asset field, this will produce an empty field that
      // the server will reject — the caller should have caught this earlier.
      const asset = field.value as AssetReadValue;
      return { value: { downloadURL: asset?.downloadURL ?? '' }, type: 'ASSET' };
    }

    case 'data':
      return { value: field.value as string, type: 'BYTES' };

    case 'stringList':
      return { value: field.value as string[], type: 'STRING_LIST' };

    case 'numberList':
      return { value: field.value as number[], type: 'NUMBER_LIST' };

    case 'number':
      return { value: field.value as number, type: 'DOUBLE' };

    case 'string':
    default:
      return { value: field.value as string, type: 'STRING' };
  }
}

// ---------------------------------------------------------------------------
// Public: CloudKit JS record → CloudKitRecord
// ---------------------------------------------------------------------------

/**
 * Converts a raw CloudKit JS record response to an expo-cloudkit `CloudKitRecord`.
 *
 * @param record     - The raw record object from a CloudKit JS database call.
 * @param zoneName   - Zone name to attach (CloudKit JS puts this on the request, not the record).
 * @param ownerName  - Owner record name to attach (same reason as zoneName).
 */
export function ckjsRecordToCloudKitRecord(
  record: unknown,
  zoneName = '_defaultZone',
  ownerName = '__defaultOwner__'
): CloudKitRecord {
  const r = record as CKJSRecord;

  const fields: Record<string, RecordField> = {};
  if (r.fields && typeof r.fields === 'object') {
    for (const [key, field] of Object.entries(r.fields)) {
      if (field != null && typeof field === 'object') {
        fields[key] = ckjsFieldToRecordField(field as CKJSField);
      }
    }
  }

  // Extract zone info from the record's zoneID if present (overrides defaults)
  const zoneFromRecord = r.zoneID?.zoneName ?? zoneName;
  const ownerFromRecord = r.zoneID?.ownerRecordName ?? ownerName;

  // System metadata — use Unix ms timestamps to match the native iOS bridge.
  // Keys are omitted (undefined) when the CloudKit JS response does not include
  // the timestamp (e.g. for locally-created records that have not been saved yet).
  const creationDate: number | undefined =
    typeof r.created?.timestamp === 'number' ? r.created.timestamp : undefined;

  const modificationDate: number | undefined =
    typeof r.modified?.timestamp === 'number' ? r.modified.timestamp : undefined;

  const createdByUserRecordID: string | undefined =
    typeof r.created?.userRecordName === 'string' ? r.created.userRecordName : undefined;

  const modifiedByUserRecordID: string | undefined =
    typeof r.modified?.userRecordName === 'string' ? r.modified.userRecordName : undefined;

  const result: CloudKitRecord = {
    recordName: r.recordName ?? '',
    recordType: r.recordType ?? '',
    zoneName: zoneFromRecord,
    ownerName: ownerFromRecord,
    changeTag: r.recordChangeTag ?? null,
    fields,
  };

  if (creationDate !== undefined) result.creationDate = creationDate;
  if (modificationDate !== undefined) result.modificationDate = modificationDate;
  if (createdByUserRecordID !== undefined) result.createdByUserRecordID = createdByUserRecordID;
  if (modifiedByUserRecordID !== undefined) result.modifiedByUserRecordID = modifiedByUserRecordID;

  return result;
}

// ---------------------------------------------------------------------------
// Public: RecordToSave → CloudKit JS record input
// ---------------------------------------------------------------------------

/**
 * Converts an expo-cloudkit `RecordToSave` to CloudKit JS record input format.
 *
 * The `zoneName` is NOT embedded in the record body — it must be passed as
 * part of the `zoneID` in the enclosing request. The caller is responsible
 * for constructing the correct `zoneID` context.
 */
export function recordToSaveToCKJS(record: RecordToSave): Record<string, unknown> {
  const ckjsFields: Record<string, CKJSField> = {};
  for (const [key, field] of Object.entries(record.fields)) {
    ckjsFields[key] = recordFieldToCKJS(field);
  }

  const result: Record<string, unknown> = {
    recordType: record.recordType,
    fields: ckjsFields,
  };

  if (record.recordName) {
    result['recordName'] = record.recordName;
  }

  if (record.changeTag) {
    result['recordChangeTag'] = record.changeTag;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public: CloudKit JS saved record → SavedRecord
// ---------------------------------------------------------------------------

/**
 * Converts a CloudKit JS record returned by a save operation to `SavedRecord`.
 *
 * A saved record always has a `recordName`, `changeTag`, and timestamps.
 *
 * @param record    - Raw CloudKit JS record from `database.saveRecords(...)`.
 * @param zoneName  - Zone name (not on the record body in CloudKit JS responses).
 * @param ownerName - Owner record name.
 */
export function ckjsSavedRecordToSavedRecord(
  record: unknown,
  zoneName = '_defaultZone',
  ownerName = '__defaultOwner__'
): SavedRecord {
  const base = ckjsRecordToCloudKitRecord(record, zoneName, ownerName);
  const r = record as CKJSRecord;

  return {
    ...base,
    // SavedRecord requires these to be non-null numbers (Unix ms timestamps).
    // Fall back to Date.now() if CloudKit JS omits them (should not happen
    // for a successfully saved record, but guards against unexpected shapes).
    modificationDate: base.modificationDate ?? Date.now(),
    creationDate: base.creationDate ?? Date.now(),
    changeTag: r.recordChangeTag ?? base.changeTag ?? '',
  } as SavedRecord;
}

// ---------------------------------------------------------------------------
// Utility: convert fields map values for output
// ---------------------------------------------------------------------------

/**
 * Exported for testing. Converts a single RecordField to its RecordFieldValue.
 */
export function extractFieldValue(field: RecordField): RecordFieldValue {
  return field.value;
}
