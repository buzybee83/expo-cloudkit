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

## Phase F — Platform Expansion (complete)

- [x] Mac Catalyst support — UIKit conditional compilation guards
- [x] Test coverage for web layer (src/web/*.ts)
- [x] Web example app (Expo Router)

## Phase G — Polish, Performance & DX

### G.1 — `desiredKeys` support on fetch operations
_Effort: M (Swift + TypeScript + web layer) | Agent: ios-native-dev + ts-sdk-dev (parallel)_

Add an optional `desiredKeys?: string[]` parameter to `fetchRecord`, `queryRecords`, and `fetchRecordZoneChanges`. CloudKit recommends specifying desired keys to avoid over-fetching fields the caller does not need. The codebase's own CLAUDE.md mandates this but no operation currently implements it.

- [x] **Swift**: Add `desiredKeys: [String]?` parameter to `CloudKitRecordManager.fetchRecord()` — use `CKFetchRecordsOperation` (instead of convenience `db.fetch(withRecordID:)`) to set `operation.desiredKeys`
- [x] **Swift**: Add `desiredKeys: [CKRecord.FieldKey]?` to `CloudKitRecordManager.queryRecords()` — set `operation.desiredKeys` on the `CKQueryOperation`
- [x] **Swift**: Add `desiredKeys` to `CloudKitRecordManager.fetchRecordZoneChanges()` — set on `ZoneConfiguration`
- [x] **Swift**: Wire `desiredKeys` through `ExpoCloudKitModule.swift` AsyncFunction params for all three operations
- [x] **TypeScript**: Add `desiredKeys?: string[]` to `fetchRecord`, `queryRecords`, `fetchRecordZoneChanges` function signatures and corresponding options types in `src/types.ts`
- [x] **Web**: Pass `desiredKeys` through to CloudKit JS `query()` and `fetch()` calls in `src/ExpoCloudKit.web.ts`

_Done when_: Calling `fetchRecord('MyType', 'id', { desiredKeys: ['title'] })` returns a record with only the `title` field populated. All three operations pass `desiredKeys` to their underlying CKOperation.

### G.2 — `fetchUserRecordID()` JS API
_Effort: S (Swift + TypeScript) | Agent: ios-native-dev + ts-sdk-dev (parallel)_

Phase A ROADMAP marks `fetchUserRecordID()` as complete, but the function does not exist in `ExpoCloudKitModule.swift` or the TypeScript layer. Only `accountStatus()` was implemented in `CloudKitContainer.swift`.

- [x] **Swift**: Add `fetchUserRecordID()` AsyncFunction in `ExpoCloudKitModule.swift` — calls `ckContainer.fetchUserRecordID()`, returns the `recordName` string
- [x] **TypeScript**: Export `fetchUserRecordID(): Promise<string>` from `src/index.ts`
- [x] **Web**: Implement via CloudKit JS `fetchCurrentUserIdentity()` in `src/ExpoCloudKit.web.ts`

_Done when_: `const userRecordName = await fetchUserRecordID()` returns the current user's record name on iOS and web.

### G.3 — `CKOperationConfiguration` — QoS and timeout settings
_Effort: M (Swift + TypeScript) | Agent: ios-native-dev + ts-sdk-dev (parallel)_

All CK operations currently hardcode `.userInitiated` QoS. Background sync, bulk imports, and non-interactive prefetches should use `.utility` or `.background`. Expose `qualityOfService` and `timeoutIntervalForRequest` as optional parameters.

- [x] **TypeScript**: Define `OperationConfig` type in `src/types.ts` — `{ qos?: 'userInitiated' | 'utility' | 'background' | 'default'; timeout?: number }`
- [x] **TypeScript**: Add optional `operationConfig?: OperationConfig` to `fetchRecord`, `queryRecords`, `saveRecords`, `deleteRecords`, `fetchRecordZoneChanges`
- [x] **Swift**: Create helper `applyConfig(_ config: [String: Any]?, to operation: CKOperation)` in `CloudKitRecordManager.swift` that maps JS QoS strings to `QualityOfService` and sets `timeoutIntervalForRequest`
- [x] **Swift**: Call `applyConfig` in all operation-dispatching methods
- [x] **Swift**: Wire config dict through `ExpoCloudKitModule.swift` AsyncFunction params

_Done when_: `saveRecords(records, { operationConfig: { qos: 'background', timeout: 30 } })` dispatches with `.background` QoS and 30s timeout. Default behavior (`.userInitiated`, no timeout override) is unchanged when `operationConfig` is omitted.

### G.4 — Expo dev menu integration for `__debug*` methods
_Effort: S (Swift config plugin) | Agent: ios-native-dev_

Surface the four existing `__debug*` functions (dumpContainerInfo, listZones, fetchRawRecord, clearZone) in the Expo developer menu (shake gesture / three-finger long press). Only active in `__DEV__` builds.

- [x] **Swift**: `DevMenuExtensionProtocol` not available in expo-modules-core; implemented `#if DEBUG` startup banner listing all `__debug*` methods + `debugMenuAvailable: false` constant
- [x] **Swift**: Debug-only `OnCreate` block stripped in release builds via `#if DEBUG`
- [x] **TypeScript**: No changes required (existing `__debug*` exports remain)

_Done when_: Shaking the device in a dev build shows "CloudKit" section with at least "Dump Container Info" and "List All Zones". Tapping them logs output to the Expo dev console.

### G.5 — XCTest for `CloudKitNotificationHandler.swift`
_Effort: S (Swift only) | Agent: ios-native-dev_

The notification handler parses APNs `userInfo` dictionaries into typed subscription events. This logic is pure data transformation and testable offline without network calls.

- [x] **Swift**: Added `ios/Tests/CloudKitNotificationHandlerTests.swift` — 8 test cases covering query (created/updated/deleted), database, empty, non-CloudKit, recordID extraction, and subscriptionID forwarding
- [x] **Swift**: Edge-case payloads handled; tests use `XCTSkip` when simulator lacks CloudKit entitlements

_Done when_: `xcodebuild test` passes with at least 5 new test cases covering query, database, and edge-case notification payloads.

### G.6 — Custom conflict resolution callback in CKSyncEngine
_Effort: M (Swift + TypeScript) | Agent: ios-native-dev + ts-sdk-dev (sequential — Swift first)_

Currently `resolveConflict()` in both `CloudKitSyncEngine.swift` and `CloudKitSyncFallback.swift` hardcodes server-record-wins with client changed-keys overlay. The `RecordsSentEvent.failedRecords` already surfaces `serverRecord` for CONFLICT errors, so JS consumers can react after the fact. This phase adds a pre-save callback so JS can provide a merged record before the engine re-enqueues.

- [x] **TypeScript**: Added `resolveConflicts?: boolean` to `SyncEngineConfig`; new `SyncConflictEvent` type in `SyncEngineEvent` union; `resolveSyncConflict(requestId, resolvedRecord | null)` exported
- [x] **Swift**: `conflictResolutionEnabled` flag on both `CloudKitSyncEngineAdapter` and `CloudKitSyncFallbackAdapter`; `pendingConflicts` dict with `CheckedContinuation` per requestId; `stop()` drains pending continuations safely
- [x] **Swift**: `onSyncConflict` event emitted with `requestId`, `clientRecord`, `serverRecord`; `resolveSyncConflict` AsyncFunction resumes the waiting continuation
- [x] **TypeScript**: JSDoc documents hang risk — caller must always call `resolveSyncConflict` for every emitted conflict

_Done when_: Setting `onConflict` in `startSyncEngine({ zones: ['z'], onConflict: (c, s) => mergedRecord })` invokes the callback on conflict and enqueues the returned record. Omitting `onConflict` preserves the existing server-record-wins behavior.

---

### Batch Execution Plan

#### Batch 1 (parallel — no dependencies)
| Phase | Goal | Agent(s) | Effort |
|-------|------|----------|--------|
| G.1 | `desiredKeys` on fetch operations | ios-native-dev + ts-sdk-dev | M |
| G.2 | `fetchUserRecordID()` JS API | ios-native-dev + ts-sdk-dev | S |
| G.5 | XCTest for NotificationHandler | ios-native-dev | S |

#### Batch 2 (parallel — no dependencies on Batch 1)
| Phase | Goal | Agent(s) | Effort |
|-------|------|----------|--------|
| G.3 | QoS + timeout settings | ios-native-dev + ts-sdk-dev | M |
| G.4 | Expo dev menu integration | ios-native-dev | S |

#### Batch 3 (after Batch 1 — depends on G.1 patterns for operation config threading)
| Phase | Goal | Agent(s) | Effort |
|-------|------|----------|--------|
| G.6 | Custom conflict resolution callback | ios-native-dev, then ts-sdk-dev | M |

### Priority & Rationale

**Start with G.1 + G.2 + G.5 (Batch 1).**

- **G.1 (`desiredKeys`)** is the highest-impact item: it directly improves network performance for every app using the module, the codebase's own guidelines already require it, and it touches foundational fetch paths that downstream features (G.3 QoS) will also modify.
- **G.2 (`fetchUserRecordID`)** is the lowest-risk item: a single CloudKit API call, no architectural decisions, fixes a documented gap. Ships a working API in under an hour.
- **G.5 (NotificationHandler tests)** is pure additive test coverage with zero risk to existing code. Runs in parallel with no conflicts.

## Phase H — CI Hardening, Architecture & API Gaps

### H.1 — Swift tests in CI
_Effort: S (CI config only) | Agent: devops_

The XCTest suite (5 test files: `ConvertersTests`, `OfflineQueueTests`, `OfflineQueueEntryTests`, `CloudKitNotificationHandlerTests`, `ExpoCloudKitTestSuite`) runs manually via `xcodebuild test` but is not part of the GitHub Actions CI pipeline. The existing CI workflow (`.github/workflows/ci.yml`) runs on `ubuntu-latest` and only executes TypeScript typecheck, lint, Jest tests, and build. Swift tests require `macos-latest` with Xcode.

- [x] **CI**: Add a new `swift-tests` job to `.github/workflows/ci.yml` using `runs-on: macos-latest` (or `macos-14` for Apple Silicon)
- [x] **CI**: Install Expo module dependencies — run `pod install` or use the example app's Xcode workspace if a standalone workspace does not exist
- [x] **CI**: Execute `xcodebuild test` with `-destination "platform=iOS Simulator,name=iPhone 15"` targeting the test scheme
- [x] **CI**: Ensure the job runs on both `push` to `main` and `pull_request` targeting `main`, matching existing triggers
- [x] **CI**: Add the `swift-tests` job to the `publish.yml` `validate` stage so Swift regressions block releases

_Risks_: The Expo module may not have a standalone `xcworkspace` — the test target may only build inside the example app's Pods workspace. If so, the CI job must `cd example && pod install` first, adding ~2 min to CI. macOS runners are slower and more expensive than Ubuntu; consider making the Swift job a separate workflow or allowing it to run in parallel with the existing `check` job.

_Done when_: A PR that breaks a Swift test (e.g., renaming a `Converters` method without updating `ConvertersTests`) fails CI with a clear `xcodebuild test` error.

### H.2 — Example app coverage for Phase G APIs
_Effort: S (TypeScript only) | Agent: ts-sdk-dev_

`example/App.tsx` demonstrates Phases A through C but does not exercise `desiredKeys`, `OperationConfig`, or `resolveSyncConflict` from Phase G. These are the most user-facing new APIs and need working example code for adoption.

- [x] **Example**: Add a "Fetch with desiredKeys" demo section — call `fetchRecord(type, id, { desiredKeys: ['title'] })` and display which fields are returned vs omitted
- [x] **Example**: Add an "Operation Config" demo — call `queryRecords` with `{ operationConfig: { qos: 'utility', timeout: 15 } }` and log the QoS used
- [x] **Example**: Add a "Conflict Resolution" demo — start sync with `resolveConflicts: true`, display emitted `SyncConflictEvent` payloads, and call `resolveSyncConflict` with a merged record
- [x] **Example**: Update the file header comment to list Phase G coverage

_Done when_: `cd example && npx expo run:ios` shows working UI for `desiredKeys` filtering, QoS configuration, and conflict resolution flow. No new TypeScript errors.

### H.3 — Multi-container support (`CloudKitClient` instance API)
_Effort: M (Swift + TypeScript) | Agent: ios-native-dev + ts-sdk-dev (parallel)_

`configure()` initializes a single global `CKContainer`. Apps with multiple containers (e.g., personal + team) must call `configure()` repeatedly, risking state conflicts in the singleton `CloudKitRecordManager`, `CloudKitSyncEngine`, and `OfflineQueue`. This phase adds an instance-based `CloudKitClient` API as an alternative to module-level singleton functions.

- [ ] **Swift**: Create `CloudKitClient.swift` — a class holding its own `CKContainer`, `CloudKitRecordManager`, `CloudKitZoneManager`, `CloudKitShareManager`, and `OfflineQueue` instances. Constructor takes `containerIdentifier: String`
- [ ] **Swift**: Add `createClient(containerIdentifier: String) -> String` AsyncFunction in `ExpoCloudKitModule.swift` — returns a client ID (UUID); store in a `[String: CloudKitClient]` dict
- [ ] **Swift**: Add `clientRecordManager`-style overloads for core operations (`saveRecords`, `queryRecords`, `deleteRecords`, `fetchRecord`) that accept a `clientId` parameter and route to the correct `CloudKitClient` instance
- [ ] **Swift**: Add `destroyClient(clientId: String)` to tear down and deregister a client
- [ ] **TypeScript**: Export `createCloudKitClient(containerId: string): Promise<CloudKitClient>` returning an object with bound methods (`client.saveRecords(...)`, `client.queryRecords(...)`, etc.)
- [ ] **TypeScript**: Add `CloudKitClient` interface to `src/types.ts`
- [ ] **Web**: Implement `createCloudKitClient` by calling `CloudKit.configure()` with a second container config and returning scoped wrapper functions

_Risks_: The `OfflineQueue` currently persists to a single `UserDefaults` key. Multi-container needs per-container keys. `CKSyncEngine` (iOS 17+) is initialized per-container — multiple engines may compete for system resources.

_Done when_: Two `CloudKitClient` instances targeting different containers can save and query records independently without cross-contamination. Destroying a client cleans up its resources.

### H.4 — `CKRecord.Reference` cascade delete option
_Effort: S (Swift + TypeScript) | Agent: ios-native-dev + ts-sdk-dev (parallel)_

`deleteRecords` currently uses `CKModifyRecordsOperation` with no reference-action awareness. The `Converters.swift` layer already parses `action: "deleteSelf"` when creating references, but callers cannot trigger cascade deletes through reference graphs. This phase adds a `referenceAction` option to `deleteRecords`.

- [x] **Swift**: Add `referenceAction: String?` parameter to `CloudKitRecordManager.deleteRecords()` — when set to `"deleteSelf"`, fetch each record before deletion and verify its reference graph (note: `CKModifyRecordsOperation` delete-by-ID does not automatically cascade; cascade is a property of the reference on the *referencing* record, not a delete-time option)
- [x] **Swift**: Alternatively, document that cascade delete is a reference-creation concern (already handled via `action: "deleteSelf"` in `Converters.toCloudKitValue`) and add a `deleteRecordWithReferences(recordName:, depth: Int)` function that fetches the record, walks its reference fields, and deletes the graph
- [x] **TypeScript**: Export `deleteRecordWithReferences(recordName: string, options?: { maxDepth?: number, database?: DatabaseScope })` in `src/index.ts`
- [x] **TypeScript**: Add JSDoc warning about potential CloudKit rate limits when deleting large reference graphs

_Risks_: CloudKit's `.deleteSelf` action is enforced server-side when the *parent* record is deleted, but only for references created with that action. A client-side graph walk adds N+1 fetch overhead and risk of partial failure. This feature should carry a "use at your own risk" warning for deep graphs.

_Done when_: `deleteRecordWithReferences('parentRecord', { maxDepth: 2 })` deletes the target record and all records it references (up to depth 2). Records referenced with `.none` action are not cascade-deleted.

### H.5 — Cursor persistence across app restarts
_Effort: S (Swift + TypeScript) | Agent: ios-native-dev + ts-sdk-dev (parallel)_

`queryRecords` stores `CKQueryOperation.Cursor` objects in an in-memory dictionary (`cursorCache` / `cursorStore`). App restart clears all cursors, forcing callers to re-query from page 1. `CKQueryOperation.Cursor` conforms to `NSSecureCoding`, so it can be serialized to `Data` and persisted.

- [ ] **Swift**: Add `persistCursor(_ cursor: CKQueryOperation.Cursor, forToken token: String)` and `loadCursor(forToken token: String) -> CKQueryOperation.Cursor?` to `CloudKitRecordManager.swift` — serialize via `NSKeyedArchiver` to `UserDefaults` (keyed `expo.cloudkit.cursors.<token>`)
- [ ] **Swift**: On `queryRecords` call, if a cursor token is provided but not in-memory, attempt to load from `UserDefaults` before returning "cursor not found"
- [ ] **Swift**: Add `clearPersistedCursors()` function to flush all stored cursor data
- [ ] **TypeScript**: Add `persistCursor?: boolean` option to `queryRecords` options (default `false` to preserve current behavior)
- [ ] **TypeScript**: Export `clearPersistedCursors(): Promise<void>`

_Risks_: `CKQueryOperation.Cursor` may not be safely deserializable across app version upgrades or CloudKit schema changes — a corrupted cursor produces a `CKError`. The implementation must catch deserialization failures and fall back to "cursor not found." Stored cursors should have a TTL or be version-stamped.

_Done when_: `queryRecords(type, predicate, { limit: 10, persistCursor: true })` returns a cursor token. After force-quitting and restarting the app, passing that token to a subsequent `queryRecords` call resumes pagination from page 2 (not page 1).

### H.6 — Swift actor migration for sync adapters
_Effort: M (Swift only) | Agent: ios-native-dev_

`CloudKitSyncEngine.swift` (352 lines) and `CloudKitSyncFallback.swift` (434 lines) protect shared mutable state (`pendingConflicts`, configuration) with a serial `DispatchQueue`. `OfflineQueue.swift` (426 lines) uses two `DispatchQueue`s. Swift actors (available since Swift 5.5, iOS 15+) provide compile-time data-race safety and are the modern replacement. Since the module targets iOS 16+, actors are available on all supported versions.

- [x] **Swift**: Convert `CloudKitSyncEngineAdapter` from class + `DispatchQueue` to `actor` — move `pendingConflicts`, `syncEngine`, `configuration` into actor-isolated state
- [x] **Swift**: Convert `CloudKitSyncFallbackAdapter` from class + `DispatchQueue` to `actor`
- [x] **Swift**: Convert `OfflineQueue` from class + two `DispatchQueue`s to `actor` _(already an actor since Phase H — no change needed)_
- [x] **Swift**: Update `ExpoCloudKitModule.swift` call sites to use `await` for actor-isolated method calls
- [x] **Swift**: Ensure `CKSyncEngineDelegate` protocol conformance works with actor isolation (`nonisolated` annotations on `handleEvent` and `nextRecordZoneChangeBatch`)
- [ ] **Swift**: Run all existing XCTests — they must continue to pass with the actor-based implementations
- [x] **Swift**: Verify no `DispatchQueue.main.async` calls remain in migrated files (replaced with `Task { @MainActor in ... }` or `Task { await self.emit(...) }` dispatch)

_Risks_: `CKSyncEngineDelegate` methods are called by the system on arbitrary threads. Actor re-entrancy and `nonisolated` annotations add complexity. The `ExpoModulesCore` event system (`sendEvent`) may require `@MainActor` dispatch, which interacts with actor isolation. `OfflineQueue`'s timer-based retry uses `DispatchQueue.global().asyncAfter` which needs reworking for actor context. This is the highest-risk phase in H and should not be parallelized with other Swift work.

_Done when_: Zero `DispatchQueue` usage remains in `CloudKitSyncEngine.swift`, `CloudKitSyncFallback.swift`, and `OfflineQueue.swift`. All existing XCTests pass. `swift build` produces no data-race warnings with strict concurrency checking enabled.

---

### Batch Execution Plan

#### Batch 1 (parallel — no dependencies)
| Phase | Goal | Agent(s) | Effort |
|-------|------|----------|--------|
| H.1 | Swift tests in CI | devops | S |
| H.2 | Example app for Phase G APIs | ts-sdk-dev | S |
| H.4 | Reference cascade delete | ios-native-dev + ts-sdk-dev | S |

#### Batch 2 (parallel — no dependencies on Batch 1)
| Phase | Goal | Agent(s) | Effort |
|-------|------|----------|--------|
| H.3 | Multi-container support | ios-native-dev + ts-sdk-dev | M |
| H.5 | Cursor persistence | ios-native-dev + ts-sdk-dev | S |

#### Batch 3 (after Batch 1 H.1 — requires CI Swift tests green before refactoring)
| Phase | Goal | Agent(s) | Effort |
|-------|------|----------|--------|
| H.6 | Swift actor migration | ios-native-dev | M |

### Priority & Rationale

**Start with H.1 + H.2 + H.4 (Batch 1).**

- **H.1 (Swift tests in CI)** is the highest-leverage infrastructure item: without it, every subsequent Swift change (including H.6 actor migration) ships without automated regression checks. Low effort, high ongoing value.
- **H.2 (Example app for Phase G)** is pure documentation value with zero risk. Phase G shipped three significant APIs (`desiredKeys`, `OperationConfig`, `resolveSyncConflict`) with no example code — this is the most visible gap for new adopters.
- **H.4 (Reference cascade delete)** is a small, self-contained API addition that completes the reference management story started in Phase C.

**Batch 2 (H.3 + H.5)** delivers the two API-gap features. Multi-container (H.3) is the most architecturally significant item in Phase H — it introduces a second code path for all core operations — but it is additive and does not modify existing singleton behavior. Cursor persistence (H.5) is a quick win that solves a real usability problem.

**Batch 3 (H.6) runs last and alone.** Actor migration is the highest-risk item: it rewrites concurrency primitives in three core files totaling 1,200+ lines. It must run after H.1 lands so that CI catches any regressions automatically. It must not overlap with H.3 or H.4 which also touch Swift files.

---

## Phase I — Performance, DX, Observability & Integration Testing

### I.1 — Performance
_Effort: M (Swift + TypeScript) | Agent: ios-native-dev + ts-sdk-dev (parallel)_

Reduce network overhead and improve throughput for high-volume use cases.

- [ ] **Swift**: Batch `CKFetchRecordsOperation` — when `fetchRecord` is called in rapid succession for multiple IDs, coalesce into a single operation within a configurable debounce window (default 50ms)
- [ ] **Swift**: Automatic CloudKit rate-limit retry — detect `CKError.requestRateLimited` / `CKError.serviceUnavailable`, read `retryAfterSeconds` from `userInfo`, and re-enqueue after the indicated delay instead of surfacing the error to JS
- [ ] **Swift**: Push notification token refresh — on `CKError.notAuthenticated` after a previously successful session, attempt one silent `accountStatus()` check and re-register subscriptions automatically
- [ ] **TypeScript**: Expose a `batchFetchRecords(ids: string[], options?)` function that maps to the coalesced Swift operation, returning a `Record<string, CloudKitRecord>` map
- [ ] **TypeScript**: Add `onRateLimited?: (retryAfter: number) => void` callback to `OperationConfig` so callers can display a "syncing paused" indicator

_Done when_: Fetching 50 records in a loop generates a single `CKFetchRecordsOperation` network call. A rate-limited operation retries transparently without surfacing an error to JS unless the retry itself fails.

---

### I.2 — DX (Developer Experience)
_Effort: M (Swift + TypeScript) | Agent: ios-native-dev + ts-sdk-dev (parallel)_

Make the module easier to adopt and debug, especially for developers new to CloudKit.

- [ ] **Swift**: Structured error recovery suggestions — augment `ExpoModulesCore.Exception` subclasses with a `recoverySuggestion: String` property that maps each `CKError.Code` to an actionable message (e.g., `notAuthenticated` → "Open Settings → iCloud and sign in")
- [ ] **TypeScript**: Surface `recoverySuggestion` on all typed error classes in `src/errors.ts` (`.recoverySuggestion: string | undefined`)
- [ ] **Swift**: SwiftUI-compatible `@Observable` wrapper — a `CloudKitStore` class (iOS 17+) conforming to `@Observable` that wraps `useCloudKitRecord`-equivalent logic for pure SwiftUI apps that embed this module via Swift Package Manager in the future
- [ ] **TypeScript**: `useCloudKitStatus()` hook — combines `accountStatus`, `isCloudKitAvailable`, and `isWebAuthenticated` into a single reactive object with a `ready: boolean` shorthand
- [ ] **TypeScript**: Zod schema integration helpers — `cloudKitRecordToZod(schema)` utility that validates a `CloudKitRecord.fields` object against a caller-supplied Zod schema and returns typed fields

_Done when_: A `CloudKitNotAuthenticatedError` thrown from any operation includes `.recoverySuggestion = "Open Settings → iCloud and sign in"`. `useCloudKitStatus()` returns `{ ready: true }` when the user is signed in and the container is reachable.

---

### I.3 — Observability
_Effort: S (Swift + TypeScript) | Agent: ios-native-dev + ts-sdk-dev (parallel)_

Surface CloudKit quota, sync health, and operation telemetry so app developers can build status UIs and alert on degraded states.

- [ ] **Swift**: `fetchContainerQuota()` — call `CKContainer.accountStatus` + `CKDatabase.fetchAllRecordZones` and aggregate approximate zone record counts; return `{ zonesUsed: number, estimatedRecordCount: number }` (CloudKit does not expose byte quotas directly via CKOperation)
- [ ] **Swift**: Sync health event — emit `onSyncHealth` event after each sync cycle with `{ sentCount, receivedCount, failedCount, durationMs, syncEngine: boolean }`
- [ ] **Swift**: Per-operation timing — when `OperationConfig.collectMetrics` is `true`, attach a `_metrics: { durationMs: number, retryCount: number }` field to the operation's resolved value
- [ ] **TypeScript**: `useSyncHealth()` hook — subscribes to `onSyncHealth` events and exposes `{ lastSyncAt, sentCount, receivedCount, failedCount, isHealthy }` state
- [ ] **TypeScript**: Add `collectMetrics?: boolean` to `OperationConfig`; add `_metrics?` field to all operation return types

_Done when_: After a sync cycle, `useSyncHealth()` updates with the sent/received/failed counts and timestamp. A fetch with `collectMetrics: true` returns `record._metrics.durationMs` alongside the record data.

---

### I.4 — Integration Testing
_Effort: L (Swift + TypeScript + CI) | Agent: qa-tester + ios-native-dev (sequential)_

Add a sandboxed end-to-end test suite that exercises real CloudKit network calls in a dedicated development container. These tests run in CI on a schedule (not on every PR) to avoid blocking fast iteration.

- [ ] **CI**: Add a `integration-tests` GitHub Actions workflow (`on: schedule: - cron: '0 4 * * *'`) running on `macos-15`; requires `CK_CONTAINER_ID` and `CK_API_TOKEN` secrets
- [ ] **Swift**: `ios/IntegrationTests/` directory — XCTest classes that call real CloudKit APIs against a `iCloud.com.expo.cloudkit.sandbox` container; skip if `CK_API_TOKEN` env var is absent
- [ ] **Swift**: Integration test coverage: `accountStatus`, `createZone`, `saveRecords`, `queryRecords`, `fetchRecord`, `deleteRecords`, `deleteZone` — verify round-trip field fidelity for all field types (String, Number, Date, Asset, Location, Data, Reference)
- [ ] **TypeScript**: `src/__tests__/integration/` — Jest tests using the web platform (`ExpoCloudKit.web.ts`) against the same sandbox container; run with `CLOUDKIT_INTEGRATION=1 jest`
- [ ] **Docs**: Add "Setting up a sandbox container" section to README explaining how to create the development container in CloudKit Dashboard and configure the CI secrets

_Done when_: `gh workflow run integration-tests.yml` exercises real CloudKit round-trips and reports pass/fail per field type. PRs are not blocked by integration tests. A failed scheduled run creates a GitHub issue automatically.

---

### Batch Execution Plan

#### Batch 1 (parallel — no dependencies)
| Phase | Goal | Agent(s) | Effort |
|-------|------|----------|--------|
| I.1 | Performance (batching, rate-limit retry) | ios-native-dev + ts-sdk-dev | M |
| I.2 | DX (error recovery, hooks, Zod) | ios-native-dev + ts-sdk-dev | M |
| I.3 | Observability (quota, sync health, metrics) | ios-native-dev + ts-sdk-dev | S |

#### Batch 2 (after Batch 1 — integration tests need stable APIs)
| Phase | Goal | Agent(s) | Effort |
|-------|------|----------|--------|
| I.4 | Integration testing (sandbox CI) | qa-tester + ios-native-dev | L |

### Priority & Rationale

**Start with I.1 + I.2 + I.3 (parallel).** All three are additive — they do not modify existing code paths, only add new capabilities and surface new data. I.3 is the smallest and can ship independently. I.2 DX improvements are the most visible to adopters.

**I.4 (integration tests) runs last** because it requires a real CloudKit container, secrets setup, and a scheduled workflow. It also benefits from I.1/I.2/I.3 being stable before writing round-trip assertions against them.

---

## Phase J — SwiftUI Integration, Zod Validation, Android Fallback & Docs Overhaul

### J.1 — SwiftUI / `@Observable` Integration (`CloudKitStore`)
_Effort: M (Swift only) | Agent: ios-native-dev_

An iOS 17+ `@Observable` macro wrapper that exposes record fetching, saving, and sync state reactively for pure SwiftUI apps. Ships as an optional import path (`import ExpoCloudKitSwiftUI`) — apps not using SwiftUI pay zero overhead. Works alongside (does not replace) the existing React Native hooks.

**Architecture decisions:**

- `CloudKitStore` wraps the existing module singleton (`CloudKitRecordManager`, `CloudKitZoneManager`) — it does **not** create its own `CKContainer`. All CloudKit operations route through the same configured container. This keeps change token state, offline queue, and sync engine consistent between SwiftUI and React Native layers.
- Sync events surface via `@Observable` published properties (`syncState: SyncState`, `lastSyncError: CloudKitError?`, `isSyncing: Bool`) that `CloudKitStore` populates by subscribing to the same internal `NotificationCenter` events that the JS event emitter uses.
- Conflicts use the same resolution path as Phase G.6 — if `resolveConflicts` is enabled, `CloudKitStore` exposes a `pendingConflicts: [SyncConflict]` array and a `resolveConflict(_:with:)` method.

**Tasks:**

- [x] **Swift**: Create `ios/SwiftUI/CloudKitStore.swift` — `@Observable` class (guarded with `#if canImport(SwiftUI)` and `@available(iOS 17, *)`) with properties: `records: [String: CloudKitRecord]`, `syncState: SyncState`, `lastError: Error?`. Note: `isSyncing` consolidated into `syncState.status` — callers use `store.syncState.status == .syncing`
- [x] **Swift**: Implement `func fetch(_ config: FetchConfig) async` — delegates to `CloudKitRecordManager.queryRecords()`, updates `records` dictionary on completion
- [x] **Swift**: Implement `func save(_ record: RecordToSave) async` — delegates to `CloudKitRecordManager.saveRecords()`, updates `records` on success, populates `error` on failure
- [x] **Swift**: Implement `func delete(_ identifier: RecordIdentifier) async` — delegates to `CloudKitRecordManager.deleteRecords()`, removes from `records`
- [x] **Swift**: Subscribe to internal sync events (`NotificationCenter` or direct delegate callback) to update `syncState` reactively; sync start/stop via `func startSync(config: SyncEngineConfig) async`
- [x] **Swift**: Add `func resolveConflict(_ conflict: SyncConflict, with resolution: CloudKitRecord) async throws` that calls through to the existing `resolveSyncConflict` machinery
- [x] **Swift**: `CloudKitStore` guarded with `#if canImport(SwiftUI)` compile-time flag — non-SwiftUI apps incur zero binary size overhead; no separate build flag needed
- [x] **Swift**: Add `ios/Tests/CloudKitStoreTests.swift` — at least 5 test cases covering fetch → records population, save → records update, delete → records removal, sync state changes, and conflict surfacing

_Risks_: The `@Observable` macro requires iOS 17+ and Swift 5.9+. The Expo Modules build pipeline may not support conditional compilation targets cleanly — the build flag approach (`EXPO_CLOUDKIT_SWIFTUI`) needs validation in a fresh `expo prebuild`. If the flag approach fails, fall back to a runtime `#available` check with the `@Observable` class always compiled but never instantiated on iOS 16.

_Done when_: A SwiftUI `View` can instantiate `@State var store = CloudKitStore()`, call `store.fetch(recordType: "Note")`, and render `store.records` in a `List` — all reactively updating when records change or sync events fire. Non-SwiftUI apps that do not import the module see no binary size increase.

---

### J.2 — Zod / Runtime Schema Validation
_Effort: S (TypeScript only) | Agent: ts-sdk-dev_

A zero-dependency TypeScript utility that validates `CloudKitRecord.fields` against a caller-supplied Zod schema, returning fully typed fields. Zod is a peer dependency (not a hard dep) — tree-shakable when not used.

**Architecture decisions:**

- `createCloudKitSchema<T>(zodSchema)` returns a `CloudKitParser<T>` object with a `.parse(record)` method and a `.safeParse(record)` method (mirroring Zod's own API shape).
- Field type coercions are applied **before** Zod validation: CloudKit `Date` fields (JS `number` — Unix ms timestamps) are coerced to `Date` objects when the Zod schema expects `z.date()`. `CKAsset` fields (`{ uri, size }`) are passed through as-is. `Data` fields (base64 strings) are not coerced — the schema must expect `z.string()`.
- `CloudKitValidationError` extends `CloudKitError` (from `src/errors.ts`) with a `zodErrors` property containing the raw Zod issue array.

**Tasks:**

- [ ] **TypeScript**: Create `src/schema.ts` — export `createCloudKitSchema<T>(schema: ZodType<T>): CloudKitParser<T>` where `CloudKitParser<T>` has `.parse(record: CloudKitRecord): T` (throws on failure) and `.safeParse(record: CloudKitRecord): { success: true, data: T } | { success: false, error: CloudKitValidationError }`
- [ ] **TypeScript**: Implement field coercion layer in `src/schema.ts` — `coerceFields(fields: Record<string, RecordField>): Record<string, unknown>` that converts `number` timestamps to `Date` when the value looks like a Unix ms timestamp (> 1e12), passes `CKAsset` objects through, and leaves all other types unchanged
- [ ] **TypeScript**: Create `CloudKitValidationError` class in `src/errors.ts` — extends `CloudKitError` with `code: CloudKitErrorCode.VALIDATION_FAILED`, `zodErrors: ZodIssue[]`, and a human-readable `message` summarizing the first 3 issues
- [ ] **TypeScript**: Add `CloudKitErrorCode.VALIDATION_FAILED = 'VALIDATION_FAILED'` to the `CloudKitErrorCode` enum in `src/errors.ts`
- [ ] **TypeScript**: Add `CloudKitParser<T>` and `CloudKitValidationError` to `src/types.ts` exports; re-export `createCloudKitSchema` from `src/index.ts`
- [ ] **TypeScript**: Add JSDoc on `createCloudKitSchema` with a usage example showing a `z.object({ title: z.string(), createdAt: z.date() })` schema parsing a CloudKit record
- [ ] **TypeScript**: Add `src/__tests__/schema.test.ts` — at least 6 test cases: valid parse, invalid field type, missing required field, date coercion, asset passthrough, safeParse returning error object
- [ ] **TypeScript**: Add `zod` to `peerDependencies` in `package.json` with `">=3.0.0"` range and `peerDependenciesMeta` marking it as `optional: true`

_Risks_: Zod v4 (currently in RC) changes the `ZodIssue` type shape. Pin the peer dep range to `>=3.0.0` and document that v4 compatibility will be validated when it ships stable. The timestamp coercion heuristic (> 1e12) could misclassify large numbers — document the coercion rules in JSDoc.

_Done when_: `const parser = createCloudKitSchema(z.object({ title: z.string(), dueDate: z.date() })); const typed = parser.parse(record);` returns `{ title: "Buy milk", dueDate: Date }` with full TypeScript inference. An invalid record throws `CloudKitValidationError` with `zodErrors` attached.

---

### J.3 — Android / Web Fallback Improvement
_Effort: M (TypeScript + config) | Agent: ts-sdk-dev_

Route Android to the existing web platform implementation (`ExpoCloudKit.web.ts`) when `tsl-apple-cloudkit` is available, instead of throwing `CloudKitNotSupportedError` for every operation. Native-only operations (CKSyncEngine, CKShare, push subscriptions) continue to throw `CloudKitNotSupportedError` on Android.

**Architecture decisions:**

- Platform detection: `Platform.OS === 'android'` triggers the same code path as `Platform.OS === 'web'`. The existing `ExpoCloudKit.web.ts` already implements 20/44 functions via CloudKit JS — Android gets the same 20 for free.
- Sign-in on Android: CloudKit JS requires a browser-based Apple ID sign-in. On Android, this is presented via a system Custom Tab (Chrome Custom Tab) rather than an embedded WebView, to satisfy Apple's OAuth security requirements. The `authenticateWeb()` function on Android opens the sign-in URL in a Custom Tab and listens for the redirect deep link.
- Metro resolver: No new Metro config needed. Create `src/ExpoCloudKit.android.ts` that re-exports from `src/ExpoCloudKit.web.ts` for the 20 supported functions. The remaining 24 native-only functions throw `CloudKitNotSupportedError` with a specific message: `"This operation requires iOS and is not available on Android."`.
- Error types: Reuses `CloudKitNotSupportedError` from `src/errors.ts` (defined in Phase C). J.2's `CloudKitValidationError` pattern is referenced for consistency but not a functional dependency.

**Tasks:**

- [ ] **TypeScript**: Create `src/ExpoCloudKit.android.ts` — import all 20 web-compatible functions from `src/ExpoCloudKit.web.ts` and re-export them; for the remaining 24 native-only functions (`startSync`, `stopSync`, `getSyncState`, `createShare`, `acceptShare`, `fetchShareParticipants`, `updateSharePermission`, `removeShareParticipant`, `fetchSharedDatabaseZones`, `presentSharingUI`, `deleteShare`, all subscription functions, and all sync-related event listeners), export stubs that throw `CloudKitNotSupportedError`
- [ ] **TypeScript**: Update `authenticateWeb()` in the Android path to use `Linking.openURL()` for Custom Tab sign-in flow; add `handleAuthRedirect(url: string)` export that parses the OAuth callback URL and completes the sign-in
- [ ] **TypeScript**: Create `src/android/auth.ts` — Custom Tab auth flow: build Apple ID OAuth URL with CloudKit JS redirect parameters, open via `Linking`, listen for redirect via `Linking.addEventListener`, extract token, call `configureWeb()` with the token
- [ ] **TypeScript**: Add platform support matrix to `src/types.ts` as a JSDoc table on the module-level comment — documenting which of the 44 functions work on iOS, web, and Android
- [ ] **TypeScript**: Update `CloudKitProvider` to auto-call `configureWeb()` when `Platform.OS === 'android'` (same as existing `Platform.OS === 'web'` behavior), using the `webConfig` prop
- [ ] **TypeScript**: Add `src/__tests__/android-fallback.test.ts` — at least 5 test cases: supported function delegates to web impl, unsupported function throws `CloudKitNotSupportedError`, `configureWeb` called on provider mount, `authenticateWeb` triggers `Linking.openURL`, `handleAuthRedirect` parses callback

_Risks_: Chrome Custom Tabs are not available on all Android devices (e.g., Amazon Fire tablets use Silk). Fall back to `Linking.openURL` which opens the default browser. Apple's CloudKit JS sign-in flow may not work in all Android browsers — this needs manual testing on Chrome, Samsung Internet, and Firefox. The 20/44 function split may change as new web functions are added in future phases — `ExpoCloudKit.android.ts` must be updated in lockstep with `ExpoCloudKit.web.ts`.

_Done when_: An Android app with `tsl-apple-cloudkit` installed can call `configureWeb()`, `authenticateWeb()`, `saveRecords()`, `queryRecords()`, `fetchRecord()`, and `deleteRecords()` successfully against CloudKit. Calling `startSync()` on Android throws `CloudKitNotSupportedError` with a clear message. `CloudKitProvider` with `webConfig` works on Android without code changes.

---

### J.4 — README / Docs Overhaul
_Effort: M (docs only) | Agent: technical-writer_

Restructure the README from its current ~600-line sequential-addition format into a coherent API reference useful to first-time adopters.

**Tasks:**

- [ ] **Docs**: Restructure README into these top-level sections (in order): Quick Start (10-line copy-paste example), Installation (`npx expo install`, peer deps), Configuration (config plugin setup, container ID, entitlements), What is CloudKit? (2-paragraph primer for React Native devs unfamiliar with iCloud/CloudKit concepts), Core Concepts (containers, databases, zones, records, sync), API Reference (organized by category — see below), Platform Support Matrix (iOS/web/Android table with checkmarks), Hooks Reference, Error Handling, Migration Guide (breaking changes per version from CHANGELOG)
- [ ] **Docs**: API Reference sub-sections: Container & Account, Records (CRUD), Zones, Sharing, Sync Engine, Subscriptions, Offline Queue, Web Platform, Debug Utilities — each with function signature, parameters table, return type, and a 3-5 line usage example
- [ ] **Docs**: Move lengthy code examples (current inline demo blocks > 20 lines) from README to `example/snippets/` directory and link from README with "See full example" links
- [ ] **Docs**: Generate API reference stubs from JSDoc comments in `src/types.ts` and `src/errors.ts` — extract function signatures, parameter descriptions, and return types into the API Reference sections
- [ ] **Docs**: Add Platform Support Matrix table — all 44 exported functions listed with iOS / Web / Android columns using checkmark/cross/dash notation, with footnotes for conditional support (e.g., "iOS 17+ only", "Requires tsl-apple-cloudkit")
- [ ] **Docs**: Add "What is CloudKit?" section — explain CKContainer, CKDatabase (private/public/shared), CKRecordZone, CKRecord, and CKSyncEngine in React Native developer terms (compare to Firebase Firestore concepts where helpful)
- [ ] **Docs**: Update CHANGELOG.md with Phase J entry stubs

_Risks_: The API reference will drift from code if not generated or validated automatically. Consider adding a CI step in a future phase that diffs JSDoc exports against README function lists. The "What is CloudKit?" section risks being too long — cap it at 500 words.

_Done when_: A developer unfamiliar with CloudKit can read the README top-to-bottom and: (1) install the module in under 2 minutes, (2) understand what CloudKit is and how it maps to concepts they know, (3) find the function signature and usage example for any of the 44 exported APIs within 30 seconds, (4) know which functions work on their target platform (iOS/web/Android).

---

### Batch Execution Plan

#### Batch 1 (parallel — no shared files)
| Phase | Goal | Agent(s) | Effort |
|-------|------|----------|--------|
| J.1 | SwiftUI `@Observable` `CloudKitStore` | ios-native-dev | M |
| J.2 | Zod schema validation helpers | ts-sdk-dev | S |
| J.4 | README / docs overhaul | technical-writer | M |

#### Batch 2 (after Batch 1 — J.3 depends on J.2 error type patterns)
| Phase | Goal | Agent(s) | Effort |
|-------|------|----------|--------|
| J.3 | Android / web fallback routing | ts-sdk-dev | M |

### Priority & Rationale

**Start with J.1 + J.2 + J.4 (Batch 1, parallel).**

- **J.1 (SwiftUI `CloudKitStore`)** is the highest-impact item for expanding the module's audience beyond React Native. SwiftUI adoption is accelerating and an `@Observable` wrapper positions the module for Swift Package Manager distribution in the future. It touches only `ios/SwiftUI/` — no conflicts with TypeScript work.
- **J.2 (Zod validation)** is the lowest-risk item: pure TypeScript, no native code, no platform-specific logic. It delivers immediate DX value for TypeScript-heavy teams and establishes the `CloudKitValidationError` pattern that J.3 references for error consistency.
- **J.4 (README overhaul)** is independent of all code work and can run in parallel. The current README's sequential-addition structure is the biggest barrier to adoption. A well-structured README is table-stakes for an OSS module.

**J.3 (Android fallback) runs in Batch 2** because it references J.2's `CloudKitValidationError` error subclass pattern for consistency, and because the `ExpoCloudKit.android.ts` file must be kept in sync with `ExpoCloudKit.web.ts` — waiting for Batch 1 ensures the web layer is stable. J.3 is also the highest-risk item in Phase J due to the Custom Tab auth flow on Android, which needs manual testing across browsers.
