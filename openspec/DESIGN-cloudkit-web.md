# Design: CloudKit Web Implementation (`ExpoCloudKit.web.ts`)

**Date**: 2026-03-10
**Status**: Proposed
**Author**: architect agent
**Depends on**: `DESIGN-android-web-expansion.md` (Option C: hybrid approach for web target)

---

## Context

The previous design analysis (`DESIGN-android-web-expansion.md`) recommended Option B (graceful degradation) with a deferred Option C spike for public database REST. This document takes a different angle: designing a **full web implementation** that supports private database access through CloudKit JS's built-in Apple ID authentication flow. This is the detailed design for `src/ExpoCloudKit.web.ts`.

The user asked for this explicitly, so we are designing it. The constraints and trade-offs identified in the previous analysis still apply, particularly around the Apple ID sign-in friction on web.

---

## 1. Which npm Package to Use

### Recommendation: `tsl-apple-cloudkit` (v0.2.34+)

**Why not raw CloudKit JS from CDN?**
- Apple's CDN-hosted `cloudkit.js` (`https://cdn.apple-cloudkit.com/ck/2/cloudkit.js`) requires a `<script>` tag -- incompatible with module bundlers (webpack, Metro web, Vite)
- No TypeScript types when loaded from CDN
- Cannot be tree-shaken or lazy-loaded via dynamic `import()`

**Why `tsl-apple-cloudkit`?**
- Downloads `cloudkit.js` from Apple's CDN at `npm install` time and bundles it as a CommonJS/ES module
- Ships TypeScript declarations for CloudKit JS v2 API surface
- Actively maintained (v0.2.34, July 2025)
- 1:1 mapping to Apple's CloudKit JS API -- no abstraction layer
- MIT licensed

**Why not a direct REST client (fetch-based)?**
- CloudKit JS handles the Apple ID authentication popup/redirect flow natively. Reimplementing the auth redirect dance with raw `fetch()` is fragile and underdocumented.
- CloudKit JS handles `ckWebAuthToken` rotation automatically (tokens are single-use; each response includes a fresh one)
- CloudKit JS handles the public-key wrapping required for private database assets
- The REST API is documented but the auth flow has subtle edge cases (popup vs redirect, `window.postMessage` for token relay) that CloudKit JS abstracts

**Trade-off acknowledged**: `tsl-apple-cloudkit` bundles ~200KB of Apple's CloudKit JS. This is acceptable because we lazy-load it (see Section 4).

**Alternative considered**: `@apple/cksdk` does not exist as a published npm package. Apple has not published an official npm module. `tsl-apple-cloudkit` is the de facto community standard.

---

## 2. Authentication Flow Design

### How CloudKit JS Auth Works

CloudKit JS uses **API token authentication** combined with **Apple ID sign-in** for private/shared database access:

1. **API Token** (required for all web access): Created in CloudKit Dashboard. Embedded in client config. Grants public database access without user sign-in.

2. **Apple ID Sign-In** (required for private/shared database): CloudKit JS opens Apple's sign-in page (popup or redirect). On success, a `ckWebAuthToken` is returned. This token is single-use -- every API response includes a fresh token for the next request. CloudKit JS manages this rotation transparently.

### Auth Flow for expo-cloudkit on Web

```
Step 1: App calls configure(containerId) with webApiToken
        └── CloudKit.configure({ containers: [{ containerIdentifier, apiTokenAuth }] })
        └── CloudKit JS initializes, public database is immediately available

Step 2: App calls getAccountStatus()
        ├── If user has a persisted session → returns 'available'
        └── If no session → returns 'noAccount'

Step 3: User triggers sign-in (explicit action, NOT automatic)
        └── App calls authenticateWeb()  [NEW function, web-only]
            └── CloudKit JS opens Apple ID sign-in popup
            └── User authenticates with Apple ID
            └── CloudKit JS receives ckWebAuthToken via postMessage
            └── Returns Promise<'available'> on success

Step 4: Subsequent API calls include ckWebAuthToken automatically
        └── CloudKit JS handles token rotation per-request
```

### Key Design Decisions

**Auth is NOT triggered by `configure()`.** The `configure()` call sets up the container and API token. It does not prompt for sign-in. This matches iOS behavior where `configure()` just sets the container ID -- the OS handles authentication separately.

**A new `authenticateWeb()` function is needed.** On iOS, the user is always signed into iCloud at the OS level. On web, there is no equivalent. We need an explicit function that triggers the Apple ID sign-in flow. This function is web-only; on iOS it returns `Promise<'available'>` immediately (the user is already authenticated).

**Auth state persistence.** CloudKit JS supports `persist: true` in the API token config, which stores the auth session in `localStorage`. When `persist` is enabled:
- The session survives page reloads
- Default expiry: 30 minutes (or 2 weeks if user chose "Keep me signed in")
- `getAccountStatus()` checks for a persisted session on load

**`addAccountStatusListener()` on web.** CloudKit JS emits `'authSuccess'` and `'authFailure'` events on the container. We map these to `onAccountStatusChanged` events. Unlike iOS (which observes `NSNotification`), web auth state only changes when the user explicitly signs in or out, or when the session expires.

### `AccountStatus` Mapping on Web

| Web state | `AccountStatus` value |
|---|---|
| CloudKit JS not yet configured | `'couldNotDetermine'` |
| Configured, no auth session | `'noAccount'` |
| Configured, valid auth session | `'available'` |
| Auth session expired (mid-request) | `'temporarilyUnavailable'` |
| Auth explicitly failed | `'noAccount'` |

`'restricted'` is never returned on web (it is an iOS parental-controls concept).

### Interaction with `CloudKitProvider`

```tsx
<CloudKitProvider
  containerId="iCloud.com.example.myapp"
  webApiToken="your-api-token-from-cloudkit-dashboard"  // NEW PROP
  webEnvironment="production"  // NEW PROP: 'development' | 'production'
>
  <App />
</CloudKitProvider>
```

- `webApiToken` is passed to `CloudKit.configure()` on web. Ignored on iOS.
- `webEnvironment` selects development vs production CloudKit environment. Ignored on iOS (the environment is determined by the build configuration).
- `CloudKitProvider` calls `configure(containerId)` on iOS and `configureWeb(containerId, webApiToken, webEnvironment)` on web, using platform detection.

---

## 3. API Mapping Table

### Fully Implementable on Web

| expo-cloudkit function | CloudKit JS method | Notes |
|---|---|---|
| `configure(containerId)` | `CloudKit.configure({ containers: [...] })` | Web version needs `webApiToken` and `webEnvironment` |
| `getAccountStatus()` | Container auth state check | Maps CloudKit JS auth state to `AccountStatus` |
| `addAccountStatusListener(cb)` | Container `'authSuccess'`/`'authFailure'` events | Limited to explicit auth actions; no OS-level observation |
| `createZone(name, db)` | `database.saveRecordZones([zone])` | Full parity |
| `deleteZone(name, db)` | `database.deleteRecordZones([zoneID])` | Full parity |
| `fetchZones(db)` | `database.fetchAllRecordZones()` | Full parity |
| `saveRecords(records, db)` | `database.saveRecords(records)` | Full parity. CloudKit JS handles `recordChangeTag` conflict detection |
| `fetchRecord(type, id, zone, db)` | `database.fetchRecords([recordName])` | Full parity |
| `queryRecords(...)` | `database.performQuery(query)` | Full parity including cursor pagination via `continuationMarker` |
| `deleteRecords(ids, db)` | `database.deleteRecords(recordNames)` | Full parity |
| `fetchRecordZoneChanges(zones, db)` | REST: `POST changes/zone` | CloudKit JS does not expose this directly; use REST fallback or `database.fetchRecordChanges()` |
| `fetchSubscriptions(db)` | `database.fetchAllSubscriptions()` | Full parity |
| `saveQuerySubscription(opts)` | `database.saveSubscriptions([sub])` | Can create on server, but push delivery goes to APNs only (no web push) |
| `saveDatabaseSubscription(db)` | `database.saveSubscriptions([sub])` | Same caveat: no web push delivery |
| `deleteSubscription(id, db)` | `database.deleteSubscriptions([id])` | Full parity |
| `acceptShare(opts)` | `container.acceptShares([shortGUID])` | Requires the share short GUID extracted from the URL |
| `fetchRecordWithReferences(name, opts)` | Multiple `fetchRecords` calls | Implementable in JS: fetch root, resolve references, recurse to depth |

### Partially Implementable (Degraded)

| expo-cloudkit function | Web behavior | Notes |
|---|---|---|
| `createShare(opts)` | Implementable via `saveRecords` with `cloudkit.share` record type | No native sharing UI, but the REST/JS API supports creating share records |
| `deleteShare(opts)` | Implementable via `deleteRecords` | Delete the CKShare record |
| `fetchShareParticipants(opts)` | Implementable via `fetchRecords` on the share record | Share participant data is in the record response |
| `downloadAsset(...)` | Returns the `downloadURL` from the asset field | No progress events; caller must use `fetch()` to download. Returns URL string, not local file path |
| `fetchSharedDatabaseZones()` | Implementable via `database.fetchAllRecordZones()` on the shared database | Full parity if user is authenticated to the shared database |

### Not Implementable on Web (Stub with `CloudKitNotSupportedError`)

| expo-cloudkit function | Why not implementable |
|---|---|
| `isSyncEngineAvailable()` | Returns `false`. CKSyncEngine is an iOS kernel-level scheduler |
| `startSyncEngine(config)` | No CKSyncEngine on web |
| `stopSyncEngine()` | No CKSyncEngine on web |
| `triggerSync()` | No CKSyncEngine on web |
| `enqueuePendingChange(change)` | No CKSyncEngine queue on web |
| `getSyncState()` | Returns `{ usesSyncEngine: false, status: 'notStarted' }` |
| `addSyncEngineListener(cb)` | Returns no-op subscription |
| `presentSharingUI(opts)` | No `UICloudSharingController` equivalent on web |
| `updateSharePermission(opts)` | Requires `CKShare` mutation semantics not exposed in CloudKit JS |
| `removeShareParticipant(opts)` | Same |
| `addShareAcceptedListener(cb)` | No universal link / intent handling on web |
| `addSubscriptionListener(cb)` | No APNs push delivery on web. Returns no-op subscription |
| `addAssetProgressListener(cb)` | No native progress callbacks. Returns no-op subscription |
| `addBatchProgressListener(cb)` | No per-record progress from CloudKit JS. Returns no-op subscription |
| `enqueueOfflineOperation(opts)` | No native persistent queue. Could use IndexedDB in future |
| `drainOfflineQueue()` | No native queue |
| `getOfflineQueueStatus(opts)` | No native queue |
| `clearOfflineQueue(opts)` | No native queue |
| `retryFailedOperations()` | No native queue |
| `addOfflineQueueListener(cb)` | No native queue events. Returns no-op subscription |
| `__debugDumpContainerInfo()` | Stub (could partially implement) |
| `__debugListZones(db)` | Stub (equivalent to `fetchZones`) |
| `__debugFetchRawRecord(opts)` | Stub (equivalent to `fetchRecord` with full fields) |
| `__debugClearZone(opts)` | Stub (would require querying all records then batch delete) |

### New Web-Only Functions

| Function | Purpose |
|---|---|
| `authenticateWeb()` | Triggers Apple ID sign-in popup via CloudKit JS. Returns `Promise<AccountStatus>`. On iOS, resolves immediately with current account status |
| `signOutWeb()` | Clears the CloudKit JS auth session. On iOS, no-op (cannot sign out of iCloud programmatically) |
| `isWebAuthenticated()` | Synchronous check: is there a valid `ckWebAuthToken` session. On iOS, delegates to `getAccountStatus` check |

---

## 4. Type Conversion Approach

CloudKit JS/REST uses a different record shape than our `CloudKitRecord` type. The web implementation needs a bidirectional conversion layer.

### CloudKit JS Record Shape (Response)

```typescript
// What CloudKit JS returns
interface CKJSRecord {
  recordName: string;
  recordType: string;
  recordChangeTag: string;
  created: { timestamp: number; userRecordName: string; deviceID: string };
  modified: { timestamp: number; userRecordName: string; deviceID: string };
  fields: Record<string, { value: CKJSValue; type?: string }>;
  // Zone info comes from the request context, not the record itself
}

type CKJSValue =
  | string                          // STRING, BYTES (base64)
  | number                          // INT64, DOUBLE, TIMESTAMP (ms since epoch)
  | boolean                         // not a CKRecord type, but CloudKit JS supports it
  | { latitude: number; longitude: number; /* ... */ }  // LOCATION
  | { recordName: string; zoneID: { zoneName: string; ownerRecordName: string }; action: string }  // REFERENCE
  | { fileChecksum: string; size: number; downloadURL?: string }  // ASSET
  | CKJSValue[];                    // LIST
```

### Conversion: CloudKit JS Record --> `CloudKitRecord`

```
CKJSRecord.recordName          --> CloudKitRecord.recordName
CKJSRecord.recordType          --> CloudKitRecord.recordType
CKJSRecord.recordChangeTag     --> CloudKitRecord.changeTag
CKJSRecord.created.timestamp   --> CloudKitRecord.creationDate  (ms --> ISO 8601 string)
CKJSRecord.modified.timestamp  --> CloudKitRecord.modificationDate  (ms --> ISO 8601 string)
zoneName (from request context) --> CloudKitRecord.zoneName
ownerName (from zone context)   --> CloudKitRecord.ownerName
CKJSRecord.fields              --> CloudKitRecord.fields  (per-field conversion below)
```

### Per-Field Type Conversion

| CloudKit JS `type` string | CloudKit JS `value` shape | expo-cloudkit `RecordField.type` | expo-cloudkit `RecordField.value` |
|---|---|---|---|
| `STRING` | `string` | `'string'` | `string` |
| `INT64` | `number` | `'number'` | `number` |
| `DOUBLE` | `number` | `'number'` | `number` |
| `TIMESTAMP` | `number` (ms since epoch) | `'date'` | ISO 8601 string (`new Date(ms).toISOString()`) |
| `BYTES` | `string` (base64) | `'data'` | `string` (base64, no conversion needed) |
| `LOCATION` | `{ latitude, longitude, ... }` | `'location'` | `{ latitude, longitude }` (drop extra fields) |
| `REFERENCE` | `{ recordName, zoneID, action }` | `'reference'` | `{ recordName, action: mapAction(action) }` |
| `ASSET` | `{ downloadURL, size, ... }` | `'asset'` | `{ downloadURL, size }` |
| `STRING_LIST` (list of strings) | `string[]` | `'stringList'` | `string[]` |
| `NUMBER_LIST` (list of numbers) | `number[]` | `'numberList'` | `number[]` |

**Reference action mapping**:
- CloudKit JS: `"NONE"`, `"DELETE_SELF"`, `"VALIDATE"`
- expo-cloudkit: `"none"`, `"deleteSelf"`
- `"VALIDATE"` maps to `"none"` (iOS CKRecord.ReferenceAction has no validate equivalent)

### Conversion: `RecordToSave` --> CloudKit JS Record Input

```
RecordToSave.recordType         --> { recordType }
RecordToSave.recordName         --> { recordName }  (omit for new records)
RecordToSave.changeTag          --> { recordChangeTag }  (omit for new records)
RecordToSave.zoneName           --> request zoneID context (not part of record body)
RecordToSave.fields             --> { fields }  (per-field reverse conversion)
```

**Per-field reverse conversion** (expo-cloudkit --> CloudKit JS):
- `'date'` value (ISO 8601 string) --> `{ value: Date.parse(isoString), type: 'TIMESTAMP' }`
- `'reference'` value --> `{ value: { recordName, zoneID: { zoneName }, action: ACTION_UPPER }, type: 'REFERENCE' }`
- `'location'` value --> `{ value: { latitude, longitude }, type: 'LOCATION' }`
- `'asset'` value (fileURL) --> Requires asset upload flow (see below)
- All others: pass `value` directly with appropriate `type` string

### Asset Upload on Web

CloudKit JS / REST asset upload is a two-step process:
1. Request upload URL: `POST assets/upload` with token fields
2. Upload file data to the returned URL
3. Use the returned `fileChecksum` and `receipt` in the record save

This is significantly different from iOS where you just pass a file URL. On web, `RecordToSave` with asset fields requires:
- The `fileURL` field to be a `Blob`, `File`, or fetchable URL
- The web implementation handles the upload dance transparently
- If the asset source is a remote URL, the web implementation fetches it first

**Decision**: Asset upload on web is deferred to a future iteration. Initial web implementation will throw `CloudKitNotSupportedError` for `RecordToSave` entries containing asset fields. Asset *download* (reading `downloadURL` from fetched records) works immediately.

### Conversion Layer File

All conversions live in a single file: `src/web/converters.ts`. This mirrors the role of `ios/Converters.swift` on the native side.

---

## 5. Lazy Loading Strategy

CloudKit JS (~200KB) must not be loaded until the user actually calls `configure()`.

### Approach: Dynamic `import()` with a Singleton Promise

```typescript
// src/web/cloudkit-loader.ts

let loadPromise: Promise<typeof import('tsl-apple-cloudkit')> | null = null;

export function getCloudKit(): Promise<typeof import('tsl-apple-cloudkit')> {
  if (!loadPromise) {
    loadPromise = import('tsl-apple-cloudkit');
  }
  return loadPromise;
}
```

**How it works**:
- First call to `configure()` triggers `getCloudKit()`, which does `import('tsl-apple-cloudkit')`
- The dynamic import returns a promise; all subsequent calls await the same promise
- Bundlers (webpack, Vite) automatically code-split the 200KB CloudKit JS into a separate chunk
- If `configure()` is never called, CloudKit JS is never loaded

**TypeScript type-only imports**: For type annotations (not runtime loading), use:
```typescript
import type * as CloudKitTypes from 'tsl-apple-cloudkit';
```
This is erased at compile time and does not trigger a bundle.

**Metro web compatibility**: Expo's Metro web bundler supports dynamic `import()` for code splitting. No special configuration needed.

### `tsl-apple-cloudkit` as a Peer Dependency

`tsl-apple-cloudkit` is declared as an **optional peer dependency** in `package.json`:

```json
{
  "peerDependencies": {
    "tsl-apple-cloudkit": ">=0.2.34"
  },
  "peerDependenciesMeta": {
    "tsl-apple-cloudkit": {
      "optional": true
    }
  }
}
```

**Why optional**: iOS-only users should not need to install `tsl-apple-cloudkit`. The dynamic `import()` will fail gracefully if the package is not installed, and `configure()` will throw a clear error message: `"tsl-apple-cloudkit is required for web support. Run: npm install tsl-apple-cloudkit"`.

---

## 6. Error Mapping

### CloudKit JS/REST Error --> `CloudKitErrorCode`

| CloudKit JS `serverErrorCode` | HTTP Status | `CloudKitErrorCode` |
|---|---|---|
| `ACCESS_DENIED` | 403 | `PERMISSION_DENIED` |
| `ATOMIC_ERROR` | 400 | `SERVER_REJECTED` |
| `AUTHENTICATION_FAILED` | 401 | `NOT_AUTHENTICATED` |
| `AUTHENTICATION_REQUIRED` | 421 | `NOT_AUTHENTICATED` |
| `BAD_REQUEST` | 400 | `SERVER_REJECTED` |
| `CONFLICT` | 409 | `CONFLICT` |
| `EXISTS` | 409 | `ALREADY_SHARED` (for share records) or `SERVER_REJECTED` (for zones/records) |
| `INTERNAL_ERROR` | 500 | `UNKNOWN` |
| `NOT_FOUND` | 404 | `RECORD_NOT_FOUND` or `ZONE_NOT_FOUND` or `SHARE_NOT_FOUND` (context-dependent) |
| `QUOTA_EXCEEDED` | 413 | `QUOTA_EXCEEDED` |
| `THROTTLED` | 429 | `SERVER_REJECTED` with `retryAfterSeconds` extracted from response |
| `TRY_AGAIN_LATER` | 503 | `NETWORK_UNAVAILABLE` |
| `VALIDATING_REFERENCE_ERROR` | 412 | `REFERENCE_VIOLATION` |
| `ZONE_NOT_FOUND` | 404 | `ZONE_NOT_FOUND` |
| Network/fetch failure | N/A | `NETWORK_UNAVAILABLE` |
| `tsl-apple-cloudkit` not installed | N/A | `NOT_SUPPORTED` with message about missing dependency |

### Error Conversion Function

```typescript
// src/web/errors.ts

function mapCloudKitJSError(
  error: CloudKitJSError,
  context: 'record' | 'zone' | 'share' | 'subscription' | 'general'
): CloudKitError {
  // Maps serverErrorCode + context to the appropriate CloudKitErrorCode
  // Extracts retryAfterSeconds from THROTTLED responses
  // For CONFLICT errors, extracts serverRecord from the error response
}
```

### `CONFLICT` Error Handling

CloudKit JS CONFLICT responses include the current server record in the error payload. The web error mapper extracts this and attaches it to `CloudKitError.serverRecord`, matching the native module behavior:

```
CloudKit JS CONFLICT error.serverRecord --> CloudKitError.serverRecord (converted via converters.ts)
```

---

## 7. Changes to `configure()` / `CloudKitProvider`

### `configure()` Signature Change

The existing `configure(containerId: string): void` signature remains unchanged for iOS. On web, an overload or options object is needed:

**Decision**: Add a new `configureWeb()` function rather than overloading `configure()`.

```typescript
/**
 * Configures CloudKit for web access using CloudKit JS.
 *
 * Must be called before any other operation on web. On iOS, this is a no-op
 * that delegates to configure(containerId).
 *
 * @param options.containerId - CloudKit container ID (e.g. "iCloud.com.example.myapp")
 * @param options.apiToken - API token from CloudKit Dashboard (required on web)
 * @param options.environment - 'development' or 'production' (default: 'development')
 * @param options.persistSession - Store auth session in localStorage (default: true)
 */
export function configureWeb(options: WebConfigOptions): Promise<void>;

export interface WebConfigOptions {
  containerId: string;
  apiToken: string;
  environment?: 'development' | 'production';
  persistSession?: boolean;
}
```

**Why `configureWeb()` instead of modifying `configure()`**:
- `configure()` is synchronous on iOS. `configureWeb()` is async (loads CloudKit JS lazily).
- Keeps the iOS path zero-overhead -- no conditional checks, no unused parameters.
- The `apiToken` parameter is meaningless on iOS and would confuse the API surface.
- `CloudKitProvider` calls the right one based on `Platform.OS`.

**Why not an optional second parameter on `configure()`**:
- `configure()` is already shipped and documented as `configure(containerId: string): void`
- Adding an optional object parameter changes the signature in a way that is confusing: `configure('iCloud.com.example', { apiToken: '...' })` suggests the options are always available, but they are ignored on iOS
- Separate functions make the platform boundary explicit

### `CloudKitProvider` Props Changes

```typescript
export interface CloudKitProviderProps {
  containerId: string;
  defaultDatabase?: DatabaseScope;
  observeAccountStatus?: boolean;
  children: React.ReactNode;

  // NEW: Web-specific props (ignored on iOS)
  /** API token from CloudKit Dashboard. Required on web for any CloudKit access. */
  webApiToken?: string;
  /** CloudKit environment. Default: 'development'. Ignored on iOS. */
  webEnvironment?: 'development' | 'production';
  /** Persist auth session in localStorage. Default: true. Ignored on iOS. */
  webPersistSession?: boolean;
}
```

**Provider behavior on web**:
1. On mount, calls `configureWeb({ containerId, apiToken: webApiToken, environment: webEnvironment, persistSession: webPersistSession })`
2. After configure resolves, checks auth state and sets `accountStatus`
3. Subscribes to CloudKit JS auth events for live status updates

---

## 8. Implementation File List and Order

### New Files

| File | Purpose | Order |
|---|---|---|
| `src/web/cloudkit-loader.ts` | Lazy-loads `tsl-apple-cloudkit` via dynamic `import()` | 1st |
| `src/web/converters.ts` | Bidirectional record/field type conversion (CloudKit JS <--> expo-cloudkit types) | 2nd |
| `src/web/errors.ts` | CloudKit JS error --> `CloudKitError` mapping | 3rd |
| `src/web/database.ts` | Helper to resolve a `DatabaseScope` string to a CloudKit JS `Database` object | 4th |
| `src/ExpoCloudKit.web.ts` | Main web implementation -- all exported functions | 5th |
| `src/CloudKitProvider.web.tsx` | Web-specific Provider that calls `configureWeb()` instead of `configure()` (or: modify existing Provider with platform check) | 6th |

### Modified Files

| File | Change |
|---|---|
| `src/types.ts` | Add `WebConfigOptions` interface |
| `src/index.ts` | Export `configureWeb`, `authenticateWeb`, `signOutWeb`, `isWebAuthenticated` |
| `src/errors.ts` | No changes needed (error codes already cover web scenarios) |
| `src/CloudKitProvider.tsx` | Add `webApiToken`, `webEnvironment`, `webPersistSession` props; platform-switch in `useEffect` |
| `package.json` | Add `tsl-apple-cloudkit` as optional peer dependency |

### Implementation Order

1. **`cloudkit-loader.ts`** -- Foundation. No dependencies.
2. **`converters.ts`** -- Depends on `src/types.ts` only. Can be unit-tested in isolation.
3. **`errors.ts`** -- Depends on `src/errors.ts` only. Can be unit-tested in isolation.
4. **`database.ts`** -- Small helper depending on `cloudkit-loader.ts`.
5. **`ExpoCloudKit.web.ts`** -- The main file. Depends on all of the above.
6. **`CloudKitProvider` changes** -- Depends on `ExpoCloudKit.web.ts` existing.

### Platform Resolution

Expo/Metro web uses the `.web.ts` extension convention for platform-specific modules. When bundling for web:
- `import { configure } from './ExpoCloudKit'` resolves to `./ExpoCloudKit.web.ts` (if it exists)
- On iOS, it resolves to `./ExpoCloudKit.ts` (the native module)

This means `src/index.ts` needs **no changes** for basic platform switching -- the bundler handles it. However, web-only exports (`authenticateWeb`, `signOutWeb`, `isWebAuthenticated`) need conditional exports or a separate entry point.

**Decision**: Web-only functions are exported from `src/index.ts` unconditionally. On iOS, they are thin stubs (no-ops or immediate resolves). This avoids sub-path exports and keeps the API surface simple.

---

## 9. What Remains as Stub

### Functions that return no-op / default values (not errors)

These silently degrade rather than throwing, matching the iOS behavior for `addXxxListener` on non-supported platforms:

| Function | Web return value |
|---|---|
| `isSyncEngineAvailable()` | `false` |
| `getSyncState()` | `{ usesSyncEngine: false, status: 'notStarted' }` |
| `addSyncEngineListener(cb)` | `{ remove: () => {} }` |
| `addSubscriptionListener(cb)` | `{ remove: () => {} }` |
| `addAssetProgressListener(cb)` | `{ remove: () => {} }` |
| `addBatchProgressListener(cb)` | `{ remove: () => {} }` |
| `addShareAcceptedListener(cb)` | `{ remove: () => {} }` |
| `addOfflineQueueListener(cb)` | `{ remove: () => {} }` |

### Functions that throw `CloudKitNotSupportedError`

| Function | Reason |
|---|---|
| `startSyncEngine(config)` | No CKSyncEngine |
| `stopSyncEngine()` | No CKSyncEngine |
| `triggerSync()` | No CKSyncEngine |
| `enqueuePendingChange(change)` | No CKSyncEngine |
| `presentSharingUI(opts)` | No UIKit |
| `updateSharePermission(opts)` | CKShare mutation not exposed in CloudKit JS |
| `removeShareParticipant(opts)` | CKShare mutation not exposed in CloudKit JS |
| `downloadAsset(...)` | No local filesystem on web (could return URL in future) |
| `enqueueOfflineOperation(opts)` | No native persistent queue |
| `drainOfflineQueue()` | No native queue |
| `getOfflineQueueStatus(opts)` | No native queue |
| `clearOfflineQueue(opts)` | No native queue |
| `retryFailedOperations()` | No native queue |
| `__debugDumpContainerInfo()` | Debug-only, low priority |
| `__debugListZones(db)` | Debug-only, low priority |
| `__debugFetchRawRecord(opts)` | Debug-only, low priority |
| `__debugClearZone(opts)` | Debug-only, low priority |

### Summary: Web Coverage

| Category | Implemented | Stubbed (no-op) | Stubbed (throws) | Total |
|---|---|---|---|---|
| Container & Account | 3 + 3 web-only | 0 | 0 | 6 |
| Zone Management | 3 | 0 | 0 | 3 |
| Record CRUD | 5 | 0 | 0 | 5 |
| Reference Resolution | 1 | 0 | 0 | 1 |
| CKSyncEngine | 0 | 3 | 4 | 7 |
| Subscriptions (CRUD) | 4 | 0 | 0 | 4 |
| Subscription Events | 0 | 1 | 0 | 1 |
| Sharing (data) | 4 | 0 | 0 | 4 |
| Sharing (UI + mutation) | 0 | 1 | 2 | 3 |
| Assets | 0 | 1 | 1 | 2 |
| Batch Progress | 0 | 1 | 0 | 1 |
| Offline Queue | 0 | 1 | 5 | 6 |
| Debug Helpers | 0 | 0 | 4 | 4 |
| **Total** | **20 + 3 new** | **8** | **16** | **47** |

**20 of 44 existing functions work on web** (45%). With the 3 new web-only functions, web gets 23 functional APIs.

---

## 10. Open Questions for Implementation

1. **`fetchRecordZoneChanges` on web**: CloudKit JS's `Database` object may not expose a `fetchRecordZoneChanges` equivalent directly. The REST API has `POST changes/zone`. If CloudKit JS does not wrap this, we need to make a raw `fetch()` call to the REST endpoint using the API token and web auth token from the CloudKit JS session. This needs investigation during implementation.

2. **Asset upload**: Deferred. The two-step upload flow (request URL, upload to URL, save with receipt) is well-documented in the REST API but adds significant complexity. Ship without it, add later.

3. **Share creation on web**: The REST API supports creating `cloudkit.share` records via `records/modify`. CloudKit JS may or may not have a higher-level API. Needs investigation. If it works, `createShare` and `deleteShare` become fully functional on web.

4. **`continuationMarker` vs `cursor`**: Our `QueryResult.cursor` maps to CloudKit JS/REST's `continuationMarker`. The conversion is a simple rename. Verify that the marker format is the same between CloudKit JS responses and our opaque cursor string.

5. **SSR safety**: `ExpoCloudKit.web.ts` must not reference `window`, `document`, or `localStorage` at module scope. All browser globals must be accessed lazily (inside function bodies) to support SSR frameworks (Next.js, Remix).

---

## Sources

- [CloudKit JS Documentation](https://developer.apple.com/documentation/cloudkitjs)
- [CloudKit Web Services Reference](https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/index.html)
- [CloudKit Web Services: Types and Dictionaries](https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/Types.html)
- [CloudKit Web Services: Error Codes](https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/ErrorCodes.html)
- [CloudKit Web Services: Composing Requests (Auth)](https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/SettingUpWebServices.html)
- [tsl-apple-cloudkit on npm](https://www.npmjs.com/package/tsl-apple-cloudkit)
- [tsl-apple-cloudkit on GitHub](https://github.com/typescriptlibs/tsl-apple-cloudkit)
- [Obtaining an API Token for CloudKit](https://developer.apple.com/documentation/cloudkit/obtaining-an-api-token-for-an-icloud-container)
- [Expo Apple Authentication](https://docs.expo.dev/versions/latest/sdk/apple-authentication/)
- [Expo AuthSession](https://docs.expo.dev/versions/latest/sdk/auth-session/)
