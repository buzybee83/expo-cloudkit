/**
 * Unit tests for src/web/converters.ts
 *
 * Tests the bidirectional record conversion between CloudKit JS shapes and
 * expo-cloudkit types.
 */

import {
  ckjsRecordToCloudKitRecord,
  recordToSaveToCKJS,
  ckjsSavedRecordToSavedRecord,
  extractFieldValue,
} from '../../web/converters';
import type { RecordToSave } from '../../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRawRecord(overrides: Record<string, unknown> = {}) {
  return {
    recordName: 'test-record-name',
    recordType: 'Note',
    recordChangeTag: 'change-tag-1',
    created: { timestamp: 1700000000000, userRecordName: '_creator_' },
    modified: { timestamp: 1700001000000, userRecordName: '_modifier_' },
    fields: {} as Record<string, { value: unknown; type?: string }>,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ckjsRecordToCloudKitRecord
// ---------------------------------------------------------------------------

describe('ckjsRecordToCloudKitRecord', () => {
  describe('basic metadata', () => {
    it('maps recordName, recordType, and changeTag', () => {
      const raw = makeRawRecord();
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.recordName).toBe('test-record-name');
      expect(result.recordType).toBe('Note');
      expect(result.changeTag).toBe('change-tag-1');
    });

    it('uses default zone and owner when zoneID is absent', () => {
      const raw = makeRawRecord();
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.zoneName).toBe('_defaultZone');
      expect(result.ownerName).toBe('__defaultOwner__');
    });

    it('uses caller-supplied zoneName and ownerName when zoneID is absent', () => {
      const raw = makeRawRecord();
      const result = ckjsRecordToCloudKitRecord(raw, 'MyZone', 'myOwner');
      expect(result.zoneName).toBe('MyZone');
      expect(result.ownerName).toBe('myOwner');
    });

    it('prefers zoneID embedded in the record over caller-supplied defaults', () => {
      const raw = makeRawRecord({
        zoneID: { zoneName: 'RecordZone', ownerRecordName: 'recOwner' },
      });
      const result = ckjsRecordToCloudKitRecord(raw, 'CallerZone', 'callerOwner');
      expect(result.zoneName).toBe('RecordZone');
      expect(result.ownerName).toBe('recOwner');
    });

    it('converts created.timestamp to Unix ms number', () => {
      const raw = makeRawRecord({ created: { timestamp: 1700000000000 } });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.creationDate).toBe(1700000000000);
    });

    it('converts modified.timestamp to Unix ms number', () => {
      const raw = makeRawRecord({ modified: { timestamp: 1700001000000 } });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.modificationDate).toBe(1700001000000);
    });

    it('omits creationDate when created timestamp is absent', () => {
      const raw = makeRawRecord({ created: undefined });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.creationDate).toBeUndefined();
    });

    it('omits modificationDate when modified timestamp is absent', () => {
      const raw = makeRawRecord({ modified: undefined });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.modificationDate).toBeUndefined();
    });

    it('sets changeTag to null when recordChangeTag is absent', () => {
      const raw = makeRawRecord({ recordChangeTag: undefined });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.changeTag).toBeNull();
    });

    it('returns empty string for recordName when absent', () => {
      const raw = makeRawRecord({ recordName: undefined });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.recordName).toBe('');
    });

    it('returns empty fields object when fields is absent', () => {
      const raw = makeRawRecord({ fields: undefined });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields).toEqual({});
    });
  });

  describe('string fields', () => {
    it('converts a STRING field', () => {
      const raw = makeRawRecord({
        fields: { title: { value: 'Hello World', type: 'STRING' } },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields['title']).toEqual({ type: 'string', value: 'Hello World' });
    });

    it('infers string type from JS string value when type is absent', () => {
      const raw = makeRawRecord({
        fields: { title: { value: 'inferred' } },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields['title']).toEqual({ type: 'string', value: 'inferred' });
    });
  });

  describe('number fields', () => {
    it('converts an INT64 field', () => {
      const raw = makeRawRecord({
        fields: { count: { value: 42, type: 'INT64' } },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields['count']).toEqual({ type: 'number', value: 42 });
    });

    it('converts a DOUBLE field', () => {
      const raw = makeRawRecord({
        fields: { score: { value: 3.14, type: 'DOUBLE' } },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields['score']).toEqual({ type: 'number', value: 3.14 });
    });

    it('infers number type from small JS number (below timestamp threshold)', () => {
      const raw = makeRawRecord({
        fields: { rating: { value: 5 } },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields['rating']).toEqual({ type: 'number', value: 5 });
    });
  });

  describe('date / timestamp fields', () => {
    it('converts a TIMESTAMP field to ISO 8601 string', () => {
      const ts = 1700000000000;
      const raw = makeRawRecord({
        fields: { dueDate: { value: ts, type: 'TIMESTAMP' } },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields['dueDate']).toEqual({
        type: 'date',
        value: new Date(ts).toISOString(),
      });
    });

    it('infers date type from large JS number (>1e12 — Unix ms heuristic)', () => {
      const ts = 1_700_000_000_001; // > 1e12
      const raw = makeRawRecord({
        fields: { ts: { value: ts } },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields['ts']?.type).toBe('date');
    });
  });

  describe('reference fields', () => {
    it('converts a REFERENCE field', () => {
      const raw = makeRawRecord({
        fields: {
          parent: {
            value: {
              recordName: 'parent-rec',
              zoneID: { zoneName: '_defaultZone' },
              action: 'DELETE_SELF',
            },
            type: 'REFERENCE',
          },
        },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields['parent']).toEqual({
        type: 'reference',
        value: { recordName: 'parent-rec', action: 'deleteSelf' },
      });
    });

    it('maps NONE action to "none"', () => {
      const raw = makeRawRecord({
        fields: {
          link: {
            value: { recordName: 'linked', zoneID: {}, action: 'NONE' },
            type: 'REFERENCE',
          },
        },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields['link']?.value).toEqual({ recordName: 'linked', action: 'none' });
    });

    it('maps VALIDATE action to "none"', () => {
      const raw = makeRawRecord({
        fields: {
          link: {
            value: { recordName: 'linked', zoneID: {}, action: 'VALIDATE' },
            type: 'REFERENCE',
          },
        },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields['link']?.value).toEqual({ recordName: 'linked', action: 'none' });
    });

    it('infers REFERENCE from shape (recordName + zoneID present, no type)', () => {
      const raw = makeRawRecord({
        fields: {
          ref: {
            value: { recordName: 'inferred-ref', zoneID: { zoneName: '_defaultZone' } },
          },
        },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields['ref']?.type).toBe('reference');
    });
  });

  describe('asset fields', () => {
    it('converts an ASSET field with downloadURL', () => {
      const raw = makeRawRecord({
        fields: {
          photo: {
            value: {
              downloadURL: 'https://cvws.icloud.com/download/file.jpg',
              size: 2048,
            },
            type: 'ASSET',
          },
        },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields['photo']).toEqual({
        type: 'asset',
        value: {
          downloadURL: 'https://cvws.icloud.com/download/file.jpg',
          size: 2048,
        },
      });
    });

    it('infers ASSET from shape (downloadURL present, no explicit type)', () => {
      const raw = makeRawRecord({
        fields: {
          attachment: { value: { downloadURL: 'https://example.com/file.pdf' } },
        },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields['attachment']?.type).toBe('asset');
    });

    it('infers ASSET from shape (fileChecksum present, no explicit type)', () => {
      const raw = makeRawRecord({
        fields: {
          file: { value: { fileChecksum: 'abc123' } },
        },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields['file']?.type).toBe('asset');
    });

    it('uses empty string for downloadURL when absent', () => {
      const raw = makeRawRecord({
        fields: {
          photo: { value: { fileChecksum: 'abc' }, type: 'ASSET' },
        },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect((result.fields['photo']?.value as { downloadURL: string }).downloadURL).toBe('');
    });
  });

  describe('list fields', () => {
    it('converts a STRING_LIST field', () => {
      const raw = makeRawRecord({
        fields: {
          tags: { value: ['alpha', 'beta', 'gamma'], type: 'STRING_LIST' },
        },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields['tags']).toEqual({ type: 'stringList', value: ['alpha', 'beta', 'gamma'] });
    });

    it('infers stringList from array of strings', () => {
      const raw = makeRawRecord({
        fields: { tags: { value: ['a', 'b'] } },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields['tags']?.type).toBe('stringList');
    });

    it('converts a NUMBER_LIST field', () => {
      const raw = makeRawRecord({
        fields: {
          scores: { value: [10, 20, 30], type: 'NUMBER_LIST' },
        },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields['scores']).toEqual({ type: 'numberList', value: [10, 20, 30] });
    });

    it('infers numberList from array of numbers', () => {
      const raw = makeRawRecord({
        fields: { nums: { value: [1, 2, 3] } },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields['nums']?.type).toBe('numberList');
    });
  });

  describe('location fields', () => {
    it('converts a LOCATION field', () => {
      const raw = makeRawRecord({
        fields: {
          loc: { value: { latitude: 37.7749, longitude: -122.4194 }, type: 'LOCATION' },
        },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields['loc']).toEqual({
        type: 'location',
        value: { latitude: 37.7749, longitude: -122.4194 },
      });
    });

    it('infers location from shape (latitude key present, no type)', () => {
      const raw = makeRawRecord({
        fields: { pos: { value: { latitude: 0, longitude: 0 } } },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields['pos']?.type).toBe('location');
    });
  });

  describe('data / bytes fields', () => {
    it('converts a BYTES field to data type', () => {
      const raw = makeRawRecord({
        fields: { blob: { value: 'SGVsbG8=', type: 'BYTES' } },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields['blob']).toEqual({ type: 'data', value: 'SGVsbG8=' });
    });
  });

  describe('null / missing field handling', () => {
    it('skips null field entries without crashing', () => {
      const raw = makeRawRecord({
        fields: { good: { value: 'ok', type: 'STRING' }, bad: null },
      });
      const result = ckjsRecordToCloudKitRecord(raw as unknown as Record<string, unknown>);
      expect(result.fields['good']).toEqual({ type: 'string', value: 'ok' });
      expect(result.fields['bad']).toBeUndefined();
    });

    it('converts null value to empty string field', () => {
      const raw = makeRawRecord({
        fields: { nullable: { value: null, type: 'STRING' } },
      });
      const result = ckjsRecordToCloudKitRecord(raw);
      expect(result.fields['nullable']).toEqual({ type: 'string', value: '' });
    });
  });
});

// ---------------------------------------------------------------------------
// recordToSaveToCKJS
// ---------------------------------------------------------------------------

describe('recordToSaveToCKJS', () => {
  it('converts a basic RecordToSave with string field', () => {
    const record: RecordToSave = {
      recordType: 'Note',
      fields: {
        title: { type: 'string', value: 'My Note' },
      },
    };
    const result = recordToSaveToCKJS(record);
    expect(result['recordType']).toBe('Note');
    const fields = result['fields'] as Record<string, { value: unknown; type: string }>;
    expect(fields['title']).toEqual({ value: 'My Note', type: 'STRING' });
  });

  it('omits recordName when not provided', () => {
    const record: RecordToSave = {
      recordType: 'Note',
      fields: { title: { type: 'string', value: 'x' } },
    };
    const result = recordToSaveToCKJS(record);
    expect('recordName' in result).toBe(false);
  });

  it('includes recordName when provided', () => {
    const record: RecordToSave = {
      recordType: 'Note',
      recordName: 'my-record-id',
      fields: { title: { type: 'string', value: 'x' } },
    };
    const result = recordToSaveToCKJS(record);
    expect(result['recordName']).toBe('my-record-id');
  });

  it('includes recordChangeTag when changeTag is provided', () => {
    const record: RecordToSave = {
      recordType: 'Note',
      recordName: 'my-id',
      changeTag: 'tag-abc',
      fields: {},
    };
    const result = recordToSaveToCKJS(record);
    expect(result['recordChangeTag']).toBe('tag-abc');
  });

  it('omits recordChangeTag when changeTag is absent', () => {
    const record: RecordToSave = {
      recordType: 'Note',
      fields: {},
    };
    const result = recordToSaveToCKJS(record);
    expect('recordChangeTag' in result).toBe(false);
  });

  it('converts a number field to DOUBLE type', () => {
    const record: RecordToSave = {
      recordType: 'Item',
      fields: { count: { type: 'number', value: 99 } },
    };
    const result = recordToSaveToCKJS(record);
    const fields = result['fields'] as Record<string, { value: unknown; type: string }>;
    expect(fields['count']).toEqual({ value: 99, type: 'DOUBLE' });
  });

  it('converts a date field to TIMESTAMP type (ms number)', () => {
    const isoDate = '2026-01-15T12:00:00.000Z';
    const record: RecordToSave = {
      recordType: 'Event',
      fields: { startDate: { type: 'date', value: isoDate } },
    };
    const result = recordToSaveToCKJS(record);
    const fields = result['fields'] as Record<string, { value: unknown; type: string }>;
    expect(fields['startDate']?.type).toBe('TIMESTAMP');
    expect(fields['startDate']?.value).toBe(Date.parse(isoDate));
  });

  it('converts a reference field to REFERENCE type with zoneID placeholder', () => {
    const record: RecordToSave = {
      recordType: 'Comment',
      fields: {
        post: { type: 'reference', value: { recordName: 'post-123', action: 'deleteSelf' } },
      },
    };
    const result = recordToSaveToCKJS(record);
    const fields = result['fields'] as Record<string, { value: unknown; type: string }>;
    expect(fields['post']?.type).toBe('REFERENCE');
    const refValue = fields['post']?.value as Record<string, unknown>;
    expect(refValue['recordName']).toBe('post-123');
    expect(refValue['action']).toBe('DELETE_SELF');
    expect(refValue['zoneID']).toBeDefined();
  });

  it('converts a stringList field to STRING_LIST type', () => {
    const record: RecordToSave = {
      recordType: 'Post',
      fields: { tags: { type: 'stringList', value: ['a', 'b'] } },
    };
    const result = recordToSaveToCKJS(record);
    const fields = result['fields'] as Record<string, { value: unknown; type: string }>;
    expect(fields['tags']).toEqual({ value: ['a', 'b'], type: 'STRING_LIST' });
  });

  it('converts a numberList field to NUMBER_LIST type', () => {
    const record: RecordToSave = {
      recordType: 'Stats',
      fields: { scores: { type: 'numberList', value: [1, 2, 3] } },
    };
    const result = recordToSaveToCKJS(record);
    const fields = result['fields'] as Record<string, { value: unknown; type: string }>;
    expect(fields['scores']).toEqual({ value: [1, 2, 3], type: 'NUMBER_LIST' });
  });

  it('converts a data field to BYTES type', () => {
    const record: RecordToSave = {
      recordType: 'Binary',
      fields: { blob: { type: 'data', value: 'SGVsbG8=' } },
    };
    const result = recordToSaveToCKJS(record);
    const fields = result['fields'] as Record<string, { value: unknown; type: string }>;
    expect(fields['blob']).toEqual({ value: 'SGVsbG8=', type: 'BYTES' });
  });

  it('handles an empty fields map', () => {
    const record: RecordToSave = { recordType: 'Empty', fields: {} };
    const result = recordToSaveToCKJS(record);
    expect(result['fields']).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// ckjsSavedRecordToSavedRecord
// ---------------------------------------------------------------------------

describe('ckjsSavedRecordToSavedRecord', () => {
  it('converts a saved record with all metadata present', () => {
    const raw = makeRawRecord({
      fields: { title: { value: 'Saved Note', type: 'STRING' } },
    });
    const result = ckjsSavedRecordToSavedRecord(raw);
    expect(result.recordName).toBe('test-record-name');
    expect(result.recordType).toBe('Note');
    expect(result.changeTag).toBe('change-tag-1');
    expect(result.creationDate).toBe(1700000000000);
    expect(result.modificationDate).toBe(1700001000000);
    expect(result.fields['title']).toEqual({ type: 'string', value: 'Saved Note' });
  });

  it('uses numeric fallback for modificationDate when absent', () => {
    const raw = makeRawRecord({ modified: undefined });
    const result = ckjsSavedRecordToSavedRecord(raw);
    // SavedRecord requires a non-null Unix ms number
    expect(result.modificationDate).not.toBeNull();
    expect(typeof result.modificationDate).toBe('number');
    expect(result.modificationDate).toBeGreaterThan(0);
  });

  it('uses numeric fallback for creationDate when absent', () => {
    const raw = makeRawRecord({ created: undefined });
    const result = ckjsSavedRecordToSavedRecord(raw);
    expect(result.creationDate).not.toBeNull();
    expect(typeof result.creationDate).toBe('number');
    expect(result.creationDate).toBeGreaterThan(0);
  });

  it('uses recordChangeTag from the raw record for changeTag', () => {
    const raw = makeRawRecord({ recordChangeTag: 'final-tag' });
    const result = ckjsSavedRecordToSavedRecord(raw);
    expect(result.changeTag).toBe('final-tag');
  });

  it('falls back to empty string for changeTag when missing', () => {
    const raw = makeRawRecord({ recordChangeTag: undefined });
    const result = ckjsSavedRecordToSavedRecord(raw);
    expect(result.changeTag).toBe('');
  });

  it('passes zoneName and ownerName through', () => {
    const raw = makeRawRecord();
    const result = ckjsSavedRecordToSavedRecord(raw, 'SpecialZone', 'specialOwner');
    expect(result.zoneName).toBe('SpecialZone');
    expect(result.ownerName).toBe('specialOwner');
  });
});

// ---------------------------------------------------------------------------
// extractFieldValue
// ---------------------------------------------------------------------------

describe('extractFieldValue', () => {
  it('returns the value from a string field', () => {
    expect(extractFieldValue({ type: 'string', value: 'hello' })).toBe('hello');
  });

  it('returns the value from a number field', () => {
    expect(extractFieldValue({ type: 'number', value: 42 })).toBe(42);
  });

  it('returns the value from a date field', () => {
    const iso = '2026-01-01T00:00:00.000Z';
    expect(extractFieldValue({ type: 'date', value: iso })).toBe(iso);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: RecordToSave → CKJS → CloudKitRecord
// ---------------------------------------------------------------------------

describe('round-trip conversion', () => {
  it('round-trips a string field through both conversions', () => {
    const original: RecordToSave = {
      recordType: 'Note',
      recordName: 'round-trip-1',
      fields: { body: { type: 'string', value: 'round-trip text' } },
    };

    const ckjsShape = recordToSaveToCKJS(original);

    // Simulate a CKJS saved-record response
    const simulatedSavedRaw = {
      recordName: 'round-trip-1',
      recordType: 'Note',
      recordChangeTag: 'new-tag',
      created: { timestamp: Date.now() },
      modified: { timestamp: Date.now() },
      fields: ckjsShape['fields'],
    };

    const saved = ckjsSavedRecordToSavedRecord(simulatedSavedRaw);
    expect(saved.recordName).toBe('round-trip-1');
    expect(saved.fields['body']).toEqual({ type: 'string', value: 'round-trip text' });
  });

  it('round-trips a number field', () => {
    const original: RecordToSave = {
      recordType: 'Item',
      fields: { qty: { type: 'number', value: 7 } },
    };

    const ckjsShape = recordToSaveToCKJS(original);
    const simulatedRaw = {
      recordName: 'server-uuid',
      recordType: 'Item',
      recordChangeTag: 't1',
      fields: ckjsShape['fields'],
    };

    const record = ckjsRecordToCloudKitRecord(simulatedRaw);
    expect(record.fields['qty']).toEqual({ type: 'number', value: 7 });
  });
});
