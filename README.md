# expo-cloudkit

[![npm version](https://img.shields.io/npm/v/expo-cloudkit)](https://www.npmjs.com/package/expo-cloudkit)
[![CI](https://github.com/atlas-ledger/expo-cloudkit/actions/workflows/ci.yml/badge.svg)](https://github.com/atlas-ledger/expo-cloudkit/actions)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

CloudKit for Expo — save and sync records with iCloud, no Swift required.

expo-cloudkit is a TypeScript-first Expo native module wrapping Apple's CloudKit framework. It covers record CRUD, custom zones, delta sync, push subscriptions, sharing, offline queuing, React hooks, and web support via CloudKit JS — all behind a consistent `async/await` API.

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
  - [Sync Engine](#sync-engine)
  - [Push Subscriptions](#push-subscriptions)
  - [Offline Queue](#offline-queue)
  - [React Hooks](#react-hooks)
  - [React Context](#react-context)
  - [Web Platform](#web-platform)
  - [Error Handling](#error-handling)
  - [Operation Config](#operation-config)
- [Platform Support Matrix](#platform-support-matrix)
- [Migration Guide](#migration-guide)
- [Contributing / License](#contributing--license)

---

## Quick Start

```typescript
// 1. Install: npx expo install expo-cloudkit
// 2. Add to app.json: { "plugins": [["expo-cloudkit", { "containerIds": ["iCloud.com.yourapp"] }]] }
// 3. npx expo prebuild --clean && npx expo run:ios

import { configure, getAccountStatus, createZone, saveRecords, queryRecords } from 'expo-cloudkit';

configure('iCloud.com.yourapp');

const status = await getAccountStatus();
if (status !== 'available') return; // user not signed into iCloud

await createZone('Notes'); // idempotent — safe to call every launch

const [saved] = await saveRecords([{
  recordType: 'Note',
  zoneName: 'Notes',
  fields: {
    title:    { type: 'string', value: 'Hello CloudKit' },
    pinned:   { type: 'number', value: 1 },
    created:  { type: 'date',   value: new Date().toISOString() },
  },
}]);

const { records } = await queryRecords(
  'Note',
  { field: 'pinned', comparator: '=', value: 1 },
  [{ field: 'created', ascending: false }],
  'Notes',
);
console.log(records[0].fields.title.value); // "Hello CloudKit"
```

---

## Installation

```bash
npx expo install expo-cloudkit
```

**Peer dependencies:** `expo` (SDK 51+), `expo-modules-core` (1.12+), `react` (18+). Optional: `tsl-apple-cloudkit` for web platform support.

**iOS minimum version:** 16.0. CKSyncEngine requires 17.0.

The module is auto-linked — no manual `pod install` step beyond `expo prebuild`.

### Swift Package Manager (Experimental)

> SPM support is available for pure Swift (non-Expo) projects. Expo projects should continue using CocoaPods.

Add expo-cloudkit as a package dependency in Xcode or your `Package.swift`:

```swift
.package(url: "https://github.com/buzybee83/expo-cloudkit.git", from: "0.10.0")
```

Then add `"ExpoCloudKit"` to your target's dependencies. The `CloudKitRecordManager`, `CloudKitZoneManager`, `CloudKitShareManager`, `CloudKitSyncEngine`, and other managers are available directly.

**Note:** Full SPM support (including the Expo module entry point) is pending ExpoModulesCore adding SPM distribution. Track progress at [expo/expo](https://github.com/expo/expo).

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
| `containerIds` | `string[]` | required | One or more `iCloud.com.*` identifiers |
| `iCloudContainerEnvironment` | `'Development' \| 'Production'` | `'Production'` | Maps to `com.apple.developer.icloud-container-environment`. Use `'Development'` for debug builds. |

**Entitlements added automatically:**
- `com.apple.developer.icloud-container-identifiers`
- `com.apple.developer.icloud-services: ["CloudKit"]`
- `UIBackgroundModes: ["remote-notification"]` (required for push subscriptions)

After changing the plugin, rebuild:

```bash
npx expo prebuild --clean
npx expo run:ios
```

---

## What is CloudKit?

CloudKit is Apple's iCloud database service. It stores structured records, binary assets, and metadata in Apple's infrastructure — with no server to maintain and no separate auth system to build. Users sign in with their Apple ID, and CloudKit handles identity, encryption, and sync.

**The main building blocks:**

A **CKContainer** is your app's isolated storage space in iCloud. Its identifier (`iCloud.com.yourcompany.yourapp`) is registered in Apple Developer and is what you pass to `configure()`. Think of it as your Firestore project or Supabase organization.

A **CKDatabase** is a scope within a container. The **private database** holds data owned by the current user — only they can read or write it. The **public database** is shared across all users of your app (world-readable by default). The **shared database** holds zones that other users have shared with the current user via CKShare. Most apps work exclusively in the private database.

A **CKRecordZone** is a named namespace within a database. Zones enable atomic writes, delta fetch (only fetching changes since the last sync), and sharing. The default zone (`_defaultZone`) always exists; create custom zones for all non-trivial data. Comparable to a Firestore collection group or a Supabase schema.

A **CKRecord** is a document — a key/value store with typed fields (`string`, `number`, `date`, `asset`, `reference`, etc.). Each record has a `recordType` (like a table name), a `recordName` (UUID), a `changeTag` (for conflict detection), and a `zoneName`. Comparable to a Firestore document or a Supabase row.

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

| Function | Returns | Description |
|----------|---------|-------------|
| `configure(containerId)` | `void` | Initialize the module. Call once at startup before any other operation. |
| `getAccountStatus()` | `Promise<AccountStatus>` | Check iCloud sign-in state. Call this before CloudKit operations. |
| `fetchUserRecordID()` | `Promise<string>` | Stable per-user identifier for this container. |
| `isCloudKitAvailable()` | `boolean` | `true` once the module is initialized (or `configureWeb()` succeeds on web). |
| `addAccountStatusListener(cb)` | `Subscription` | Subscribe to iCloud account state changes. |
| `useCloudKitStatus(options?)` | `CloudKitStatus` | Reactive hook — combines account status, availability, and `ready` shorthand. |

```typescript
import { configure, getAccountStatus } from 'expo-cloudkit';

configure('iCloud.com.yourapp');

const status = await getAccountStatus();
// 'available' | 'noAccount' | 'restricted' | 'couldNotDetermine' | 'temporarilyUnavailable'
if (status !== 'available') {
  // Prompt user: Settings → [Your Name] → iCloud
}
```

```typescript
import { useCloudKitStatus } from 'expo-cloudkit';

function App() {
  const { ready, loading, error } = useCloudKitStatus();
  if (loading) return <ActivityIndicator />;
  if (error) return <Text>{error.recoverySuggestion ?? error.message}</Text>;
  if (!ready) return <Text>Sign in to iCloud to continue</Text>;
  return <MainContent />;
}
```

---

### Records

| Function | Returns | Description |
|----------|---------|-------------|
| `saveRecords(records, database?, operationConfig?)` | `Promise<SavedRecord[]>` | Insert or update. Auto-chunks at 400. Calls `CKModifyRecordsOperation`. |
| `fetchRecord(recordType, recordName, zoneName?, database?, desiredKeys?)` | `Promise<CloudKitRecord>` | Fetch one record by ID. |
| `queryRecords(recordType, predicate?, sort?, zoneName?, database?, limit?, cursor?, desiredKeys?)` | `Promise<QueryResult>` | Query with optional predicate and cursor pagination. |
| `deleteRecords(ids, database?)` | `Promise<void>` | Delete by record identifier. Auto-chunks at 400. |
| `batchFetchRecords(recordIDs, database?, desiredKeys?, operationConfig?)` | `Promise<BatchFetchResult[]>` | Fetch multiple records in one `CKFetchRecordsOperation`. Per-record success/error, never throws on partial failure. |
| `fetchRecordZoneChanges(zoneNames, database?)` | `Promise<ZoneChanges>` | Delta fetch — only changes since the last sync token. |
| `fetchRecordWithReferences(recordName, options)` | `Promise<ResolvedRecord>` | Fetch a record and recursively resolve its reference fields (depth 1–3). |
| `deleteRecordWithReferences(recordName, recordType, zoneName?, options?)` | `Promise<string[]>` | Walk reference graph and delete the root plus all referenced records in one batch. |

**Field types:**

| Type key | JS value when saving | JS value when reading |
|----------|---------------------|----------------------|
| `'string'` | `string` | `string` |
| `'number'` | `number` | `number` |
| `'date'` | ISO 8601 string | ISO 8601 string |
| `'data'` | base64 string | base64 string |
| `'location'` | `{ latitude, longitude }` | `{ latitude, longitude }` |
| `'reference'` | `{ recordName, action: 'none' \| 'deleteSelf' }` | same |
| `'asset'` | local file URI | `{ downloadURL, size }` |
| `'stringList'` | `string[]` | `string[]` |
| `'numberList'` | `number[]` | `number[]` |

```typescript
// Save (insert or update)
const [saved] = await saveRecords([{
  recordType: 'Note',
  zoneName: 'Notes',
  fields: { title: { type: 'string', value: 'My Note' } },
}]);

// Update with conflict detection
await saveRecords([{
  recordType: 'Note',
  recordName: saved.recordName,
  changeTag:  saved.changeTag,  // throws CONFLICT if server changed it
  zoneName:   'Notes',
  fields: { title: { type: 'string', value: 'Updated' } },
}]);

// Query with pagination
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

---

### Zones

| Function | Returns | Description |
|----------|---------|-------------|
| `createZone(zoneName, database?)` | `Promise<Zone>` | Create a `CKRecordZone`. Idempotent — safe to call every launch. |
| `deleteZone(zoneName, database?)` | `Promise<void>` | Delete a zone **and all its records**. Permanent. |
| `fetchZones(database?)` | `Promise<Zone[]>` | List all custom zones. Does not include `_defaultZone`. |

```typescript
const zone = await createZone('Notes', 'private');
// zone.capabilities → ['fetchChanges', 'atomicChanges', 'sharing']

const zones = await fetchZones('private');
```

---

### Assets

Assets are binary files stored as `CKAsset`. Upload by providing a `file://` URI in the field value; read back a temporary `downloadURL`.

**Size limits:** 250 MB per asset in the public database; larger files are supported in the private database. Throws `CloudKitError` with code `ASSET_TOO_LARGE` if exceeded.

```typescript
// Save a record with an asset field
await saveRecords([{
  recordType: 'Attachment',
  zoneName: 'Notes',
  fields: {
    name: { type: 'string', value: 'report.pdf' },
    file: { type: 'asset', fileURL: 'file:///path/to/report.pdf' },
  },
}]);

// Download an asset to a local path
import * as FileSystem from 'expo-file-system';

const localPath = await downloadAsset(
  'Attachment', saved.recordName, 'file',
  FileSystem.documentDirectory + 'report.pdf',
  'Notes',
);

// Track upload/download progress
const sub = addAssetProgressListener((p) => {
  console.log(`${p.direction} ${p.fieldName}: ${Math.round(p.fraction * 100)}%`);
});
```

---

### Sharing

CKShare lets you share a record (and its zone) with other iCloud users. The sharer creates a `CKShare` record; recipients accept it via a URL.

| Function | Returns | Description |
|----------|---------|-------------|
| `createShare(options)` | `Promise<Share>` | Create a `CKShare` for a root record. One share per record. |
| `presentSharingUI(options)` | `Promise<SharingUIResult>` | Present native `UICloudSharingController` (iOS only). |
| `acceptShare(options)` | `Promise<AcceptedShare>` | Accept an invitation URL. |
| `fetchShareParticipants(options)` | `Promise<ShareParticipant[]>` | List participants on a share. |
| `updateSharePermission(options)` | `Promise<Share>` | Change a participant's access level. |
| `removeShareParticipant(options)` | `Promise<Share>` | Revoke a participant's access. |
| `deleteShare(options)` | `Promise<void>` | Delete the `CKShare`, revoking all access. |
| `fetchSharedDatabaseZones()` | `Promise<SharedZone[]>` | List zones shared with the current user. |
| `addShareAcceptedListener(cb)` | `Subscription` | Fires when the app opens a share URL. |

```typescript
// Share a record
const share = await createShare({ recordName: 'abc-123', zoneName: 'Notes', publicPermission: 'readOnly' });
console.log(share.shareURL); // send this URL to participants

// Accept an invitation (typically from a deep link)
const sub = addShareAcceptedListener(async (event) => {
  const accepted = await acceptShare({ shareURL: event.shareURL });
  navigateToZone(accepted.zoneName);
});
```

---

### Sync Engine

CKSyncEngine (iOS 17+) handles sync scheduling automatically. On iOS 16, expo-cloudkit falls back to polling with `CKFetchRecordZoneChangesOperation`. The API is identical in both cases.

**iOS 17+ is required for automatic scheduling.** On iOS 16, `getSyncState()` returns `{ usesSyncEngine: false }` and polling runs every 30 seconds.

| Function | Returns | Description |
|----------|---------|-------------|
| `startSyncEngine(config)` | `Promise<void>` | Start sync for the specified zones. |
| `stopSyncEngine()` | `Promise<void>` | Stop the sync engine and release its resources. |
| `getSyncState()` | `SyncState` | Synchronous snapshot of `{ status, usesSyncEngine }`. |
| `triggerSync()` | `Promise<void>` | Manually trigger a fetch + send cycle. |
| `enqueuePendingChange(change)` | `void` | Queue a save or delete for the next sync cycle. |
| `resolveSyncConflict(requestId, record \| null)` | `void` | Resolve a pending conflict (when `resolveConflicts: true`). |
| `isSyncEngineAvailable()` | `boolean` | `true` when CKSyncEngine (iOS 17+) is active. |
| `addSyncEngineListener(cb)` | `Subscription` | Subscribe to all sync events. |
| `useCloudKitSync(options)` | hook return | React hook — manages sync engine lifecycle on mount/unmount. |
| `useSyncHealth()` | `SyncHealthState` | React hook — reactive sync health after each cycle. |

```typescript
import { startSyncEngine, addSyncEngineListener, enqueuePendingChange } from 'expo-cloudkit';

await startSyncEngine({ zones: ['Notes'], database: 'private' });

const sub = addSyncEngineListener((event) => {
  if (event.type === 'recordsFetched') {
    applyChanges(event.changedRecords, event.deletedRecordIDs);
  }
  if (event.type === 'syncError') {
    console.error(event.error.code, event.error.message);
  }
});

// Queue a local change for the next sync
enqueuePendingChange({ type: 'save', record: { recordType: 'Note', zoneName: 'Notes', fields: { ... } } });
```

**Custom conflict resolution** — by default, server-record-wins. To handle conflicts manually:

```typescript
await startSyncEngine({ zones: ['Notes'], resolveConflicts: true });

addSyncEngineListener((event) => {
  if (event.type === 'conflict') {
    const merged = mergeRecords(event.clientRecord, event.serverRecord);
    resolveSyncConflict(event.requestId, merged);
    // or: resolveSyncConflict(event.requestId, null) to accept server version
  }
});
```

> When `resolveConflicts: true`, you **must** call `resolveSyncConflict` for every `conflict` event. Failing to do so blocks the sync engine indefinitely.

**React hook:**

```typescript
import { useCloudKitSync } from 'expo-cloudkit';

const { state, isRunning, triggerSync } = useCloudKitSync({
  zones: ['Notes', 'Tasks'],
  onRecordsFetched: (event) => applyChanges(event.changedRecords, event.deletedRecordIDs),
  onSyncError: (event) => console.error(event.error.code),
});
```

---

### Push Subscriptions

Push subscriptions use APNs silent push to notify the app when CloudKit records change. The config plugin adds the required background mode entitlement automatically.

| Function | Description |
|----------|-------------|
| `saveQuerySubscription(options)` | Create a `CKQuerySubscription`. Returns subscription ID. |
| `saveDatabaseSubscription(database?)` | Create a `CKDatabaseSubscription` for all changes in a database. |
| `deleteSubscription(id, database?)` | Cancel an active subscription by ID. |
| `fetchSubscriptions(database?)` | List all active subscriptions. |
| `addSubscriptionListener(cb)` | Receive push notification events (`'query'` or `'database'`). |
| `useCloudKitSubscription(recordType, options)` | React hook — manages subscription lifecycle, invalidates query hooks on push. |

```typescript
// Subscribe to record changes
const subId = await saveQuerySubscription({
  recordType: 'Note',
  predicate: { field: 'pinned', comparator: '=', value: 1 },
  firesOnRecordCreation: true,
  firesOnRecordUpdate: true,
  zoneName: 'Notes',
});

addSubscriptionListener((event) => {
  if (event.type === 'query' && event.recordID) {
    void fetchRecord('Note', event.recordID, 'Notes').then(updateUI);
  }
});
```

---

### Offline Queue

The offline queue persists CloudKit operations to disk and replays them when connectivity is restored. Operations are stored at `Library/Application Support/expo-cloudkit/offline-queue.json`.

**Auto-drain triggers:** connectivity restored (NWPathMonitor), app foreground.

**Retry policy:** exponential backoff starting at 5s, doubling each attempt, capped at 300s. Max 10 retries per entry. Queue capacity: 500 entries.

| Function | Description |
|----------|-------------|
| `enqueueOfflineOperation(options)` | Persist a save or delete. Returns `{ queueId }`. |
| `drainOfflineQueue()` | Flush all pending entries immediately. Returns `{ succeeded, failed, skipped }`. |
| `getOfflineQueueStatus(options?)` | Counts: `pending`, `retrying`, `failed`, `total`. Pass `{ includeEntries: true }` for full list. |
| `clearOfflineQueue(options?)` | Remove entries by status (`'failed'`, `'all'`, etc.). |
| `retryFailedOperations()` | Reset permanently-failed entries back to `pending`. |
| `addOfflineQueueListener(cb)` | Events: `operationCompleted`, `operationFailed`, `operationMovedToFailed`, `queueDrained`, `queueStatusChanged`. |

```typescript
// Queue a save when offline
const { queueId } = await enqueueOfflineOperation({
  type: 'save',
  record: { recordType: 'Note', zoneName: 'Notes', fields: { title: { type: 'string', value: 'Written offline' } } },
});

// Or use saveRecords with automatic fallback
await saveRecords(records, 'private', { queueOnFailure: true });
```

---

### React Hooks

All hooks handle loading/error/refetch states and clean up listeners on unmount.

#### `useCloudKitRecord(recordName, options)`

Fetches and tracks a single record. Optionally re-fetches on push notifications.

```typescript
import { useCloudKitRecord } from 'expo-cloudkit';

const { data, loading, fetching, error, refetch, update, optimisticStatus } =
  useCloudKitRecord(recordName, { recordType: 'Note', zoneName: 'Notes' });

// Optimistic update — applies locally, rolls back on failure
await update({ title: { type: 'string', value: 'New Title' } });
```

**Returns:** `data`, `loading`, `fetching`, `error`, `refetch`, `update`, `optimisticStatus`, `optimisticError`

#### `useCloudKitQuery(recordType, options)`

Queries records with predicates, sorting, and cursor pagination.

```typescript
import { useCloudKitQuery } from 'expo-cloudkit';

const { data, loading, hasMore, fetchMore, refetch, optimisticAdd, optimisticRemove } =
  useCloudKitQuery('Note', {
    predicate: { field: 'archived', comparator: '=', value: 0 },
    sortDescriptors: [{ field: 'createdAt', ascending: false }],
    zoneName: 'Notes',
    resultsLimit: 25,
  });
```

**Returns:** `data`, `loading`, `fetching`, `error`, `hasMore`, `fetchMore`, `refetch`, `optimisticAdd`, `optimisticRemove`, `pendingCount`, `optimisticErrors`

#### `useCloudKitSync(options)`

Manages the sync engine lifecycle — starts on mount, stops on unmount.

```typescript
const { state, isRunning, triggerSync, enqueuePendingChange } = useCloudKitSync({
  zones: ['Notes'],
  onRecordsFetched: (event) => applyChanges(event.changedRecords, event.deletedRecordIDs),
});
```

#### `useCloudKitStatus(options?)`

Combines account status, availability, and web auth into one reactive object.

```typescript
const { ready, loading, accountStatus, error } = useCloudKitStatus({ pollInterval: 30_000 });
```

#### `useSyncHealth()`

Reactive sync health state updated after each sync cycle.

```typescript
const { isHealthy, lastSyncAt, failedCount, lastDurationMs } = useSyncHealth();
```

#### `useCloudKitSubscription(recordType, options)`

Creates a `CKQuerySubscription` on mount and deletes it on unmount. Automatically invalidates `useCloudKitQuery` hooks when a push arrives.

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
| `containerId` | `string` | required | CloudKit container identifier |
| `defaultDatabase` | `DatabaseScope` | `'private'` | Default database for all hooks in the tree |
| `observeAccountStatus` | `boolean` | `true` | Subscribe to `onAccountStatusChanged` events |
| `webConfig` | `WebConfigOptions` | `undefined` | Auto-calls `configureWeb()` on web |

---

### Web Platform

On web, 20 of 44 operations are supported via [CloudKit JS](https://developer.apple.com/documentation/cloudkitjs) using the optional peer dependency `tsl-apple-cloudkit`.

**Supported on web:** configure, account status, zones (CRUD), record CRUD, query, `fetchRecordZoneChanges`, subscriptions (server-side only — no APNs on web), reference deep linking.

**Not supported on web** (throws `CloudKitNotSupportedError`): CKSyncEngine, asset download, offline queue, `presentSharingUI`, permission mutations.

```bash
npm install tsl-apple-cloudkit
```

| Function | Description |
|----------|-------------|
| `configureWeb(containerId, options)` | Initialize CloudKit JS. No-op on native. |
| `authenticateWeb()` | Trigger Apple ID sign-in popup on web. Returns `AccountStatus`. |
| `signOutWeb()` | Clear the web auth session. No-op on native. |
| `isWebAuthenticated()` | Synchronous check for an active CloudKit JS session. |

```typescript
await configureWeb('iCloud.com.example.myapp', {
  apiToken: 'YOUR_CLOUDKIT_JS_API_TOKEN', // CloudKit Dashboard → API Access → Tokens
  environment: 'development',
  persistSession: true,
});

const status = await authenticateWeb(); // triggers Apple ID sign-in popup
```

---

### Error Handling

All async functions throw `CloudKitError` on failure. On non-iOS platforms, they throw `CloudKitNotSupportedError`.

```typescript
import { CloudKitError, CloudKitErrorCode, CloudKitNotSupportedError } from 'expo-cloudkit';

try {
  await saveRecords([record]);
} catch (err) {
  if (err instanceof CloudKitNotSupportedError) return; // Android / web

  if (err instanceof CloudKitError) {
    if (err.recoverySuggestion) Alert.alert('CloudKit Error', err.recoverySuggestion);

    if (err.code === CloudKitErrorCode.CONFLICT) {
      const merged = mergeRecords(record, err.serverRecord!);
      await saveRecords([merged]);
    }
    if (err.code === CloudKitErrorCode.RATE_LIMITED && err.retryAfterSeconds) {
      await new Promise(r => setTimeout(r, err.retryAfterSeconds! * 1000));
    }
  }
}
```

**`CloudKitError` properties:** `code` (`CloudKitErrorCode`), `message`, `recoverySuggestion` (display-ready hint), `retryAfterSeconds` (rate-limit cases), `serverRecord` (CONFLICT cases only).

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
| `NOT_SUPPORTED` | CloudKit unavailable on this platform (Android, web) |
| `UNKNOWN` | Unexpected error — check `err.message` |

---

### Operation Config

All fetch and write operations accept an optional `operationConfig` parameter to control CloudKit's quality-of-service scheduling and network timeout.

```typescript
import type { OperationConfig } from 'expo-cloudkit';
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `qos` | `'userInitiated' \| 'utility' \| 'background' \| 'default'` | `'userInitiated'` | QoS priority for the underlying `CKOperation` |
| `timeout` | `number` | system default | Network timeout in seconds |
| `collectMetrics` | `boolean` | `false` | Attach `_metrics: { durationMs, retryCount }` to results |

```typescript
// High priority — user tapped refresh
const records = await queryRecords('Note', undefined, undefined, 'Notes', 'private', 25,
  undefined, undefined, { qos: 'userInitiated' });

// Background prefetch
await fetchRecordZoneChanges(['Notes'], 'private', undefined, { qos: 'utility', timeout: 60 });

// Bulk import — lowest priority, with metrics
const results = await saveRecords(largeArray, 'private', { qos: 'background', collectMetrics: true });
```

**Rate-limit auto-retry:** all operations silently retry up to 3 times on `CKError.requestRateLimited`, `serviceUnavailable`, or `zoneBusy`. Subscribe to `addRateLimitedListener` to observe retries.

---

## Platform Support Matrix

| Feature group | iOS 16 | iOS 17+ | Web | Android |
|---------------|--------|---------|-----|---------|
| Core Record CRUD | ✅ | ✅ | ✅ | ❌ |
| Zones | ✅ | ✅ | ✅ | ❌ |
| Assets (`CKAsset`) | ✅ | ✅ | ⚠️ upload only | ❌ |
| Sharing (`CKShare`) | ✅ | ✅ | ⚠️ no `presentSharingUI` | ❌ |
| CKSyncEngine | ⚠️ polling fallback | ✅ | ❌ | ❌ |
| Push Subscriptions | ✅ | ✅ | ⚠️ server-side only | ❌ |
| Offline Queue | ✅ | ✅ | ❌ | ❌ |
| React Hooks | ✅ | ✅ | ✅ | ❌ |
| Web Platform | ❌ | ❌ | ✅ | ❌ |
| Mac Catalyst | ✅ | ✅ | n/a | ❌ |

**Legend:** ✅ fully supported / ⚠️ partial / ❌ not available

---

## Migration Guide

All releases to date are backwards compatible. No call sites require updates when upgrading. Additions per version:

| Version | Notable additions |
|---------|------------------|
| **0.8.0** | `batchFetchRecords`, `useCloudKitStatus` hook, `useSyncHealth` hook, `CloudKitError.recoverySuggestion`, `RATE_LIMITED` error code |
| **0.7.0** | `createCloudKitClient` (multi-container), `deleteRecordWithReferences`, `persistCursor` on `queryRecords`, `clearPersistedCursors` |
| **0.6.0** | `desiredKeys` on fetch operations, `fetchUserRecordID` implemented, `operationConfig` on all operations, `resolveSyncConflict` + `resolveConflicts` option |
| **0.5.0** | Web platform via `configureWeb` / `tsl-apple-cloudkit`. Add `npm install tsl-apple-cloudkit` for web support. |
| **0.4.0** | `CloudKitProvider`, `useAccountStatus`, `useCloudKitSubscription`, optimistic updates on hooks |
| **0.3.0** | Offline queue, `useCloudKitRecord`, `useCloudKitQuery`, `useCloudKitSync`, `saveRecords({ queueOnFailure })` |
| **0.2.0** | CKSyncEngine, push subscriptions, CKShare |

See [CHANGELOG](CHANGELOG.md) for the full diff per release.

---

## Contributing / License

Issues and pull requests are welcome. API changes require a GitHub issue discussion before implementation.

See [CHANGELOG](CHANGELOG.md) for full version history.

MIT — see [LICENSE](LICENSE).
