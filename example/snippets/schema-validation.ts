/**
 * expo-cloudkit — Runtime schema validation with Zod
 *
 * expo-cloudkit does not include a built-in schema DSL. This snippet shows
 * the recommended pattern for validating records fetched from CloudKit using
 * Zod. Validation failures surface as CloudKitError with code VALIDATION_FAILED.
 *
 * Install Zod: npm install zod
 */

import { z } from 'zod';
import {
  queryRecords,
  fetchRecord,
  CloudKitError,
  CloudKitErrorCode,
} from 'expo-cloudkit';
import type { CloudKitRecord } from 'expo-cloudkit';

// ---------------------------------------------------------------------------
// 1. Define your Zod schema for a record type
// ---------------------------------------------------------------------------

// CloudKit fields arrive as { type: string, value: T } objects.
// Define field-level schemas that validate the `value` property.

const NoteFieldSchema = z.object({
  title:   z.object({ type: z.literal('string'), value: z.string().min(1) }),
  body:    z.object({ type: z.literal('string'), value: z.string() }).optional(),
  pinned:  z.object({ type: z.literal('number'), value: z.number().int().min(0).max(1) }).optional(),
  created: z.object({ type: z.literal('date'),   value: z.string().datetime() }).optional(),
});

const NoteRecordSchema = z.object({
  recordType:  z.literal('Note'),
  recordName:  z.string().uuid(),
  zoneName:    z.string(),
  fields:      NoteFieldSchema,
});

// Infer the validated TypeScript type
type ValidatedNote = z.infer<typeof NoteRecordSchema>;

// ---------------------------------------------------------------------------
// 2. Validate a record, throwing CloudKitError on failure
// ---------------------------------------------------------------------------

function validateNote(record: CloudKitRecord): ValidatedNote {
  const result = NoteRecordSchema.safeParse(record);

  if (!result.success) {
    // Surface as a CloudKitError so callers don't need separate error handling
    throw new CloudKitError(
      CloudKitErrorCode.VALIDATION_FAILED,
      `Note record "${record.recordName}" failed validation: ${result.error.message}`,
    );
  }

  return result.data;
}

// ---------------------------------------------------------------------------
// 3. Use in fetch / query flows
// ---------------------------------------------------------------------------

async function fetchValidatedNote(recordName: string, zoneName: string): Promise<ValidatedNote> {
  const raw = await fetchRecord('Note', recordName, zoneName);
  return validateNote(raw); // throws CloudKitError(VALIDATION_FAILED) if invalid
}

async function queryValidatedNotes(zoneName: string): Promise<ValidatedNote[]> {
  const { records } = await queryRecords(
    'Note',
    { field: 'pinned', comparator: '=', value: 1 },
    [{ field: 'created', ascending: false }],
    zoneName,
    'private',
    50,
  );

  const valid: ValidatedNote[] = [];
  const errors: string[] = [];

  for (const record of records) {
    try {
      valid.push(validateNote(record));
    } catch (err) {
      if (err instanceof CloudKitError && err.code === CloudKitErrorCode.VALIDATION_FAILED) {
        // Log and skip invalid records rather than failing the whole query
        errors.push(`${record.recordName}: ${err.message}`);
      } else {
        throw err;
      }
    }
  }

  if (errors.length > 0) {
    console.warn(`${errors.length} Note record(s) failed validation and were skipped:`, errors);
  }

  return valid;
}

// ---------------------------------------------------------------------------
// 4. Example usage
// ---------------------------------------------------------------------------

async function main() {
  try {
    const notes = await queryValidatedNotes('Notes');
    for (const note of notes) {
      // note.fields.title.value is typed as string — Zod guarantees it
      console.log(note.recordName, note.fields.title.value);
    }
  } catch (err) {
    if (err instanceof CloudKitError) {
      console.error(err.code, err.recoverySuggestion ?? err.message);
    }
  }
}

export { NoteRecordSchema, validateNote, fetchValidatedNote, queryValidatedNotes };
export type { ValidatedNote };

void main();
