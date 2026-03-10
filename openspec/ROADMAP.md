# expo-cloudkit Roadmap

## Phase A — Core CK Operations (complete)

- [x] CKContainer setup and account status (`accountStatus()`, `fetchUserRecordID()`)
- [x] Custom zones (CKRecordZone) — create, delete, list
- [x] Record CRUD — save, fetch by ID, delete, query with predicates
- [x] Asset upload/download with progress callbacks
- [x] TypeScript bindings and type definitions (`src/types.ts`, `src/index.ts`)
- [x] Expo config plugin (iCloud entitlements in `plugin/`)

## Phase B — Sync & Sharing (complete)

### CKSyncEngine (iOS 17+)
- [x] `ios/ExpoCloudKitSyncEngine.swift` adapter implementing `CKSyncEngineDelegate`
- [x] `startSync()` / `stopSync()` / `getSyncState()` JS API
- [x] Change token persistence (UserDefaults, keyed per container + zone)
- [x] Conflict resolution — server-record-wins default, hook for custom resolution
- [x] JS events: `onSyncStateChanged`, `onRecordsReceived`, `onRecordsSent`

### Push Subscriptions
- [x] `CKQuerySubscription` — subscribe to record changes matching a predicate
- [x] `CKDatabaseSubscription` — subscribe to all changes in a database
- [x] `addEventListener` / `removeEventListener` JS API for subscription events
- [x] Silent push handling (APNs background mode entitlement via config plugin)

### CKShare
- [x] `createShare(recordName:)` — share a record; saves CKShare + root record via CKModifyRecordsOperation
- [x] `acceptShare(shareURL:)` + `addShareAcceptedListener` — accept a share invitation from a URL; emits `onShareAccepted` on deep link open
- [x] `fetchShareParticipants(shareRecordName:)` — list participants and their roles from the CKShare record
- [x] `updateSharePermission` + `removeShareParticipant` — change or revoke participant access
- [x] `fetchSharedDatabaseZones()` — list all zones in the shared database with attached share/participant info
- [x] `presentSharingUI()` — present UICloudSharingController for create-share and manage-participants modes
- [x] `deleteShare(shareRecordName:)` — unshare a record by deleting its CKShare

### iOS 16 Fallback
- [x] `CKServerChangeToken` persistence and management
- [x] Manual fetch-changes flow (no CKSyncEngine dependency)
- [x] Automatic capability detection — use CKSyncEngine on 17+, fallback on 16
- [x] Graceful degradation surface in JS API (returns `syncEngine: false` in status)

## Phase C — Advanced (complete)

- [x] Offline queue with automatic retry (exponential backoff, persist across app restarts)
- [x] React hooks: `useCloudKitRecord`, `useCloudKitQuery`, `useCloudKitSync`
- [x] Android stub — all APIs return a `CloudKitNotSupportedError` gracefully
- [x] CloudKit Dashboard helper tooling (for development/debug)
- [x] Batch record operations with progress reporting
- [x] `CKRecord.Reference` deep linking support

## Phase D — DX Improvements (complete)

- [x] `CloudKitProvider` — opt-in React context sharing `containerId`, reactive `accountStatus`, `defaultDatabase`, and `QueryCache`
- [x] `useAccountStatus()` / `useContainerId()` — convenience hooks requiring a Provider ancestor
- [x] `QueryCache` — internal pub/sub registry for cross-hook invalidation without a full data cache
- [x] `useCloudKitSubscription` — manages `CKQuerySubscription` lifecycle (create/delete/listener), invalidates `QueryCache` on push
- [x] Optimistic updates in `useCloudKitRecord` — `update(fields)` with `optimisticStatus` / `optimisticError` state machine
- [x] Optimistic mutations in `useCloudKitQuery` — `optimisticAdd(record)` / `optimisticRemove(recordName)` with `pendingCount`, `pendingRecordNames`, `optimisticErrors`

## Phase E — Web Platform (complete)

- [x] `src/ExpoCloudKit.web.ts` — Metro `.web.ts` platform override; 20/44 functions implemented via CloudKit JS
- [x] `configureWeb(containerId, options)` — lazy-loads `tsl-apple-cloudkit`, calls `CloudKit.configure()`
- [x] `authenticateWeb()` / `signOutWeb()` / `isWebAuthenticated()` — web auth lifecycle; native stubs for parity
- [x] `isCloudKitAvailable()` — cross-platform availability check
- [x] `CloudKitProvider.webConfig` prop — auto-calls `configureWeb()` on `Platform.OS === 'web'`
- [x] `src/web/cloudkit-loader.ts` — singleton dynamic import with retry and clear install error
- [x] `src/web/converters.ts` — bidirectional CloudKit JS ↔ `CloudKitRecord`/`RecordField` conversion
- [x] `src/web/errors.ts` — `serverErrorCode` string → `CloudKitErrorCode` mapping
- [x] `src/web/auth.ts` — in-memory + localStorage auth state with SSR guard and pub/sub
- [x] `src/web/database.ts` — `DatabaseScope` → CloudKit JS database resolver
- [x] `tsl-apple-cloudkit` added as optional peer dependency (`>=0.2.0`)
