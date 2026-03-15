/**
 * Unit tests for createCloudKitSchema and CloudKitValidationError.
 *
 * Intentionally does NOT install or import from `zod` — a lightweight
 * mock object that satisfies the ZodLike<T> structural type is used instead,
 * keeping zod out of devDependencies.
 */

import { createCloudKitSchema } from '../schema';
import { CloudKitError, CloudKitValidationError, CloudKitErrorCode } from '../errors';
import type { CloudKitRecord } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal CloudKitRecord fixture with the given fields. */
function makeRecord(fields: CloudKitRecord['fields']): CloudKitRecord {
  return {
    recordType: 'TestRecord',
    recordName: 'test-record-001',
    zoneName: '_defaultZone',
    ownerName: '_owner',
    modificationDate: null,
    creationDate: null,
    changeTag: null,
    fields,
  };
}

/**
 * A mock Zod-like schema that validates `{ title: string }`.
 * Returns a Zod-shaped success/failure result without depending on zod.
 */
const mockStringSchema = {
  safeParse(input: unknown): { success: true; data: { title: string } } | { success: false; error: { issues: unknown[] } } {
    const obj = input as Record<string, unknown>;
    if (typeof obj['title'] !== 'string') {
      return {
        success: false,
        error: {
          issues: [{ path: ['title'], message: 'Expected string, received ' + typeof obj['title'] }],
        },
      };
    }
    return { success: true, data: { title: obj['title'] } };
  },
};

/**
 * A mock schema that validates `{ createdAt: Date }`.
 */
const mockDateSchema = {
  safeParse(input: unknown): { success: true; data: { createdAt: Date } } | { success: false; error: { issues: unknown[] } } {
    const obj = input as Record<string, unknown>;
    if (!(obj['createdAt'] instanceof Date)) {
      return {
        success: false,
        error: {
          issues: [{ path: ['createdAt'], message: 'Expected Date instance' }],
        },
      };
    }
    return { success: true, data: { createdAt: obj['createdAt'] } };
  },
};

/**
 * A mock schema that validates `{ count: number }` (non-timestamp number).
 */
const mockNumberSchema = {
  safeParse(input: unknown): { success: true; data: { count: number } } | { success: false; error: { issues: unknown[] } } {
    const obj = input as Record<string, unknown>;
    if (typeof obj['count'] !== 'number') {
      return {
        success: false,
        error: { issues: [{ path: ['count'], message: 'Expected number' }] },
      };
    }
    return { success: true, data: { count: obj['count'] } };
  },
};

/**
 * A mock schema that passes through an asset field unchanged.
 */
const mockAssetSchema = {
  safeParse(input: unknown): { success: true; data: { photo: unknown } } | { success: false; error: { issues: unknown[] } } {
    const obj = input as Record<string, unknown>;
    if (typeof (obj['photo'] as Record<string, unknown>)?.['downloadURL'] !== 'string') {
      return {
        success: false,
        error: { issues: [{ path: ['photo'], message: 'Expected asset object' }] },
      };
    }
    return { success: true, data: { photo: obj['photo'] } };
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createCloudKitSchema', () => {
  // 1. Valid record → parse returns typed data
  it('parse returns typed data for a valid record', () => {
    const schema = createCloudKitSchema(mockStringSchema);
    const record = makeRecord({
      title: { type: 'string', value: 'Hello CloudKit' },
    });
    const result = schema.parse(record);
    expect(result.title).toBe('Hello CloudKit');
  });

  // 2. Invalid record → parse throws CloudKitValidationError
  it('parse throws CloudKitValidationError for an invalid record', () => {
    const schema = createCloudKitSchema(mockStringSchema);
    const record = makeRecord({
      title: { type: 'number', value: 42 },
    });
    expect(() => schema.parse(record)).toThrow(CloudKitValidationError);
  });

  it('thrown CloudKitValidationError has VALIDATION_FAILED code', () => {
    const schema = createCloudKitSchema(mockStringSchema);
    const record = makeRecord({ title: { type: 'number', value: 42 } });
    let caught: unknown;
    try {
      schema.parse(record);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CloudKitValidationError);
    expect((caught as CloudKitValidationError).code).toBe(CloudKitErrorCode.VALIDATION_FAILED);
  });

  it('thrown CloudKitValidationError includes zodErrors array', () => {
    const schema = createCloudKitSchema(mockStringSchema);
    const record = makeRecord({ title: { type: 'number', value: 42 } });
    let caught: unknown;
    try {
      schema.parse(record);
    } catch (err) {
      caught = err;
    }
    expect((caught as CloudKitValidationError).zodErrors).toHaveLength(1);
  });

  // 3. safeParse success → { success: true, data }
  it('safeParse returns success: true with typed data for a valid record', () => {
    const schema = createCloudKitSchema(mockStringSchema);
    const record = makeRecord({ title: { type: 'string', value: 'Hi' } });
    const result = schema.safeParse(record);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe('Hi');
    }
  });

  // 4. safeParse failure → { success: false, error: CloudKitValidationError }
  it('safeParse returns success: false with CloudKitValidationError for invalid record', () => {
    const schema = createCloudKitSchema(mockStringSchema);
    const record = makeRecord({ title: { type: 'number', value: 99 } });
    const result = schema.safeParse(record);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(CloudKitValidationError);
      expect(result.error.code).toBe(CloudKitErrorCode.VALIDATION_FAILED);
    }
  });

  // 5. Date coercion — number > 1e12 becomes Date
  it('coerces a number > 1e12 to a Date before validation', () => {
    const schema = createCloudKitSchema(mockDateSchema);
    const timestampMs = 1_700_000_000_000; // 2023-11-14 — well above 1e12
    const record = makeRecord({
      createdAt: { type: 'date', value: timestampMs },
    });
    const result = schema.safeParse(record);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.createdAt).toBeInstanceOf(Date);
      expect(result.data.createdAt.getTime()).toBe(timestampMs);
    }
  });

  // 6. Non-timestamp number — passed through as number (not coerced to Date)
  it('passes through a small number without coercing to Date', () => {
    const schema = createCloudKitSchema(mockNumberSchema);
    const record = makeRecord({
      count: { type: 'number', value: 7 },
    });
    const result = schema.safeParse(record);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.count).toBe('number');
      expect(result.data.count).toBe(7);
    }
  });

  // 7. Asset passthrough — { downloadURL, size } unchanged
  it('passes through an asset field value unchanged', () => {
    const schema = createCloudKitSchema(mockAssetSchema);
    const assetValue = { downloadURL: 'https://cdn.example.com/photo.jpg', size: 204800 };
    const record = makeRecord({
      photo: { type: 'asset', value: assetValue },
    });
    const result = schema.safeParse(record);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.photo).toEqual(assetValue);
    }
  });
});

// ---------------------------------------------------------------------------
// CloudKitValidationError
// ---------------------------------------------------------------------------

describe('CloudKitValidationError', () => {
  it('is an instance of CloudKitError', () => {
    const err = new CloudKitValidationError([{ path: ['x'], message: 'bad' }]);
    expect(err).toBeInstanceOf(CloudKitError);
  });

  it('builds a human-readable message from the first 3 issues', () => {
    const issues = [
      { path: ['title'], message: 'Required' },
      { path: ['count'], message: 'Expected number' },
      { path: ['deep', 'field'], message: 'Too small' },
      { path: ['extra'], message: 'Should not appear' },
    ];
    const err = new CloudKitValidationError(issues);
    expect(err.message).toContain('title: Required');
    expect(err.message).toContain('count: Expected number');
    expect(err.message).toContain('deep.field: Too small');
    expect(err.message).not.toContain('Should not appear');
  });

  it('has name CloudKitValidationError', () => {
    const err = new CloudKitValidationError([]);
    expect(err.name).toBe('CloudKitValidationError');
  });

  it('has recoverySuggestion set', () => {
    const err = new CloudKitValidationError([]);
    expect(err.recoverySuggestion).toBeTruthy();
  });

  it('preserves the prototype chain for instanceof checks', () => {
    const err = new CloudKitValidationError([]);
    expect(err instanceof CloudKitValidationError).toBe(true);
  });
});
