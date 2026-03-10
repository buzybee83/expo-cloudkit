# Changelog

All notable changes to `expo-cloudkit` will be documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

---

## [0.5.0] — 2026-03-10

### Added

**CloudKit Web Services (web platform target)**

- `ExpoCloudKit.web.ts` — Metro `.web.ts` platform override implementing 20 of 44 CloudKit operations via CloudKit JS (`tsl-apple-cloudkit` optional peer dependency)
- `configureWeb(containerId, options)` — configures CloudKit JS with an API token; no-op on native
- `authenticateWeb()` — triggers Apple ID sign-in popup on web; delegates to `getAccountStatus()` on native
- `signOutWeb()` — clears the web auth session; no-op on native
- `isWebAuthenticated()` — synchronous check for a valid CloudKit JS session; always `false` on native
- `isCloudKitAvailable()` — returns `true` once `configureWeb()` succeeds on web; relies on native module on iOS
- `WebConfigOptions` type — `{ apiToken, environment?, persistSession? }`
- `CloudKitProvider` gains a `webConfig` prop that automatically calls `configureWeb()` on web when provided
- `src/web/` sub-package: `cloudkit-loader.ts`, `converters.ts`, `errors.ts`, `auth.ts`, `database.ts` — all SSR-safe, no `expo-modules-core` or `react-native` imports

**Supported on web**: zones, record CRUD, query, zone changes, subscriptions (server-side only — APNs not delivered on web), share data operations, reference deep linking

**Not supported on web** (throws `CloudKitNotSupportedError`): CKSyncEngine, asset download, offline queue, `UICloudSharingController`, share permission mutation

---

## [0.4.0] — 2026-03-10

### Added

**React context and account status**

- `CloudKitProvider` — opt-in React context provider; calls `configure()` on mount, observes account status reactively, and owns a `QueryCache` instance shared across all hooks in the tree
- `useAccountStatus()` — reads reactive iCloud account status from the nearest `CloudKitProvider`; updates automatically on account state changes
- `useContainerId()` — reads the container ID from the nearest `CloudKitProvider`

**Push subscription hook**

- `useCloudKitSubscription(recordType, options)` — manages `CKQuerySubscription` lifecycle (creates subscription on mount, deletes on unmount); automatically invalidates `useCloudKitQuery` hooks via `QueryCache` when push notifications arrive

**Optimistic updates for `useCloudKitRecord`**

- `update(fields)` method — applies field updates optimistically to local state and rolls back automatically if the CloudKit write fails
- `optimisticStatus` field — reflects current optimistic operation state (`'idle' | 'pending' | 'committed' | 'rolled-back'`)
- `optimisticError` field — holds the error from the most recent failed optimistic update

**Optimistic updates for `useCloudKitQuery`**

- `optimisticAdd(record)` — adds a record to the local query result immediately, with automatic rollback on save failure
- `optimisticRemove(recordName)` — removes a record from the local query result immediately, with automatic rollback on delete failure
- `pendingCount` field — number of in-flight optimistic operations
- `pendingRecordNames` field — array of record names currently in an optimistic state
- `optimisticErrors` field — array of errors from rolled-back optimistic operations

**New TypeScript types**

- `OptimisticStatus` — `'idle' | 'pending' | 'committed' | 'rolled-back'`
- `CloudKitProviderProps` — props for `CloudKitProvider`
- `UseCloudKitSubscriptionOptions` — options for `useCloudKitSubscription`
- `UseCloudKitSubscriptionReturn` — return shape of `useCloudKitSubscription`

> Note: `QueryCache` is an internal pub/sub registry enabling cross-hook invalidation and is not part of the public API.

> All changes in this release are purely additive TypeScript/React additions. No Swift or iOS changes were made.

---

## [0.3.0] - 2026-03-09

### Added
- **Offline queue** — persist CloudKit operations for offline-first apps (`enqueueOfflineOperation`, `drainOfflineQueue`, `clearOfflineQueue`, `getOfflineQueueStatus`, `retryFailedOperations`, `addOfflineQueueListener`). JSON-backed at `Library/Application Support/expo-cloudkit/offline-queue.json`. NWPathMonitor drain on connectivity restore, exponential backoff (5·2ⁿ s, capped at 300 s), 500-entry cap, 10-retry max, `onOfflineQueueEvent` discriminated-union events.
- **React hooks** — `useCloudKitRecord`, `useCloudKitQuery`, `useCloudKitSync` with stale-fetch guard and `fetchMore` cursor pagination.
- **Android stub** — All public APIs return `CloudKitNotSupportedError` on non-iOS; no crash.
- **CloudKit Dashboard helpers** — `__debugDumpContainerInfo`, `__debugListZones`, `__debugFetchRawRecord`, `__debugClearZone` dev-only introspection utilities.
- **Batch operations** — `saveRecords`/`deleteRecords` auto-chunk at 400 (CloudKit hard limit); `addBatchProgressListener` / `onBatchProgress` event with `{ completed, total, recordName }`.
- **`CKRecord.Reference` deep linking** — `fetchRecordWithReferences(recordName, { depth })` recursively resolves reference fields up to depth 3, with parallel fetch via `DispatchGroup` and fallback to shallow stub on error.
- **Jest infrastructure** — 41 unit tests for React hooks (`useCloudKitRecord`, `useCloudKitQuery`, `useCloudKitSync`).
- **GitHub Actions CI** — typecheck → lint → Jest → expo build on every PR and push to `main`.

### Changed
- `saveRecords` accepts new `queueOnFailure` option: on retryable `CKError`, each record is individually enqueued and resolves with `{ queued: true, queueId }`.

---

## [0.2.0] — 2026-03-08

### Added

**Phase B: CKSyncEngine (iOS 17+)**

- `startSyncEngine()`, `stopSyncEngine()`, `triggerSync()`, `getSyncState()`, `addSyncEngineListener()` — full sync integration with `CKSyncEngineDelegate`
- iOS 16 fallback: manual `CKFetchRecordZoneChangesOperation` with timer-based polling and per-zone `CKServerChangeToken` persistence
- Automatic capability detection: uses CKSyncEngine on iOS 17+, polling fallback on iOS 16
- Change token persistence via `UserDefaults`, keyed per container and zone
- Server-record-wins conflict resolution with failed records surfaced in `recordsSent` events
- `isSyncEngineAvailable()` — runtime check for iOS 17+ availability
- `enqueuePendingChange()` — enqueue a save or delete for the next sync cycle

**Phase B: Push Subscriptions**

- `saveQuerySubscription()` — subscribe to record changes matching a `CKQuerySubscription` predicate
- `saveDatabaseSubscription()` — subscribe to all changes in a database via `CKDatabaseSubscription`
- `deleteSubscription()` — cancel an active subscription by ID
- `fetchSubscriptions()` — list all subscriptions registered for the container
- `addSubscriptionListener()` — receive `QuerySubscriptionEvent` and `DatabaseSubscriptionEvent` notifications via silent push

**Phase B: CKShare**

- `createShare()` — share a record; saves `CKShare` + root record via `CKModifyRecordsOperation`
- `deleteShare()` — unshare a record by deleting its `CKShare`
- `presentSharingUI()` — present native `UICloudSharingController` for create-share and manage-participants modes
- `fetchShareParticipants()` — list participants and their roles from the `CKShare` record
- `updateSharePermission()` — change a participant's access level
- `removeShareParticipant()` — revoke a participant's access
- `acceptShare()` — accept a share invitation from a URL
- `fetchSharedDatabaseZones()` — list all zones in the shared database with attached share and participant info
- `addShareAcceptedListener()` — emits `onShareAccepted` when a share deep link is opened

**New TypeScript types**

- Sync: `SyncState`, `SyncEngineConfig`, `SyncEngineEvent` (discriminated union), `SyncProviderStatus`, `SyncStateChangedEvent`, `RecordsFetchedEvent`, `RecordsSentEvent`, `SyncErrorEvent`
- Subscriptions: `CloudKitSubscription`, `SubscriptionType`, `SubscriptionNotificationType`, `SaveQuerySubscriptionOptions`, `QuerySubscriptionEvent`, `DatabaseSubscriptionEvent`, `SubscriptionEvent`
- Sharing: `Share`, `ShareParticipant`, `SharePermission`, `SharingUIResult`, `AcceptedShare`, `SharedZone`, `ShareInvitationEvent`, `ParticipantAcceptanceStatus`, `ParticipantPermission`, `ParticipantRole`, `CreateShareOptions`, `DeleteShareOptions`, `PresentSharingOptions`, `FetchParticipantsOptions`, `UpdatePermissionOptions`, `RemoveParticipantOptions`, `AcceptShareOptions`

**New error codes**

- `SYNC_ENGINE_NOT_RUNNING`, `TOKEN_EXPIRED`, `ACCOUNT_CHANGED` — sync lifecycle errors
- `SUBSCRIPTION_NOT_FOUND` — subscription lookup failure
- `ALREADY_SHARED`, `PARTICIPANT_NEEDS_VERIFICATION`, `REFERENCE_VIOLATION`, `SHARE_NOT_FOUND`, `PARTICIPANT_NOT_FOUND`, `SHARING_UI_UNAVAILABLE` — sharing errors

**Config plugin**

- `app.plugin.js` entry point added for `@expo/config-plugins` resolution
- Silent push (APNs background mode entitlement) now added automatically for subscription support

### Fixed

- `queryRecords` cursor-based pagination was non-functional (always returned page 1); now uses an in-memory cursor cache keyed by UUID token
- `PendingRecordChange` replaced with discriminated union to prevent invalid shapes at compile time
- `enqueueSave` race condition in CKSyncEngine adapter resolved
- `CloudKitModuleError` now correctly serializes `code` field to JS via `Exception` subclasses
- `RecordsFetchedEvent` now includes `zoneName: string` field, matching the Swift event payload

## [0.1.0] - 2026-03-07

### Added

**Phase A: Foundation**

- `configure(containerId)` — initialize the module with a CloudKit container identifier
- `getAccountStatus()` — query current iCloud account status
- `addAccountStatusListener(callback)` — subscribe to account status changes
- `createZone(zoneName, database?)` — create a custom CKRecordZone
- `deleteZone(zoneName, database?)` — delete a zone and all its records
- `fetchZones(database?)` — list all custom zones in a database
- `saveRecords(records, database?)` — insert or update CKRecords (up to 400 per call)
- `fetchRecord(recordType, recordId, zoneName?, database?)` — fetch a single record by ID
- `queryRecords(recordType, predicate?, sortDescriptors?, zoneName?, database?, resultsLimit?, cursor?)` — query records with optional filtering and cursor-based pagination
- `deleteRecords(recordIds, database?)` — delete records by identifier
- `fetchRecordZoneChanges(zoneNames, database?)` — delta fetch with server-side change tokens
- `CloudKitError` error class with `CloudKitErrorCode` enum for typed error handling
- Config plugin (`withCloudKit`) that adds iCloud entitlements and background modes
- Full TypeScript type definitions for all Phase A–E API surface
- Example app demonstrating configure, getAccountStatus, createZone, saveRecords, queryRecords

[0.1.0]: https://github.com/atlas-ledger/expo-cloudkit/releases/tag/v0.1.0
[0.2.0]: https://github.com/atlas-ledger/expo-cloudkit/compare/v0.1.0...v0.2.0
[0.3.0]: https://github.com/atlas-ledger/expo-cloudkit/compare/v0.2.0...v0.3.0
[0.4.0]: https://github.com/atlas-ledger/expo-cloudkit/compare/v0.3.0...v0.4.0
[0.5.0]: https://github.com/atlas-ledger/expo-cloudkit/compare/v0.4.0...v0.5.0
[Unreleased]: https://github.com/atlas-ledger/expo-cloudkit/compare/v0.5.0...HEAD
