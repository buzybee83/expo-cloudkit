/**
 * expo-cloudkit — CloudKitDevTools overlay (Phase N.3)
 *
 * A dev-only floating overlay that displays real-time CloudKit state.
 * Renders null in production (__DEV__ === false).
 *
 * Inspired by React Query DevTools and Redux DevTools Extension.
 *
 * @example
 * ```tsx
 * // In your root layout (App.tsx or _layout.tsx):
 * import { CloudKitDevTools } from 'expo-cloudkit';
 *
 * export default function App() {
 *   return (
 *     <>
 *       <YourAppContent />
 *       <CloudKitDevTools position="bottom-right" />
 *     </>
 *   );
 * }
 * ```
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import {
  addAccountStatusListener,
  addSyncEngineListener,
  addSyncHealthListener,
  getOfflineQueueStatus,
} from '../ExpoCloudKit';
import type {
  AccountStatus,
  OfflineQueueStatus,
  SyncConflictEvent,
  SyncEngineEvent,
  SyncHealthEvent,
  SyncStateMap,
} from '../types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Props for the CloudKitDevTools overlay.
 */
export interface CloudKitDevToolsProps {
  /**
   * Corner where the toggle button is anchored.
   * @default 'bottom-right'
   */
  position?: 'bottom-right' | 'bottom-left';
  /**
   * Whether the panel starts open.
   * @default false
   */
  initiallyOpen?: boolean;
}

// ---------------------------------------------------------------------------
// Internal state types
// ---------------------------------------------------------------------------

interface SyncScopeRow {
  scope: string;
  status: string;
  usesSyncEngine: boolean;
}

// ---------------------------------------------------------------------------
// Sub-panels
// ---------------------------------------------------------------------------

function SectionHeader({ title }: { title: string }): React.JSX.Element {
  return <Text style={styles.sectionHeader}>{title}</Text>;
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

// SyncStatus panel
function SyncStatusPanel({ rows }: { rows: SyncScopeRow[] }): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <View>
        <SectionHeader title="Sync Status" />
        <Text style={styles.dimText}>No sync engine started</Text>
      </View>
    );
  }

  return (
    <View>
      <SectionHeader title="Sync Status" />
      {rows.map((r) => (
        <View key={r.scope} style={styles.card}>
          <Row label="Scope" value={r.scope} />
          <Row label="Status" value={r.status} />
          <Row label="Engine" value={r.usesSyncEngine ? 'CKSyncEngine (iOS 17+)' : 'Fallback (iOS 16)'} />
        </View>
      ))}
    </View>
  );
}

// Queue depth panel
function QueuePanel({ queue }: { queue: OfflineQueueStatus | null }): React.JSX.Element {
  return (
    <View>
      <SectionHeader title="Offline Queue" />
      {queue === null ? (
        <Text style={styles.dimText}>Loading…</Text>
      ) : (
        <View style={styles.card}>
          <Row label="Pending" value={String(queue.pending)} />
          <Row label="Retrying" value={String(queue.retrying)} />
          <Row label="Failed" value={String(queue.failed)} />
          <Row label="Total" value={String(queue.total)} />
        </View>
      )}
    </View>
  );
}

// Sync health panel
function SyncHealthPanel({ health }: { health: SyncHealthEvent | null }): React.JSX.Element {
  return (
    <View>
      <SectionHeader title="Sync Health" />
      {health === null ? (
        <Text style={styles.dimText}>Awaiting first sync cycle…</Text>
      ) : (
        <View style={styles.card}>
          <Row label="Scope" value={health.databaseScope} />
          <Row label="Sent" value={String(health.sentCount)} />
          <Row label="Received" value={String(health.receivedCount)} />
          <Row label="Failed" value={String(health.failedCount)} />
          <Row label="Duration" value={`${health.durationMs}ms`} />
        </View>
      )}
    </View>
  );
}

// Account status panel
function AccountStatusPanel({ status }: { status: AccountStatus | null }): React.JSX.Element {
  const color =
    status === 'available' ? '#4caf50'
    : status === null ? '#aaa'
    : '#f44336';

  return (
    <View>
      <SectionHeader title="Account Status" />
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Status</Text>
          <Text style={[styles.rowValue, { color }]}>{status ?? 'unknown'}</Text>
        </View>
      </View>
    </View>
  );
}

// Conflict log panel
function ConflictLogPanel({ conflicts }: { conflicts: SyncConflictEvent[] }): React.JSX.Element {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const toggleRow = useCallback((idx: number) => {
    setExpandedIdx((prev) => (prev === idx ? null : idx));
  }, []);

  return (
    <View>
      <SectionHeader title={`Conflict Log (${conflicts.length})`} />
      {conflicts.length === 0 ? (
        <Text style={styles.dimText}>No conflicts recorded</Text>
      ) : (
        conflicts.map((c, idx) => (
          <TouchableOpacity
            key={c.requestId}
            onPress={() => toggleRow(idx)}
            style={styles.card}
            activeOpacity={0.7}
          >
            <View style={styles.row}>
              <Text style={styles.rowLabel}>{c.databaseScope}</Text>
              <Text style={styles.rowValue}>
                {typeof c.clientRecord === 'object' && c.clientRecord !== null && 'recordType' in c.clientRecord
                  ? String((c.clientRecord as { recordType?: unknown }).recordType ?? '—')
                  : '—'}
                {expandedIdx === idx ? ' ▲' : ' ▼'}
              </Text>
            </View>
            {expandedIdx === idx && (
              <Text style={styles.conflictDetail}>
                {`requestId: ${c.requestId}`}
              </Text>
            )}
          </TouchableOpacity>
        ))
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Floating dev overlay that displays real-time CloudKit state.
 *
 * Renders null when `__DEV__` is false, so it is safe to leave in production
 * builds — it will be dead code-eliminated by the bundler.
 *
 * Mount it once near the root of your component tree, above any navigation
 * containers, so it appears on top of all screens.
 */
export function CloudKitDevTools(props: CloudKitDevToolsProps): React.JSX.Element | null {
  if (!__DEV__) return null;

  return <CloudKitDevToolsInner {...props} />;
}

// Extracted so hooks run unconditionally within this component boundary.
function CloudKitDevToolsInner({
  position = 'bottom-right',
  initiallyOpen = false,
}: CloudKitDevToolsProps): React.JSX.Element {
  const [open, setOpen] = useState(initiallyOpen);
  const [accountStatus, setAccountStatus] = useState<AccountStatus | null>(null);
  const [syncRows, setSyncRows] = useState<SyncScopeRow[]>([]);
  const [queueStatus, setQueueStatus] = useState<OfflineQueueStatus | null>(null);
  const [lastHealth, setLastHealth] = useState<SyncHealthEvent | null>(null);
  const [conflicts, setConflicts] = useState<SyncConflictEvent[]>([]);

  // Track the live SyncStateMap across all scopes
  const syncStateRef = useRef<SyncStateMap>({});

  const positionStyle = position === 'bottom-left' ? styles.anchorLeft : styles.anchorRight;

  // ---- Account status subscription ----------------------------------------
  useEffect(() => {
    const sub = addAccountStatusListener((status: AccountStatus) => {
      setAccountStatus(status);
    });
    return () => sub.remove();
  }, []);

  // ---- Sync engine subscription -------------------------------------------
  useEffect(() => {
    const sub = addSyncEngineListener((event: SyncEngineEvent) => {
      if (event.type === 'stateChanged') {
        const updated: SyncStateMap = {
          ...syncStateRef.current,
          [event.databaseScope]: {
            usesSyncEngine: false, // filled in from next getSyncState() if needed
            status: event.state.status,
          },
        };
        syncStateRef.current = updated;
        const rows: SyncScopeRow[] = Object.entries(updated).map(([scope, state]) => ({
          scope,
          status: state?.status ?? 'unknown',
          usesSyncEngine: state?.usesSyncEngine ?? false,
        }));
        setSyncRows(rows);
      }

      if (event.type === 'conflict') {
        setConflicts((prev) => {
          const next = [event, ...prev];
          // Keep only the last 10
          return next.slice(0, 10);
        });
      }
    });

    return () => sub.remove();
  }, []);

  // ---- Sync health subscription -------------------------------------------
  useEffect(() => {
    const sub = addSyncHealthListener((event: SyncHealthEvent) => {
      setLastHealth(event);
    });
    return () => sub.remove();
  }, []);

  // ---- Queue depth polling (every 2s when panel is open) ------------------
  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    const poll = async (): Promise<void> => {
      try {
        const status = await getOfflineQueueStatus();
        if (!cancelled) setQueueStatus(status);
      } catch {
        // Queue not available (e.g. non-iOS); leave null
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), 2000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open]);

  // ---- Toggle button -------------------------------------------------------
  const toggleOpen = useCallback(() => setOpen((prev) => !prev), []);

  return (
    <View style={[styles.container, positionStyle]} pointerEvents="box-none">
      {open && (
        <View style={styles.panel}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelTitle}>CloudKit DevTools</Text>
            <TouchableOpacity onPress={toggleOpen} hitSlop={styles.hitSlop}>
              <Text style={styles.closeBtn}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.scrollArea} showsVerticalScrollIndicator={false}>
            <AccountStatusPanel status={accountStatus} />
            <SyncStatusPanel rows={syncRows} />
            <QueuePanel queue={queueStatus} />
            <SyncHealthPanel health={lastHealth} />
            <ConflictLogPanel conflicts={conflicts} />
            <View style={styles.spacer} />
          </ScrollView>
        </View>
      )}

      <TouchableOpacity
        style={styles.toggleButton}
        onPress={toggleOpen}
        activeOpacity={0.8}
      >
        <Text style={styles.toggleButtonText}>{open ? '▼ CK' : '▲ CK'}</Text>
      </TouchableOpacity>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const PANEL_WIDTH = 300;
const PANEL_HEIGHT = 420;

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 40,
    zIndex: 9999,
    elevation: 9999,
    alignItems: 'flex-end',
  },
  anchorRight: {
    right: 12,
  },
  anchorLeft: {
    left: 12,
    alignItems: 'flex-start',
  },

  // Panel
  panel: {
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    backgroundColor: 'rgba(18, 18, 24, 0.95)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    marginBottom: 8,
    overflow: 'hidden',
  },
  panelHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  panelTitle: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
    letterSpacing: 0.4,
  },
  closeBtn: {
    color: '#aaa',
    fontSize: 16,
  },
  scrollArea: {
    flex: 1,
    paddingHorizontal: 12,
    paddingTop: 8,
  },

  // Sections
  sectionHeader: {
    color: '#7dd3fc',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: 12,
    marginBottom: 4,
  },
  card: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
  },
  rowLabel: {
    color: '#9ca3af',
    fontSize: 12,
  },
  rowValue: {
    color: '#e5e7eb',
    fontSize: 12,
    fontWeight: '500',
    flexShrink: 1,
    textAlign: 'right',
    marginLeft: 8,
  },
  dimText: {
    color: '#6b7280',
    fontSize: 12,
    fontStyle: 'italic',
    marginBottom: 4,
  },
  conflictDetail: {
    color: '#9ca3af',
    fontSize: 11,
    marginTop: 4,
    fontFamily: 'monospace' as const,
  },
  spacer: {
    height: 16,
  },

  // Toggle button
  toggleButton: {
    backgroundColor: 'rgba(30, 30, 45, 0.9)',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  toggleButtonText: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '600',
  },
  hitSlop: {
    top: 8,
    bottom: 8,
    left: 8,
    right: 8,
  },
});
