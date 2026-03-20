# Changelog

All notable changes to `expo-cloudkit` will be documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

---

## [0.16.0] — 2026-03-19

### Added

- **System fields on `CloudKitRecord`** — `creationDate`, `modificationDate` (Unix ms timestamps), `createdByUserRecordID`, `modifiedByUserRecordID` are now included on every record returned by `saveRecords`, `fetchRecord`, `queryRecords`, and `fetchRecordZoneChanges`. Fields are absent (not null) on unsaved records. Date type changed from ISO string to `number` (Unix ms) for consistency with CloudKit JS.
- **`fetchAllZoneChanges(zoneNames, database?)`** — auto-paginates `fetchRecordZoneChanges` until `moreComing` is false, returning a single merged `ZoneChanges` result. Eliminates the manual pagination loop every caller was writing.
- **`useInfiniteQuery(options)`** — React hook for cursor-based infinite scroll over `queryRecords`. Separate `isLoading` / `isFetchingNextPage` states, `hasNextPage` flag, `fetchNextPage()` action.
- **`fetchPrivateDatabaseZones()`** — named alias for `fetchZones('private')`. Symmetric counterpart to `fetchSharedDatabaseZones()` for zone discovery on reinstall or new-device install.
- **`drainOfflineQueueForZone(zoneName, database?)`** — zone-scoped offline queue drain. Flushes only entries belonging to the specified zone, leaving other zones' entries queued. Useful when a single zone's subscription resumes after being offline.
- **`getZoneChangeToken(zoneName, database?)`** — returns the persisted `CKServerChangeToken` for a zone as a base64 string. Use to persist tokens across reinstalls in your own storage.
- **`setZoneChangeToken(zoneName, database?, tokenBase64)`** — seeds a previously-persisted token back on reinstall to avoid a full zone re-fetch. Pass `null` to clear the token and force a full re-sync.

---

## [0.15.0] — 2026-03-19

### Added

- **`isCurrentUser` on `ShareParticipant`** — `CKShare.Participant.isCurrentUser` is now serialized and exposed on every participant object returned by `fetchShareParticipants`, `createShare`, `createZoneShare`, `fetchSharedDatabaseZones`, and sharing UI delegate callbacks. Use this to identify the owner/current user in participant lists without a separate `fetchUserRecordID` call.

### Fixed

- **`stopSyncEngine`** — Task bodies now wrapped in `do/catch`; errors from provider teardown are surfaced as Promise rejections instead of silently hanging. All-scopes stop now runs providers concurrently via `withThrowingTaskGroup` (previously sequential).

---

## [0.14.0] — 2026-03-19

### Added

- **Parallel database scopes in `startSyncEngine`** — `SyncEngineConfig` now accepts `databases?: DatabaseScope | DatabaseScope[]`. Pass `['private', 'shared']` to run one sync engine per scope simultaneously. Independent `CKSyncEngine` (iOS 17+) or fallback adapter (iOS 16) instances per scope with separate change token stores.
- **`databaseScope` on all sync events** — Every `SyncEngineEvent` now includes `databaseScope: DatabaseScope` so listeners can distinguish which engine produced the event.
- **`SyncStateMap` type** — `getSyncState()` returns `Partial<Record<DatabaseScope, SyncState>>` (e.g. `{ private: { status: 'idle' }, shared: { status: 'syncing' } }`).
- **Scoped `stopSyncEngine(database?)`** — optional scope stops just that engine; no argument stops all.
- **Scoped `triggerSync(database?)`** — optional scope targets one engine; no argument fans out.
- **`database?` on `PendingRecordChange`** — route enqueued changes to the correct engine.
- **Conflict routing via `conflictScopeMap`** — O(1) lookup maps `requestId` to scope for correct `resolveSyncConflict` routing.

### Fixed

- **`ChangeTokenStore` scope-qualified CKSyncEngine state key** — latent bug where two engines overwrote each other's serialization in `UserDefaults`. Key is now `expo.cloudkit.<id>.syncEngineState.<scope>`. Existing single-scope users will do a one-time full re-sync on first launch after upgrade.

### Deprecated

- **`SyncEngineConfig.database`** — use `databases` instead. Still works; normalized to `databases: [value]` internally.

---

## [0.13.0] — 2026-03-19

### Added

- **`createZoneShare(zoneName, database?)`** — convenience method that creates a zone-level `CKShare` without requiring a pre-existing anchor record. Internally creates a `_zoneShare` sentinel record, saves it with a new `CKShare`, and presents `UICloudSharingController`. Idempotent: returns the existing share URL if the zone is already shared. Returns `null` on user cancel.
- **`getShareURL(recordName, zoneName, database?)`** — fetches an existing share's URL without re-presenting `UICloudSharingController`. Useful for "Copy invite link" flows. Throws `SHARE_NOT_FOUND` if no share is attached to the record.
- **`syncCompleted` event** — new `SyncEngineEvent` type emitted once after each full zone pull cycle. Payload: `recordCount`, `zoneNames`, `isInitialSync`. Fired by both the iOS 17+ `CKSyncEngine` path and the iOS 16 fallback adapter.
- **`CloudKitErrorCode.SHARE_NOT_FOUND`** — new error code for `getShareURL` when no share is attached to a record.

### Fixed

- **`SyncConflictEvent.serverRecord`** — now typed as `RecordToSave` (was `CloudKitRecord`), eliminating the `as unknown as RecordToSave` double-cast previously required when calling `resolveSyncConflict()`. `clientRecord` updated to match.

---

## [0.12.0] — 2026-03-19

### Added

**Phase J.1 — SwiftUI `@Observable` CloudKitStore**

- `ios/SwiftUI/CloudKitStore.swift` — `@MainActor @Observable CloudKitStore` (iOS 17+) and `CloudKitStoreLegacy: ObservableObject` (iOS 16+) with `fetch`, `save`, `delete`, and `startSync` methods. All errors land in `store.error`; never thrown to the view layer.
- `ios/SwiftUI/CloudKitStoreView.swift` — generic `CloudKitStoreView` and `CloudKitStoreViewLegacy` with loading overlay and dismissible error banner.
- Both variants use `#if canImport(ExpoModulesCore)` guards for SPM compatibility.

**Phase J.2 — Zod schema validation helpers** _(previously released in v0.11.0)_

- `createCloudKitSchema(schema)` — wraps any Zod-compatible schema to parse `CloudKitRecord` field maps into fully typed objects. Extracts `.value` from each field, coerces Unix ms timestamps to `Date`, and passes assets through as-is.
- `CloudKitValidationError` — `CloudKitError` subclass with `zodErrors: unknown[]` field for programmatic error handling.
- `CloudKitErrorCode.VALIDATION_ERROR` added to the error code enum.
- `zod >= 3.0.0` added as an optional peer dependency.

**Phase J.3 — Android / web fallback routing**

- `src/ExpoCloudKit.android.ts` — routes Android to the web (`tsl-apple-cloudkit`) implementation for all supported CloudKit JS functions. Native-only ops (CKSyncEngine, CKShare, push subscriptions) throw `CloudKitNotSupportedError` with a clear message.
- `src/android/auth.ts` — `authenticateAndroid()` opens Apple ID sign-in via `Linking.openURL()` (Custom Tab); `handleAuthRedirect()` parses the OAuth callback URL.
- `CloudKitProvider` auto-calls `configureWeb()` on Android when `webConfig` is provided (same as web).
- Platform support table added to `src/types.ts` module JSDoc: iOS / Web / Android availability for all 55+ exported functions.

**Phase J.4 — Documentation overhaul**

- Complete README restructure with 16 top-level sections in a fixed reading order: Quick Start, Installation, Configuration, What is CloudKit?, Core Concepts, API Reference (14 subsections), Platform Support Matrix, Error Handling, Migration Guide.
- Per-function parameter tables across all 55+ exported functions — each entry includes parameter name, type, default, and description.
- Full Platform Support Matrix with iOS 16 / iOS 17+ / Web / Android columns for every exported function, plus 7 explanatory footnotes for partial-support cases.
- "What is CloudKit?" primer: CKContainer, CKDatabase, CKRecordZone, CKRecord, and CKSyncEngine explained with Firestore/Supabase comparisons for React Native developers.
- Config plugin options table extended with `backgroundSyncTaskIdentifier` (added in 0.11.0).
- Migration Guide table updated through v0.11.0 with all additions since v0.2.0.
- Error Handling section promoted to a top-level section with `CloudKitUnavailableError` and `isNativeModuleAvailable()` usage patterns.
- Long inline code blocks (>20 lines) replaced with "See full example" links to `example/snippets/`: `quick-start.ts`, `sync-engine.ts`, `schema-validation.ts`.

---

## [0.11.0] — 2026-03-19

### Added

**Expo Go graceful fallback**

- `CloudKitUnavailableError` — thrown by all API calls when the native module fails to load (Expo Go, missing dev client). Extends `CloudKitError` with `code: MODULE_UNAVAILABLE` and an actionable message pointing to `npx expo run:ios`.
- `MODULE_UNAVAILABLE` added to `CloudKitErrorCode`.
- `isNativeModuleAvailable(): boolean` — returns `true` only when the native module loaded successfully. Use this to gate CloudKit UI without try/catch. Returns `false` on Expo Go, Android, and web.
- `assertNativeAvailable()` now throws `CloudKitUnavailableError` (instead of `UNKNOWN`) on iOS when the module is absent.

**Swift Package Manager support (experimental)**

- `Package.swift` added at repo root. Pure Swift (non-Expo) projects can consume `CloudKitRecordManager`, `CloudKitZoneManager`, `CloudKitShareManager`, `CloudKitSyncEngine`, and other managers via SPM today.
- `#if canImport(ExpoModulesCore)` guards added to `ExpoCloudKitModule.swift`, `Converters.swift`, and `CloudKitClient.swift` so the package compiles without Expo when ExpoModulesCore is absent.
- `Package.swift` included in the npm tarball via `files` in `package.json`.
- Full SPM support (including the Expo module entry point) is pending ExpoModulesCore adding SPM distribution.
- Expo projects: no changes needed — CocoaPods auto-linking is unchanged.

**Background sync via `BGTaskScheduler`**

- `registerBackgroundSync(taskIdentifier: string): Promise<void>` — registers a `BGAppRefreshTask` handler that calls `triggerSync()` when the system fires the task. Call once at app launch; safe to call before `startSyncEngine()` (the provider is resolved lazily at task-fire time).
- `scheduleBackgroundSync(): Promise<void>` — asks the system to schedule the next refresh as soon as conditions allow (minimum 15 min).
- Config plugin: new optional `backgroundSyncTaskIdentifier` prop. When set, injects the identifier into `BGTaskSchedulerPermittedIdentifiers` and adds `fetch` and `processing` to `UIBackgroundModes` in `Info.plist`.
- Web stubs reject with `CloudKitNotSupportedError` — background tasks are iOS-only.

---

## [0.10.0] — 2026-03-15

### Changed

**Phase H.6 — Swift actor migration for sync adapters**

- `CloudKitSyncEngineAdapter` converted from `class + DispatchQueue` to a Swift `actor`. All mutable state (`pendingSaves`, `pendingDeletes`, `pendingConflicts`, health accumulators, `engine`) is now actor-isolated. The serial `stateQueue` DispatchQueue is removed entirely.
- `CloudKitSyncFallbackAdapter` converted to a Swift `actor`. CloudKit callback bridging uses `withCheckedContinuation` + `@unchecked Sendable` result boxes, eliminating all `DispatchQueue.sync` patterns.
- `CloudKitSyncProtocol` protocol methods (`start`, `stop`, `triggerSync`, `enqueueSave`, `enqueueDelete`, `resumeConflictResolution`) marked `async`; protocol constrained to `Sendable`.
- `CKSyncEngineDelegate` methods annotated `nonisolated` so the system can call them directly; delegate methods `await` back into actor isolation for state mutations.
- `ExpoCloudKitModule.swift` sync call sites wrapped in `Task { await ... }` to bridge the synchronous Expo Modules Core functions to the async actor API.
- Zero `DispatchQueue` usage remains in either sync adapter file.

---

## [0.9.0] — 2026-03-15

### Added

**Phase J.1 — SwiftUI `@Observable` store**

- **`CloudKitStore`** (`ios/SwiftUI/CloudKitStore.swift`) — `@Observable` class (iOS 17+/macOS 14+) wrapping the record manager. Exposes `records`, `isSyncing`, `syncState`, `lastError`, and `pendingConflicts`. Provides `fetch()`, `save()`, `delete()` convenience methods. Automatically updates on sync state change notifications. Guarded by `#if canImport(SwiftUI)`.

**Phase J.2 — Zod / schema validation**

- **`createCloudKitSchema<T>(schema)`** — wraps any Zod-compatible schema (duck-typed `ZodLike<T>`) to parse and validate CloudKit record fields before returning them to callers. No hard `zod` import — works with any library that implements `.parse()` / `.safeParse()`.
- **`CloudKitParser<T>`** interface — returned by `createCloudKitSchema`; exposes `.parseRecord()` and `.safeParseRecord()`.
- **`CloudKitValidationError`** — thrown when schema validation fails; includes `zodErrors: unknown[]` for field-level detail.
- **`VALIDATION_FAILED`** added to `CloudKitErrorCode`.
- **`coerceFields()`** helper — auto-converts epoch-millisecond numbers to `Date` before validation.

**Phase J.3 — Android / web fallback routing**

- **`src/ExpoCloudKit.android.ts`** — Metro platform extension that re-exports all web/CloudKit-JS stubs and adds Android-specific overrides: `resolveSyncConflict` throws `CloudKitNotSupportedError`; `addSyncHealthListener` returns a no-op subscription.
- **`src/android/auth.ts`** — `authenticateAndroid(containerId, options?)` calls `configureWeb` then opens Apple ID sign-in via `Linking.openURL`; `handleAuthRedirect(url)` detects CloudKit auth redirect URLs.
- **`CloudKitProvider`** now auto-calls `configureWeb` on Android (same as web).
- Exports: `authenticateAndroid`, `handleAuthRedirect`.

**Phase J.4 — README overhaul**

- Complete README restructure: Quick Start, Installation, What is CloudKit?, full API Reference (14 subsections), Platform Support Matrix, Migration Guide. ~750 lines replacing the previous incremental additions.
- Example snippets in `example/snippets/`: `quick-start.ts`, `sync-engine.ts`, `schema-validation.ts`.

---

## [0.8.0] — 2026-03-14

### Added

**Phase I.1 — Performance**

- **`batchFetchRecords(recordIDs, database?, desiredKeys?, operationConfig?)`** — fetches multiple records in a single `CKFetchRecordsOperation` network call. Returns `BatchFetchResult[]` with per-record success or error, never throwing on partial failures.
- **`BatchFetchResult`** type — `{ recordName, record?, error? }` discriminated union.
- **Automatic rate-limit retry** — all CloudKit operations (`saveRecords`, `fetchRecord`, `queryRecords`, `deleteRecords`, `fetchRecordZoneChanges`, `batchFetchRecords`) now silently retry up to 3 times on `CKError.requestRateLimited`, `serviceUnavailable`, or `zoneBusy`. Reads `CKErrorRetryAfterKey` (defaults to 5 s) and waits via `Task.sleep` before each retry.
- **`addRateLimitedListener(callback)`** — subscribe to `onRateLimited` events emitted before each automatic retry. Payload: `{ retryAfter, operationName, retryCount }`.
- **`RateLimitedEvent`** type.

**Phase I.2 — Developer Experience**

- **`recoverySuggestion`** property on `CloudKitError` — human-readable recovery hint for common error codes (`NOT_AUTHENTICATED`, `NETWORK_UNAVAILABLE`, `QUOTA_EXCEEDED`, `CONFLICT`, `RATE_LIMITED`, `ASSET_TOO_LARGE`). `undefined` when no guidance applies. All error subclasses inherit it automatically.
- **`RATE_LIMITED`** added to `CloudKitErrorCode` enum.
- **`useCloudKitStatus()`** hook — combines `accountStatus`, `isCloudKitAvailable`, and `isWebAuthenticated` into a single reactive object. Exposes `ready: boolean` shorthand (true when account is available and CloudKit is reachable). Accepts optional `pollInterval` for periodic re-checks.
- **`CloudKitStatus`** and **`UseCloudKitStatusOptions`** types.

**Phase I.3 — Observability**

- **`onSyncHealth` event** — emitted after each sync cycle on both iOS 17+ (CKSyncEngine) and iOS 16 fallback paths. Payload: `{ sentCount, receivedCount, failedCount, durationMs, syncEngine }`.
- **`addSyncHealthListener(callback)`** — subscribe to sync health events.
- **`useSyncHealth()`** hook — reactive sync health state: `lastSyncAt`, `sentCount`, `receivedCount`, `failedCount`, `lastDurationMs`, `isHealthy`, `syncEngine`.
- **`collectMetrics` option in `OperationConfig`** — when `true`, attaches `_metrics: { durationMs, retryCount }` to operation results. For array results, a sentinel record with `recordName: '__metrics__'` is appended.
- **`SyncHealthEvent`**, **`OperationMetrics`**, **`SyncHealthState`** types.

### Fixed

- **Swift CI fully green** — upgraded example app to Expo SDK 53 / `expo-modules-core@2.x`, resolving `AppContext.appCodeSignEntitlements` compile error from `expo-file-system`. Switched `swift-tests` runner from `macos-14` to `macos-15`. Added `super.init()` to Exception subclasses required by Swift 6 / Xcode 16. Removed deleted `CKError.assetFileSizeExceeded` enum case (replaced by `CKErrorBatchRequestFailed` in iOS 18 SDK). Converted `OfflineQueueTests` to `async/await` for Swift 6 actor isolation.

---

## [0.7.0] — 2026-03-12

### Added

**Phase H — CI Hardening, Architecture & API Gaps**

- **Swift tests in CI** — GitHub Actions now runs the full XCTest suite (`ConvertersTests`, `OfflineQueueTests`, `OfflineQueueEntryTests`, `CloudKitNotificationHandlerTests`) on `macos-14` using `expo prebuild` + CocoaPods. Both `ci.yml` (every push/PR) and `publish.yml` (blocks npm release on failure).
- **`deleteRecordWithReferences(recordName, recordType, zoneName?, options?)`** — client-side reference graph delete. Fetches the root record, walks `CKRecord.Reference` fields up to `maxDepth` levels (1–3), and deletes the entire collected set in one batched `CKModifyRecordsOperation`. Returns the array of deleted record names.
- **`DeleteRecordWithReferencesOptions`** type — `{ maxDepth?: 1 | 2 | 3, database?: DatabaseScope }`.
- **`createCloudKitClient(containerId): Promise<CloudKitClient>`** — creates an isolated CloudKit client bound to a specific container, independent of the module-level singleton. Supports `saveRecords`, `queryRecords`, `deleteRecords`, and `destroy()`. Enables apps with multiple CloudKit containers to operate them concurrently without state conflicts.
- **`CloudKitClient`** interface — public type for the multi-container client object.
- **Cursor persistence** — `queryRecords` now accepts `persistCursor?: boolean` (default `false`). When `true`, cursors are serialized via `NSKeyedArchiver` to `UserDefaults` and survive app restarts. Pass a previously-returned cursor token on the next call to resume pagination from where you left off across sessions.
- **`clearPersistedCursors(): Promise<void>`** — removes all persisted cursor data from device storage.

### Changed

- **`OfflineQueue` migrated to Swift actor** — mutable state (`entries`, `isDraining`, debounce task) is now actor-isolated. NWPathMonitor callbacks re-enter actor isolation via `Task { await self.handlePathUpdate(...) }`. Timer-based retry replaced with `Task.sleep`. Eliminates all `DispatchQueue.sync` usage in `OfflineQueue.swift`.
- **`CloudKitSyncEngine` and `CloudKitSyncFallback` queue hardening** — `pendingQueue` renamed to `stateQueue` with explicit `.userInitiated` QoS. Full actor migration deferred until `CKSyncEngineDelegate.handleEvent` async/actor interaction patterns are resolved without deadlock risk.

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
