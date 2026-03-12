# Changelog

All notable changes to `expo-cloudkit` will be documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

---

## [0.6.0] — 2026-03-11

### Added

**Phase G — Polish, Performance & DX**

- **`desiredKeys` on fetch operations** — `fetchRecord`, `queryRecords`, and `fetchRecordZoneChanges` now accept an optional `desiredKeys?: string[]` parameter that passes through to the underlying `CKOperation`, avoiding over-fetching of unused fields. Web: passed to CloudKit JS query/fetch options.
- **`fetchUserRecordID(): Promise<string>`** — returns the current iCloud user's record name. Previously documented as complete but not implemented. On web, delegates to `fetchCurrentUserIdentity()` / `fetchUserRecordName()` in CloudKit JS.
- **`OperationConfig` type** — new `operationConfig?: OperationConfig` optional parameter on `saveRecords`, `deleteRecords`, `fetchRecord`, `queryRecords`, and `fetchRecordZoneChanges`. Controls `qualityOfService` (`'userInitiated' | 'utility' | 'background' | 'default'`) and `timeout` (seconds) for the underlying `CKOperation`. Default behavior (`.userInitiated`, no timeout) is unchanged when omitted.
- **Custom conflict resolution in `CKSyncEngine`** — set `resolveConflicts: true` in `startSyncEngine` options to opt into manual conflict handling. The module emits `onSyncConflict` events with `{ requestId, clientRecord, serverRecord }`; call `resolveSyncConflict(requestId, mergedRecord)` (or `resolveSyncConflict(requestId, null)` to accept the server version). When `resolveConflicts` is false (default), server-record-wins behavior is unchanged.
- **`resolveSyncConflict(requestId, resolvedRecord | null): void`** — new exported function to complete a pending conflict resolution.
- **`SyncConflictEvent`** — new variant in the `SyncEngineEvent` discriminated union (`type: 'conflict'`).
- **XCTest: `CloudKitNotificationHandlerTests`** — 8 new offline test cases covering query (created/updated/deleted), database subscription, empty/non-CloudKit payloads, `recordID` extraction, and `subscriptionID` forwarding.
- **XCTest: `ConvertersTests` expanded** — 11 new cases: `toCKRecord` round-trips for date, location, stringList, and numberList fields; `toExpoError` coverage for `serverRecordChanged`→`CONFLICT`, `limitExceeded`→`LIMIT_EXCEEDED`, `assetFileTooBig`→`ASSET_TOO_LARGE`, `operationCancelled`→`UNKNOWN`; `toDictionary` reference field type/action coverage.
- **Example app Phase D section** — `CloudKitProvider` wraps the app; `useAccountStatus`, optimistic update demo (`update()`, `optimisticAdd`, `optimisticRemove`), `useCloudKitSubscription` demo added to `example/App.tsx`.

---

## [0.5.3] — 2026-03-11

### Fixed

- **Config plugin**: `com.apple.developer.icloud-container-environment` was written as an array (`['Development', 'Production']`) instead of the string Xcode requires. Now reads `iCloudContainerEnvironment` from plugin options (default: `'Production'`) and writes it as a plain string.
- **CloudKitProvider (web)**: `getAccountStatus()` was called before `configureWeb()` finished, always returning `'couldNotDetermine'` on web. Provider now awaits `configureWeb()` before fetching account status.
- **`authenticateWeb()`**: After `setUpAuth()` returns `null` (user not signed in), now calls `whenUserSignsIn()` to properly await the CloudKit JS sign-in flow instead of returning `'noAccount'` immediately.
- **example-web**: Fixed Metro bundler 404 — parent `.gitignore` includes `node_modules/` which caused Watchman to skip `example-web/node_modules/`; set `resolver.useWatchman = false` to use Node.js crawler instead.
- **example-web**: Removed duplicate "Sign in with Apple" button (rendered by both `AccountBanner` and `index.tsx`).

---

## [0.5.2] — 2026-03-10

### Added

- 186 unit tests for the web layer across 5 new test suites in `src/__tests__/web/`:
  `errors.test.ts` (35 cases), `converters.test.ts` (52 cases), `auth.test.ts` (24 cases),
  `database.test.ts` (6 cases), `ExpoCloudKitWeb.test.ts` (48 cases, including listener
  functional tests, stub rejection assertions, `configureWeb`/`authenticateWeb` integration,
  and `requireContainer` guard via `jest.isolateModulesAsync`)
- Total test suite grows from 41 to 227 passing tests

### Fixed

- Corrected misleading test name in `ExpoCloudKitWeb.test.ts` (`authenticateWeb` rejection
  handling test was titled "throws when called before configureWeb")
- Plugged auth listener state leak in `auth.test.ts`: orphaned `jest.fn()` listeners now
  auto-unsubscribed via `afterEach` using a `trackedSubscribe` helper

---

## [0.5.1] — 2026-03-10

### Fixed

- Mac Catalyst support via `#if canImport(UIKit)` conditional compilation guards throughout the Swift layer
- `UIApplication.didBecomeActiveNotification` replaced with `NSApplication.didBecomeActiveNotification` on AppKit targets in `OfflineQueue`
- `presentSharingUI()` now throws `CloudKitNotSupportedError` on macOS native (no `UICloudSharingController` equivalent on AppKit)
- `@available(iOS 17, macOS 14, *)` availability annotations added to the CKSyncEngine adapter and `CKSyncEngineDelegate` protocol conformance

> No TypeScript or public API changes — this is a purely a Swift build fix for Mac Catalyst targets.

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
