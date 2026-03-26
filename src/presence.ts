/**
 * expo-cloudkit — Phase K.1: Presence & Cursors
 *
 * React hook for real-time presence tracking in a shared CloudKit zone.
 *
 * Presence state is stored as `ExpoPresence` CKRecord instances in the shared
 * zone. Updates propagate via the existing CKSyncEngine / iOS-16 fallback
 * pipeline. Latency is typically 1–5 seconds — suitable for "User X is here"
 * indicators but not for sub-second, character-level collaboration.
 *
 * Requirements:
 * - The module must be configured (`configure(containerId)`) before mounting.
 * - The sync engine must be running for the target zone (`startSyncEngine()`).
 * - The zone must be a shared zone (created via CKShare) so other participants
 *   can read/write the ExpoPresence records within it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  addPresenceListener,
  getPresence,
  startPresence,
  stopPresence,
  updatePresenceCursor,
  updatePresenceStatus,
} from './ExpoCloudKit';
import type {
  DatabaseScope,
  PresenceChangedEvent,
  PresenceEntry,
  StartPresenceOptions,
} from './types';

// ---------------------------------------------------------------------------
// usePresence hook
// ---------------------------------------------------------------------------

/**
 * React hook for real-time presence in a shared CloudKit zone.
 *
 * Calling this hook:
 * 1. Calls `startPresence` on mount to write the local user's presence record.
 * 2. Subscribes to `onPresenceChanged` events and maintains a live `participants` list.
 * 3. Calls `stopPresence` on unmount to delete the local presence record.
 *
 * @param zoneName - The shared zone to track presence in.
 * @param options  - Display name, database scope, initial status, metadata.
 * @returns An object with:
 *   - `participants` — All currently online participants (excluding the local user by default).
 *   - `allParticipants` — Online participants including the local user.
 *   - `setStatus` — Updates the local user's status.
 *   - `setCursor` — Updates the local user's cursor position (debounced 500 ms).
 *   - `isReady` — True once `startPresence` has resolved.
 *
 * @example
 * ```typescript
 * const { participants, setStatus, setCursor } = usePresence('SharedNotes');
 *
 * // Show avatars for all other online users
 * return participants.map(p => <Avatar key={p.userRecordName} entry={p} />);
 * ```
 */
export function usePresence(
  zoneName: string,
  options?: {
    database?: DatabaseScope;
    displayName?: string;
    status?: StartPresenceOptions['status'];
    metadata?: Record<string, unknown>;
  }
): {
  /** Currently online participants (other users only — excludes the local user). */
  participants: PresenceEntry[];
  /** Currently online participants including the local user. */
  allParticipants: PresenceEntry[];
  /** Updates the local user's status. Writes to CloudKit immediately. */
  setStatus: (status: 'active' | 'idle' | 'editing') => void;
  /** Updates the local user's cursor position. Debounced 500 ms before writing. */
  setCursor: (cursor: Record<string, unknown>) => void;
  /** True once `startPresence` has resolved and presence is active. */
  isReady: boolean;
} {
  const [allParticipants, setAllParticipants] = useState<PresenceEntry[]>([]);
  const [isReady, setIsReady] = useState(false);
  const zoneNameRef = useRef(zoneName);
  const databaseRef = useRef(options?.database ?? 'shared');

  // Keep latest zoneName/database in refs so callbacks don't close over stale values
  useEffect(() => {
    zoneNameRef.current = zoneName;
  }, [zoneName]);

  useEffect(() => {
    databaseRef.current = options?.database ?? 'shared';
  }, [options?.database]);

  useEffect(() => {
    let mounted = true;

    const presenceOptions: StartPresenceOptions = {
      zoneName,
      database: options?.database ?? 'shared',
      displayName: options?.displayName,
      status: options?.status ?? 'active',
      metadata: options?.metadata,
    };

    // Start presence — fetch existing participants after we are registered.
    startPresence(presenceOptions)
      .then(() => {
        if (!mounted) return;
        setIsReady(true);
        return getPresence({ zoneName, database: presenceOptions.database });
      })
      .then((initial) => {
        if (!mounted || !initial) return;
        setAllParticipants(initial);
      })
      .catch(() => {
        // startPresence failed (e.g. not configured, not authenticated).
        // Presence will not be active — isReady stays false.
      });

    // Subscribe to ongoing presence changes for this zone.
    const subscription = addPresenceListener((event: PresenceChangedEvent) => {
      if (event.zoneName !== zoneNameRef.current) return;

      setAllParticipants((prev) => {
        const { participant, changeType } = event;

        if (changeType === 'left') {
          // Remove departed participant
          return prev.filter((p) => p.userRecordName !== participant.userRecordName);
        }

        // joined or updated — upsert
        const idx = prev.findIndex((p) => p.userRecordName === participant.userRecordName);
        if (idx === -1) {
          return [...prev, participant];
        }
        const updated = [...prev];
        updated[idx] = participant;
        return updated;
      });
    });

    return () => {
      mounted = false;
      subscription.remove();
      // Best-effort stop — if the app is force-killed, the record persists until
      // another client observes the stale lastSeen and emits a 'left' event locally.
      stopPresence({ zoneName, database: presenceOptions.database }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneName, options?.database]);

  const setStatus = useCallback(
    (status: 'active' | 'idle' | 'editing') => {
      updatePresenceStatus({ zoneName: zoneNameRef.current, status }).catch(() => {});
    },
    []
  );

  const setCursor = useCallback((cursor: Record<string, unknown>) => {
    updatePresenceCursor({ zoneName: zoneNameRef.current, cursor }).catch(() => {});
  }, []);

  const participants = allParticipants.filter((p) => !p.isCurrentUser);

  return { participants, allParticipants, setStatus, setCursor, isReady };
}
