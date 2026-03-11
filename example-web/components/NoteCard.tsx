/**
 * NoteCard — a single row in the notes list.
 *
 * Demonstrates:
 *   - Rendering a CloudKitRecord's typed fields
 *   - Dimmed / pending state from optimisticAdd / optimisticRemove
 *   - Platform-adaptive delete UI (button on web, swipe on native would be added separately)
 */

import type { CloudKitRecord } from 'expo-cloudkit';
import React from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

export interface NoteCardProps {
  /** The CloudKit record representing this note. */
  record: CloudKitRecord;
  /** When true, the card is dimmed and a spinner is shown (optimistic state). */
  isPending: boolean;
  /** Called when the card body is tapped (navigate to detail screen). */
  onPress: () => void;
  /** Called when the delete action is triggered. */
  onDelete: () => void;
}

export function NoteCard({ record, isPending, onPress, onDelete }: NoteCardProps) {
  const titleField = record.fields['title'];
  const title = typeof titleField?.value === 'string' ? titleField.value : '(untitled)';

  const bodyField = record.fields['body'];
  const bodyPreview =
    typeof bodyField?.value === 'string' && bodyField.value.length > 0
      ? bodyField.value.slice(0, 80)
      : undefined;

  const modDate = record.modificationDate
    ? new Date(record.modificationDate).toLocaleDateString()
    : null;

  return (
    <Pressable
      style={[styles.card, isPending && styles.cardPending]}
      onPress={isPending ? undefined : onPress}
      accessible
      accessibilityRole="button"
      accessibilityLabel={`Note: ${title}${isPending ? ', saving' : ''}`}
    >
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={[styles.title, isPending && styles.textDimmed]} numberOfLines={1}>
            {title}
          </Text>
          {isPending && <ActivityIndicator size="small" color="#888" />}
        </View>

        {bodyPreview !== undefined && (
          <Text style={[styles.preview, isPending && styles.textDimmed]} numberOfLines={2}>
            {bodyPreview}
          </Text>
        )}

        {modDate !== null && (
          <Text style={[styles.date, isPending && styles.textDimmed]}>{modDate}</Text>
        )}
      </View>

      {/* Delete button — shown as a button on web, side icon on native */}
      {Platform.OS === 'web' ? (
        <Pressable
          style={styles.deleteButtonWeb}
          onPress={isPending ? undefined : onDelete}
          accessible
          accessibilityRole="button"
          accessibilityLabel="Delete note"
          disabled={isPending}
        >
          <Text style={styles.deleteButtonText}>Delete</Text>
        </Pressable>
      ) : (
        <Pressable
          style={styles.deleteButtonNative}
          onPress={isPending ? undefined : onDelete}
          accessible
          accessibilityRole="button"
          accessibilityLabel="Delete note"
          disabled={isPending}
        >
          <Text style={styles.deleteIconText}>x</Text>
        </Pressable>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e0e0e0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 2,
    elevation: 1,
  },
  cardPending: {
    opacity: 0.55,
  },
  content: {
    flex: 1,
    gap: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  preview: {
    fontSize: 13,
    color: '#666',
    lineHeight: 18,
  },
  date: {
    fontSize: 11,
    color: '#aaa',
    marginTop: 2,
  },
  textDimmed: {
    color: '#aaa',
  },
  deleteButtonWeb: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: '#ffebee',
  },
  deleteButtonText: {
    color: '#c62828',
    fontSize: 13,
    fontWeight: '600',
  },
  deleteButtonNative: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#ffebee',
    justifyContent: 'center',
    alignItems: 'center',
  },
  deleteIconText: {
    color: '#c62828',
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 16,
  },
});
