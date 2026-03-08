# Changelog

All notable changes to `expo-cloudkit` will be documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

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
[Unreleased]: https://github.com/atlas-ledger/expo-cloudkit/compare/v0.1.0...HEAD
