# expo-cloudkit Roadmap

## Phase A — Core CK Operations (complete)

- [x] CKContainer setup and account status (`accountStatus()`, `fetchUserRecordID()`)
- [x] Custom zones (CKRecordZone) — create, delete, list
- [x] Record CRUD — save, fetch by ID, delete, query with predicates
- [x] Asset upload/download with progress callbacks
- [x] TypeScript bindings and type definitions (`src/types.ts`, `src/index.ts`)
- [x] Expo config plugin (iCloud entitlements in `plugin/`)

## Phase B — Sync & Sharing (in progress)

### CKSyncEngine (iOS 17+)
- [x] `ios/ExpoCloudKitSyncEngine.swift` adapter implementing `CKSyncEngineDelegate`
- [x] `startSync()` / `stopSync()` / `getSyncState()` JS API
- [x] Change token persistence (UserDefaults, keyed per container + zone)
- [x] Conflict resolution — server-record-wins default, hook for custom resolution
- [x] JS events: `onSyncStateChanged`, `onRecordsReceived`, `onRecordsSent`

### Push Subscriptions
- [ ] `CKQuerySubscription` — subscribe to record changes matching a predicate
- [ ] `CKDatabaseSubscription` — subscribe to all changes in a database
- [ ] `addEventListener` / `removeEventListener` JS API for subscription events
- [ ] Silent push handling (APNs background mode entitlement via config plugin)

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

## Phase C — Advanced (planned)

- [ ] Offline queue with automatic retry (exponential backoff, persist across app restarts)
- [ ] React hooks: `useCloudKitRecord`, `useCloudKitQuery`, `useCloudKitSync`
- [ ] Android stub — all APIs return a `CloudKitNotSupportedError` gracefully
- [ ] CloudKit Dashboard helper tooling (for development/debug)
- [ ] Batch record operations with progress reporting
- [ ] `CKRecord.Reference` deep linking support
