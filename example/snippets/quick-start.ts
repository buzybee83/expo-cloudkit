/**
 * expo-cloudkit — Quick Start
 *
 * Install:     npx expo install expo-cloudkit
 * Configure:   add to app.json (see README §Configuration)
 * Rebuild:     npx expo prebuild --clean && npx expo run:ios
 */

import {
  configure,
  getAccountStatus,
  createZone,
  saveRecords,
  fetchRecord,
  queryRecords,
  CloudKitError,
  CloudKitErrorCode,
} from 'expo-cloudkit';

async function main() {
  // 1. Initialize once at app startup — before any CloudKit call
  configure('iCloud.com.yourcompany.yourapp');

  // 2. Check iCloud account status before operating
  const status = await getAccountStatus();
  if (status !== 'available') {
    // 'noAccount'              — user is not signed into iCloud
    // 'restricted'             — parental controls or MDM
    // 'temporarilyUnavailable' — transient; retry after a delay
    console.warn('iCloud not available:', status);
    return;
  }

  // 3. Create a zone — idempotent, safe to call every launch
  await createZone('Notes', 'private');

  // 4. Save a record
  const [saved] = await saveRecords([
    {
      recordType: 'Note',
      zoneName: 'Notes',
      fields: {
        title:    { type: 'string', value: 'Hello CloudKit' },
        body:     { type: 'string', value: 'First record saved from Expo.' },
        pinned:   { type: 'number', value: 1 },
        created:  { type: 'date',   value: new Date().toISOString() },
      },
    },
  ]);
  console.log('Saved:', saved.recordName, saved.changeTag);

  // 5. Fetch it back
  const note = await fetchRecord('Note', saved.recordName, 'Notes');
  console.log(note.fields.title.value); // "Hello CloudKit"

  // 6. Query with a predicate and pagination
  const page1 = await queryRecords(
    'Note',
    { field: 'pinned', comparator: '=', value: 1 },
    [{ field: 'created', ascending: false }],
    'Notes',
    'private',
    25,
  );
  console.log('Found:', page1.records.length, 'note(s)');

  if (page1.cursor) {
    const page2 = await queryRecords('Note', undefined, undefined, 'Notes', 'private', 25, page1.cursor);
    console.log('Page 2:', page2.records.length);
  }

  // 7. Error handling pattern
  try {
    await fetchRecord('Note', 'nonexistent-id', 'Notes');
  } catch (err) {
    if (err instanceof CloudKitError) {
      if (err.code === CloudKitErrorCode.RECORD_NOT_FOUND) {
        console.log('Record does not exist');
      } else if (err.recoverySuggestion) {
        console.warn(err.recoverySuggestion);
      }
    }
  }
}

void main();
