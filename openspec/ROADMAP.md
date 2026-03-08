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
- [ ] `ios/ExpoCloudKitSyncEngine.swift` adapter implementing `CKSyncEngineDelegate`
- [ ] `startSync()` / `stopSync()` / `getSyncState()` JS API
- [ ] Change token persistence (UserDefaults, keyed per container + zone)
- [ ] Conflict resolution — server-record-wins default, hook for custom resolution
- [ ] JS events: `onSyncStateChanged`, `onRecordsReceived`, `onRecordsSent`

### Push Subscriptions
- [ ] `CKQuerySubscription` — subscribe to record changes matching a predicate
- [ ] `CKDatabaseSubscription` — subscribe to all changes in a database
- [ ] `addEventListener` / `removeEventListener` JS API for subscription events
- [ ] Silent push handling (APNs background mode entitlement via config plugin)

### CKShare
- [ ] `createShare(recordID)` — share a record or zone
- [ ] `acceptShare(url)` — accept a share invitation from a URL
- [ ] `fetchShareParticipants(shareURL)` — list participants and their roles
- [ ] `updateShareParticipant(participantID, role, permission)` — change access
- [ ] Shared zone support in record/zone APIs

### iOS 16 Fallback
- [ ] `CKServerChangeToken` persistence and management
- [ ] Manual fetch-changes flow (no CKSyncEngine dependency)
- [ ] Automatic capability detection — use CKSyncEngine on 17+, fallback on 16
- [ ] Graceful degradation surface in JS API (returns `syncEngine: false` in status)

## Phase C — Advanced (planned)

- [ ] Offline queue with automatic retry (exponential backoff, persist across app restarts)
- [ ] React hooks: `useCloudKitRecord`, `useCloudKitQuery`, `useCloudKitSync`
- [ ] Android stub — all APIs return a `CloudKitNotSupportedError` gracefully
- [ ] CloudKit Dashboard helper tooling (for development/debug)
- [ ] Batch record operations with progress reporting
- [ ] `CKRecord.Reference` deep linking support
