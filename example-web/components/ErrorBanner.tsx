/**
 * ErrorBanner — displays a CloudKitError with its code and message.
 *
 * Null-safe: renders nothing when error is undefined or null.
 *
 * Demonstrates:
 *   - CloudKitError typed error classes from expo-cloudkit
 *   - error.code for programmatic error handling
 *   - error.message for user-facing display
 */

import type { CloudKitError } from 'expo-cloudkit';
import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

export interface ErrorBannerProps {
  /** The error to display. Renders nothing when undefined or null. */
  error: CloudKitError | Error | undefined | null;
}

export function ErrorBanner({ error }: ErrorBannerProps) {
  if (error == null) {
    return null;
  }

  // CloudKitError instances carry a typed `code` property.
  // Plain Error instances only have `message`.
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;

  return (
    <View style={styles.banner}>
      <View style={styles.row}>
        <Text style={styles.icon}>!</Text>
        <View style={styles.content}>
          {code !== undefined && (
            <Text style={styles.code}>{code}</Text>
          )}
          <Text style={styles.message}>{error.message}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: '#ffebee',
    borderLeftWidth: 4,
    borderLeftColor: '#c62828',
    borderRadius: 4,
    padding: 12,
    marginHorizontal: 16,
    marginVertical: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  icon: {
    fontSize: 16,
    fontWeight: '700',
    color: '#c62828',
    lineHeight: 20,
  },
  content: {
    flex: 1,
    gap: 2,
  },
  code: {
    fontSize: 12,
    fontWeight: '700',
    color: '#c62828',
    fontFamily: Platform.OS === 'web' ? 'monospace' : 'Courier',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  message: {
    fontSize: 14,
    color: '#c62828',
    lineHeight: 19,
  },
});

