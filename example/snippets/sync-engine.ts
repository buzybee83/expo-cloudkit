/**
 * expo-cloudkit — CKSyncEngine with custom conflict resolution
 *
 * iOS 17+ uses CKSyncEngine for automatic scheduling.
 * iOS 16 falls back to polling via CKFetchRecordZoneChangesOperation.
 * The JS API is identical in both cases.
 */

import {
  configure,
  getAccountStatus,
  startSyncEngine,
  stopSyncEngine,
  addSyncEngineListener,
  enqueuePendingChange,
  resolveSyncConflict,
  getSyncState,
  isSyncEngineAvailable,
} from 'expo-cloudkit';
import type { CloudKitRecord, RecordIdentifier, SyncEngineEvent } from 'expo-cloudkit';

// ---------------------------------------------------------------------------
// Local state (replace with your own store)
// ---------------------------------------------------------------------------

const localRecords = new Map<string, CloudKitRecord>();

function applyServerChanges(changed: CloudKitRecord[], deleted: RecordIdentifier[]) {
  for (const record of changed) {
    localRecords.set(record.recordName, record);
  }
  for (const { recordName } of deleted) {
    localRecords.delete(recordName);
  }
}

function mergeRecords(client: CloudKitRecord, server: CloudKitRecord): CloudKitRecord {
  // Simple last-write-wins by modificationDate — replace with your own logic
  const clientDate = client.modificationDate ? new Date(client.modificationDate) : new Date(0);
  const serverDate = server.modificationDate ? new Date(server.modificationDate) : new Date(0);
  return clientDate > serverDate ? client : server;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function setupSync() {
  configure('iCloud.com.yourcompany.yourapp');

  const status = await getAccountStatus();
  if (status !== 'available') {
    console.warn('iCloud not available — sync not started');
    return null;
  }

  console.log('CKSyncEngine available:', isSyncEngineAvailable()); // true on iOS 17+

  // Start with manual conflict resolution enabled
  await startSyncEngine({
    zones: ['Notes', 'Tasks'],
    database: 'private',
    automaticallySync: true,
    resolveConflicts: true, // opt in to manual conflict handling
  });

  const syncState = getSyncState();
  console.log('Sync state:', syncState.status, '/ usesSyncEngine:', syncState.usesSyncEngine);

  // Subscribe to all sync events
  const subscription = addSyncEngineListener((event: SyncEngineEvent) => {
    switch (event.type) {
      case 'stateChanged':
        console.log('Sync lifecycle:', event.state.status);
        break;

      case 'recordsFetched':
        // One event per zone per sync cycle
        console.log(`[${event.zoneName}] fetched ${event.changedRecords.length} changed, ${event.deletedRecordIDs.length} deleted`);
        applyServerChanges(event.changedRecords, event.deletedRecordIDs);
        break;

      case 'recordsSent':
        console.log(`Sent ${event.savedRecords.length} records`);
        for (const failure of event.failedRecords) {
          console.warn('Send failure:', failure.recordIdentifier.recordName, failure.error.code);
        }
        break;

      case 'conflict':
        // Requires resolveConflicts: true in startSyncEngine config
        // You MUST call resolveSyncConflict for every conflict event —
        // failing to do so blocks the sync engine indefinitely.
        console.log('Conflict detected for record:', event.clientRecord.recordName);
        const resolved = mergeRecords(event.clientRecord, event.serverRecord);
        resolveSyncConflict(event.requestId, resolved);
        // Pass null to accept server version: resolveSyncConflict(event.requestId, null)
        break;

      case 'syncError':
        // Unrecoverable — stop the engine and inspect the error
        console.error('Sync error:', event.error.code, event.error.message);
        void stopSyncEngine();
        break;
    }
  });

  return subscription;
}

// ---------------------------------------------------------------------------
// Queue a change for the next sync cycle
// ---------------------------------------------------------------------------

function saveNoteLocally(title: string) {
  enqueuePendingChange({
    type: 'save',
    record: {
      recordType: 'Note',
      zoneName: 'Notes',
      fields: {
        title: { type: 'string', value: title },
        updated: { type: 'date', value: new Date().toISOString() },
      },
    },
  });
}

function deleteNoteLocally(recordName: string) {
  enqueuePendingChange({
    type: 'delete',
    recordIdentifier: { recordName, zoneName: 'Notes' },
  });
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

async function teardown(subscription: { remove(): void } | null) {
  subscription?.remove();
  await stopSyncEngine();
}

export { setupSync, saveNoteLocally, deleteNoteLocally, teardown };
