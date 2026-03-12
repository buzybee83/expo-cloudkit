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

- [ ] **Swift**: Convert `CloudKitSyncEngineAdapter` from class + `DispatchQueue` to `actor` — move `pendingConflicts`, `syncEngine`, `configuration` into actor-isolated state
- [ ] **Swift**: Convert `CloudKitSyncFallbackAdapter` from class + `DispatchQueue` to `actor`
- [ ] **Swift**: Convert `OfflineQueue` from class + two `DispatchQueue`s to `actor`
- [ ] **Swift**: Update `ExpoCloudKitModule.swift` call sites to use `await` for actor-isolated method calls
- [ ] **Swift**: Ensure `CKSyncEngineDelegate` protocol conformance works with actor isolation (may need `nonisolated` annotations on delegate methods)
- [ ] **Swift**: Run all existing XCTests — they must continue to pass with the actor-based implementations
- [ ] **Swift**: Verify no `DispatchQueue.main.async` calls remain in migrated files (replace with `@MainActor` where needed for UI/event dispatch)

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
