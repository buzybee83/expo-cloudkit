import type { CloudKitRecord, RecordField, RecordFieldValue } from './types';

/**
 * A single versioned migration step.
 *
 * The `up` function receives a raw `CloudKitRecord` (after all prior steps
 * have run) and must return a transformed `CloudKitRecord`. Steps are applied
 * in ascending `version` order.
 *
 * @template From - Input record type before this step.
 * @template To   - Output record type after this step.
 */
export interface MigrationStep<From, To> {
  /** The schema version this step produces. Must be unique within a migration set. */
  version: number;
  /** Transform a record from the previous shape to this version's shape. */
  up: (record: From) => To;
}

/**
 * A versioned, parse-able CloudKit schema.
 *
 * Created by `createCloudKitMigration`. Provides `migrate`, `parse`,
 * `serialize`, and a convenience `load` (migrate + parse in one call).
 *
 * @template T - The typed data shape produced by `parse`.
 */
export interface CloudKitSchema<T extends Record<string, RecordFieldValue>> {
  /** The CloudKit record type this schema targets (e.g. `'Note'`). */
  version: number;
  /** The CloudKit record type this schema targets. */
  recordType: string;
  /** Parse a raw (already migrated) `CloudKitRecord` into the typed shape. */
  parse: (record: CloudKitRecord) => T;
  /** Serialize a typed shape back to CloudKit field format. */
  serialize: (data: T) => Record<string, RecordField>;
}

/**
 * Options passed to `createCloudKitMigration`.
 *
 * @template T - The typed data shape produced by `parse`.
 */
export interface CreateCloudKitMigrationOptions<T extends Record<string, RecordFieldValue>> {
  /** The CloudKit record type string as registered in CloudKit Dashboard. */
  recordType: string;
  /**
   * The current schema version for this record type.
   * Records with a lower `_schemaVersion` field will have migrations applied.
   */
  version: number;
  /**
   * Ordered list of migration steps.
   *
   * Each step's `version` must be unique. Steps are sorted and applied in
   * ascending version order; only steps with `version > storedVersion` run.
   */
  migrations?: MigrationStep<CloudKitRecord, CloudKitRecord>[];
  /** Parse a migrated `CloudKitRecord` into the typed shape. */
  parse: (record: CloudKitRecord) => T;
  /** Serialize the typed shape back to a CloudKit field dictionary. */
  serialize: (data: T) => Record<string, RecordField>;
}

/**
 * A versioned CloudKit schema object returned by `createCloudKitMigration`.
 *
 * Use `migrate` to upgrade stale records, `parse` to extract typed data,
 * `serialize` to prepare data for a `saveRecords` call, and `load` as a
 * convenient shortcut for migrate + parse in a single call.
 *
 * @template T - The typed data shape produced by `parse`.
 */
export interface CloudKitMigration<T extends Record<string, RecordFieldValue>> {
  /** The CloudKit record type string this schema targets. */
  recordType: string;
  /** The current schema version. */
  version: number;
  /**
   * Apply any pending migration steps to a raw `CloudKitRecord`.
   *
   * Reads the `_schemaVersion` field from the record's fields (defaulting to
   * `0` when absent). Runs all migration steps whose `version` is greater than
   * the stored version in ascending order, then stamps `_schemaVersion` with
   * the current `version`.
   *
   * If the stored version is already >= the current version, the record is
   * returned unchanged.
   */
  migrate: (record: CloudKitRecord) => CloudKitRecord;
  /**
   * Parse a (migrated) `CloudKitRecord` into the typed shape.
   *
   * Does not apply migrations — call `migrate` first, or use `load`.
   */
  parse: (record: CloudKitRecord) => T;
  /**
   * Serialize the typed shape back to a CloudKit field dictionary, suitable
   * for passing to `saveRecords`.
   */
  serialize: (data: T) => Record<string, RecordField>;
  /**
   * Convenience method: run `migrate` then `parse` in a single call.
   *
   * @example
   * ```typescript
   * const raw = await fetchRecord('note-123', 'Notes');
   * const note = NoteSchema.load(raw); // migrate + parse
   * ```
   */
  load: (record: CloudKitRecord) => T;
}

/**
 * Creates a versioned CloudKit schema with migration support.
 *
 * Migrations run in version order when the stored `_schemaVersion` field
 * is lower than the current schema version. This lets you rename fields,
 * add defaults, and transform values without touching CloudKit Dashboard.
 *
 * @param options - Schema definition including record type, version, migration
 *   steps, parse, and serialize functions.
 * @returns A `CloudKitMigration` object with `migrate`, `parse`, `serialize`,
 *   and `load` methods.
 *
 * @example
 * ```typescript
 * const NoteSchema = createCloudKitMigration({
 *   recordType: 'Note',
 *   version: 2,
 *   migrations: [
 *     {
 *       version: 1,
 *       up: (record) => ({
 *         ...record,
 *         fields: {
 *           ...record.fields,
 *           // rename 'body' -> 'content'
 *           content: record.fields.body ?? { type: 'string', value: '' },
 *         },
 *       }),
 *     },
 *   ],
 *   parse: (record) => ({
 *     title: record.fields.title?.value as string ?? '',
 *     content: record.fields.content?.value as string ?? '',
 *   }),
 *   serialize: (data) => ({
 *     title: { type: 'string', value: data.title },
 *     content: { type: 'string', value: data.content },
 *   }),
 * });
 *
 * // Usage:
 * const raw = await fetchRecord('note-123', 'Notes');
 * const note = NoteSchema.migrate(raw);   // applies any pending migrations
 * const parsed = NoteSchema.parse(note);  // typed output
 * // Or in one call:
 * const parsed2 = NoteSchema.load(raw);
 * ```
 */
export function createCloudKitMigration<T extends Record<string, RecordFieldValue>>(
  options: CreateCloudKitMigrationOptions<T>,
): CloudKitMigration<T> {
  const { recordType, version, migrations = [], parse, serialize } = options;

  function migrate(record: CloudKitRecord): CloudKitRecord {
    const storedVersion = (record.fields._schemaVersion?.value as number) ?? 0;
    if (storedVersion >= version) return record;

    // Run each migration step whose version is > storedVersion, in ascending order.
    const pending = migrations
      .filter((m) => m.version > storedVersion)
      .sort((a, b) => a.version - b.version);

    let current = record;
    for (const step of pending) {
      current = step.up(current);
    }

    // Stamp the current schema version onto the record.
    return {
      ...current,
      fields: {
        ...current.fields,
        _schemaVersion: { type: 'number', value: version },
      },
    };
  }

  return {
    recordType,
    version,
    migrate,
    parse,
    serialize,
    load: (record) => parse(migrate(record)),
  };
}
