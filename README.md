# expo-cloudkit

[![npm version](https://img.shields.io/npm/v/expo-cloudkit)](https://www.npmjs.com/package/expo-cloudkit)
[![CI](https://github.com/atlas-ledger/expo-cloudkit/actions/workflows/ci.yml/badge.svg)](https://github.com/atlas-ledger/expo-cloudkit/actions)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

CloudKit for Expo — save and sync records with iCloud, with no Swift required.

expo-cloudkit is a TypeScript-first Expo native module over Apple's CloudKit framework. It covers record CRUD, custom zones, delta sync, push subscriptions, sharing, offline queuing, React hooks, and web support via CloudKit JS — all behind a consistent `async/await` API.

**iOS-first.** Android returns `CloudKitNotSupportedError` on every call. Web is partially supported via `tsl-apple-cloudkit` (20 of 44 operations) — see [Web Platform (CloudKit JS)](#web-platform-cloudkit-js).

---

## Table of contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
  - [Container & Account](#container--account)
  - [Zones](#zones)
  - [Records](#records)
  - [Assets](#assets)
  - [CKSyncEngine (iOS 17+)](#cksyncengine-ios-17)
  - [Push Subscriptions](#push-subscriptions)
  - [Sharing (CKShare)](#sharing-ckshare)
  - [Offline Queue](#offline-queue)
  - [React Hooks](#react-hooks)
  - [CloudKitProvider](#cloudkitprovider)
  - [Web Platform (CloudKit JS)](#web-platform-cloudkit-js)
  - [Batch Operations](#batch-operations)
  - [Reference Deep Linking](#reference-deep-linking)
  - [Operation Configuration](#operation-configuration)
  - [Dashboard Helpers (dev-only)](#dashboard-helpers-dev-only)
  - [Error Handling](#error-handling)
- [Platform Support](#platform-support)
- [Contributing](#contributing)
- [License](#license)

---

## Requirements

- iOS 16.0+ for all Phase A operations (zones, record CRUD, delta fetch, assets)
- iOS 17.0+ for CKSyncEngine (`startSyncEngine` / `useCloudKitSync`)
- Expo SDK 51+
- `expo-modules-core` 1.12+
- An Apple Developer account with a CloudKit container configured

---

## Installation

```bash
npx expo install expo-cloudkit
```

---

## Configuration

Add the config plugin to `app.json` or `app.config.js`:

```json
{
  "expo": {
    "plugins": [
      [
        "expo-cloudkit",
        {
          "containerIds": ["iCloud.com.yourcompany.yourapp"]
        }
      ]
    ]
  }
}
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `containerIds` | `string[]` | required | One or more `iCloud.com.*` container identifiers |
| `iCloudContainerEnvironment` | `'Development' \| 'Production'` | `'Production'` | Maps to `com.apple.developer.icloud-container-environment` entitlement. Use `'Development'` for debug builds |

```json
{
  "plugins": [
    [
      "expo-cloudkit",
      {
        "containerIds": ["iCloud.com.yourcompany.yourapp"],
        "iCloudContainerEnvironment": "Development"
      }
    ]
  ]
}
```

Then rebuild your native project:

```bash
npx expo prebuild --clean
npx expo run:ios
```

The plugin automatically adds:

- `com.apple.developer.icloud-container-identifiers` entitlement
- `com.apple.developer.icloud-services = ["CloudKit"]` entitlement
- `UIBackgroundModes: ["remote-notification"]` in Info.plist (required for push subscriptions)

---

## Quick Start

```typescript
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

// 1. Initialize once at app startup
configure('iCloud.com.yourcompany.yourapp');

// 2. Check iCloud account before any operation
const status = await getAccountStatus();
if (status !== 'available') {
  // 'noAccount'              — user is not signed into iCloud
  // 'restricted'             — parental controls or MDM prevents iCloud
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
      title:     { type: 'string', value: 'Hello CloudKit' },
      body:      { type: 'string', value: 'First record saved from Expo.' },
      wordCount: { type: 'number', value: 3 },
      createdAt: { type: 'date',   value: new Date().toISOString() },
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
  { field: 'wordCount', comparator: '>', value: 0 },
  [{ field: 'createdAt', ascending: false }],
  'Notes',
  'private',
  50
);
if (page1.cursor) {
  const page2 = await queryRecords('Note', undefined, undefined, 'Notes', 'private', 50, page1.cursor);
}
```

---

## API Reference

### Container & Account

#### `configure(containerId: string): void`

Initializes the module with your CloudKit container. Must be called before any other operation.

```typescript
configure('iCloud.com.example.myapp');
```

#### `getAccountStatus(): Promise<AccountStatus>`

Returns the current iCloud account status. Always call this before performing CloudKit operations.

```typescript
type AccountStatus =
  | 'available'               // User is signed in and CloudKit is reachable
  | 'noAccount'               // No iCloud account on the device
  | 'restricted'              // Parental controls or MDM restriction
  | 'couldNotDetermine'       // Status could not be determined (retry)
  | 'temporarilyUnavailable'; // Transient — retry after a short delay

const status = await getAccountStatus();
if (status !== 'available') {
  // Prompt the user to sign into iCloud via Settings
}
```

#### `addAccountStatusListener(callback): Subscription`

Fires whenever the iCloud account status changes (user signs in or out, network changes).

```typescript
const sub = addAccountStatusListener((status) => {
  if (status === 'available') {
    startApp();
  }
});

// When done:
sub.remove();
```

#### `fetchUserRecordID(): Promise<string>`

Returns the current iCloud user's CloudKit record name. This is a stable, per-container identifier that persists across app installs and can be used to associate user data with a specific iCloud account.

```typescript
const userRecordName = await fetchUserRecordID();
// e.g. "_abc123def456..." — stable per user per container
console.log('User record:', userRecordName);
```

Throws `CloudKitError` with code `NOT_AUTHENTICATED` if the user is not signed into iCloud.

---

### Zones

Custom zones enable atomic operations, delta fetch, and sharing. The default zone (`_defaultZone`) always exists; create custom zones for all non-trivial data.

#### `createZone(zoneName, database?): Promise<Zone>`

Creates a `CKRecordZone`. Idempotent — safe if the zone already exists.

```typescript
const zone = await createZone('Notes', 'private');
// zone.zoneName     → 'Notes'
// zone.capabilities → ['fetchChanges', 'atomicChanges', 'sharing']
```

#### `deleteZone(zoneName, database?): Promise<void>`

Deletes a zone and **all records inside it**. Permanent.

```typescript
await deleteZone('Notes', 'private');
```

#### `fetchZones(database?): Promise<Zone[]>`

Lists all custom zones. Does not include `_defaultZone`.

```typescript
const zones = await fetchZones('private');
zones.forEach(z => console.log(z.zoneName));
```

`database` defaults to `'private'` for all zone operations. Pass `'shared'` or `'public'` as needed.

---

### Records

#### `saveRecords(records, database?): Promise<SavedRecord[]>`

Inserts or updates records using `CKModifyRecordsOperation`. Records without a `recordName` are inserted; records with one are updated. Provide `changeTag` to enable server-side conflict detection.

CloudKit hard limit: 400 records per call. `saveRecords` auto-chunks at 400 — see [Batch Operations](#batch-operations).

```typescript
const [saved] = await saveRecords([
  {
    recordType: 'Note',
    zoneName: 'Notes',
    fields: {
      title: { type: 'string', value: 'My Note' },
      pinned: { type: 'number', value: 1 },
    },
  },
]);

// Update with conflict detection:
const [updated] = await saveRecords([
  {
    recordType: 'Note',
    recordName: saved.recordName,
    zoneName: 'Notes',
    changeTag: saved.changeTag, // fails with CONFLICT if server has a newer version
    fields: {
      title: { type: 'string', value: 'Updated Title' },
    },
  },
]);
```

**Field types:**

| Type key | JS value | CloudKit type |
|----------|----------|---------------|
| `'string'` | `string` | `NSString` |
| `'number'` | `number` | `NSNumber` |
| `'date'` | ISO 8601 string | `NSDate` |
| `'data'` | base64 string | `NSData` |
| `'location'` | `{ latitude: number, longitude: number }` | `CLLocation` |
| `'reference'` | `{ recordName: string, action: 'none' \| 'deleteSelf' }` | `CKRecord.Reference` |
| `'asset'` | local file URI (save) or `{ downloadURL, size }` (read) | `CKAsset` |
| `'stringList'` | `string[]` | `[NSString]` |
| `'numberList'` | `number[]` | `[NSNumber]` |

#### `fetchRecord(recordType, recordId, zoneName?, database?): Promise<CloudKitRecord>`

Fetches a single record by type and record name.

```typescript
try {
  const note = await fetchRecord('Note', 'abc-123', 'Notes');
  console.log(note.fields.title.value);
} catch (err) {
  if (err instanceof CloudKitError && err.code === CloudKitErrorCode.RECORD_NOT_FOUND) {
    // Record was deleted on another device
  }
}
```

Pass `desiredKeys` to fetch only specific fields and avoid over-fetching:

```typescript
// Fetch only the title and createdAt fields
const note = await fetchRecord('Note', 'abc-123', 'Notes', 'private', ['title', 'createdAt']);
console.log(note.fields.title.value); // Other fields are absent from the response
```

#### `queryRecords(recordType, predicate?, sortDescriptors?, zoneName?, database?, resultsLimit?, cursor?): Promise<QueryResult>`

Queries records with an optional predicate and sort. Results are paginated via a cursor.

Supported predicate comparators: `=`, `!=`, `<`, `<=`, `>`, `>=`, `BEGINSWITH`, `CONTAINS`, `IN`

```typescript
// First page
const page1 = await queryRecords(
  'Note',
  { field: 'pinned', comparator: '=', value: 1 },
  [{ field: 'createdAt', ascending: false }],
  'Notes',
  'private',
  25
);

// Subsequent pages
if (page1.cursor) {
  const page2 = await queryRecords('Note', undefined, undefined, 'Notes', 'private', 25, page1.cursor);
}
```

Pass `desiredKeys` as the last parameter to limit fields returned per record:

```typescript
const page1 = await queryRecords(
  'Note',
  { field: 'pinned', comparator: '=', value: 1 },
  [{ field: 'createdAt', ascending: false }],
  'Notes', 'private', 25, undefined,
  ['title', 'pinned'] // only fetch these fields
);
```

#### `deleteRecords(recordIds, database?): Promise<void>`

Deletes one or more records permanently.

```typescript
await deleteRecords([
  { recordName: 'abc-123', zoneName: 'Notes' },
  { recordName: 'def-456', zoneName: 'Notes' },
]);
```

#### `fetchRecordZoneChanges(zoneNames, database?): Promise<ZoneChanges>`

Delta fetch — returns only records changed since the last sync token. Store the token and pass it on the next call to get incremental updates.

```typescript
const changes = await fetchRecordZoneChanges(['Notes']);
// Persist changes.syncToken — pass it next time to get only new changes

if (changes.moreComing) {
  // More pages available — call again with the returned token
  const more = await fetchRecordZoneChanges(['Notes']);
}

changes.changedRecords.forEach(record => applyRecord(record));
changes.deletedRecordNames.forEach(name => removeRecord(name));
```

---

### Assets

Assets are binary files stored via `CKAsset`. Upload a file URI in the `asset` field when saving; the read value returns a temporary `downloadURL`.

#### `downloadAsset(recordType, recordId, fieldName, destinationPath, zoneName?, database?): Promise<string>`

Downloads a `CKAsset` field to a local file path. Returns the local path after download completes.

```typescript
import * as FileSystem from 'expo-file-system';

const localPath = await downloadAsset(
  'Note',
  saved.recordName,
  'attachment',
  FileSystem.documentDirectory + 'attachment.pdf',
  'Notes'
);
console.log('Downloaded to:', localPath);
```

#### `addAssetProgressListener(callback): Subscription`

Receives upload and download progress for `CKAsset` operations.

```typescript
const sub = addAssetProgressListener((progress) => {
  // progress.direction  — 'upload' | 'download'
  // progress.fieldName  — the asset field name
  // progress.fraction   — 0.0 to 1.0 (-1 if unknown)
  console.log(`${progress.direction} ${progress.fieldName}: ${Math.round(progress.fraction * 100)}%`);
});
sub.remove();
```

---

### CKSyncEngine (iOS 17+)

CKSyncEngine provides automatic, system-managed sync scheduling. On iOS 16, the module falls back to a polling loop using `CKFetchRecordZoneChangesOperation` — the JS API is identical in both cases.

**iOS version requirement:** `startSyncEngine` requires iOS 16+. CKSyncEngine delegation (automatic scheduling) requires iOS 17+. On iOS 16, `getSyncState()` returns `{ usesSyncEngine: false }`.

#### `isSyncEngineAvailable(): boolean`

Returns `true` if `CKSyncEngine` (iOS 17+) is active on this device. Use this to show UI that depends on real-time sync capability.

```typescript
if (isSyncEngineAvailable()) {
  console.log('CKSyncEngine active — real-time sync enabled');
} else {
  console.log('iOS 16 fallback — polling every 30s');
}
```

#### `startSyncEngine(config): Promise<void>`

Initializes the sync provider for the specified zones. On iOS 17+, delegates scheduling to CKSyncEngine. On iOS 16, starts a 30-second polling timer.

```typescript
await startSyncEngine({
  zones: ['Notes', 'Tasks'],
  database: 'private',
  automaticallySync: true, // default; set false for manual triggerSync() only
});
```

Throws `CloudKitError` with code `NOT_AUTHENTICATED` if the user is not signed into iCloud.

#### `getSyncState(): SyncState`

Synchronous snapshot of the current sync state. No network call.

```typescript
const { status, usesSyncEngine } = getSyncState();
// status: 'idle' | 'syncing' | 'suspended' | 'notStarted'
// usesSyncEngine: true on iOS 17+, false on iOS 16 fallback
```

#### `triggerSync(): Promise<void>`

Manually triggers one fetch + send cycle outside the automatic schedule.

```typescript
try {
  await triggerSync();
} catch (err) {
  if (err instanceof CloudKitError && err.code === CloudKitErrorCode.SYNC_ENGINE_NOT_RUNNING) {
    // Call startSyncEngine() first
  }
}
```

#### `enqueuePendingChange(change): void`

Queues a save or delete for the engine to push on its next cycle. Discriminated union — `type: 'save'` requires `record`; `type: 'delete'` requires `recordIdentifier`.

```typescript
// Queue a save
enqueuePendingChange({
  type: 'save',
  record: {
    recordType: 'Note',
    recordName: 'abc-123',
    zoneName: 'Notes',
    fields: { title: { type: 'string', value: 'Updated' } },
  },
});

// Queue a delete
enqueuePendingChange({
  type: 'delete',
  recordIdentifier: { recordName: 'abc-123', zoneName: 'Notes' },
});
```

#### `addSyncEngineListener(callback): Subscription`

Receives all sync engine events. Filter by `event.type` to handle each case.

```typescript
const sub = addSyncEngineListener((event) => {
  switch (event.type) {
    case 'stateChanged':
      console.log('Sync state:', event.state.status);
      break;

    case 'recordsFetched':
      // Apply server changes to local state — one event per zone per cycle
      applyChanges(event.changedRecords, event.deletedRecordIDs);
      break;

    case 'recordsSent':
      // Handle any push failures (e.g. conflicts)
      event.failedRecords.forEach(({ recordIdentifier, error, serverRecord }) => {
        if (error.code === 'CONFLICT' && serverRecord) {
          const merged = mergeRecords(serverRecord, localVersion(recordIdentifier));
          enqueuePendingChange({ type: 'save', record: merged });
        }
      });
      break;

    case 'syncError':
      // Unrecoverable — call stopSyncEngine() and inspect error.code
      console.error('Sync error:', event.error.code, event.error.message);
      break;
  }
});

// Cleanup on unmount:
sub.remove();
```

#### `stopSyncEngine(): Promise<void>`

Stops the sync engine and releases its resources.

```typescript
await stopSyncEngine();
// getSyncState() now returns { status: 'notStarted' }
```

#### Custom conflict resolution

By default the sync engine applies server-record-wins when a save conflict occurs. To handle conflicts yourself, set `resolveConflicts: true` in `startSyncEngine` and listen for `onSyncConflict` events:

```typescript
import { startSyncEngine, addSyncEngineListener, resolveSyncConflict } from 'expo-cloudkit';

await startSyncEngine({
  zones: ['Notes'],
  database: 'private',
  resolveConflicts: true, // opt-in to manual resolution
});

const sub = addSyncEngineListener((event) => {
  if (event.type === 'conflict') {
    // event.requestId   — opaque ID, must be passed back to resolveSyncConflict
    // event.clientRecord — the record you tried to save
    // event.serverRecord — the current server version

    const merged = mergeRecords(event.clientRecord, event.serverRecord);

    // Pass the merged record — or null to accept the server version
    resolveSyncConflict(event.requestId, merged);
    // resolveSyncConflict(event.requestId, null); // accept server version
  }
});
```

> **Important:** When `resolveConflicts: true`, you **must** call `resolveSyncConflict` for every `conflict` event. Failing to do so leaves the sync engine waiting indefinitely for that conflict to be resolved.

---

### Push Subscriptions

Push subscriptions use APNs silent push to notify the app when CloudKit records change. The config plugin adds the required background mode entitlement automatically.

#### `saveQuerySubscription(options): Promise<string>`

Creates a `CKQuerySubscription`. Fires when records of the specified type are created, updated, or deleted.

```typescript
const subscriptionId = await saveQuerySubscription({
  recordType: 'Note',
  predicate: { field: 'pinned', comparator: '=', value: 1 },
  firesOnRecordCreation: true,
  firesOnRecordUpdate: true,
  firesOnRecordDeletion: false,
  zoneName: 'Notes',
  database: 'private',
});
// Store subscriptionId to delete later
```

Throws `CloudKitError` with code `NOT_AUTHENTICATED` if the user is not signed in, or `NETWORK_UNAVAILABLE` if offline.

#### `saveDatabaseSubscription(database?): Promise<string>`

Creates a `CKDatabaseSubscription`. Fires whenever anything changes in the database. The push payload does not include record data — call `fetchRecordZoneChanges` on receipt to get the actual deltas.

```typescript
const id = await saveDatabaseSubscription('private');
```

#### `deleteSubscription(subscriptionId, database?): Promise<void>`

Cancels an active subscription.

```typescript
await deleteSubscription(subscriptionId, 'private');
```

#### `fetchSubscriptions(database?): Promise<CloudKitSubscription[]>`

Lists all active subscriptions.

```typescript
const subs = await fetchSubscriptions('private');
subs.forEach(sub => {
  console.log(sub.id, sub.type, sub.recordType ?? '(database-level)');
});
```

#### `addSubscriptionListener(callback): Subscription`

Receives push notification events from active subscriptions. Events arrive when the app is foregrounded after receiving a silent push.

```typescript
const sub = addSubscriptionListener((event) => {
  if (event.type === 'query') {
    // A specific record changed
    // event.notificationType: 'created' | 'updated' | 'deleted'
    if (event.recordID) {
      void fetchRecord('Note', event.recordID, 'Notes').then(update);
    }
  } else {
    // event.type === 'database' — something changed; fetch deltas
    void fetchRecordZoneChanges(['Notes']).then(applyChanges);
  }
});
sub.remove();
```

---

### Sharing (CKShare)

CKShare lets you share a record (and its zone) with other iCloud users. The sharer creates a `CKShare`; recipients accept it via a URL.

#### `createShare(options): Promise<Share>`

Creates a new `CKShare` for a root record using `CKModifyRecordsOperation`. A record can only be the root of one share at a time.

```typescript
try {
  const share = await createShare({
    recordName: 'abc-123',
    zoneName: 'Notes',
    publicPermission: 'readOnly', // Anyone with the link can read
  });
  console.log('Share URL:', share.shareURL);
  // Send share.shareURL to your participants
} catch (err) {
  if (err instanceof CloudKitError && err.code === CloudKitErrorCode.ALREADY_SHARED) {
    // Record is already shared — call fetchShareParticipants instead
  }
}
```

#### `presentSharingUI(options): Promise<SharingUIResult>`

Presents the system `UICloudSharingController`. Creates a share if one does not already exist, then lets the user manage participants. Resolves when the user dismisses the sheet.

```typescript
const result = await presentSharingUI({
  recordName: 'abc-123',
  zoneName: 'Notes',
  permission: 'readWrite',
});

if (result.outcome === 'shared') {
  console.log('Share active:', result.share?.shareURL);
} else {
  console.log('User cancelled sharing');
}
```

#### `acceptShare(options): Promise<AcceptedShare>`

Accepts a share invitation via its URL. Call `fetchSharedDatabaseZones()` afterward to read the shared content.

```typescript
const accepted = await acceptShare({
  shareURL: 'https://www.icloud.com/share/...',
});
console.log('Shared zone:', accepted.zoneName, 'owner:', accepted.ownerName);
```

#### `addShareAcceptedListener(callback): Subscription`

Fires when the system routes a CloudKit share URL to the app (via universal link or the Sharing sheet). The share has not been accepted yet at this point — pass `event.shareURL` to `acceptShare()` to complete the flow.

```typescript
const sub = addShareAcceptedListener(async (event) => {
  const accepted = await acceptShare({ shareURL: event.shareURL });
  navigateToSharedZone(accepted.zoneName);
});
sub.remove();
```

#### `fetchShareParticipants(options): Promise<ShareParticipant[]>`

Returns the current list of participants on a share.

```typescript
const participants = await fetchShareParticipants({
  shareRecordName: 'share-uuid',
  zoneName: 'Notes',
});
participants.forEach(p => {
  console.log(p.participantRecordName, p.role, p.acceptanceStatus);
  // role: 'owner' | 'privateUser' | 'publicUser' | 'unknown'
  // acceptanceStatus: 'unknown' | 'pending' | 'accepted' | 'removed'
});
```

#### `updateSharePermission(options): Promise<Share>`

Changes a participant's permission level. The owner's permission cannot be changed.

```typescript
const updated = await updateSharePermission({
  shareRecordName: 'share-uuid',
  participantRecordName: 'participant-uuid',
  permission: 'readWrite', // 'none' | 'readOnly' | 'readWrite'
  zoneName: 'Notes',
});
```

#### `removeShareParticipant(options): Promise<Share>`

Revokes a participant's access.

```typescript
await removeShareParticipant({
  shareRecordName: 'share-uuid',
  participantRecordName: 'participant-uuid',
  zoneName: 'Notes',
});
```

#### `deleteShare(options): Promise<void>`

Deletes the `CKShare` record, revoking access for all participants. The root record is not deleted.

```typescript
await deleteShare({ shareRecordName: 'share-uuid', zoneName: 'Notes' });
```

#### `fetchSharedDatabaseZones(): Promise<SharedZone[]>`

Lists all zones accessible in the shared database — zones shared with the current user by others.

```typescript
const sharedZones = await fetchSharedDatabaseZones();
sharedZones.forEach(zone => {
  console.log(zone.zoneName, 'shared by', zone.ownerName);
  zone.participants.forEach(p => console.log(' -', p.participantRecordName, p.permission));
});
```

---

### Offline Queue

The offline queue persists CloudKit operations to disk and retries them automatically when connectivity is restored. Operations are stored at `Library/Application Support/expo-cloudkit/offline-queue.json`.

**Automatic drain triggers:**
- Connectivity restored (NWPathMonitor)
- App comes to foreground

**Retry policy:** Exponential backoff starting at 5 seconds, doubling each attempt, capped at 300 seconds. Maximum 10 retries per entry. Queue capacity: 500 entries.

#### `enqueueOfflineOperation(options): Promise<{ queueId: string }>`

Persists a save or delete to the queue. Returns a `queueId` you can use to track the entry.

```typescript
// Queue a save
const { queueId } = await enqueueOfflineOperation({
  type: 'save',
  record: {
    recordType: 'Note',
    zoneName: 'Notes',
    fields: { title: { type: 'string', value: 'Written offline' } },
  },
  database: 'private',
});

// Queue a delete
await enqueueOfflineOperation({
  type: 'delete',
  recordIdentifier: { recordName: 'abc-123', zoneName: 'Notes' },
});
```

You can also use `saveRecords` with `queueOnFailure: true` to fall back to the queue on any retryable CloudKit error:

```typescript
const results = await saveRecords(records, 'private', { queueOnFailure: true });
// For entries that got queued: result is { queued: true, queueId: '...' }
```

#### `drainOfflineQueue(): Promise<OfflineQueueDrainResult>`

Attempts to flush all pending and retrying entries immediately. Returns a summary.

```typescript
const { succeeded, failed, skipped } = await drainOfflineQueue();
console.log(`${succeeded} saved, ${failed} failed, ${skipped} skipped`);
```

#### `getOfflineQueueStatus(options?): Promise<OfflineQueueStatus>`

Returns aggregate counts. Pass `{ includeEntries: true }` for the full entry list.

```typescript
const { pending, retrying, failed, total } = await getOfflineQueueStatus();
if (failed > 0) {
  console.warn(`${failed} operations permanently failed — call retryFailedOperations()`);
}

// Full entry list for a debug screen:
const { entries } = await getOfflineQueueStatus({ includeEntries: true });
```

#### `clearOfflineQueue(options?): Promise<void>`

Removes entries by status. Clears everything by default.

```typescript
await clearOfflineQueue({ status: 'failed' }); // failed entries only
await clearOfflineQueue({ status: 'all' });     // everything, including pending (permanent)
```

#### `retryFailedOperations(): Promise<void>`

Resets all permanently-failed entries back to `pending` for the next drain.

```typescript
await retryFailedOperations();
const { pending } = await getOfflineQueueStatus();
console.log(`${pending} operations rescheduled`);
```

#### `addOfflineQueueListener(callback): Subscription`

Receives all offline queue lifecycle events.

```typescript
const sub = addOfflineQueueListener((event) => {
  switch (event.type) {
    case 'operationCompleted':
      console.log('Saved to iCloud:', event.queueId);
      break;
    case 'operationFailed':
      // event.willRetry is true if another attempt will be scheduled
      console.warn(`Attempt ${event.retryCount} failed:`, event.errorCode);
      break;
    case 'operationMovedToFailed':
      // All retries exhausted — requires manual intervention
      console.error('Permanently failed:', event.queueId, event.errorCode);
      notifyUser('Some changes could not be saved to iCloud');
      break;
    case 'queueDrained':
      console.log(`Drain complete: ${event.succeeded} ok, ${event.failed} failed`);
      break;
    case 'queueStatusChanged':
      // event.status has pending, retrying, failed, total counts
      updateBadge(event.status.pending + event.status.retrying);
      break;
  }
});
sub.remove();
```

---

### React Hooks

React hooks wrap the imperative API with loading, error, and refetch state management. Import from `'expo-cloudkit'`.

#### `useCloudKitRecord(recordName, options)`

Fetches a single record and keeps it up to date.

```typescript
import { useCloudKitRecord } from 'expo-cloudkit';

function NoteScreen({ recordName }: { recordName: string }) {
  const { data, loading, fetching, error, refetch } = useCloudKitRecord(recordName, {
    recordType: 'Note',
    zoneName: 'Notes',
    subscribe: true, // re-fetches on push notification for this record
  });

  if (loading) return <ActivityIndicator />;
  if (error) return <Text>Error: {error.message}</Text>;

  return (
    <>
      <Text>{data?.fields.title.value as string}</Text>
      <Button title="Refresh" onPress={refetch} />
    </>
  );
}
```

**Returns:** `{ data, loading, fetching, error, refetch }`

- `loading` — `true` only before `data` has ever been set (initial load spinner)
- `fetching` — `true` during any in-flight fetch, including re-fetches
- `error` — preserves previous `data` on refetch failure (stale-while-revalidate)
- Pass `recordName: undefined` to suspend fetching without unmounting

#### `useCloudKitQuery(recordType, options)`

Queries records with predicates, sorting, and cursor-based pagination.

```typescript
import { useCloudKitQuery } from 'expo-cloudkit';

function NoteList() {
  const { data, loading, fetching, error, hasMore, fetchMore, refetch } = useCloudKitQuery('Note', {
    predicate: { field: 'archived', comparator: '=', value: 0 },
    sortDescriptors: [{ field: 'createdAt', ascending: false }],
    zoneName: 'Notes',
    resultsLimit: 25,
    subscribe: true, // re-fetches on any matching push notification
  });

  if (loading) return <ActivityIndicator />;

  return (
    <FlatList
      data={data}
      keyExtractor={item => item.recordName}
      renderItem={({ item }) => <NoteRow record={item} />}
      onEndReached={hasMore ? fetchMore : undefined}
      refreshing={fetching && !loading}
      onRefresh={refetch}
    />
  );
}
```

**Returns:** `{ data, loading, fetching, error, hasMore, fetchMore, refetch }`

`predicate` and `sortDescriptors` are JSON-stringified in the effect dependency array — you do not need to memoize them.

#### `useCloudKitSync(options)`

Manages the CKSyncEngine lifecycle inside a component. Starts the engine on mount; stops it on unmount.

```typescript
import { useCloudKitSync } from 'expo-cloudkit';

function SyncProvider({ children }: { children: React.ReactNode }) {
  const { state, isRunning, triggerSync, error } = useCloudKitSync({
    zones: ['Notes', 'Tasks'],
    database: 'private',
    automaticallySync: true,
    onRecordsFetched: (event) => {
      // Called once per zone per sync cycle
      applyChanges(event.changedRecords, event.deletedRecordIDs);
    },
    onSyncError: (event) => {
      console.error('Sync error:', event.error.code);
    },
  });

  return (
    <SyncContext.Provider value={{ state, isRunning, triggerSync, error }}>
      {children}
    </SyncContext.Provider>
  );
}
```

**Returns:** `{ state, isRunning, triggerSync, enqueuePendingChange, error }`

- `isRunning` — derived from `state.status !== 'notStarted'`
- `triggerSync` — stable reference; safe to pass as a prop or callback without memoization
- Flip `enabled: false` to stop the engine without unmounting the component

---

### CloudKitProvider

`CloudKitProvider` is an opt-in React context that:
- Calls `configure()` (or `configureWeb()` on web) on mount
- Exposes reactive `accountStatus` across the component tree
- Shares a single `QueryCache` instance for cross-hook push invalidation

```tsx
import { CloudKitProvider } from 'expo-cloudkit';

export default function App() {
  return (
    <CloudKitProvider
      containerId="iCloud.com.example.myapp"
      observeAccountStatus
      webConfig={{ apiToken: process.env.EXPO_PUBLIC_CLOUDKIT_API_TOKEN }}
    >
      <AppContent />
    </CloudKitProvider>
  );
}
```

`CloudKitProvider` props:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `containerId` | `string` | required | CloudKit container identifier |
| `observeAccountStatus` | `boolean` | `false` | Subscribe to account status changes |
| `defaultDatabase` | `DatabaseScope` | `'private'` | Hooks default to this database |
| `webConfig` | `WebConfigOptions` | `undefined` | Auto-calls `configureWeb()` on web when provided |

#### `useAccountStatus(): AccountStatus`

Returns the reactive account status from the nearest `CloudKitProvider`. Updates automatically on account changes.

```tsx
import { useAccountStatus } from 'expo-cloudkit';

function Header() {
  const status = useAccountStatus();
  return <Text>{status === 'available' ? 'Signed in' : 'Not signed in'}</Text>;
}
```

#### `useContainerId(): string`

Returns the container ID from the nearest `CloudKitProvider`.

#### Optimistic updates in `useCloudKitRecord`

```tsx
const { data, update, optimisticStatus, optimisticError } = useCloudKitRecord(recordName, {
  recordType: 'Note',
  zoneName: 'Notes',
});

// Applies update locally immediately; rolls back automatically if the CloudKit write fails
await update({ title: { type: 'string', value: 'New Title' } });

// optimisticStatus: 'idle' | 'pending' | 'committed' | 'rolled-back'
// optimisticError: CloudKitError | null (last rollback cause)
```

#### Optimistic mutations in `useCloudKitQuery`

```tsx
const {
  data,
  optimisticAdd,
  optimisticRemove,
  pendingCount,
  pendingRecordNames,
  optimisticErrors,
} = useCloudKitQuery('Note', { zoneName: 'Notes' });

// Adds to result list immediately; removed automatically on save failure
const tempRecord = { recordName: 'temp-uuid', recordType: 'Note', fields: { title: { type: 'string', value: 'Draft' } } };
await optimisticAdd(tempRecord);

// Removes from result list immediately; re-added automatically on delete failure
await optimisticRemove('abc-123');
```

#### `useCloudKitSubscription(recordType, options)`

Manages a `CKQuerySubscription` lifecycle (create on mount, delete on unmount). Automatically invalidates `useCloudKitQuery` hooks when a push notification arrives for the matching record type.

```tsx
import { useCloudKitSubscription } from 'expo-cloudkit';

function NoteList() {
  // Creates a subscription on mount; automatically triggers refetch on push
  const { subscriptionId, error } = useCloudKitSubscription('Note', {
    predicate: { field: 'archived', comparator: '=', value: 0 },
    zoneName: 'Notes',
    database: 'private',
  });
  // ...
}
```

---

### Web Platform (CloudKit JS)

On web, 20 of 44 expo-cloudkit operations are implemented via [CloudKit JS](https://developer.apple.com/documentation/cloudkitjs) using the optional peer dependency `tsl-apple-cloudkit`.

**Install the peer dependency for web support:**

```bash
npm install tsl-apple-cloudkit
```

**Supported on web:** `configureWeb`, `authenticateWeb`, `signOutWeb`, `isWebAuthenticated`, `isCloudKitAvailable`, zones (CRUD), record CRUD, query, `fetchRecordZoneChanges`, subscriptions (server-side only — APNs silent push is not delivered to web browsers).

**Not supported on web** (throws `CloudKitNotSupportedError`): `CKSyncEngine`, `downloadAsset`, offline queue, `presentSharingUI`, `updateSharePermission`, `removeShareParticipant`.

#### `configureWeb(containerId, options): Promise<void>`

Initializes CloudKit JS. Must be called before any web CloudKit operation. No-op on native.

```typescript
import { configureWeb } from 'expo-cloudkit';

await configureWeb('iCloud.com.example.myapp', {
  apiToken: 'YOUR_CLOUDKIT_JS_API_TOKEN',   // from CloudKit Dashboard → API Access
  environment: 'development',               // 'development' | 'production'
  persistSession: true,                     // persist auth across page reloads
});
```

Get an API token from [CloudKit Dashboard](https://icloud.developer.apple.com/dashboard) → your container → API Access → Tokens.

#### `authenticateWeb(): Promise<AccountStatus>`

Triggers the Apple ID sign-in flow on web. If the user is already signed in, resolves immediately with `'available'`. Never throws — returns `'noAccount'` on any error or user dismissal.

```typescript
const status = await authenticateWeb();
if (status === 'available') {
  // User is now authenticated — safe to call CloudKit operations
}
```

**Note:** CloudKit JS injects Apple's sign-in button into a DOM element with `id="apple-sign-in-button"`. To ensure the sign-in flow works, include this element in your component tree on web:

```tsx
{Platform.OS === 'web' && (
  // @ts-expect-error: nativeID maps to DOM id on web
  <View nativeID="apple-sign-in-button" />
)}
```

#### `signOutWeb(): Promise<void>`

Clears the web auth session. No-op on native.

```typescript
await signOutWeb();
```

#### `isWebAuthenticated(): boolean`

Synchronous check for a valid CloudKit JS session. Always returns `false` on native.

```typescript
if (isWebAuthenticated()) {
  loadUserData();
}
```

#### `isCloudKitAvailable(): boolean`

Returns `true` once `configureWeb()` has successfully completed on web, or once the native module is initialized on iOS. Use this to gate CloudKit operations.

```typescript
if (!isCloudKitAvailable()) {
  return <Text>CloudKit not configured</Text>;
}
```

#### Using `CloudKitProvider` on web

Pass `webConfig` to `CloudKitProvider` to handle `configureWeb()` automatically:

```tsx
<CloudKitProvider
  containerId="iCloud.com.example.myapp"
  webConfig={{
    apiToken: process.env.EXPO_PUBLIC_CLOUDKIT_API_TOKEN,
    environment: 'development',
  }}
>
  <App />
</CloudKitProvider>
```

`CloudKitProvider` awaits `configureWeb()` before calling `getAccountStatus()`, avoiding the common race condition where account status resolves as `'couldNotDetermine'` on first render.

---

### Operation Configuration

All fetch and write operations accept an optional `operationConfig` parameter to control CloudKit's quality-of-service scheduling and network timeout.

```typescript
import { OperationConfig } from 'expo-cloudkit';
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `qos` | `'userInitiated' \| 'utility' \| 'background' \| 'default'` | `'userInitiated'` | Quality-of-service priority for the underlying `CKOperation` |
| `timeout` | `number` | system default | Network timeout in seconds |

**Use cases:**

```typescript
// User tapped "Refresh" — highest priority
const records = await queryRecords('Note', undefined, undefined, 'Notes', 'private', 25,
  undefined, undefined, { qos: 'userInitiated' });

// Background prefetch — don't compete with user-initiated ops
await fetchRecordZoneChanges(['Notes'], 'private', undefined,
  { qos: 'utility', timeout: 60 });

// Bulk import — lowest priority, longer timeout
await saveRecords(largeArray, 'private', { qos: 'background', timeout: 120 });
```

Operations that omit `operationConfig` default to `.userInitiated` with no timeout override — existing behavior is unchanged.

---

### Batch Operations

`saveRecords` and `deleteRecords` automatically split oversized arrays to stay within CloudKit's 400-record limit. Each chunk is sent as a separate `CKModifyRecordsOperation`.

#### `addBatchProgressListener(callback): Subscription`

Receives per-record progress events during a `saveRecords` call. One event fires per record as `CKModifyRecordsOperation` reports per-record completion. Useful for progress bars during large imports.

```typescript
const sub = addBatchProgressListener((progress) => {
  // progress.completed  — records done so far (1-based)
  // progress.total      — total records in this batch operation
  // progress.recordName — the record just processed
  setProgress(progress.completed / progress.total);
});

await saveRecords(largeArray);
sub.remove();
```

---

### Reference Deep Linking

#### `fetchRecordWithReferences(recordName, options): Promise<ResolvedRecord>`

Fetches a record and recursively resolves its `CKRecord.Reference` fields up to the specified depth. Resolved records appear in `resolvedReferences`, keyed by field name. Reference fields whose target record cannot be fetched remain as `ReferenceValue` entries in `fields` — they do not cause the call to fail.

Internally issues a `CKFetchRecordsOperation` per depth level, with parallel fetching via `DispatchGroup`. Depth 1 = 2 round trips max; depth 2 = 3; depth 3 = 4.

```typescript
const note = await fetchRecordWithReferences('abc-123', {
  recordType: 'Note',
  zoneName: 'Notes',
  depth: 2, // 1–3, default 1
});

const author = note.resolvedReferences['author']; // ResolvedRecord | undefined
const org    = author?.resolvedReferences['organization']; // depth 2

console.log(author?.fields.name.value);
console.log(org?.fields.displayName.value);
```

---

### Dashboard Helpers (dev-only)

These functions are prefixed `__debug` to signal they are for developer tooling only. Do not call them in production user-facing code. All four throw `CloudKitNotSupportedError` on non-iOS platforms.

#### `__debugDumpContainerInfo(): Promise<ContainerInfo>`

Returns the container identifier and current account status.

```typescript
const info = await __debugDumpContainerInfo();
console.log(info.containerID, info.accountStatus);
```

#### `__debugListZones(database?): Promise<Zone[]>`

Lists all custom zones directly from the server, bypassing any in-memory zone cache.

```typescript
const zones = await __debugListZones('private');
```

#### `__debugFetchRawRecord(options): Promise<RawRecord>`

Fetches a single record with all server-assigned metadata fields included (`creationDate`, `modificationDate`, `creatorUserRecordID`, `lastModifiedUserRecordID`, `recordChangeTag`).

```typescript
const raw = await __debugFetchRawRecord({
  recordName: 'abc-123',
  recordType: 'Note',
  zoneName: 'Notes',
});
console.log(raw.creatorUserRecordID, raw.recordChangeTag);
```

#### `__debugClearZone(options): Promise<void>`

Deletes all records in a zone without deleting the zone itself.

**Warning: permanent and irreversible.** All records are deleted from the server immediately.

```typescript
// Only call during development or testing
await __debugClearZone({ zoneName: 'Notes', database: 'private' });
```

---

### Error Handling

All async functions throw `CloudKitError` on failure. On non-iOS platforms, they throw `CloudKitNotSupportedError`.

```typescript
import { CloudKitError, CloudKitErrorCode, CloudKitNotSupportedError } from 'expo-cloudkit';

try {
  await saveRecords([record]);
} catch (err) {
  if (err instanceof CloudKitNotSupportedError) {
    // Running on Android or web — CloudKit is unavailable
    return;
  }

  if (err instanceof CloudKitError) {
    switch (err.code) {
      case CloudKitErrorCode.NOT_AUTHENTICATED:
        // Prompt the user to sign into iCloud in Settings
        showSignInPrompt();
        break;

      case CloudKitErrorCode.CONFLICT:
        // Server record changed since last fetch
        // err.serverRecord contains the current server version for merge resolution
        const merged = mergeWithServer(localRecord, err.serverRecord!);
        await saveRecords([merged]);
        break;

      case CloudKitErrorCode.NETWORK_UNAVAILABLE:
        // Device is offline — enqueue and retry later
        await enqueueOfflineOperation({ type: 'save', record });
        if (err.retryAfterSeconds) {
          // CloudKit requested a specific retry delay (rate limiting)
          setTimeout(retry, err.retryAfterSeconds * 1000);
        }
        break;

      case CloudKitErrorCode.QUOTA_EXCEEDED:
        showStorageFullAlert();
        break;

      default:
        console.error('CloudKit error:', err.code, err.message);
    }
  }
}
```

**`CloudKitError` properties:**

| Property | Type | Description |
|----------|------|-------------|
| `code` | `CloudKitErrorCode` | Stable string code for programmatic handling |
| `message` | `string` | Human-readable description |
| `retryAfterSeconds` | `number \| undefined` | Seconds to wait before retrying (rate-limit cases) |
| `serverRecord` | `CloudKitRecord \| undefined` | Current server record (CONFLICT cases only) |

**All error codes:**

| Code | When |
|------|------|
| `NOT_AUTHENTICATED` | User is not signed into iCloud |
| `NETWORK_UNAVAILABLE` | No network connectivity |
| `QUOTA_EXCEEDED` | User's iCloud storage is full |
| `ZONE_NOT_FOUND` | Zone does not exist — call `createZone` first |
| `RECORD_NOT_FOUND` | Record ID does not exist |
| `CONFLICT` | Server record changed since last fetch — see `err.serverRecord` |
| `PERMISSION_DENIED` | User lacks permission for this operation |
| `SERVER_REJECTED` | CloudKit server rejected the request |
| `ASSET_TOO_LARGE` | CKAsset file exceeds size limit |
| `LIMIT_EXCEEDED` | Batch exceeds 400 records — auto-chunked by `saveRecords` |
| `SYNC_ENGINE_NOT_RUNNING` | `startSyncEngine()` not called, or engine was stopped |
| `TOKEN_EXPIRED` | Sync token expired — full re-sync will follow automatically |
| `ACCOUNT_CHANGED` | iCloud account changed — tokens reset, re-sync will follow |
| `SUBSCRIPTION_NOT_FOUND` | Subscription ID does not exist |
| `ALREADY_SHARED` | Record is already the root of an existing CKShare |
| `SHARE_NOT_FOUND` | CKShare record does not exist |
| `PARTICIPANT_NOT_FOUND` | Participant is not on this share |
| `PARTICIPANT_NEEDS_VERIFICATION` | Participant must verify identity before being added |
| `SHARING_UI_UNAVAILABLE` | `UICloudSharingController` could not be presented |
| `REFERENCE_VIOLATION` | Operation would violate a `CKRecord.Reference` integrity constraint |
| `NOT_SUPPORTED` | CloudKit unavailable on this platform (Android, web) |
| `UNKNOWN` | Unexpected error — check `err.message` |

---

## Platform Support

| Platform | Support |
|----------|---------|
| iOS 16+ | Full: zones, records, delta fetch, assets, subscriptions, sharing, offline queue |
| iOS 17+ | CKSyncEngine automatic scheduling via `startSyncEngine` / `useCloudKitSync` |
| Android | All calls return `CloudKitNotSupportedError` — no crash |
| Web (via CloudKit JS) | 20 of 44 operations supported via `configureWeb()` + `tsl-apple-cloudkit`; unsupported calls throw `CloudKitNotSupportedError` |
| macOS (Mac Catalyst) | Same as iOS 16+ — UIKit-guarded APIs unavailable on AppKit targets |

Web requires the optional peer dependency `tsl-apple-cloudkit` (`npm install tsl-apple-cloudkit`). CloudKit is an Apple service — full web support beyond what CloudKit JS exposes is outside the scope of this module. Android is not supported.

---

## Contributing

Issues and pull requests are welcome. API changes require an RFC (GitHub issue discussion) before implementation.

See [CHANGELOG](CHANGELOG.md) for full version history.

---

## License

MIT — see [LICENSE](LICENSE).
