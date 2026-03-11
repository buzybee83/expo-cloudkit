/**
 * AccountBanner — displays the current iCloud account status.
 *
 * On web when the account is not authenticated, shows a "Sign in with Apple"
 * button that calls authenticateWeb(). On iOS, authentication is automatic
 * via the device's iCloud account — only the status badge is shown.
 *
 * Demonstrates:
 *   - useAccountStatus() from CloudKitProvider
 *   - isCloudKitAvailable() guard
 *   - authenticateWeb() for web sign-in
 *   - Platform.OS check for web vs iOS branching
 */

import {
  useAccountStatus,
  isCloudKitAvailable,
  authenticateWeb,
} from 'expo-cloudkit';
import React from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import type { AccountStatus } from 'expo-cloudkit';

function statusColor(status: AccountStatus | 'loading'): string {
  switch (status) {
    case 'available':
      return '#2e7d32';
    case 'loading':
      return '#888';
    case 'noAccount':
    case 'restricted':
      return '#c62828';
    case 'couldNotDetermine':
    case 'temporarilyUnavailable':
      return '#e65100';
    default:
      return '#888';
  }
}

function statusLabel(status: AccountStatus | 'loading'): string {
  switch (status) {
    case 'available':
      return 'Signed in to iCloud';
    case 'loading':
      return 'Checking...';
    case 'noAccount':
      return 'No iCloud account';
    case 'restricted':
      return 'Restricted by parental controls';
    case 'couldNotDetermine':
      return 'Could not determine account status';
    case 'temporarilyUnavailable':
      return 'Temporarily unavailable';
    default:
      return String(status);
  }
}

export function AccountBanner() {
  const status = useAccountStatus();
  const available = isCloudKitAvailable();

  const [isSigningIn, setIsSigningIn] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>(undefined);

  async function handleWebSignIn() {
    setIsSigningIn(true);
    setError(undefined);
    try {
      await authenticateWeb();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setIsSigningIn(false);
    }
  }

  return (
    <View style={styles.container}>
      {/* Status badge row */}
      <View style={styles.row}>
        <View style={[styles.dot, { backgroundColor: statusColor(status) }]} />
        <Text style={[styles.statusText, { color: statusColor(status) }]}>
          {statusLabel(status)}
        </Text>
        {status === 'loading' && <ActivityIndicator size="small" style={styles.spinner} />}
      </View>

      {/* CloudKit not available on this platform */}
      {!available && (
        <Text style={styles.hint}>
          CloudKit native APIs are not available on {Platform.OS}. Using CloudKit Web Services.
        </Text>
      )}

      {/* Web: show sign-in button when not yet authenticated */}
      {Platform.OS === 'web' && status !== 'available' && status !== 'loading' && (
        <View style={styles.webSignIn}>
          <Pressable
            style={[styles.signInButton, isSigningIn && styles.signInButtonDisabled]}
            onPress={() => void handleWebSignIn()}
            disabled={isSigningIn}
          >
            {isSigningIn ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.signInButtonText}>Sign in with Apple</Text>
            )}
          </Pressable>
          {error !== undefined && <Text style={styles.errorText}>{error}</Text>}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e0e0e0',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  statusText: {
    fontSize: 15,
    fontWeight: '600',
  },
  spinner: {
    marginLeft: 4,
  },
  hint: {
    fontSize: 12,
    color: '#888',
    lineHeight: 16,
  },
  webSignIn: {
    marginTop: 4,
    gap: 8,
  },
  signInButton: {
    backgroundColor: '#000',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 6,
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  signInButtonDisabled: {
    opacity: 0.5,
  },
  signInButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  errorText: {
    fontSize: 13,
    color: '#c62828',
  },
});
