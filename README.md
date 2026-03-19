# expo-cloudkit

[![npm version](https://img.shields.io/npm/v/expo-cloudkit)](https://www.npmjs.com/package/expo-cloudkit)
[![CI](https://github.com/atlas-ledger/expo-cloudkit/actions/workflows/ci.yml/badge.svg)](https://github.com/atlas-ledger/expo-cloudkit/actions)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

CloudKit for Expo — save and sync records with iCloud, no Swift required.

expo-cloudkit is a TypeScript-first Expo native module wrapping Apple's CloudKit framework. Record CRUD, custom zones, delta sync, push subscriptions, sharing, offline queuing, React hooks, and web support via CloudKit JS — all behind a consistent `async/await` API.

**iOS-first.** Android returns `CloudKitNotSupportedError` on every call. Web is partially supported via `tsl-apple-cloudkit` (20 of 44 operations).

---

## Table of Contents

- [Quick Start](#quick-start)
- [Installation](#installation)
- [Configuration](#configuration)
- [What is CloudKit?](#what-is-cloudkit)
- [Core Concepts](#core-concepts)
- [API Reference](#api-reference)
  - [Container & Account](#container--account)
  - [Records](#records)
  - [Zones](#zones)
  - [Assets](#assets)
  - [Sharing](#sharing)
  - [Sync Engine (iOS 17+)](#sync-engine-ios-17)
  - [Push Subscriptions](#push-subscriptions)
  - [Offline Queue](#offline-queue)
  - [React Hooks](#react-hooks)
  - [React Context](#react-context)
  - [Web Platform](#web-platform)
  - [Background Sync](#background-sync)
  - [Schema Validation](#schema-validation)
  - [Multi-Container](#multi-container)
  - [Operation Config](#operation-config)
  - [Debug Helpers](#debug-helpers)
- [Platform Support Matrix](#platform-support-matrix)
- [Error Handling](#error-handling)
- [Migration Guide](#migration-guide)
- [Contributing / License](#contributing--license)

---

## Quick Start

```typescript
import { configure, getAccountStatus, saveRecords, fetchRecord } from 'expo-cloudkit';

// Call once at app startup, before any CloudKit operation
configure('iCloud.com.yourcompany.yourapp');

const status = await getAccountStatus();
if (status !== 'available') return; // user not signed in to iCloud

const [saved] = await saveRecords([{
  recordType: 'Note',
  zoneName: '_defaultZone',
  fields: {
    title: { type: 'string', value: 'Hello CloudKit' },
  },
}]);

const note = await fetchRecord('Note', saved.recordName, '_defaultZone');
console.log(note.fields.title.value); // "Hello CloudKit"
```

See the [full quick-start snippet](example/snippets/quick-start.ts) for zones, query, pagination, and error handling.

---

## Installation

```bash
npx expo install expo-cloudkit
```

**Peer dependencies:**

| Package | Version | Required? |
|---------|---------|-----------|
| `expo` | SDK 51+ | Yes |
| `expo-modules-core` | 1.12+ | Yes |
| `react` | 18+ | Yes |
| `tsl-apple-cloudkit` | any | Only for web platform support |

Install the web peer dependency if you need web support:

```bash
npm install tsl-apple-cloudkit
```

**iOS minimum version:** 16.0. CKSyncEngine requires iOS 17.0.

The module is auto-linked — no manual `pod install` step beyond `expo prebuild`.

### Swift Package Manager (Experimental)

SPM support is available for pure Swift (non-Expo) projects. Expo projects should continue using CocoaPods.

```swift
.package(url: "https://github.com/buzybee83/expo-cloudkit.git", from: "0.11.0")
```

Then add `"ExpoCloudKit"` to your target's dependencies. Full SPM support (including the Expo module entry point) is pending ExpoModulesCore adding SPM distribution.

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
          "containerIds": ["iCloud.com.yourcompany.yourapp"],
          "iCloudContainerEnvironment": "Production"
        }
      ]
    ]
  }
}
```

**Plugin options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `containerIds` | `string[]` | **required** | One or more `iCloud.com.*` container identifiers, registered in Apple Developer portal |
| `iCloudContainerEnvironment` | `'Development' \| 'Production'` | `'Production'` | Environment for the `com.apple.developer.icloud-container-environment` entitlement. Use `'Development'` for debug builds. |
| `backgroundSyncTaskIdentifier` | `string` | — | Reverse-DNS task identifier for BGTaskScheduler background sync. Pass the same value to `registerBackgroundSync()` at runtime. |

**Container ID format:** must start with `iCloud.` — for example, `iCloud.com.yourcompany.yourapp`. The plugin will throw if the format is wrong.

**Entitlements added automatically:**
- `com.apple.developer.icloud-container-identifiers`
- `com.apple.developer.icloud-services: ["CloudKit"]`
- `UIBackgroundModes: ["remote-notification"]` (required for push subscriptions)
- `UIBackgroundModes: ["fetch", "processing"]` and `BGTaskSchedulerPermittedIdentifiers` when `backgroundSyncTaskIdentifier` is set

After changing the plugin, rebuild:

```bash
npx expo prebuild --clean
npx expo run:ios
```

---

## What is CloudKit?

CloudKit is Apple's iCloud database service. It stores structured records, binary assets, and metadata in Apple's infrastructure — with no server to maintain and no separate auth system to build. Users sign in with their Apple ID, and CloudKit handles identity, encryption, and sync.

**Compared to Firestore / Supabase:** a CloudKit container is your project, a database scope is your schema tier, a record zone is a collection group, and a record is a document. The key difference is that CloudKit is user-identity-first: each user's private database is physically separate, and sharing requires explicit Apple-managed sharing records (`CKShare`).

**The four main building blocks:**

A **CKContainer** is your app's isolated space in iCloud. Its identifier (`iCloud.com.yourcompany.yourapp`) is registered in Apple Developer and is what you pass to `configure()`. Think of it as a Firestore project.

A **CKDatabase** is a scope within a container. The **private database** holds data owned by the current user — only they can read or write it. The **public database** is shared across all users of your app (world-readable by default). The **shared database** holds zones that other users have shared with the current user via CKShare. Most apps work exclusively in the private database.

A **CKRecordZone** is a named namespace within a database. Zones enable atomic writes, delta fetch (receiving only what changed since the last sync), and sharing. The `_defaultZone` always exists; create custom zones for any non-trivial data. Comparable to a Firestore collection group.

A **CKRecord** is a document — a key/value store with typed fields (`string`, `number`, `date`, `asset`, `reference`, etc.). Each record has a `recordType` (like a table name), a `recordName` (UUID), a `changeTag` (for conflict detection), and a `zoneName`. Comparable to a Firestore document.

**CKSyncEngine** (iOS 17+) is Apple's automatic sync scheduler. It batches local changes, handles rate limiting, and retries on failure — all OS-managed. On iOS 16, expo-cloudkit falls back to polling with `CKFetchRecordZoneChangesOperation`. The JS API is identical in both cases.

---

## Core Concepts

- **Containers** — one per app (`iCloud.com.*`), registered in Apple Developer portal
- **Databases** — `private` (per-user), `public` (all users), `shared` (received shares)
- **Zones** — namespaces within a database; required for delta fetch and sharing
- **Records** — typed key/value documents with a `recordType`, `recordName`, and `changeTag`
- **Assets** — binary files stored as `CKAsset`; uploaded via file URI, downloaded via `downloadAsset()`
- **References** — typed links between records (`CKRecord.Reference`); can cascade delete
- **Sync** — `CKSyncEngine` (iOS 17+) or manual polling fallback (iOS 16); both exposed via the same `startSyncEngine()` API

---

## API Reference

### Container & Account

#### `configure(containerId)`

Initialize the module. **Call once at startup before any other operation.**

| Parameter | Type | Description |
|-----------|------|-------------|
| `containerId` | `string` | CloudKit container identifier, e.g. `"iCloud.com.yourapp"` |

```typescript
import { configure } from 'expo-cloudkit';

configure('iCloud.com.yourcompany.yourapp');
```

#### `getAccountStatus()`

Check iCloud sign-in state. Call this before CloudKit operations — CloudKit rejects requests when the user is not signed in.

**Returns:** `Promise<AccountStatus>`

`AccountStatus` values:

| Value | Meaning |
|-------|---------|
| `'available'` | User is signed in and CloudKit is reachable |
| `'noAccount'` | No iCloud account on this device |
| `'restricted'` | Parental controls or MDM restriction |
| `'couldNotDetermine'` | Status unknown — retry |
| `'temporarilyUnavailable'` | Transient — retry after a short delay |

```typescript
const status = await getAccountStatus();
if (status !== 'available') {
  // Prompt: Settings → [Your Name] → iCloud
}
```

#### `addAccountStatusListener(callback)`

Subscribe to iCloud account state changes (e.g. user signs in or out).

| Parameter | Type | Description |
|-----------|------|-------------|
| `callback` | `(status: AccountStatus) => void` | Called when account state changes |

**Returns:** `Subscription` — call `.remove()` to unsubscribe.

```typescript
const sub = addAccountStatusListener((status) => {
  if (status !== 'available') showSignInPrompt();
});
// later: sub.remove()
```

#### `fetchUserRecordID()`

Returns the stable per-user identifier for this container. Useful as a user ID in your data model.

**Returns:** `Promise<string>` — the user's `CKRecord.ID.recordName`

**Throws:** `CloudKitError` with code `NOT_AUTHENTICATED` if the user is not signed in.

```typescript
const userId = await fetchUserRecordID();
// e.g. "_ab12cd34ef56" — stable across app installs
```

#### `isCloudKitAvailable()`

Returns `true` once the module is initialized (or `configureWeb()` succeeds on web). Synchronous.

```typescript
if (isCloudKitAvailable()) {
  // safe to call CloudKit operations
}
```

---

### Records

All write operations call `CKModifyRecordsOperation` internally. All read operations call the corresponding `CKFetch*Operation`.

#### `saveRecords(records, database?, operationConfig?)`

Insert or update records. Automatically chunks batches at 400 (the CloudKit hard limit).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `records` | `RecordToSave[]` | **required** | Records to save |
| `database` | `DatabaseScope` | `'private'` | Target database |
| `operationConfig` | `OperationConfig` | — | QoS, timeout, metrics |

**Returns:** `Promise<SavedRecord[]>`

**Throws:** `CloudKitError` with code `CONFLICT` when `changeTag` mismatches. Check `err.serverRecord` for the current server version.

```typescript
// Insert
const [saved] = await saveRecords([{
  recordType: 'Note',
  zoneName: 'Notes',
  fields: {
    title:   { type: 'string', value: 'My Note' },
    pinned:  { type: 'number', value: 1 },
    created: { type: 'date',   value: new Date().toISOString() },
  },
}]);

// Update with conflict detection
await saveRecords([{
  recordType: 'Note',
  recordName: saved.recordName,
  changeTag:  saved.changeTag, // throws CONFLICT if server changed it
  zoneName:   'Notes',
  fields: { title: { type: 'string', value: 'Updated Title' } },
}]);

// Enqueue for offline replay on failure
await saveRecords([record], 'private', { queueOnFailure: true });
```

#### `fetchRecord(recordType, recordName, zoneName?, database?, desiredKeys?)`

Fetch one record by ID.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `recordType` | `string` | **required** | Record type name |
| `recordName` | `string` | **required** | UUID record identifier |
| `zoneName` | `string` | `'_defaultZone'` | Zone containing the record |
| `database` | `DatabaseScope` | `'private'` | Target database |
| `desiredKeys` | `string[]` | all fields | Limit which fields are returned |

**Returns:** `Promise<CloudKitRecord>`

**Throws:** `CloudKitError` with code `RECORD_NOT_FOUND` if the record does not exist.

```typescript
const note = await fetchRecord('Note', recordName, 'Notes');
console.log(note.fields.title.value);

// Partial fetch — only retrieve the title field
const partial = await fetchRecord('Note', recordName, 'Notes', 'private', ['title']);
```

#### `batchFetchRecords(recordIDs, database?, desiredKeys?, operationConfig?)`

Fetch multiple records in a single `CKFetchRecordsOperation`. Never throws on partial failure — errors are per-record.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `recordIDs` | `RecordIdentifier[]` | **required** | Records to fetch |
| `database` | `DatabaseScope` | `'private'` | Target database |
| `desiredKeys` | `string[]` | all fields | Fields to return |
| `operationConfig` | `OperationConfig` | — | QoS, timeout, metrics |

**Returns:** `Promise<BatchFetchResult[]>` — each entry has `{ recordName, record?, error? }`.

```typescript
const results = await batchFetchRecords([
  { recordName: 'abc-123', zoneName: 'Notes' },
  { recordName: 'def-456', zoneName: 'Notes' },
]);

for (const result of results) {
  if (result.error) console.warn(result.recordName, result.error.code);
  else console.log(result.record!.fields.title.value);
}
```

#### `queryRecords(recordType, predicate?, sort?, zoneName?, database?, limit?, cursor?, desiredKeys?, operationConfig?)`

Query records with optional predicate, sort, and cursor-based pagination.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `recordType` | `string` | **required** | Record type name |
| `predicate` | `QueryPredicate` | — | Filter condition |
| `sort` | `SortDescriptor[]` | — | Sort order |
| `zoneName` | `string` | `'_defaultZone'` | Zone to query |
| `database` | `DatabaseScope` | `'private'` | Target database |
| `limit` | `number` | 200 | Max records per page |
| `cursor` | `string` | — | Resume pagination from previous result |
| `desiredKeys` | `string[]` | all fields | Limit returned fields |
| `operationConfig` | `OperationConfig` | — | QoS, timeout, metrics |

**Returns:** `Promise<QueryResult>` — `{ records: CloudKitRecord[], cursor?: string }`

```typescript
const page1 = await queryRecords(
  'Note',
  { field: 'pinned', comparator: '=', value: 1 },
  [{ field: 'createdAt', ascending: false }],
  'Notes', 'private', 25,
);

if (page1.cursor) {
  const page2 = await queryRecords('Note', undefined, undefined, 'Notes', 'private', 25, page1.cursor);
}
```

**`QueryPredicate` comparators:** `'='`, `'!='`, `'<'`, `'<='`, `'>'`, `'>='`, `'beginsWith'`, `'in'`

#### `deleteRecords(ids, database?)`

Delete records by identifier. Auto-chunks at 400.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `ids` | `RecordIdentifier[]` | **required** | Records to delete |
| `database` | `DatabaseScope` | `'private'` | Target database |

**Returns:** `Promise<void>`

```typescript
await deleteRecords([{ recordName: saved.recordName, zoneName: 'Notes' }]);
```

#### `fetchRecordZoneChanges(zoneNames, database?, changeTokens?, desiredKeys?)`

Delta fetch — returns only records that changed since the last sync token. Tokens are persisted automatically per zone.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `zoneNames` | `string[]` | **required** | Zones to fetch changes from |
| `database` | `DatabaseScope` | `'private'` | Target database |
| `changeTokens` | `Record<string, string>` | persisted tokens | Override stored tokens |
| `desiredKeys` | `string[]` | all fields | Limit returned fields |

**Returns:** `Promise<ZoneChanges>` — `{ changed: CloudKitRecord[], deleted: RecordIdentifier[], newTokens: Record<string, string> }`

```typescript
const { changed, deleted } = await fetchRecordZoneChanges(['Notes', 'Tasks']);
applyChanges(changed, deleted);
```

#### `fetchRecordWithReferences(recordName, options)`

Fetch a record and recursively resolve its reference fields. Depth 1–3.

| Parameter | Type | Description |
|-----------|------|-------------|
| `recordName` | `string` | Root record identifier |
| `options` | `FetchWithReferencesOptions` | `{ zoneName, recordType, depth?, database? }` |

**Returns:** `Promise<ResolvedRecord>`

```typescript
const resolved = await fetchRecordWithReferences('note-id', {
  recordType: 'Note',
  zoneName: 'Notes',
  depth: 2,
});
```

#### `deleteRecordWithReferences(recordName, recordType, zoneName?, options?)`

Walk the reference graph and delete the root record plus all referenced records in one batched operation.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `recordName` | `string` | **required** | Root record to delete |
| `recordType` | `string` | **required** | Root record type |
| `zoneName` | `string` | `'_defaultZone'` | Zone containing the record |
| `options` | `DeleteRecordWithReferencesOptions` | — | `{ maxDepth?: 1 \| 2 \| 3, database? }` |

**Returns:** `Promise<string[]>` — array of deleted record names.

```typescript
const deleted = await deleteRecordWithReferences('note-id', 'Note', 'Notes', { maxDepth: 2 });
console.log(`Deleted ${deleted.length} records`);
```

**Field types:**

| Type key | JS value when saving | JS value when reading |
|----------|---------------------|----------------------|
| `'string'` | `string` | `string` |
| `'number'` | `number` | `number` |
| `'date'` | ISO 8601 string | ISO 8601 string |
| `'data'` | base64 string | base64 string |
| `'location'` | `{ latitude, longitude }` | `{ latitude, longitude }` |
| `'reference'` | `{ recordName, action: 'none' \| 'deleteSelf' }` | same |
| `'asset'` | local `file://` URI | `{ downloadURL, size }` |
| `'stringList'` | `string[]` | `string[]` |
| `'numberList'` | `number[]` | `number[]` |

---

### Zones

#### `createZone(zoneName, database?)`

Create a `CKRecordZone`. **Idempotent — safe to call every launch.**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `zoneName` | `string` | **required** | Zone name |
| `database` | `DatabaseScope` | `'private'` | Target database |

**Returns:** `Promise<Zone>` — includes `capabilities` array.

```typescript
const zone = await createZone('Notes', 'private');
// zone.capabilities → ['fetchChanges', 'atomicChanges', 'sharing']
```

#### `deleteZone(zoneName, database?)`

Delete a zone and **all its records**. Permanent.

```typescript
await deleteZone('Notes', 'private');
```

#### `fetchZones(database?)`

List all custom zones. Does not include `_defaultZone`.

**Returns:** `Promise<Zone[]>`

```typescript
const zones = await fetchZones('private');
```

---

### Assets

Assets are binary files stored as `CKAsset`. Upload by providing a `file://` URI in the field value; read back a temporary `downloadURL`.

**Size limits:** 250 MB per asset in the public database. Throws `CloudKitError` with code `ASSET_TOO_LARGE` if exceeded.

#### `downloadAsset(recordType, recordName, fieldName, destinationPath, zoneName?, database?)`

Download an asset field to a local file path.

| Parameter | Type | Description |
|-----------|------|-------------|
| `recordType` | `string` | Record type |
| `recordName` | `string` | Record identifier |
| `fieldName` | `string` | Asset field name |
| `destinationPath` | `string` | Local file path for download |
| `zoneName` | `string` | Zone containing the record |
| `database` | `DatabaseScope` | Target database |

**Returns:** `Promise<string>` — the local file path.

```typescript
import * as FileSystem from 'expo-file-system';

// Save a record with an asset
await saveRecords([{
  recordType: 'Attachment',
  zoneName: 'Notes',
  fields: {
    name: { type: 'string', value: 'report.pdf' },
    file: { type: 'asset', fileURL: 'file:///path/to/report.pdf' },
  },
}]);

// Download it later
const localPath = await downloadAsset(
  'Attachment', recordName, 'file',
  FileSystem.documentDirectory + 'report.pdf',
  'Notes',
);
```

#### `addAssetProgressListener(callback)`

Track upload and download progress for asset operations.

| Parameter | Type | Description |
|-----------|------|-------------|
| `callback` | `(progress: AssetProgress) => void` | Called during transfer |

**Returns:** `Subscription`

```typescript
const sub = addAssetProgressListener((p) => {
  console.log(`${p.direction} ${p.fieldName}: ${Math.round(p.fraction * 100)}%`);
});
```

---

### Sharing

CKShare lets you share a record (and its zone) with other iCloud users. The sharer creates a `CKShare` record; recipients accept it via a URL.

#### `createShare(options)`

Create a `CKShare` for a root record. One share per record.

| Option | Type | Description |
|--------|------|-------------|
| `recordName` | `string` | Root record to share |
| `zoneName` | `string` | Zone containing the record |
| `publicPermission` | `SharePermission` | `'none' \| 'readOnly' \| 'readWrite'` |
| `database` | `DatabaseScope` | Target database |

**Returns:** `Promise<Share>` — includes `shareURL`.

```typescript
const share = await createShare({
  recordName: 'note-abc-123',
  zoneName: 'Notes',
  publicPermission: 'readOnly',
});
// Send share.shareURL to participants
```

#### `presentSharingUI(options)`

Present the native `UICloudSharingController`. **iOS only** — throws `CloudKitNotSupportedError` on macOS native and web.

**Returns:** `Promise<SharingUIResult>`

```typescript
const result = await presentSharingUI({ shareURL: share.shareURL, zoneName: 'Notes' });
```

#### `acceptShare(options)`

Accept an invitation URL (typically from a deep link).

```typescript
const accepted = await acceptShare({ shareURL: event.shareURL });
navigateToZone(accepted.zoneName);
```

#### `fetchShareParticipants(options)`

List participants on a share.

**Returns:** `Promise<ShareParticipant[]>`

#### `updateSharePermission(options)`

Change a participant's access level.

**Returns:** `Promise<Share>`

#### `removeShareParticipant(options)`

Revoke a participant's access.

**Returns:** `Promise<Share>`

#### `deleteShare(options)`

Delete the `CKShare`, revoking all access.

**Returns:** `Promise<void>`

#### `fetchSharedDatabaseZones()`

List all zones shared with the current user.

**Returns:** `Promise<SharedZone[]>`

#### `addShareAcceptedListener(callback)`

Fires when the app is opened via a share URL.

```typescript
const sub = addShareAcceptedListener(async (event) => {
  const accepted = await acceptShare({ shareURL: event.shareURL });
  navigateToZone(accepted.zoneName);
});
```

---

### Sync Engine (iOS 17+)

CKSyncEngine handles sync scheduling automatically. On iOS 16, expo-cloudkit falls back to polling with `CKFetchRecordZoneChangesOperation`. **The JS API is identical in both cases.**

**iOS 17+ is required for automatic OS-managed scheduling.** On iOS 16, `getSyncState()` returns `{ usesSyncEngine: false }` and polling runs every 30 seconds.

See the [full sync engine snippet](example/snippets/sync-engine.ts) for a complete setup including conflict resolution.

#### `startSyncEngine(config)`

Start sync for the specified zones.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `zones` | `string[]` | **required** | Zone names to sync |
| `database` | `DatabaseScope` | `'private'` | Target database |
| `automaticallySync` | `boolean` | `true` | Let the OS schedule syncs |
| `resolveConflicts` | `boolean` | `false` | Opt in to manual conflict resolution |

**Returns:** `Promise<void>`

```typescript
await startSyncEngine({ zones: ['Notes'], database: 'private' });
```

#### `stopSyncEngine()`

Stop the sync engine and release its resources.

**Returns:** `Promise<void>`

#### `getSyncState()`

Synchronous snapshot of current sync state.

**Returns:** `SyncState` — `{ status: SyncProviderStatus, usesSyncEngine: boolean }`

```typescript
const { status, usesSyncEngine } = getSyncState();
```

#### `triggerSync()`

Manually trigger a fetch + send cycle.

**Returns:** `Promise<void>`

#### `enqueuePendingChange(change)`

Queue a save or delete for the next sync cycle.

| Parameter | Type | Description |
|-----------|------|-------------|
| `change` | `PendingRecordChange` | `{ type: 'save', record }` or `{ type: 'delete', recordIdentifier }` |

```typescript
enqueuePendingChange({
  type: 'save',
  record: { recordType: 'Note', zoneName: 'Notes', fields: { title: { type: 'string', value: 'Queued' } } },
});
```

#### `resolveSyncConflict(requestId, record | null)`

Resolve a pending conflict. **Required for every `conflict` event when `resolveConflicts: true`.**

Failing to call this blocks the sync engine indefinitely.

```typescript
addSyncEngineListener((event) => {
  if (event.type === 'conflict') {
    const merged = mergeRecords(event.clientRecord, event.serverRecord);
    resolveSyncConflict(event.requestId, merged);
    // or pass null to accept server version
  }
});
```

#### `isSyncEngineAvailable()`

Returns `true` when CKSyncEngine (iOS 17+) is active.

#### `addSyncEngineListener(callback)`

Subscribe to all sync events.

| Event type | Payload highlights |
|------------|-------------------|
| `'stateChanged'` | `{ state: SyncState }` |
| `'recordsFetched'` | `{ zoneName, changedRecords, deletedRecordIDs }` |
| `'recordsSent'` | `{ savedRecords, failedRecords }` |
| `'conflict'` | `{ requestId, clientRecord, serverRecord }` (requires `resolveConflicts: true`) |
| `'syncError'` | `{ error: CloudKitError }` |

**Returns:** `Subscription`

---

### Push Subscriptions

Push subscriptions use APNs silent push to notify the app when records change. The config plugin adds the required background mode automatically.

#### `saveQuerySubscription(options)`

Create a `CKQuerySubscription`.

| Option | Type | Description |
|--------|------|-------------|
| `recordType` | `string` | Record type to watch |
| `predicate` | `QueryPredicate` | Filter condition |
| `firesOnRecordCreation` | `boolean` | Watch inserts |
| `firesOnRecordUpdate` | `boolean` | Watch updates |
| `firesOnRecordDeletion` | `boolean` | Watch deletes |
| `zoneName` | `string` | Zone to watch |

**Returns:** `Promise<string>` — subscription ID.

```typescript
const subId = await saveQuerySubscription({
  recordType: 'Note',
  predicate: { field: 'pinned', comparator: '=', value: 1 },
  firesOnRecordCreation: true,
  firesOnRecordUpdate: true,
  zoneName: 'Notes',
});
```

#### `saveDatabaseSubscription(database?)`

Subscribe to all changes in a database via `CKDatabaseSubscription`.

**Returns:** `Promise<string>` — subscription ID.

#### `deleteSubscription(id, database?)`

Cancel an active subscription by ID.

#### `fetchSubscriptions(database?)`

List all active subscriptions.

**Returns:** `Promise<CloudKitSubscription[]>`

#### `addSubscriptionListener(callback)`

Receive push notification events.

```typescript
addSubscriptionListener((event) => {
  if (event.type === 'query' && event.recordID) {
    void fetchRecord('Note', event.recordID, 'Notes').then(updateUI);
  }
});
```

---

### Offline Queue

The offline queue persists CloudKit operations to disk and replays them when connectivity is restored.

**Storage:** `Library/Application Support/expo-cloudkit/offline-queue.json`

**Auto-drain triggers:** connectivity restored (NWPathMonitor), app foreground.

**Retry policy:** exponential backoff starting at 5 s, doubling each attempt, capped at 300 s. Max 10 retries per entry. Queue capacity: 500 entries.

#### `enqueueOfflineOperation(options)`

Persist a save or delete operation.

| Option | Type | Description |
|--------|------|-------------|
| `type` | `'save' \| 'delete'` | Operation type |
| `record` | `RecordToSave` | For `type: 'save'` |
| `recordIdentifier` | `RecordIdentifier` | For `type: 'delete'` |

**Returns:** `Promise<QueuedResult>` — `{ queueId: string }`

```typescript
const { queueId } = await enqueueOfflineOperation({
  type: 'save',
  record: { recordType: 'Note', zoneName: 'Notes', fields: { title: { type: 'string', value: 'Written offline' } } },
});
```

#### `drainOfflineQueue()`

Flush all pending entries immediately.

**Returns:** `Promise<OfflineQueueDrainResult>` — `{ succeeded, failed, skipped }`

#### `getOfflineQueueStatus(options?)`

Get queue entry counts.

| Option | Type | Description |
|--------|------|-------------|
| `includeEntries` | `boolean` | Include full entry list in result |

**Returns:** `Promise<OfflineQueueStatus>` — `{ pending, retrying, failed, total, entries? }`

#### `clearOfflineQueue(options?)`

Remove entries by status.

#### `retryFailedOperations()`

Reset permanently-failed entries back to `pending`.

#### `addOfflineQueueListener(callback)`

Subscribe to queue events: `operationCompleted`, `operationFailed`, `operationMovedToFailed`, `queueDrained`, `queueStatusChanged`.

---

### React Hooks

All hooks handle loading/error/refetch states and clean up listeners on unmount. Hooks work standalone or within a `CloudKitProvider`.

#### `useCloudKitRecord(recordName, options)`

Fetch and track a single record. Optionally re-fetches on push notifications.

| Option | Type | Description |
|--------|------|-------------|
| `recordType` | `string` | **required** |
| `zoneName` | `string` | Zone containing the record |
| `database` | `DatabaseScope` | Target database |
| `desiredKeys` | `string[]` | Limit returned fields |

**Returns:** `{ data, loading, fetching, error, refetch, update, optimisticStatus, optimisticError }`

```typescript
const { data, loading, error, update } = useCloudKitRecord(recordName, {
  recordType: 'Note',
  zoneName: 'Notes',
});

// Optimistic update — applies locally, rolls back on failure
await update({ title: { type: 'string', value: 'New Title' } });
```

#### `useCloudKitQuery(recordType, options)`

Query records with predicates, sorting, and cursor pagination.

| Option | Type | Description |
|--------|------|-------------|
| `predicate` | `QueryPredicate` | Filter condition |
| `sortDescriptors` | `SortDescriptor[]` | Sort order |
| `zoneName` | `string` | Zone to query |
| `database` | `DatabaseScope` | Target database |
| `resultsLimit` | `number` | Max records per page |

**Returns:** `{ data, loading, fetching, error, hasMore, fetchMore, refetch, optimisticAdd, optimisticRemove, pendingCount, optimisticErrors }`

```typescript
const { data, loading, hasMore, fetchMore, optimisticAdd } = useCloudKitQuery('Note', {
  predicate: { field: 'archived', comparator: '=', value: 0 },
  sortDescriptors: [{ field: 'createdAt', ascending: false }],
  zoneName: 'Notes',
  resultsLimit: 25,
});
```

#### `useCloudKitSync(options)`

Manage the sync engine lifecycle — starts on mount, stops on unmount.

| Option | Type | Description |
|--------|------|-------------|
| `zones` | `string[]` | **required** — zones to sync |
| `database` | `DatabaseScope` | Target database |
| `onRecordsFetched` | `(event) => void` | Called when server changes arrive |
| `onSyncError` | `(event) => void` | Called on unrecoverable sync errors |

**Returns:** `{ state, isRunning, triggerSync, enqueuePendingChange }`

```typescript
const { state, isRunning, triggerSync } = useCloudKitSync({
  zones: ['Notes', 'Tasks'],
  onRecordsFetched: (event) => applyChanges(event.changedRecords, event.deletedRecordIDs),
  onSyncError: (event) => console.error(event.error.code),
});
```

#### `useCloudKitStatus(options?)`

Combines account status, availability, and web auth into one reactive object.

| Option | Type | Description |
|--------|------|-------------|
| `pollInterval` | `number` | Re-check interval in ms |

**Returns:** `{ ready, loading, accountStatus, isAvailable, error }`

```typescript
const { ready, loading, error } = useCloudKitStatus({ pollInterval: 30_000 });
if (!ready) return <SignInPrompt />;
```

#### `useSyncHealth()`

Reactive sync health state, updated after each sync cycle.

**Returns:** `{ isHealthy, lastSyncAt, sentCount, receivedCount, failedCount, lastDurationMs, syncEngine }`

```typescript
const { isHealthy, lastSyncAt, failedCount } = useSyncHealth();
```

#### `useCloudKitSubscription(recordType, options)`

Create a `CKQuerySubscription` on mount, delete it on unmount. Automatically invalidates `useCloudKitQuery` hooks when a push arrives.

```typescript
const { subscriptionId, error } = useCloudKitSubscription('Note', { zoneName: 'Notes' });
```

---

### React Context

`CloudKitProvider` is an opt-in context that calls `configure()` (or `configureWeb()` on web) on mount, exposes reactive account status, and shares a `QueryCache` for cross-hook push invalidation.

All hooks work without a provider. When present, they gain automatic database defaults and cache-driven invalidation.

```tsx
import { CloudKitProvider, useAccountStatus } from 'expo-cloudkit';

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

function Header() {
  const status = useAccountStatus(); // reactive, no prop-drilling
  return <Text>{status === 'available' ? 'Synced' : 'Offline'}</Text>;
}
```

**`CloudKitProvider` props:**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `containerId` | `string` | **required** | CloudKit container identifier |
| `defaultDatabase` | `DatabaseScope` | `'private'` | Default database for all hooks in the tree |
| `observeAccountStatus` | `boolean` | `true` | Subscribe to `onAccountStatusChanged` events |
| `webConfig` | `WebConfigOptions` | — | Auto-calls `configureWeb()` on web and Android |

---

### Web Platform

On web, 20 of 44 operations are supported via [CloudKit JS](https://developer.apple.com/documentation/cloudkitjs) using the optional peer dependency `tsl-apple-cloudkit`.

**Supported on web:** configure, account status, zones (CRUD), record CRUD, query, `fetchRecordZoneChanges`, subscriptions (server-side only — APNs not delivered on web), reference deep linking.

**Not supported on web** (throws `CloudKitNotSupportedError`): CKSyncEngine, asset download, offline queue, `presentSharingUI`, permission mutations.

#### `configureWeb(containerId, options)`

Initialize CloudKit JS. No-op on native.

| Option | Type | Description |
|--------|------|-------------|
| `apiToken` | `string` | CloudKit Dashboard API token |
| `environment` | `'development' \| 'production'` | Target environment |
| `persistSession` | `boolean` | Cache the auth session in localStorage |

```typescript
await configureWeb('iCloud.com.example.myapp', {
  apiToken: process.env.EXPO_PUBLIC_CLOUDKIT_API_TOKEN!,
  environment: 'development',
  persistSession: true,
});
```

#### `authenticateWeb()`

Trigger Apple ID sign-in popup on web.

**Returns:** `Promise<AccountStatus>`

#### `signOutWeb()`

Clear the web auth session.

#### `isWebAuthenticated()`

Synchronous check for an active CloudKit JS session.

---

### Background Sync

Background sync uses `BGTaskScheduler` to wake the app and call `triggerSync()` at OS-scheduled intervals. Requires `backgroundSyncTaskIdentifier` in the config plugin.

#### `registerBackgroundSync(taskIdentifier)`

Register a `BGAppRefreshTask` handler. **Call once at app startup**, before `startSyncEngine()`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `taskIdentifier` | `string` | Must match `backgroundSyncTaskIdentifier` in config plugin |

**Returns:** `Promise<void>`

```typescript
await registerBackgroundSync('com.example.myapp.cloudkit-sync');
```

#### `scheduleBackgroundSync()`

Ask the system to schedule the next refresh as soon as conditions allow (minimum 15 min imposed by iOS).

**Returns:** `Promise<void>`

---

### Schema Validation

`createCloudKitSchema` wraps any Zod-compatible schema to validate records before returning them. No hard `zod` dependency — works with any library implementing `.parse()` / `.safeParse()`.

See the [full schema validation snippet](example/snippets/schema-validation.ts) for a complete Zod example with `safeParse`, bulk validation, and error collection.

```typescript
import { z } from 'zod';
import { createCloudKitSchema, fetchRecord, CloudKitErrorCode } from 'expo-cloudkit';

const NoteSchema = z.object({
  recordType: z.literal('Note'),
  fields: z.object({
    title: z.object({ type: z.literal('string'), value: z.string().min(1) }),
  }),
});

const noteParser = createCloudKitSchema(NoteSchema);

const raw = await fetchRecord('Note', recordName, 'Notes');
const note = noteParser.parseRecord(raw); // throws CloudKitValidationError on failure
```

---

### Multi-Container

#### `createCloudKitClient(containerId)`

Create an isolated CloudKit client bound to a specific container, independent of the module-level singleton. Enables apps with multiple CloudKit containers.

**Returns:** `Promise<CloudKitClient>` — supports `saveRecords`, `queryRecords`, `deleteRecords`, and `destroy()`.

```typescript
const secondaryClient = await createCloudKitClient('iCloud.com.example.secondary');
const records = await secondaryClient.queryRecords('Item', undefined, undefined, 'Items');
await secondaryClient.destroy();
```

---

### Operation Config

All fetch and write operations accept an optional `operationConfig` parameter.

```typescript
import type { OperationConfig } from 'expo-cloudkit';
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `qos` | `'userInitiated' \| 'utility' \| 'background' \| 'default'` | `'userInitiated'` | QoS priority for the underlying `CKOperation` |
| `timeout` | `number` | system default | Network timeout in seconds |
| `collectMetrics` | `boolean` | `false` | Attach `_metrics: { durationMs, retryCount }` to results |
| `queueOnFailure` | `boolean` | `false` | On retryable error, enqueue to offline queue instead of throwing |

```typescript
// High priority — user tapped refresh
await queryRecords('Note', undefined, undefined, 'Notes', 'private', 25,
  undefined, undefined, { qos: 'userInitiated' });

// Background prefetch with metrics
const results = await saveRecords(largeArray, 'private', { qos: 'background', collectMetrics: true });
```

**Rate-limit auto-retry:** all operations silently retry up to 3 times on `CKError.requestRateLimited`, `serviceUnavailable`, or `zoneBusy`. Subscribe to `addRateLimitedListener` to observe retries.

```typescript
import { addRateLimitedListener } from 'expo-cloudkit';

const sub = addRateLimitedListener((event) => {
  console.log(`${event.operationName} rate-limited, retry ${event.retryCount} after ${event.retryAfter}s`);
});
```

---

### Debug Helpers

Dev-only utilities for inspecting CloudKit container state. **Do not ship these calls in production.**

| Function | Description |
|----------|-------------|
| `__debugDumpContainerInfo()` | Returns container metadata (`ContainerInfo`) |
| `__debugListZones()` | Lists all zones across all databases |
| `__debugFetchRawRecord(recordName)` | Fetch a record without type coercion (`RawRecord`) |
| `__debugClearZone(zoneName)` | Delete all records in a zone (irreversible) |

---

## Platform Support Matrix

| Function | iOS 16 | iOS 17+ | Web | Android |
|----------|--------|---------|-----|---------|
| `configure` | ✅ | ✅ | ✅ | ❌ |
| `getAccountStatus` | ✅ | ✅ | ✅ | ❌ |
| `addAccountStatusListener` | ✅ | ✅ | ✅ | ❌ |
| `fetchUserRecordID` | ✅ | ✅ | ✅ | ❌ |
| `isCloudKitAvailable` | ✅ | ✅ | ✅ | ❌ |
| `isNativeModuleAvailable` | ✅ | ✅ | ❌ | ❌ |
| `saveRecords` | ✅ | ✅ | ✅ | ❌ |
| `fetchRecord` | ✅ | ✅ | ✅ | ❌ |
| `batchFetchRecords` | ✅ | ✅ | ❌ | ❌ |
| `queryRecords` | ✅ | ✅ | ✅ | ❌ |
| `deleteRecords` | ✅ | ✅ | ✅ | ❌ |
| `fetchRecordZoneChanges` | ✅ | ✅ | ✅ | ❌ |
| `fetchRecordWithReferences` | ✅ | ✅ | ✅ | ❌ |
| `deleteRecordWithReferences` | ✅ | ✅ | ❌ | ❌ |
| `createZone` | ✅ | ✅ | ✅ | ❌ |
| `deleteZone` | ✅ | ✅ | ✅ | ❌ |
| `fetchZones` | ✅ | ✅ | ✅ | ❌ |
| `downloadAsset` | ✅ | ✅ | ❌ ¹ | ❌ |
| `addAssetProgressListener` | ✅ | ✅ | ❌ | ❌ |
| `createShare` | ✅ | ✅ | ⚠️ ² | ❌ |
| `presentSharingUI` | ✅ | ✅ | ❌ | ❌ |
| `acceptShare` | ✅ | ✅ | ⚠️ ² | ❌ |
| `fetchShareParticipants` | ✅ | ✅ | ⚠️ ² | ❌ |
| `updateSharePermission` | ✅ | ✅ | ❌ | ❌ |
| `removeShareParticipant` | ✅ | ✅ | ❌ | ❌ |
| `deleteShare` | ✅ | ✅ | ⚠️ ² | ❌ |
| `fetchSharedDatabaseZones` | ✅ | ✅ | ⚠️ ² | ❌ |
| `addShareAcceptedListener` | ✅ | ✅ | ❌ | ❌ |
| `startSyncEngine` | ⚠️ ³ | ✅ | ❌ | ❌ |
| `stopSyncEngine` | ⚠️ ³ | ✅ | ❌ | ❌ |
| `getSyncState` | ⚠️ ³ | ✅ | ❌ | ❌ |
| `triggerSync` | ⚠️ ³ | ✅ | ❌ | ❌ |
| `enqueuePendingChange` | ⚠️ ³ | ✅ | ❌ | ❌ |
| `resolveSyncConflict` | ⚠️ ³ | ✅ | ❌ | ❌ |
| `isSyncEngineAvailable` | ✅ | ✅ | ❌ | ❌ |
| `addSyncEngineListener` | ⚠️ ³ | ✅ | ❌ | ❌ |
| `saveQuerySubscription` | ✅ | ✅ | ⚠️ ⁴ | ❌ |
| `saveDatabaseSubscription` | ✅ | ✅ | ⚠️ ⁴ | ❌ |
| `deleteSubscription` | ✅ | ✅ | ⚠️ ⁴ | ❌ |
| `fetchSubscriptions` | ✅ | ✅ | ⚠️ ⁴ | ❌ |
| `addSubscriptionListener` | ✅ | ✅ | ❌ ⁵ | ❌ |
| `enqueueOfflineOperation` | ✅ | ✅ | ❌ | ❌ |
| `drainOfflineQueue` | ✅ | ✅ | ❌ | ❌ |
| `getOfflineQueueStatus` | ✅ | ✅ | ❌ | ❌ |
| `clearOfflineQueue` | ✅ | ✅ | ❌ | ❌ |
| `retryFailedOperations` | ✅ | ✅ | ❌ | ❌ |
| `addOfflineQueueListener` | ✅ | ✅ | ❌ | ❌ |
| `configureWeb` | ✅ ⁶ | ✅ ⁶ | ✅ | ❌ |
| `authenticateWeb` | ✅ ⁶ | ✅ ⁶ | ✅ | ✅ ⁷ |
| `signOutWeb` | ✅ ⁶ | ✅ ⁶ | ✅ | ❌ |
| `isWebAuthenticated` | ✅ ⁶ | ✅ ⁶ | ✅ | ❌ |
| `registerBackgroundSync` | ✅ | ✅ | ❌ | ❌ |
| `scheduleBackgroundSync` | ✅ | ✅ | ❌ | ❌ |
| `createCloudKitClient` | ✅ | ✅ | ❌ | ❌ |
| `createCloudKitSchema` | ✅ | ✅ | ✅ | ✅ |
| `clearPersistedCursors` | ✅ | ✅ | ❌ | ❌ |
| `addRateLimitedListener` | ✅ | ✅ | ❌ | ❌ |
| `addSyncHealthListener` | ✅ | ✅ | ❌ | ❌ |
| `addBatchProgressListener` | ✅ | ✅ | ❌ | ❌ |

**Legend:** ✅ fully supported / ⚠️ partial / ❌ not available

**Footnotes:**

1. Web: asset upload works (field value with file URI), but `downloadAsset()` throws `CloudKitNotSupportedError`.
2. Web: read-only operations work; permission mutations (`updateSharePermission`, `removeShareParticipant`, `presentSharingUI`) throw `CloudKitNotSupportedError`.
3. iOS 16: sync engine functions work via polling fallback (`CKFetchRecordZoneChangesOperation`). `getSyncState().usesSyncEngine` returns `false`.
4. Web: subscription management (create/delete/fetch) works server-side. APNs push delivery is not available on web; use polling or `fetchRecordZoneChanges` instead.
5. Web: `addSubscriptionListener` is a no-op on web because APNs push is not delivered to browsers.
6. iOS native: `configureWeb`, `signOutWeb`, and `isWebAuthenticated` are no-ops. `authenticateWeb` delegates to `getAccountStatus()`.
7. Android: `authenticateWeb` calls `configureWeb` + opens Apple ID sign-in via `Linking.openURL`. See `authenticateAndroid` for the full Android auth flow.

---

## Error Handling

All async functions throw `CloudKitError` on failure. On Android, they throw `CloudKitNotSupportedError`.

```typescript
import {
  CloudKitError,
  CloudKitErrorCode,
  CloudKitNotSupportedError,
  CloudKitUnavailableError,
  isNativeModuleAvailable,
} from 'expo-cloudkit';

// Check availability before calling (Expo Go, missing dev client)
if (!isNativeModuleAvailable()) {
  console.warn('CloudKit not available — run with npx expo run:ios');
  return;
}

try {
  await saveRecords([record]);
} catch (err) {
  if (err instanceof CloudKitNotSupportedError) return; // Android / web stub

  if (err instanceof CloudKitUnavailableError) {
    // Module failed to load — Expo Go, missing dev client
    console.warn(err.message);
    return;
  }

  if (err instanceof CloudKitError) {
    // Display the recovery suggestion when available
    if (err.recoverySuggestion) {
      Alert.alert('CloudKit Error', err.recoverySuggestion);
    }

    switch (err.code) {
      case CloudKitErrorCode.NOT_AUTHENTICATED:
        // Show: Settings → [Your Name] → iCloud
        break;
      case CloudKitErrorCode.CONFLICT:
        // err.serverRecord holds the current server version
        const merged = mergeRecords(record, err.serverRecord!);
        await saveRecords([merged]);
        break;
      case CloudKitErrorCode.RATE_LIMITED:
        // err.retryAfterSeconds is set — back off and retry
        await delay(err.retryAfterSeconds! * 1000);
        break;
      case CloudKitErrorCode.QUOTA_EXCEEDED:
        Alert.alert('iCloud storage full', err.recoverySuggestion);
        break;
    }
  }
}
```

**`CloudKitError` properties:**

| Property | Type | Description |
|----------|------|-------------|
| `code` | `CloudKitErrorCode` | Machine-readable error code |
| `message` | `string` | Error description |
| `recoverySuggestion` | `string \| undefined` | Display-ready hint for common errors |
| `retryAfterSeconds` | `number \| undefined` | Set for `RATE_LIMITED` errors |
| `serverRecord` | `CloudKitRecord \| undefined` | Set for `CONFLICT` errors |

**All error codes:**

| Code | When it fires |
|------|---------------|
| `NOT_AUTHENTICATED` | User is not signed into iCloud |
| `NETWORK_UNAVAILABLE` | No network connectivity |
| `QUOTA_EXCEEDED` | User's iCloud storage is full |
| `ZONE_NOT_FOUND` | Zone does not exist — call `createZone` first |
| `RECORD_NOT_FOUND` | Record ID does not exist |
| `CONFLICT` | Server record changed since last fetch — check `err.serverRecord` |
| `PERMISSION_DENIED` | Insufficient permissions for this operation |
| `SERVER_REJECTED` | CloudKit server rejected the request |
| `ASSET_TOO_LARGE` | CKAsset file exceeds size limit |
| `LIMIT_EXCEEDED` | Batch over 400 records — `saveRecords` auto-chunks |
| `RATE_LIMITED` | CloudKit rate limiting — check `err.retryAfterSeconds` |
| `VALIDATION_FAILED` | Record failed runtime schema validation |
| `SYNC_ENGINE_NOT_RUNNING` | `startSyncEngine()` not called or engine was stopped |
| `TOKEN_EXPIRED` | Sync token expired — full re-sync follows automatically |
| `ACCOUNT_CHANGED` | iCloud account switched — tokens reset, re-sync follows |
| `SUBSCRIPTION_NOT_FOUND` | Subscription ID does not exist |
| `ALREADY_SHARED` | Record is already the root of an existing `CKShare` |
| `SHARE_NOT_FOUND` | `CKShare` record does not exist |
| `PARTICIPANT_NOT_FOUND` | Participant is not on this share |
| `PARTICIPANT_NEEDS_VERIFICATION` | Participant must verify identity before being added |
| `SHARING_UI_UNAVAILABLE` | `UICloudSharingController` could not be presented |
| `REFERENCE_VIOLATION` | Operation would violate a `CKRecord.Reference` integrity constraint |
| `MODULE_UNAVAILABLE` | Native module failed to load (Expo Go, missing dev client) |
| `NOT_SUPPORTED` | CloudKit unavailable on this platform (Android) |
| `UNKNOWN` | Unexpected error — check `err.message` |

---

## Migration Guide

All releases to date are backwards compatible unless noted. Additions per version:

| Version | Notable additions |
|---------|------------------|
| **0.11.0** | `CloudKitUnavailableError`, `MODULE_UNAVAILABLE` error code, `isNativeModuleAvailable()`, background sync (`registerBackgroundSync`, `scheduleBackgroundSync`), `backgroundSyncTaskIdentifier` config plugin option, Swift Package Manager (experimental) |
| **0.10.0** | Internal: `CloudKitSyncEngineAdapter` and `CloudKitSyncFallbackAdapter` converted to Swift actors. No public API changes. |
| **0.9.0** | `CloudKitStore` SwiftUI `@Observable` store (Swift only), `createCloudKitSchema` + `CloudKitParser` (Zod-compatible validation), `CloudKitValidationError`, `VALIDATION_FAILED` error code, `authenticateAndroid`, `handleAuthRedirect` |
| **0.8.0** | `batchFetchRecords`, `useCloudKitStatus` hook, `useSyncHealth` hook, `CloudKitError.recoverySuggestion`, `RATE_LIMITED` error code, `addRateLimitedListener`, `addSyncHealthListener`, `collectMetrics` in `OperationConfig` |
| **0.7.0** | `createCloudKitClient` (multi-container), `deleteRecordWithReferences`, `clearPersistedCursors`, cursor persistence via `persistCursor` on `queryRecords` |
| **0.6.0** | `desiredKeys` on fetch operations, `fetchUserRecordID` implemented, `operationConfig` on all operations, `resolveSyncConflict`, `resolveConflicts` option on `startSyncEngine` |
| **0.5.3** | Bug fixes: config plugin environment entitlement, web account status race, `authenticateWeb` sign-in flow |
| **0.5.0** | Web platform via `configureWeb` / `tsl-apple-cloudkit` — add `npm install tsl-apple-cloudkit` for web support |
| **0.4.0** | `CloudKitProvider`, `useAccountStatus`, `useCloudKitSubscription`, optimistic updates on hooks |
| **0.3.0** | Offline queue, `useCloudKitRecord`, `useCloudKitQuery`, `useCloudKitSync`, `saveRecords({ queueOnFailure: true })` |
| **0.2.0** | CKSyncEngine, push subscriptions, CKShare |

See [CHANGELOG](CHANGELOG.md) for the full diff per release.

---

## Contributing / License

Issues and pull requests are welcome. API changes require a GitHub issue discussion before implementation.

MIT — see [LICENSE](LICENSE).
