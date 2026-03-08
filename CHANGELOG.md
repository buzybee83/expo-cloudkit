# Changelog

All notable changes to `expo-cloudkit` will be documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added

**Phase B: Sync Engine & iOS 16 Fallback**

- CKSyncEngine integration (iOS 17+): `startSyncEngine()`, `stopSyncEngine()`, `triggerSync()`, `getSyncState()`, `addSyncEngineListener()`
- iOS 16 fallback: manual `CKFetchRecordZoneChangesOperation` with timer-based polling and per-zone `CKServerChangeToken` persistence
- Automatic capability detection: uses CKSyncEngine on iOS 17+, polling fallback on iOS 16
- Change token persistence via UserDefaults, keyed per container and zone
- Server-record-wins conflict resolution with failed record surfacing in `recordsSent` events
- New TypeScript types: `SyncState`, `SyncEngineConfig`, `SyncEngineEvent` (discriminated union), `SyncProviderStatus`
- New error codes: `SYNC_ENGINE_NOT_RUNNING`, `TOKEN_EXPIRED`, `ACCOUNT_CHANGED`

### Fixed

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

### Phase B–E stubs (not yet implemented)
- `startSyncEngine` / `triggerSync` / `stopSyncEngine` — CKSyncEngine wrapper (iOS 17+)
- `downloadAsset` / `addAssetProgressListener` — CKAsset download with progress
- CKShare functions — sharing and participant management

[0.1.0]: https://github.com/atlas-ledger/expo-cloudkit/releases/tag/v0.1.0
[Unreleased]: https://github.com/atlas-ledger/expo-cloudkit/compare/v0.1.0...HEAD
