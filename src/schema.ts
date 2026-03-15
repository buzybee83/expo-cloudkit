/**
 * expo-cloudkit — Zod schema validation helpers
 *
 * Provides `createCloudKitSchema`, a factory that wraps any Zod (or
 * Zod-compatible) schema and produces a typed parser for `CloudKitRecord`
 * values.  The `zod` package is an optional peer dependency; this file does
 * NOT import from `zod` at runtime — the schema is accepted via structural
 * typing so any compatible validator works.
 */

import type { CloudKitRecord, RecordField } from './types';
import { CloudKitValidationError } from './errors';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * A typed parser for CloudKit records produced by `createCloudKitSchema`.
 *
 * Both `parse` and `safeParse` accept a raw `CloudKitRecord` (as returned by
 * `fetchRecord`, `queryRecords`, etc.) and validate its fields against the
 * schema you provided.
 */
export interface CloudKitParser<T> {
  /**
   * Parse a CloudKit record and return typed data.
   *
   * @throws {CloudKitValidationError} if the record fields do not match the schema
   */
  parse(record: CloudKitRecord): T;

  /**
   * Parse a CloudKit record without throwing.
   *
   * Returns `{ success: true, data }` on success or
   * `{ success: false, error: CloudKitValidationError }` on failure.
   */
  safeParse(
    record: CloudKitRecord
  ):
    | { success: true; data: T }
    | { success: false; error: CloudKitValidationError };
}

/**
 * Minimal interface that `createCloudKitSchema` accepts as a `schema`
 * argument.  Matches the shape of any Zod schema object, but is also
 * compatible with custom validators that implement the same contract.
 */
interface ZodLike<T> {
  safeParse(
    input: unknown
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: unknown[] } };
}

// ---------------------------------------------------------------------------
// createCloudKitSchema
// ---------------------------------------------------------------------------

/**
 * Creates a typed parser for CloudKit records using a Zod schema (or any
 * validator that implements the same `safeParse` interface).
 *
 * Field type coercions applied before validation:
 * - `number` values greater than `1e12` are coerced to `Date` objects
 *   (CloudKit timestamps are stored as Unix millisecond integers).
 * - All other values (`string`, `string[]`, `number[]`, asset objects,
 *   location objects, reference objects) are passed through unchanged.
 *
 * @param schema - A Zod schema or any object with a `safeParse` method that
 *   returns `{ success, data }` or `{ success, error: { issues } }`.
 * @returns A `CloudKitParser<T>` with `parse` and `safeParse` methods.
 *
 * @example
 * ```typescript
 * import { z } from 'zod'
 * import { createCloudKitSchema } from 'expo-cloudkit'
 *
 * const NoteSchema = createCloudKitSchema(z.object({
 *   title: z.string(),
 *   createdAt: z.date(),
 * }))
 *
 * // Throws CloudKitValidationError if fields do not match
 * const note = NoteSchema.parse(record)
 * // note.title: string, note.createdAt: Date
 *
 * // Or use safeParse to avoid throwing
 * const result = NoteSchema.safeParse(record)
 * if (result.success) {
 *   console.log(result.data.title)
 * } else {
 *   console.error(result.error.zodErrors)
 * }
 * ```
 */
export function createCloudKitSchema<T>(schema: ZodLike<T>): CloudKitParser<T> {
  return {
    parse(record: CloudKitRecord): T {
      const coerced = coerceFields(record.fields ?? {});
      const result = schema.safeParse(coerced);
      if (!result.success) {
        throw new CloudKitValidationError(result.error.issues, record);
      }
      return result.data;
    },

    safeParse(
      record: CloudKitRecord
    ): { success: true; data: T } | { success: false; error: CloudKitValidationError } {
      const coerced = coerceFields(record.fields ?? {});
      const result = schema.safeParse(coerced);
      if (!result.success) {
        return {
          success: false,
          error: new CloudKitValidationError(result.error.issues, record),
        };
      }
      return { success: true, data: result.data };
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the `.value` from each `RecordField` and coerces CloudKit
 * timestamps (numbers > 1e12) to `Date` objects before passing the plain
 * object to the caller's schema validator.
 */
function coerceFields(fields: Record<string, RecordField>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    const v = field.value;
    // CloudKit timestamps arrive as Unix milliseconds (> 1e12 for any date
    // after 2001-09-09).  Coerce them to Date so z.date() validators work.
    if (typeof v === 'number' && v > 1e12) {
      out[key] = new Date(v);
    } else {
      out[key] = v;
    }
  }
  return out;
}
