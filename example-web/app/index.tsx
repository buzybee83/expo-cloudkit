/**
 * Home screen — account status + sign-in
 *
 * Demonstrates:
 *   - useAccountStatus() — reactive iCloud account status from CloudKitProvider
 *   - useContainerId()   — the active container ID from CloudKitProvider
 *   - authenticateWeb()  — sign-in with Apple ID on web (no-op on iOS)
 *   - isCloudKitAvailable() — guard for non-iOS platforms
 *   - Platform.OS checks for web vs iOS branching
 */

import {
  useAccountStatus,
  useContainerId,
  authenticateWeb,
  isCloudKitAvailable,
} from 'expo-cloudkit';
import { useRouter } from 'expo-router';
import React from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { AccountBanner } from '../components/AccountBanner';

export default function HomeScreen() {
  const accountStatus = useAccountStatus();
  const containerId = useContainerId();
  const router = useRouter();

  const [isSigningIn, setIsSigningIn] = React.useState(false);
  const [signInError, setSignInError] = React.useState<string | undefined>(undefined);

  async function handleWebSignIn() {
    setIsSigningIn(true);
    setSignInError(undefined);
    try {
      await authenticateWeb();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sign-in failed.';
      setSignInError(message);
    } finally {
      setIsSigningIn(false);
    }
  }

  const available = isCloudKitAvailable();

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>expo-cloudkit</Text>
      <Text style={styles.subtitle}>Universal CloudKit Example</Text>

      {/* Account status from CloudKitProvider */}
      <AccountBanner />

      {/* Container info */}
      <View style={styles.infoRow}>
        <Text style={styles.label}>Container:</Text>
        <Text style={styles.value} numberOfLines={1} ellipsizeMode="middle">
          {containerId}
        </Text>
      </View>

      <View style={styles.infoRow}>
        <Text style={styles.label}>Platform:</Text>
        <Text style={styles.value}>{Platform.OS}</Text>
      </View>

      <View style={styles.infoRow}>
        <Text style={styles.label}>CloudKit available:</Text>
        <Text style={[styles.value, { color: available ? '#2e7d32' : '#c62828' }]}>
          {available ? 'Yes' : 'No (web or Android)'}
        </Text>
      </View>

      {/* Web sign-in — only shown on web when not yet signed in */}
      {Platform.OS === 'web' && accountStatus !== 'available' && (
        <View style={styles.signInSection}>
          <Text style={styles.signInHint}>
            On web, sign in with your Apple ID to access your private CloudKit database.
          </Text>
          <Pressable
            style={[styles.signInButton, isSigningIn && styles.signInButtonDisabled]}
            onPress={handleWebSignIn}
            disabled={isSigningIn || accountStatus === 'loading'}
          >
            {isSigningIn ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.signInButtonText}>Sign in with Apple</Text>
            )}
          </Pressable>
          {signInError !== undefined && (
            <Text style={styles.signInError}>{signInError}</Text>
          )}
        </View>
      )}

      {/* iOS — sign-in is automatic via the device iCloud account */}
      {Platform.OS !== 'web' && accountStatus !== 'available' && accountStatus !== 'loading' && (
        <View style={styles.signInSection}>
          <Text style={styles.signInHint}>
            Open Settings → Apple ID to sign in to iCloud on this device.
          </Text>
        </View>
      )}

      {/* Navigate to Notes screen */}
      <Pressable
        style={[
          styles.notesButton,
          accountStatus !== 'available' && styles.notesButtonDisabled,
        ]}
        onPress={() => router.push('/notes')}
        disabled={accountStatus !== 'available'}
      >
        <Text style={styles.notesButtonText}>View Notes</Text>
      </Pressable>

      {accountStatus !== 'available' && accountStatus !== 'loading' && (
        <Text style={styles.disabledHint}>Sign in to iCloud to view notes.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    backgroundColor: '#f5f5f5',
  },
  heading: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    marginBottom: 24,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
    gap: 8,
  },
  label: {
    fontSize: 14,
    color: '#555',
    fontWeight: '600',
    minWidth: 130,
  },
  value: {
    flex: 1,
    fontSize: 14,
    color: '#333',
  },
  signInSection: {
    marginTop: 24,
    gap: 12,
  },
  signInHint: {
    fontSize: 14,
    color: '#555',
    lineHeight: 20,
  },
  signInButton: {
    backgroundColor: '#000',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 8,
    alignItems: 'center',
  },
  signInButtonDisabled: {
    opacity: 0.5,
  },
  signInButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  signInError: {
    color: '#c62828',
    fontSize: 13,
  },
  notesButton: {
    marginTop: 32,
    backgroundColor: '#1565c0',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 8,
    alignItems: 'center',
  },
  notesButtonDisabled: {
    backgroundColor: '#90a4ae',
  },
  notesButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  disabledHint: {
    marginTop: 8,
    fontSize: 13,
    color: '#888',
    textAlign: 'center',
  },
});
