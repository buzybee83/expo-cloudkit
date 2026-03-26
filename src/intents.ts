/**
 * expo-cloudkit — App Intents / Shortcuts helpers (Phase N.4)
 *
 * Provides TypeScript types that describe iOS App Intents wrapping CloudKit
 * operations, and a `generateAppIntentSwift()` code-generation helper that
 * produces AppIntent Swift stubs suitable for inclusion in a host-app iOS
 * project.
 *
 * ## Background
 *
 * iOS App Intents (iOS 16+) allow Siri, Shortcuts, and Spotlight to invoke
 * CloudKit operations without opening the app. Because App Intents must be
 * registered inside the host application's binary (the module cannot inject
 * them automatically), the recommended integration pattern is:
 *
 * 1. Describe intents in your `app.config.ts` via the `intents` config-plugin
 *    option.
 * 2. Run `expo prebuild` — the config plugin writes generated
 *    `CloudKitIntents.swift` stubs into `ios/<AppName>/CloudKitIntents.swift`.
 * 3. Open the generated stubs in Xcode and add your CloudKit business logic
 *    (e.g. calling `saveRecords`, `queryRecords`) in each `perform()` body.
 *
 * @example
 * ```typescript
 * // app.config.ts
 * export default {
 *   plugins: [
 *     ['expo-cloudkit', {
 *       iCloudContainerEnvironment: 'Development',
 *       intents: [
 *         {
 *           id: 'com.myapp.SaveNote',
 *           title: 'Save Note',
 *           description: 'Save a new note to your CloudKit library',
 *           category: 'create',
 *           parameters: [
 *             { name: 'title', type: 'string', title: 'Note Title' },
 *             { name: 'body',  type: 'string', title: 'Note Body', optional: true },
 *           ],
 *         },
 *       ],
 *     }],
 *   ],
 * };
 * ```
 *
 * @example Generating Swift code programmatically in a build script:
 * ```typescript
 * import { generateAppIntentSwift } from 'expo-cloudkit';
 *
 * const swift = generateAppIntentSwift({
 *   id: 'com.myapp.DeleteNote',
 *   title: 'Delete Note',
 *   category: 'delete',
 *   parameters: [{ name: 'recordName', type: 'string', title: 'Record Name' }],
 * });
 * fs.writeFileSync('ios/MyApp/DeleteNoteIntent.swift', swift);
 * ```
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Describes a single input parameter of an App Intent.
 *
 * Each parameter maps to an `@Parameter` property on the generated Swift
 * `AppIntent` struct.
 */
export interface CloudKitIntentParameter {
  /**
   * Swift property name — must be a valid Swift identifier (camelCase
   * recommended, e.g. `noteTitle`).
   */
  name: string;
  /**
   * Primitive type for the parameter.
   *
   * | TS type     | Swift type |
   * |-------------|------------|
   * | `'string'`  | `String`   |
   * | `'number'`  | `Double`   |
   * | `'boolean'` | `Bool`     |
   * | `'date'`    | `Date`     |
   */
  type: 'string' | 'number' | 'boolean' | 'date';
  /**
   * Human-readable label shown in the Shortcuts app parameter picker.
   */
  title: string;
  /**
   * Optional longer description shown alongside the parameter in Shortcuts.
   */
  description?: string;
  /**
   * When `true`, the generated Swift property becomes an Optional (`?`) and
   * the `@Parameter` annotation includes `default: nil`.
   * @default false
   */
  optional?: boolean;
}

/**
 * Complete definition of an App Intent wrapping one or more CloudKit
 * operations.
 *
 * Pass an array of these to the `intents` config-plugin option, or supply
 * them directly to `generateAppIntentSwift()`.
 */
export interface CloudKitIntentDefinition {
  /**
   * Reverse-DNS bundle identifier for the intent.
   * Must be unique within the app. Conventionally matches the struct name
   * when possible (e.g. `'com.myapp.SaveNote'` → `SaveNoteIntent`).
   *
   * @example 'com.myapp.SaveNote'
   */
  id: string;
  /**
   * Short title displayed in the Shortcuts app action list.
   * Keep under ~40 characters.
   */
  title: string;
  /**
   * Longer description for the Shortcuts app.
   * Falls back to `title` when omitted.
   */
  description?: string;
  /**
   * Input parameters for the intent.
   * Each entry becomes an `@Parameter`-annotated property on the struct.
   */
  parameters?: CloudKitIntentParameter[];
  /**
   * Grouping hint for the Shortcuts app action browser.
   *
   * | Value      | Suggested use case            |
   * |------------|-------------------------------|
   * | `'create'` | Save / insert a new record    |
   * | `'read'`   | Fetch / query records         |
   * | `'update'` | Modify an existing record     |
   * | `'delete'` | Delete a record               |
   * | `'share'`  | Share, invite participants    |
   */
  category?: 'create' | 'read' | 'update' | 'delete' | 'share';
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

/**
 * Returns a Swift `AppIntent` stub as a string for the given intent
 * definition.
 *
 * The generated file imports `AppIntents` (iOS 16+) and `ExpoCloudKit`
 * so the developer can immediately call SDK functions inside `perform()`.
 *
 * The `perform()` body contains a `// TODO:` comment — developers fill in
 * the CloudKit logic using the `expo-cloudkit` APIs they already know.
 *
 * @param intent - The intent definition to generate Swift code for.
 * @returns A syntactically valid Swift source file as a string.
 *
 * @example
 * ```typescript
 * const swift = generateAppIntentSwift({
 *   id: 'com.myapp.SaveNote',
 *   title: 'Save Note',
 *   parameters: [
 *     { name: 'title', type: 'string', title: 'Note Title' },
 *     { name: 'body',  type: 'string', title: 'Note Body', optional: true },
 *   ],
 * });
 * // Write `swift` to ios/<AppName>/SaveNoteIntent.swift
 * ```
 */
export function generateAppIntentSwift(intent: CloudKitIntentDefinition): string {
  const structName = intentStructName(intent.id);
  const description = intent.description ?? intent.title;

  const params = (intent.parameters ?? [])
    .map((p) => buildParamBlock(p))
    .join('\n\n');

  const paramsSection = params.length > 0 ? `\n${params}\n` : '';

  return [
    '// Generated by expo-cloudkit — do not edit the struct signature.',
    '// Fill in the perform() body with your CloudKit logic.',
    'import AppIntents',
    'import ExpoCloudKit',
    '',
    '@available(iOS 16.0, *)',
    `struct ${structName}: AppIntent {`,
    `    static var title: LocalizedStringResource = "${escapeSwiftString(intent.title)}"`,
    `    static var description = IntentDescription("${escapeSwiftString(description)}")`,
    paramsSection,
    '    func perform() async throws -> some IntentResult {',
    '        // TODO: implement using expo-cloudkit APIs',
    '        // Example: try await saveRecords([...])',
    '        return .result()',
    '    }',
    '}',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Maps a TS parameter type to its Swift counterpart.
 */
function swiftType(type: CloudKitIntentParameter['type']): string {
  switch (type) {
    case 'string':  return 'String';
    case 'number':  return 'Double';
    case 'boolean': return 'Bool';
    case 'date':    return 'Date';
  }
}

/**
 * Derives the Swift struct name from a reverse-DNS intent id.
 *
 * `'com.myapp.SaveNote'` → `'SaveNoteIntent'`
 *
 * If the last segment already ends with `Intent` or `Shortcut`, the
 * `Intent` suffix is NOT appended to avoid `SaveNoteIntentIntent`.
 */
function intentStructName(id: string): string {
  const segment = id.split('.').pop() ?? 'CloudKitIntent';
  const cleaned = segment.replace(/[^a-zA-Z0-9]/g, '');
  if (/intent|shortcut/i.test(cleaned)) return cleaned;
  return `${cleaned}Intent`;
}

/**
 * Builds the Swift `@Parameter` block for a single parameter.
 */
function buildParamBlock(p: CloudKitIntentParameter): string {
  const annotation = p.optional
    ? `    @Parameter(title: "${escapeSwiftString(p.title)}", default: nil)`
    : `    @Parameter(title: "${escapeSwiftString(p.title)}")`;

  const swiftTypeName = swiftType(p.type);
  const optionalSuffix = p.optional ? '?' : '';

  const lines = [annotation, `    var ${p.name}: ${swiftTypeName}${optionalSuffix}`];

  if (p.description) {
    lines.unshift(`    // ${p.description}`);
  }

  return lines.join('\n');
}

/**
 * Escapes a string for safe inclusion inside a Swift string literal.
 * Handles backslashes, double-quotes, and newlines.
 */
function escapeSwiftString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
