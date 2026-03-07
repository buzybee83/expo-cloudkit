/**
 * expo-cloudkit — Example App
 *
 * Demonstrates Phase A functionality:
 * - configure()
 * - getAccountStatus()
 * - addAccountStatusListener()
 * - createZone()
 * - saveRecords()
 * - queryRecords()
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
  AccountStatus,
  CloudKitError,
  CloudKitRecord,
  SavedRecord,
  Subscription,
  Zone,
  addAccountStatusListener,
  configure,
  createZone,
  getAccountStatus,
  queryRecords,
  saveRecords,
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

  const log = useCallback((message: string, isError = false) => {
    const entry: LogEntry = {
      id: ++logIdRef.current,
      timestamp: new Date().toLocaleTimeString(),
      message,
      isError,
    };
    setLogs((prev) => [entry, ...prev].slice(0, 50));
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

  // Step 2: Create zone
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

  // Step 3: Save a record
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

  // Step 4: Query records
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
  // Render
  // ---------------------------------------------------------------------------

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>expo-cloudkit Example</Text>

      {/* Account status badge */}
      <StatusBadge status={accountStatus} />

      {/* Action buttons */}
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

      {isLoading && <ActivityIndicator style={styles.spinner} />}

      {/* Query results */}
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

      {/* Log output */}
      <Text style={styles.sectionTitle}>Log</Text>
      <ScrollView style={styles.logContainer}>
        {logs.map((entry) => (
          <Text
            key={entry.id}
            style={[styles.logEntry, entry.isError && styles.logError]}
          >
            [{entry.timestamp}] {entry.message}
          </Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

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
    marginBottom: 12,
  },
  spinner: {
    marginVertical: 8,
  },
  results: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6C6C70',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
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
    flex: 1,
    backgroundColor: '#1C1C1E',
    borderRadius: 8,
    padding: 10,
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
