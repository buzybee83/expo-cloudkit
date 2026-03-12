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
