/**
 * expo-cloudkit — Example App
 *
 * Demonstrates Phase A, B, and C functionality:
 *
 * Phase A:
 * - configure()
 * - getAccountStatus()
 * - addAccountStatusListener()
 * - createZone()
 * - saveRecords()
 * - queryRecords()
 *
 * Phase B:
 * - startSyncEngine() / stopSyncEngine() / getSyncState() / addSyncEngineListener()
 * - saveQuerySubscription() / addSubscriptionListener()
 * - createShare() / presentSharingUI() / fetchShareParticipants()
 *
 * Phase C:
 * - useCloudKitRecord / useCloudKitQuery / useCloudKitSync (React hooks)
 * - enqueueOfflineOperation() / drainOfflineQueue() / getOfflineQueueStatus() / addOfflineQueueListener()
 * - addBatchProgressListener()
 * - fetchRecordWithReferences()
 *
 * To run:
 *   cd example && expo run:ios
 *
 * Prerequisites:
 * - A real iOS device or simulator signed into iCloud
 * - An iCloud container matching the ID below created in developer.apple.com
 * - The app's bundle ID added to the container
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Button,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  // Types
  AccountStatus,
  BatchProgress,
  CloudKitError,
  CloudKitRecord,
  OfflineQueueStatus,
  SavedRecord,
  Share,
  ShareParticipant,
  Subscription,
  SyncState,
  Zone,
  // Phase A
  addAccountStatusListener,
  configure,
  createZone,
  getAccountStatus,
  queryRecords,
  saveRecords,
  // Phase B — CKSyncEngine
  startSyncEngine,
  stopSyncEngine,
  getSyncState,
  addSyncEngineListener,
  // Phase B — Push Subscriptions
  saveQuerySubscription,
  addSubscriptionListener,
  // Phase B — CKShare
  createShare,
  presentSharingUI,
  fetchShareParticipants,
  // Phase C — React Hooks
  useCloudKitRecord,
  useCloudKitQuery,
  useCloudKitSync,
  // Phase C — Offline Queue
  enqueueOfflineOperation,
  drainOfflineQueue,
  getOfflineQueueStatus,
  addOfflineQueueListener,
  // Phase C — Batch Progress
  addBatchProgressListener,
  // Phase C — CKRecord.Reference deep linking
  fetchRecordWithReferences,
} from 'expo-cloudkit';

// ---------------------------------------------------------------------------
// Configuration — replace with your actual container ID
// ---------------------------------------------------------------------------

const CONTAINER_ID = 'iCloud.com.example.expocloudkitexample';
const ZONE_NAME = 'ExampleZone';
const RECORD_TYPE = 'Note';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LogEntry {
  id: number;
  timestamp: string;
  message: string;
  isError: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function App(): React.JSX.Element {
  const [accountStatus, setAccountStatus] = useState<AccountStatus | null>(null);
  const [zone, setZone] = useState<Zone | null>(null);
  const [savedRecord, setSavedRecord] = useState<SavedRecord | null>(null);
  const [queriedRecords, setQueriedRecords] = useState<CloudKitRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logIdRef = useRef(0);
  const subscriptionRef = useRef<Subscription | null>(null);

  // Phase B — sync engine state
  const [syncState, setSyncState] = useState<SyncState | null>(null);

  // Phase C — offline queue status
  const [queueStatus, setQueueStatus] = useState<OfflineQueueStatus | null>(null);

  // Phase C — batch progress
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);

  // Phase B — share state
  const [share, setShare] = useState<Share | null>(null);
  const [shareParticipants, setShareParticipants] = useState<ShareParticipant[]>([]);

  const log = useCallback((message: string, isError = false) => {
    const entry: LogEntry = {
      id: ++logIdRef.current,
      timestamp: new Date().toLocaleTimeString(),
      message,
      isError,
    };
    setLogs((prev) => [entry, ...prev].slice(0, 100));
  }, []);

  // Step 1: Configure and check account status on mount
  useEffect(() => {
    log('Configuring expo-cloudkit...');
    try {
      configure(CONTAINER_ID);
      log(`Configured container: ${CONTAINER_ID}`);
    } catch (err) {
      log(`configure() failed: ${errorMessage(err)}`, true);
      return;
    }

    // Check initial account status
    getAccountStatus()
      .then((status) => {
        setAccountStatus(status);
        log(`Account status: ${status}`);
      })
      .catch((err) => {
        log(`getAccountStatus() failed: ${errorMessage(err)}`, true);
      });

    // Listen for future account changes
    subscriptionRef.current = addAccountStatusListener((status) => {
      setAccountStatus(status);
      log(`Account status changed: ${status}`);
    });

    return () => {
      subscriptionRef.current?.remove();
    };
  }, [log]);

  // ---------------------------------------------------------------------------
  // Phase A handlers
  // ---------------------------------------------------------------------------

  const handleCreateZone = useCallback(async () => {
    setIsLoading(true);
    try {
      log(`Creating zone "${ZONE_NAME}"...`);
      const z = await createZone(ZONE_NAME, 'private');
      setZone(z);
      log(`Zone created: ${z.zoneName} (capabilities: ${z.capabilities.join(', ')})`);
    } catch (err) {
      log(`createZone() failed: ${errorMessage(err)}`, true);
    } finally {
      setIsLoading(false);
    }
  }, [log]);

  const handleSaveRecord = useCallback(async () => {
    if (!zone) {
      log('Create a zone first', true);
      return;
    }
    setIsLoading(true);
    try {
      const title = `Note ${Date.now()}`;
      log(`Saving record "${title}"...`);
      const [record] = await saveRecords(
        [
          {
            recordType: RECORD_TYPE,
            zoneName: ZONE_NAME,
            fields: {
              title: { type: 'string', value: title },
              createdAt: { type: 'date', value: new Date().toISOString() },
              wordCount: { type: 'number', value: Math.floor(Math.random() * 500) },
              tags: { type: 'stringList', value: ['example', 'cloudkit'] },
            },
          },
        ],
        'private'
      );
      setSavedRecord(record);
      log(`Record saved: ${record.recordName} (changeTag: ${record.changeTag})`);
    } catch (err) {
      log(`saveRecords() failed: ${errorMessage(err)}`, true);
    } finally {
      setIsLoading(false);
    }
  }, [zone, log]);

  const handleQueryRecords = useCallback(async () => {
    if (!zone) {
      log('Create a zone first', true);
      return;
    }
    setIsLoading(true);
    try {
      log(`Querying all "${RECORD_TYPE}" records in "${ZONE_NAME}"...`);
      const result = await queryRecords(
        RECORD_TYPE,
        undefined, // no predicate — fetch all
        [{ field: 'createdAt', ascending: false }],
        ZONE_NAME,
        'private',
        20
      );
      setQueriedRecords(result.records);
      log(
        `Query returned ${result.records.length} record(s).` +
          (result.cursor ? ' More available (cursor returned).' : '')
      );
    } catch (err) {
      log(`queryRecords() failed: ${errorMessage(err)}`, true);
    } finally {
      setIsLoading(false);
    }
  }, [zone, log]);

  // ---------------------------------------------------------------------------
  // Phase B — CKSyncEngine handlers
  // ---------------------------------------------------------------------------

  const handleStartSyncEngine = useCallback(async () => {
    setIsLoading(true);
    try {
      log('Starting CKSyncEngine...');
      await startSyncEngine({ zones: [ZONE_NAME], database: 'private', automaticallySync: true });
      const state = getSyncState();
      setSyncState(state);
      log(`SyncEngine started. status=${state.status} usesSyncEngine=${state.usesSyncEngine}`);
    } catch (err) {
      log(`startSyncEngine() failed: ${errorMessage(err)}`, true);
    } finally {
      setIsLoading(false);
    }
  }, [log]);

  const handleStopSyncEngine = useCallback(async () => {
    setIsLoading(true);
    try {
      log('Stopping CKSyncEngine...');
      await stopSyncEngine();
      const state = getSyncState();
      setSyncState(state);
      log(`SyncEngine stopped. status=${state.status}`);
    } catch (err) {
      log(`stopSyncEngine() failed: ${errorMessage(err)}`, true);
    } finally {
      setIsLoading(false);
    }
  }, [log]);

  const handleGetSyncState = useCallback(() => {
    const state = getSyncState();
    setSyncState(state);
    log(`SyncState: status=${state.status} usesSyncEngine=${state.usesSyncEngine}`);
  }, [log]);

  const handleAddSyncEngineListener = useCallback(() => {
    log('Registering addSyncEngineListener (1 event, then auto-removed)...');
    const sub = addSyncEngineListener((event) => {
      log(`SyncEngine event: type=${event.type}`);
      sub.remove();
    });
  }, [log]);

  // ---------------------------------------------------------------------------
  // Phase B — Push Subscriptions handlers
  // ---------------------------------------------------------------------------

  const handleSaveQuerySubscription = useCallback(async () => {
    if (!zone) {
      log('Create a zone first', true);
      return;
    }
    setIsLoading(true);
    try {
      log(`Saving CKQuerySubscription for "${RECORD_TYPE}"...`);
      const subscriptionId = await saveQuerySubscription({
        recordType: RECORD_TYPE,
        zoneName: ZONE_NAME,
        database: 'private',
        firesOnRecordCreation: true,
        firesOnRecordUpdate: true,
        firesOnRecordDeletion: false,
      });
      log(`Subscription saved: id=${subscriptionId}`);
    } catch (err) {
      log(`saveQuerySubscription() failed: ${errorMessage(err)}`, true);
    } finally {
      setIsLoading(false);
    }
  }, [zone, log]);

  const handleAddSubscriptionListener = useCallback(() => {
    log('Registering addSubscriptionListener (1 event, then auto-removed)...');
    const sub = addSubscriptionListener((event) => {
      if (event.type === 'query') {
        log(`Push notification: subscriptionID=${event.subscriptionID} notificationType=${event.notificationType} recordID=${event.recordID ?? 'n/a'}`);
      } else {
        log(`Database subscription event: subscriptionID=${event.subscriptionID} database=${event.databaseScope}`);
      }
      sub.remove();
    });
  }, [log]);

  // ---------------------------------------------------------------------------
  // Phase B — CKShare handlers
  // ---------------------------------------------------------------------------

  const handleCreateShare = useCallback(async () => {
    if (!savedRecord) {
      log('Save a record first', true);
      return;
    }
    setIsLoading(true);
    try {
      log(`Creating share for record "${savedRecord.recordName}"...`);
      const s = await createShare({
        recordName: savedRecord.recordName,
        zoneName: ZONE_NAME,
        database: 'private',
        publicPermission: 'readOnly',
      });
      setShare(s);
      log(`Share created: ${s.shareRecordName} URL=${s.shareURL ?? 'none'}`);
    } catch (err) {
      log(`createShare() failed: ${errorMessage(err)}`, true);
    } finally {
      setIsLoading(false);
    }
  }, [savedRecord, log]);

  const handlePresentSharingUI = useCallback(async () => {
    if (!savedRecord) {
      log('Save a record first', true);
      return;
    }
    setIsLoading(true);
    try {
      log('Presenting system sharing UI...');
      const result = await presentSharingUI({
        recordName: savedRecord.recordName,
        zoneName: ZONE_NAME,
        database: 'private',
        permission: 'readWrite',
      });
      log(`Sharing UI outcome=${result.outcome} shareURL=${result.share?.shareURL ?? 'none'}`);
    } catch (err) {
      log(`presentSharingUI() failed: ${errorMessage(err)}`, true);
    } finally {
      setIsLoading(false);
    }
  }, [savedRecord, log]);

  const handleFetchShareParticipants = useCallback(async () => {
    if (!share) {
      log('Create a share first', true);
      return;
    }
    setIsLoading(true);
    try {
      log(`Fetching participants for share "${share.shareRecordName}"...`);
      const participants = await fetchShareParticipants({
        shareRecordName: share.shareRecordName,
        zoneName: ZONE_NAME,
        database: 'private',
      });
      setShareParticipants(participants);
      log(`Fetched ${participants.length} participant(s).`);
    } catch (err) {
      log(`fetchShareParticipants() failed: ${errorMessage(err)}`, true);
    } finally {
      setIsLoading(false);
    }
  }, [share, log]);

  // ---------------------------------------------------------------------------
  // Phase C — Offline Queue handlers
  // ---------------------------------------------------------------------------

  const handleEnqueueOfflineOperation = useCallback(async () => {
    setIsLoading(true);
    try {
      const title = `Offline Note ${Date.now()}`;
      log(`Enqueueing offline save for "${title}"...`);
      const result = await enqueueOfflineOperation({
        type: 'save',
        database: 'private',
        record: {
          recordType: RECORD_TYPE,
          zoneName: ZONE_NAME,
          fields: {
            title: { type: 'string', value: title },
            createdAt: { type: 'date', value: new Date().toISOString() },
          },
        },
      });
      log(`Enqueued: queueId=${result.queueId}`);
    } catch (err) {
      log(`enqueueOfflineOperation() failed: ${errorMessage(err)}`, true);
    } finally {
      setIsLoading(false);
    }
  }, [log]);

  const handleDrainOfflineQueue = useCallback(async () => {
    setIsLoading(true);
    try {
      log('Draining offline queue...');
      const drainResult = await drainOfflineQueue();
      log(`Drain complete: succeeded=${drainResult.succeeded} failed=${drainResult.failed} skipped=${drainResult.skipped}`);
    } catch (err) {
      log(`drainOfflineQueue() failed: ${errorMessage(err)}`, true);
    } finally {
      setIsLoading(false);
    }
  }, [log]);

  const handleGetOfflineQueueStatus = useCallback(async () => {
    setIsLoading(true);
    try {
      log('Getting offline queue status...');
      const status = await getOfflineQueueStatus({ includeEntries: false });
      setQueueStatus(status);
      log(`Queue status: pending=${status.pending} retrying=${status.retrying} failed=${status.failed} total=${status.total}`);
    } catch (err) {
      log(`getOfflineQueueStatus() failed: ${errorMessage(err)}`, true);
    } finally {
      setIsLoading(false);
    }
  }, [log]);

  const handleAddOfflineQueueListener = useCallback(() => {
    log('Registering addOfflineQueueListener (until next event)...');
    const sub = addOfflineQueueListener((event) => {
      log(`OfflineQueue event: type=${event.type}`);
      sub.remove();
    });
  }, [log]);

  // ---------------------------------------------------------------------------
  // Phase C — Batch Progress handler
  // ---------------------------------------------------------------------------

  const handleAddBatchProgressListener = useCallback(async () => {
    if (!zone) {
      log('Create a zone first', true);
      return;
    }
    setIsLoading(true);
    try {
      log('Registering batch progress listener and saving 3 records...');
      const sub = addBatchProgressListener((progress) => {
        setBatchProgress(progress);
        log(`Batch progress: ${progress.completed}/${progress.total} — ${progress.recordName}`);
        if (progress.completed === progress.total) {
          sub.remove();
        }
      });

      // Save a small batch to exercise the listener
      await saveRecords(
        [1, 2, 3].map((i) => ({
          recordType: RECORD_TYPE,
          zoneName: ZONE_NAME,
          fields: {
            title: { type: 'string', value: `Batch Note ${i} @ ${Date.now()}` },
            createdAt: { type: 'date', value: new Date().toISOString() },
          },
        })),
        'private'
      );
      log('Batch save complete.');
    } catch (err) {
      log(`Batch save failed: ${errorMessage(err)}`, true);
    } finally {
      setIsLoading(false);
    }
  }, [zone, log]);

  // ---------------------------------------------------------------------------
  // Phase C — fetchRecordWithReferences handler
  // ---------------------------------------------------------------------------

  const handleFetchRecordWithReferences = useCallback(async () => {
    if (!savedRecord) {
      log('Save a record first', true);
      return;
    }
    setIsLoading(true);
    try {
      log(`Fetching record with references: "${savedRecord.recordName}" depth=1...`);
      const resolved = await fetchRecordWithReferences(savedRecord.recordName, {
        recordType: RECORD_TYPE,
        zoneName: ZONE_NAME,
        database: 'private',
        depth: 1,
      });
      const refFieldCount = Object.keys(resolved.resolvedReferences).length;
      log(`Resolved record: ${resolved.recordName} — ${refFieldCount} reference field(s) resolved.`);
    } catch (err) {
      log(`fetchRecordWithReferences() failed: ${errorMessage(err)}`, true);
    } finally {
      setIsLoading(false);
    }
  }, [savedRecord, log]);

  // ---------------------------------------------------------------------------
  // Phase C — React Hooks demos (rendered as sub-components below)
  // ---------------------------------------------------------------------------

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>expo-cloudkit Example</Text>

      {/* Account status badge */}
      <StatusBadge status={accountStatus} />

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* ------------------------------------------------------------------ */}
        {/* Phase A — Core CRUD                                                 */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeader title="Phase A — Zones + Records" />
        <View style={styles.buttons}>
          <Button
            title="1. Create Zone"
            onPress={handleCreateZone}
            disabled={isLoading || accountStatus !== 'available'}
          />
          <Button
            title="2. Save Record"
            onPress={handleSaveRecord}
            disabled={isLoading || !zone}
          />
          <Button
            title="3. Query Records"
            onPress={handleQueryRecords}
            disabled={isLoading || !zone}
          />
        </View>

        {queriedRecords.length > 0 && (
          <View style={styles.results}>
            <Text style={styles.sectionTitle}>
              Query Results ({queriedRecords.length})
            </Text>
            {queriedRecords.slice(0, 5).map((r) => (
              <Text key={r.recordName} style={styles.recordRow} numberOfLines={1}>
                {(r.fields['title']?.value as string) ?? r.recordName}
              </Text>
            ))}
            {queriedRecords.length > 5 && (
              <Text style={styles.moreText}>…and {queriedRecords.length - 5} more</Text>
            )}
          </View>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Phase B — CKSyncEngine                                              */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeader title="Phase B — CKSyncEngine (iOS 17+)" />
        <View style={styles.buttons}>
          <Button
            title="Start Sync Engine"
            onPress={handleStartSyncEngine}
            disabled={isLoading || accountStatus !== 'available'}
          />
          <Button
            title="Stop Sync Engine"
            onPress={handleStopSyncEngine}
            disabled={isLoading}
          />
          <Button
            title="Get Sync State"
            onPress={handleGetSyncState}
            disabled={isLoading}
          />
          <Button
            title="Add Sync Engine Listener (1 event)"
            onPress={handleAddSyncEngineListener}
            disabled={isLoading}
          />
        </View>
        {syncState && (
          <View style={styles.results}>
            <Text style={styles.sectionTitle}>Sync State</Text>
            <Text style={styles.recordRow}>status: {syncState.status}</Text>
            <Text style={styles.recordRow}>
              usesSyncEngine: {syncState.usesSyncEngine ? 'yes (iOS 17+)' : 'no (iOS 16 fallback)'}
            </Text>
          </View>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Phase B — Push Subscriptions                                        */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeader title="Phase B — Push Subscriptions" />
        <View style={styles.buttons}>
          <Button
            title="Save Query Subscription"
            onPress={handleSaveQuerySubscription}
            disabled={isLoading || !zone}
          />
          <Button
            title="Add Subscription Listener (1 event)"
            onPress={handleAddSubscriptionListener}
            disabled={isLoading}
          />
        </View>

        {/* ------------------------------------------------------------------ */}
        {/* Phase B — CKShare                                                   */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeader title="Phase B — CKShare" />
        <View style={styles.buttons}>
          <Button
            title="Create Share (needs saved record)"
            onPress={handleCreateShare}
            disabled={isLoading || !savedRecord}
          />
          <Button
            title="Present Sharing UI (needs saved record)"
            onPress={handlePresentSharingUI}
            disabled={isLoading || !savedRecord}
          />
          <Button
            title="Fetch Participants (needs share)"
            onPress={handleFetchShareParticipants}
            disabled={isLoading || !share}
          />
        </View>
        {share && (
          <View style={styles.results}>
            <Text style={styles.sectionTitle}>Share</Text>
            <Text style={styles.recordRow} numberOfLines={1}>
              recordName: {share.shareRecordName}
            </Text>
            <Text style={styles.recordRow} numberOfLines={1}>
              URL: {share.shareURL ?? 'none'}
            </Text>
            <Text style={styles.recordRow}>
              publicPermission: {share.publicPermission}
            </Text>
          </View>
        )}
        {shareParticipants.length > 0 && (
          <View style={styles.results}>
            <Text style={styles.sectionTitle}>
              Participants ({shareParticipants.length})
            </Text>
            {shareParticipants.map((p) => (
              <Text key={p.participantRecordName} style={styles.recordRow} numberOfLines={1}>
                {p.firstName ?? ''} {p.lastName ?? ''} — {p.role} / {p.permission}
              </Text>
            ))}
          </View>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Phase C — React Hooks                                               */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeader title="Phase C — React Hooks" />
        <HooksDemoSection
          savedRecordName={savedRecord?.recordName}
          zoneName={ZONE_NAME}
          log={log}
        />

        {/* ------------------------------------------------------------------ */}
        {/* Phase C — Offline Queue                                             */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeader title="Phase C — Offline Queue" />
        <View style={styles.buttons}>
          <Button
            title="Enqueue Offline Operation"
            onPress={handleEnqueueOfflineOperation}
            disabled={isLoading}
          />
          <Button
            title="Drain Offline Queue"
            onPress={handleDrainOfflineQueue}
            disabled={isLoading}
          />
          <Button
            title="Get Queue Status"
            onPress={handleGetOfflineQueueStatus}
            disabled={isLoading}
          />
          <Button
            title="Add Queue Listener (1 event)"
            onPress={handleAddOfflineQueueListener}
            disabled={isLoading}
          />
        </View>
        {queueStatus && (
          <View style={styles.results}>
            <Text style={styles.sectionTitle}>Queue Status</Text>
            <Text style={styles.recordRow}>pending: {queueStatus.pending}</Text>
            <Text style={styles.recordRow}>retrying: {queueStatus.retrying}</Text>
            <Text style={styles.recordRow}>failed: {queueStatus.failed}</Text>
            <Text style={styles.recordRow}>total: {queueStatus.total}</Text>
          </View>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Phase C — Batch Progress                                            */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeader title="Phase C — Batch Progress" />
        <View style={styles.buttons}>
          <Button
            title="Save 3 Records with Progress Listener"
            onPress={handleAddBatchProgressListener}
            disabled={isLoading || !zone}
          />
        </View>
        {batchProgress && (
          <View style={styles.results}>
            <Text style={styles.sectionTitle}>Last Batch Progress</Text>
            <Text style={styles.recordRow}>
              {batchProgress.completed}/{batchProgress.total}
            </Text>
            <Text style={styles.recordRow} numberOfLines={1}>
              recordName: {batchProgress.recordName}
            </Text>
          </View>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Phase C — CKRecord.Reference deep linking                          */}
        {/* ------------------------------------------------------------------ */}
        <SectionHeader title="Phase C — fetchRecordWithReferences" />
        <View style={styles.buttons}>
          <Button
            title="Fetch Record with References (depth=1)"
            onPress={handleFetchRecordWithReferences}
            disabled={isLoading || !savedRecord}
          />
        </View>

        {isLoading && <ActivityIndicator style={styles.spinner} />}

        {/* Log output */}
        <Text style={[styles.sectionTitle, styles.logLabel]}>Log</Text>
        <View style={styles.logContainer}>
          {logs.map((entry) => (
            <Text
              key={entry.id}
              style={[styles.logEntry, entry.isError && styles.logError]}
            >
              [{entry.timestamp}] {entry.message}
            </Text>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Phase C — React Hooks demo section (rendered inside App's scroll view)
// ---------------------------------------------------------------------------

interface HooksDemoSectionProps {
  savedRecordName: string | undefined;
  zoneName: string;
  log: (message: string, isError?: boolean) => void;
}

function HooksDemoSection({ savedRecordName, zoneName, log }: HooksDemoSectionProps): React.JSX.Element {
  // useCloudKitRecord — fetch the most recently saved record
  const {
    data: hookRecord,
    loading: hookRecordLoading,
    error: hookRecordError,
    refetch: hookRecordRefetch,
  } = useCloudKitRecord(savedRecordName, {
    recordType: RECORD_TYPE,
    zoneName,
    database: 'private',
    enabled: savedRecordName !== undefined,
    subscribe: false,
  });

  // useCloudKitQuery — query Note records
  const {
    data: hookQueryRecords,
    loading: hookQueryLoading,
    hasMore: hookQueryHasMore,
    fetchMore: hookQueryFetchMore,
    refetch: hookQueryRefetch,
  } = useCloudKitQuery(RECORD_TYPE, {
    sortDescriptors: [{ field: 'createdAt', ascending: false }],
    zoneName,
    database: 'private',
    resultsLimit: 5,
    enabled: savedRecordName !== undefined,
  });

  // useCloudKitSync — manage sync engine lifecycle
  const {
    state: hookSyncState,
    isRunning: hookSyncIsRunning,
    triggerSync: hookTriggerSync,
    error: hookSyncError,
  } = useCloudKitSync({
    zones: [zoneName],
    database: 'private',
    automaticallySync: false,
    enabled: false, // disabled by default so it doesn't conflict with imperative demo above
    onRecordsFetched: (event) => {
      log(`[useCloudKitSync] recordsFetched: zone=${event.zoneName} changed=${event.changedRecords.length} deleted=${event.deletedRecordIDs.length}`);
    },
    onSyncError: (event) => {
      log(`[useCloudKitSync] syncError: ${event.error.message}`, true);
    },
  });

  return (
    <View>
      {/* useCloudKitRecord status */}
      <View style={styles.results}>
        <Text style={styles.sectionTitle}>useCloudKitRecord</Text>
        {savedRecordName === undefined ? (
          <Text style={styles.moreText}>Save a record first to enable this hook.</Text>
        ) : hookRecordLoading ? (
          <ActivityIndicator />
        ) : hookRecordError ? (
          <Text style={[styles.recordRow, { color: '#FF6B6B' }]}>
            Error: {hookRecordError.message}
          </Text>
        ) : hookRecord ? (
          <Text style={styles.recordRow} numberOfLines={1}>
            {(hookRecord.fields['title']?.value as string) ?? hookRecord.recordName}
          </Text>
        ) : (
          <Text style={styles.moreText}>No data yet.</Text>
        )}
        <Button
          title="Refetch via useCloudKitRecord"
          onPress={() => {
            void hookRecordRefetch().then((r) => {
              log(r ? `useCloudKitRecord refetch: ${r.recordName}` : 'useCloudKitRecord refetch: no result');
            });
          }}
          disabled={savedRecordName === undefined}
        />
      </View>

      {/* useCloudKitQuery status */}
      <View style={styles.results}>
        <Text style={styles.sectionTitle}>useCloudKitQuery</Text>
        {savedRecordName === undefined ? (
          <Text style={styles.moreText}>Save a record first to enable this hook.</Text>
        ) : hookQueryLoading ? (
          <ActivityIndicator />
        ) : hookQueryRecords && hookQueryRecords.length > 0 ? (
          <>
            <Text style={styles.recordRow}>{hookQueryRecords.length} record(s) loaded.</Text>
            {hookQueryHasMore && (
              <Text style={styles.moreText}>More available — tap Fetch More.</Text>
            )}
          </>
        ) : (
          <Text style={styles.moreText}>No records yet.</Text>
        )}
        <View style={styles.rowButtons}>
          <Button
            title="Refetch"
            onPress={() => {
              void hookQueryRefetch().then((records) => {
                log(`useCloudKitQuery refetch: ${records?.length ?? 0} record(s)`);
              });
            }}
            disabled={savedRecordName === undefined}
          />
          <Button
            title="Fetch More"
            onPress={() => {
              void hookQueryFetchMore().then(() => {
                log('useCloudKitQuery fetchMore complete');
              });
            }}
            disabled={!hookQueryHasMore}
          />
        </View>
      </View>

      {/* useCloudKitSync status */}
      <View style={styles.results}>
        <Text style={styles.sectionTitle}>useCloudKitSync (enabled=false by default)</Text>
        <Text style={styles.recordRow}>
          isRunning: {hookSyncIsRunning ? 'yes' : 'no'}
        </Text>
        <Text style={styles.recordRow}>status: {hookSyncState.status}</Text>
        {hookSyncError && (
          <Text style={[styles.recordRow, { color: '#FF6B6B' }]}>
            error: {hookSyncError.message}
          </Text>
        )}
        <Button
          title="triggerSync() via hook"
          onPress={() => {
            void hookTriggerSync().then(() => {
              log('useCloudKitSync triggerSync() called');
            });
          }}
          disabled={!hookSyncIsRunning}
        />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionHeader({ title }: { title: string }): React.JSX.Element {
  return <Text style={styles.sectionHeader}>{title}</Text>;
}

function StatusBadge({ status }: { status: AccountStatus | null }): React.JSX.Element {
  const color =
    status === 'available'
      ? '#34C759'
      : status === null
      ? '#8E8E93'
      : '#FF3B30';

  return (
    <View style={styles.badge}>
      <View style={[styles.badgeDot, { backgroundColor: color }]} />
      <Text style={styles.badgeText}>
        iCloud: {status ?? 'checking…'}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  if (err instanceof CloudKitError) {
    return `[${err.code}] ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
    color: '#1C1C1E',
  },
  sectionHeader: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1C1C1E',
    backgroundColor: '#E5E5EA',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginTop: 16,
    marginBottom: 8,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
  },
  badgeDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  badgeText: {
    fontSize: 15,
    color: '#1C1C1E',
  },
  buttons: {
    gap: 8,
    marginBottom: 8,
  },
  rowButtons: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  spinner: {
    marginVertical: 8,
  },
  results: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
    gap: 4,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6C6C70',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  logLabel: {
    marginTop: 16,
  },
  recordRow: {
    fontSize: 14,
    color: '#1C1C1E',
    paddingVertical: 2,
  },
  moreText: {
    fontSize: 13,
    color: '#8E8E93',
    marginTop: 4,
  },
  logContainer: {
    minHeight: 200,
    backgroundColor: '#1C1C1E',
    borderRadius: 8,
    padding: 10,
    marginBottom: 32,
  },
  logEntry: {
    fontSize: 12,
    fontFamily: 'Menlo',
    color: '#E5E5EA',
    marginBottom: 2,
  },
  logError: {
    color: '#FF6B6B',
  },
});
