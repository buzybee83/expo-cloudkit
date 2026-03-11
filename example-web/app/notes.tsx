/**
 * Notes list screen
 *
 * Demonstrates:
 *   - useCloudKitQuery()    — fetch and paginate records
 *   - optimisticAdd()       — create a record with immediate UI feedback
 *   - optimisticRemove()    — delete a record with immediate UI feedback
 *   - pendingRecordNames    — per-record pending indicators
 *   - useCloudKitSubscription() — live updates via CKQuerySubscription
 *   - loading / fetching / error states
 */

import {
  useCloudKitQuery,
  useCloudKitSubscription,
} from 'expo-cloudkit';
import { useRouter } from 'expo-router';
import React from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { ErrorBanner } from '../components/ErrorBanner';
import { NoteCard } from '../components/NoteCard';

const RECORD_TYPE = 'Note';
const ZONE_NAME = 'Notes';

export default function NotesScreen() {
  const router = useRouter();

  const {
    data: notes,
    loading,
    fetching,
    error,
    refetch,
    fetchMore,
    hasMore,
    optimisticAdd,
    optimisticRemove,
    pendingRecordNames,
    optimisticErrors,
  } = useCloudKitQuery(RECORD_TYPE, {
    zoneName: ZONE_NAME,
    sortDescriptors: [{ field: 'modificationDate', ascending: false }],
    resultsLimit: 25,
  });

  // Live updates: when CloudKit pushes a notification for the Notes zone,
  // refetch the list so we pick up changes made on other devices.
  useCloudKitSubscription(RECORD_TYPE, {
    zoneName: ZONE_NAME,
    onNotification: () => {
      void refetch();
    },
  });

  async function handleAdd() {
    const timestamp = new Date().toLocaleTimeString();
    await optimisticAdd({
      recordType: RECORD_TYPE,
      zoneName: ZONE_NAME,
      fields: {
        title: { type: 'string', value: `New Note (${timestamp})` },
        body: { type: 'string', value: '' },
      },
    });
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
        <Text style={styles.loadingText}>Loading notes...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Fetch error banner */}
      <ErrorBanner error={error} />

      {/* Optimistic add errors (any record that failed to save) */}
      {optimisticErrors.size > 0 && (
        <View style={styles.optimisticErrorSection}>
          {Array.from(optimisticErrors.values()).map((err, i) => (
            <ErrorBanner key={i} error={err} />
          ))}
        </View>
      )}

      {/* Refetch indicator (shown during background refetches, not initial load) */}
      {fetching && !loading && (
        <View style={styles.fetchingBar}>
          <ActivityIndicator size="small" />
          <Text style={styles.fetchingText}>Syncing...</Text>
        </View>
      )}

      <FlatList
        data={notes ?? []}
        keyExtractor={(item) => item.recordName}
        renderItem={({ item }) => (
          <NoteCard
            record={item}
            isPending={pendingRecordNames.has(item.recordName)}
            onPress={() => router.push(`/note/${item.recordName}`)}
            onDelete={() => void optimisticRemove(item.recordName)}
          />
        )}
        ListEmptyComponent={
          !fetching ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>No notes yet.</Text>
              <Text style={styles.emptySubtext}>Tap "Add Note" to create one.</Text>
            </View>
          ) : null
        }
        ListFooterComponent={
          hasMore ? (
            <Pressable style={styles.loadMoreButton} onPress={() => void fetchMore()}>
              <Text style={styles.loadMoreText}>Load more</Text>
            </Pressable>
          ) : null
        }
        contentContainerStyle={styles.listContent}
      />

      <Pressable style={styles.addButton} onPress={() => void handleAdd()}>
        <Text style={styles.addButtonText}>+ Add Note</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    color: '#666',
    fontSize: 15,
  },
  fetchingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#e3f2fd',
  },
  fetchingText: {
    fontSize: 13,
    color: '#1565c0',
  },
  listContent: {
    padding: 16,
    paddingBottom: 100,
    gap: 8,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 48,
    gap: 8,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#555',
  },
  emptySubtext: {
    fontSize: 14,
    color: '#888',
  },
  loadMoreButton: {
    marginTop: 16,
    alignSelf: 'center',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1565c0',
  },
  loadMoreText: {
    color: '#1565c0',
    fontSize: 14,
    fontWeight: '600',
  },
  addButton: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    backgroundColor: '#1565c0',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 28,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 4,
  },
  addButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  optimisticErrorSection: {
    gap: 4,
  },
});
