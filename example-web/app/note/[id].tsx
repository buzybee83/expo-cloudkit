/**
 * Note detail screen — single record with optimistic update
 *
 * Demonstrates:
 *   - useCloudKitRecord()  — fetch and subscribe to a single record
 *   - update()             — optimistic field update (merges only changed fields)
 *   - optimisticStatus     — 'idle' | 'pending' | 'committed' | 'rolled-back'
 *   - optimisticError      — error from the most recent failed update
 *   - loading / error states
 */

import { useCloudKitRecord } from 'expo-cloudkit';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { ErrorBanner } from '../../components/ErrorBanner';

const RECORD_TYPE = 'Note';
const ZONE_NAME = 'Notes';

export default function NoteDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const {
    data,
    loading,
    fetching,
    error,
    refetch,
    update,
    optimisticStatus,
    optimisticError,
  } = useCloudKitRecord(id, {
    recordType: RECORD_TYPE,
    zoneName: ZONE_NAME,
    // Subscribe to push notifications for this specific record so edits
    // made on another device are reflected automatically.
    subscribe: true,
  });

  // Local editable state — initialised once data loads, then controlled locally
  const [localTitle, setLocalTitle] = React.useState<string>('');
  const [localBody, setLocalBody] = React.useState<string>('');
  const initialised = React.useRef(false);

  React.useEffect(() => {
    if (data && !initialised.current) {
      const titleField = data.fields['title'];
      const bodyField = data.fields['body'];
      setLocalTitle(typeof titleField?.value === 'string' ? titleField.value : '');
      setLocalBody(typeof bodyField?.value === 'string' ? bodyField.value : '');
      initialised.current = true;
    }
  }, [data]);

  async function handleSave() {
    if (!data) return;

    const result = await update({
      title: { type: 'string', value: localTitle },
      body: { type: 'string', value: localBody },
    });

    if (result !== undefined) {
      // On success, go back to the notes list
      router.back();
    }
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
        <Text style={styles.loadingText}>Loading note...</Text>
      </View>
    );
  }

  if (error && !data) {
    return (
      <View style={styles.centered}>
        <ErrorBanner error={error} />
        <Pressable style={styles.retryButton} onPress={() => void refetch()}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Optimistic update error */}
      <ErrorBanner error={optimisticError} />

      {/* Fetch error during background refresh */}
      {error && data && <ErrorBanner error={error} />}

      {/* Optimistic status indicator */}
      {optimisticStatus === 'pending' && (
        <View style={styles.statusBar}>
          <ActivityIndicator size="small" color="#1565c0" />
          <Text style={styles.statusText}>Saving...</Text>
        </View>
      )}
      {optimisticStatus === 'committed' && (
        <View style={[styles.statusBar, styles.statusBarSuccess]}>
          <Text style={styles.statusTextSuccess}>Saved</Text>
        </View>
      )}
      {optimisticStatus === 'rolled-back' && (
        <View style={[styles.statusBar, styles.statusBarError]}>
          <Text style={styles.statusTextError}>Save failed — changes reverted</Text>
        </View>
      )}

      {/* Background refetch indicator */}
      {fetching && !loading && optimisticStatus === 'idle' && (
        <View style={styles.statusBar}>
          <ActivityIndicator size="small" color="#555" />
          <Text style={styles.statusText}>Refreshing...</Text>
        </View>
      )}

      <View style={styles.form}>
        <Text style={styles.fieldLabel}>Title</Text>
        <TextInput
          style={styles.titleInput}
          value={localTitle}
          onChangeText={setLocalTitle}
          placeholder="Note title"
          placeholderTextColor="#aaa"
          editable={optimisticStatus !== 'pending'}
        />

        <Text style={styles.fieldLabel}>Body</Text>
        <TextInput
          style={styles.bodyInput}
          value={localBody}
          onChangeText={setLocalBody}
          placeholder="Write your note here..."
          placeholderTextColor="#aaa"
          multiline
          editable={optimisticStatus !== 'pending'}
        />

        {data && (
          <View style={styles.metadata}>
            <Text style={styles.metaText}>
              Record: {data.recordName}
            </Text>
            {data.modificationDate && (
              <Text style={styles.metaText}>
                Modified: {new Date(data.modificationDate).toLocaleString()}
              </Text>
            )}
          </View>
        )}
      </View>

      <View style={styles.actions}>
        <Pressable
          style={styles.cancelButton}
          onPress={() => router.back()}
          disabled={optimisticStatus === 'pending'}
        >
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[
            styles.saveButton,
            optimisticStatus === 'pending' && styles.saveButtonDisabled,
          ]}
          onPress={() => void handleSave()}
          disabled={optimisticStatus === 'pending' || !data}
        >
          {optimisticStatus === 'pending' ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.saveButtonText}>Save</Text>
          )}
        </Pressable>
      </View>
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
    gap: 16,
    padding: 24,
  },
  loadingText: {
    color: '#666',
    fontSize: 15,
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#e3f2fd',
  },
  statusBarSuccess: {
    backgroundColor: '#e8f5e9',
  },
  statusBarError: {
    backgroundColor: '#ffebee',
  },
  statusText: {
    fontSize: 13,
    color: '#1565c0',
  },
  statusTextSuccess: {
    fontSize: 13,
    color: '#2e7d32',
    fontWeight: '600',
  },
  statusTextError: {
    fontSize: 13,
    color: '#c62828',
    fontWeight: '600',
  },
  form: {
    flex: 1,
    padding: 16,
    gap: 8,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#555',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 12,
  },
  titleInput: {
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 18,
    fontWeight: '600',
    color: '#1a1a1a',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ddd',
  },
  bodyInput: {
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#333',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ddd',
    minHeight: 160,
    textAlignVertical: 'top',
  },
  metadata: {
    marginTop: 16,
    gap: 4,
  },
  metaText: {
    fontSize: 12,
    color: '#aaa',
  },
  actions: {
    flexDirection: 'row',
    padding: 16,
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#ddd',
    backgroundColor: '#fff',
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ccc',
    alignItems: 'center',
  },
  cancelButtonText: {
    fontSize: 15,
    color: '#555',
    fontWeight: '600',
  },
  saveButton: {
    flex: 2,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#1565c0',
    alignItems: 'center',
  },
  saveButtonDisabled: {
    opacity: 0.6,
  },
  saveButtonText: {
    fontSize: 15,
    color: '#fff',
    fontWeight: '700',
  },
  retryButton: {
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 8,
    backgroundColor: '#1565c0',
  },
  retryButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
});
