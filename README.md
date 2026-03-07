# expo-cloudkit

A general-purpose Expo native module for CloudKit record-level operations on iOS.

**iOS only.** MIT license. Designed for use with Expo SDK 51+.

> **Status:** Phase A (Foundation) — Container, Zones, Record CRUD. Phases B–E (sync engine, sharing, assets) are in progress.

---

## What it does

expo-cloudkit provides a TypeScript-first, async/await API over Apple's CloudKit framework:

| Phase | Feature | Status |
|-------|---------|--------|
| A | Container + Account status | Ready |
| A | Zone management (create, delete, list) | Ready |
| A | Record CRUD (save, fetch, query, delete) | Ready |
| A | Delta fetch (zone changes + sync tokens) | Ready |
| B | CKSyncEngine wrapper (iOS 17+) | Planned |
| B | CKQuerySubscription push notifications | Planned |
| C | CKShare + UICloudSharingController | Planned |
| C | Share participant management | Planned |
| D | CKAsset upload/download with progress | Planned |
| E | Documentation, example app polish | Planned |

---

## Requirements

- iOS 16.0+ (iOS 17+ recommended for CKSyncEngine in Phase B)
- Expo SDK 51+
- `expo-modules-core` 1.12+
- An Apple Developer account with a CloudKit container configured

---

## Installation

```bash
npx expo install expo-cloudkit
```

### Config plugin (required)

Add the plugin to your `app.json` or `app.config.js`. Replace the container ID with your own:

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

Then rebuild your native project:

```bash
npx expo prebuild --clean
npx expo run:ios
```

The plugin adds:
- `com.apple.developer.icloud-container-identifiers` entitlement
- `com.apple.developer.icloud-services = ["CloudKit"]` entitlement
- `UIBackgroundModes: ["remote-notification"]` in Info.plist

---

## Quick Start

```typescript
import {
  configure,
  getAccountStatus,
  createZone,
  saveRecords,
  queryRecords,
  CloudKitError,
  CloudKitErrorCode,
} from 'expo-cloudkit';

// 1. Initialize — call once at app startup
configure('iCloud.com.yourcompany.yourapp');

// 2. Check iCloud account
const status = await getAccountStatus();
if (status !== 'available') {
  console.warn('iCloud not available:', status);
  return;
}

// 3. Create a zone (idempotent — safe to call every launch)
const zone = await createZone('MyZone', 'private');

// 4. Save a record
const [saved] = await saveRecords([
  {
    recordType: 'Note',
    zoneName: 'MyZone',
    fields: {
      title:     { type: 'string', value: 'Hello CloudKit' },
      createdAt: { type: 'date',   value: new Date().toISOString() },
      wordCount: { type: 'number', value: 42 },
    },
  },
]);
console.log('Saved:', saved.recordName, saved.changeTag);

// 5. Query records
const result = await queryRecords(
  'Note',
  { field: 'wordCount', comparator: '>', value: 10 },
  [{ field: 'createdAt', ascending: false }],
  'MyZone',
  'private',
  50 // resultsLimit
);
console.log('Records:', result.records.length);
if (result.cursor) {
  // Fetch next page
  const page2 = await queryRecords('Note', undefined, undefined, 'MyZone', 'private', 50, result.cursor);
}
```

---

## Error Handling

All async functions throw `CloudKitError` on failure:

```typescript
import { CloudKitError, CloudKitErrorCode } from 'expo-cloudkit';

try {
  await saveRecords([record]);
} catch (err) {
  if (err instanceof CloudKitError) {
    switch (err.code) {
      case CloudKitErrorCode.NOT_AUTHENTICATED:
        // Prompt user to sign into iCloud
        break;
      case CloudKitErrorCode.CONFLICT:
        // err.serverRecord contains the server's current version
        // Perform field-level merge then retry
        break;
      case CloudKitErrorCode.NETWORK_UNAVAILABLE:
        // Queue the operation locally and retry when online
        if (err.retryAfterSeconds) {
          // CloudKit requested a specific delay
          setTimeout(retry, err.retryAfterSeconds * 1000);
        }
        break;
    }
  }
}
```

### Error Codes

| Code | When |
|------|------|
| `NOT_AUTHENTICATED` | User not signed into iCloud |
| `NETWORK_UNAVAILABLE` | No network connectivity |
| `QUOTA_EXCEEDED` | User's iCloud storage is full |
| `ZONE_NOT_FOUND` | Zone does not exist (create it first) |
| `RECORD_NOT_FOUND` | Record ID does not exist |
| `CONFLICT` | Server record changed since last fetch (check `err.serverRecord`) |
| `PERMISSION_DENIED` | User lacks permission for this operation |
| `SERVER_REJECTED` | CloudKit server rejected the request |
| `ASSET_TOO_LARGE` | CKAsset file exceeds size limit |
| `LIMIT_EXCEEDED` | Batch exceeds 400 records — split and retry |
| `UNKNOWN` | Unexpected error — check `err.message` |

---

## API Reference

### Container & Account

#### `configure(containerId: string): void`

Initializes the module with a CloudKit container. Must be called before anything else.

```typescript
configure('iCloud.com.example.myapp');
```

#### `getAccountStatus(): Promise<AccountStatus>`

Returns the current iCloud account status.

```typescript
type AccountStatus = 'available' | 'noAccount' | 'restricted' | 'couldNotDetermine' | 'temporarilyUnavailable';
```

#### `addAccountStatusListener(callback): Subscription`

Fires whenever the iCloud account status changes (e.g., user signs in/out).

```typescript
const sub = addAccountStatusListener((status) => {
  console.log('Account:', status);
});
// Later:
sub.remove();
```

---

### Zone Management

#### `createZone(zoneName, database?): Promise<Zone>`

Creates a CKRecordZone. Idempotent — safe if zone already exists.

#### `deleteZone(zoneName, database?): Promise<void>`

Deletes a zone and **all records inside it**. Permanent.

#### `fetchZones(database?): Promise<Zone[]>`

Lists all custom zones. Does not include the default zone.

```typescript
interface Zone {
  zoneName: string;
  ownerName: string;
  capabilities: string[]; // e.g. ['fetchChanges', 'atomicChanges', 'sharing']
}
```

`database` defaults to `'private'` everywhere. Pass `'shared'` or `'public'` as needed.

---

### Record CRUD

#### `saveRecords(records, database?): Promise<SavedRecord[]>`

Inserts or updates records. Records without a `recordName` are inserted with a CloudKit-generated UUID. Records with a `changeTag` use conflict detection — the save will fail with `CONFLICT` if the server record has changed.

CloudKit limit: max 400 records per call.

```typescript
interface RecordToSave {
  recordType: string;
  recordName?: string;    // omit for insert
  zoneName?: string;      // omit for default zone
  changeTag?: string;     // provide for conflict detection
  fields: Record<string, RecordField>;
}
```

#### `fetchRecord(recordType, recordId, zoneName?, database?): Promise<CloudKitRecord>`

Fetches a single record by its type and record name.

#### `queryRecords(recordType, predicate?, sortDescriptors?, zoneName?, database?, resultsLimit?, cursor?): Promise<QueryResult>`

Queries records. Results are paginated via a cursor:

```typescript
const page1 = await queryRecords('Note', undefined, undefined, 'MyZone');
if (page1.cursor) {
  const page2 = await queryRecords('Note', undefined, undefined, 'MyZone', 'private', 100, page1.cursor);
}
```

Supported predicate comparators: `=`, `!=`, `<`, `<=`, `>`, `>=`, `BEGINSWITH`, `CONTAINS`, `IN`

#### `deleteRecords(recordIds, database?): Promise<void>`

```typescript
await deleteRecords([
  { recordName: 'abc123', zoneName: 'MyZone' }
]);
```

#### `fetchRecordZoneChanges(zoneNames, database?): Promise<ZoneChanges>`

Delta fetch — returns only records changed since the last sync token.

```typescript
interface ZoneChanges {
  changedRecords: CloudKitRecord[];
  deletedRecordNames: string[];
  syncToken: string;   // store this; pass on next call
  moreComing: boolean; // call again if true
}
```

---

### Record Field Types

| Type key | JS value | CloudKit type |
|----------|----------|---------------|
| `'string'` | `string` | `NSString` |
| `'number'` | `number` | `NSNumber` |
| `'date'` | ISO 8601 string | `NSDate` |
| `'data'` | base64 string | `NSData` |
| `'location'` | `{ latitude, longitude }` | `CLLocation` |
| `'reference'` | `{ recordName, action }` | `CKRecord.Reference` |
| `'asset'` | file URI (save) or `{ downloadURL, size }` (read) | `CKAsset` |
| `'stringList'` | `string[]` | `[NSString]` |
| `'numberList'` | `number[]` | `[NSNumber]` |

---

### CKSyncEngine (Phase B — iOS 17+)

```typescript
if (isSyncEngineAvailable()) {
  await startSyncEngine({
    zones: ['MyZone'],
    database: 'private',
    automaticallySync: true,
  });

  const sub = addSyncEngineListener((event) => {
    if (event.type === 'fetchedRecordChanges') {
      console.log('Changed:', event.changedRecords);
      console.log('Deleted:', event.deletedRecordNames);
    }
  });
}
```

> CKSyncEngine is not yet implemented. The functions are stubbed and will reject with NOT_IMPLEMENTED.

---

## iOS Version Notes

- **iOS 16+**: All Phase A operations (zones, record CRUD, delta fetch)
- **iOS 17+**: CKSyncEngine (Phase B) — covers 92%+ of active devices as of March 2026
- No Android support — CloudKit is Apple-only by design

---

## License

MIT — see [LICENSE](LICENSE).

---

## Contributing

Issues and PRs welcome. API changes require an RFC (GitHub issue discussion) before implementation. See [CHANGELOG](CHANGELOG.md) for version history.
