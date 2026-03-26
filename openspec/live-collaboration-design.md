# Phase K: Live Collaboration Features

**Date**: 2026-03-25
**Status**: Proposed
**Author**: architect
**Module version**: 0.19.0

---

## Context

expo-cloudkit v0.19.0 ships with a mature CloudKit integration: CKSyncEngine
(iOS 17+), iOS 16 manual-fetch fallback, multi-scope sync, encrypted fields,
CKShare with participant management, push subscriptions, conflict resolution
strategies (server-wins, client-wins, field-level merge, manual), and offline
queue support.

This document designs three features that extend the module toward live,
multi-user collaboration:

- **K.1** Presence & Cursors -- real-time awareness of who is active in a
  shared zone
- **K.2** CRDT-Based Conflict Resolution -- opt-in conflict-free automatic
  merging for structured field types
- **K.3** Live Activities / Widgets Integration -- bridging CloudKit record
  changes into ActivityKit and WidgetKit extensions

All three features build on existing module primitives (sync engine, push
subscriptions, config plugin) and follow the thin-wrapper principle: mirror
CloudKit semantics in the JS API rather than hiding them.

---

## Feature K.1: Presence & Cursors

### Problem

Users collaborating on a shared zone have no way to see who else is active.
This is table stakes for collaboration UX -- showing avatars, cursor positions,
or "User X is editing" indicators.

### Questions & Answers

#### How is presence state stored in CloudKit?

**Answer: Dedicated record type in the shared zone.**

CloudKit has no built-in presence primitive. The options are:

| Option | Mechanism | Pros | Cons |
|--------|-----------|------|------|
| A | Dedicated `_Presence` record type in the shared zone | Uses existing sync; participants auto-receive updates; naturally scoped to the share | One record per user per zone; needs cleanup |
| B | Zone-level metadata field (CKRecordZone custom fields) | Lighter weight | CKRecordZone does not support custom fields; not viable |
| C | Out-of-band signaling (e.g., APNs data payload) | Lowest latency | Requires server-side relay; violates "no backend" constraint |

**Recommendation: Option A.** Store a `CKRecord` of type `ExpoPresence` in the
shared zone. One record per participant per zone, keyed by
`presence-<userRecordName>` as the record name.

Record schema:

| Field | CKRecord type | JS type | Purpose |
|-------|---------------|---------|---------|
| `userId` | String | string | `CKCurrentUserDefaultName` resolved at write time |
| `displayName` | String | string | User-provided display name |
| `lastSeen` | Date | number (Unix ms) | Heartbeat timestamp |
| `status` | String | string | `'active'` / `'idle'` / `'editing'` |
| `cursor` | String (JSON) | `PresenceCursor \| null` | Serialized cursor position -- app-defined structure |
| `metadata` | String (JSON) | `Record<string, unknown> \| null` | Arbitrary app-specific data (color, avatar URL, etc.) |

Why a dedicated record type instead of a shadow field on existing records:
- Presence is ephemeral; mixing it with business records pollutes change
  histories and triggers unnecessary conflict resolution.
- A separate record type can be filtered out of `onRecordsFetched` events
  and routed to a dedicated presence event stream.
- Cleanup (removing stale entries) does not risk corrupting business data.

#### How are updates propagated?

**Answer: CKSyncEngine + CKDatabaseSubscription (existing infrastructure).**

Presence records live in the shared zone alongside business records. The
existing sync engine already tracks shared zones and emits `onRecordsFetched`
events. When a presence record arrives, the Swift layer:

1. Detects the `ExpoPresence` record type in `handleFetchedRecords`.
2. Strips it from the normal `recordsFetched` event (business records only).
3. Emits a separate `onPresenceChanged` event with the parsed presence entry.

This reuses existing sync infrastructure with zero new CloudKit API calls.
No additional push subscription is needed -- the database subscription that
drives CKSyncEngine already covers all record types in the zone.

On iOS 16 (fallback adapter), presence records arrive via the same
`CKFetchRecordZoneChangesOperation` polling loop. Latency is limited by the
poll interval (default 30 seconds), which is acceptable for presence but not
ideal. The design does not attempt to solve iOS 16 latency -- it is what it is.

#### What is the heartbeat mechanism?

**Answer: Client-side timer, 30-second interval, 90-second offline threshold.**

```
Heartbeat interval:  30 seconds
Offline threshold:   90 seconds (3 missed heartbeats)
Idle threshold:      5 minutes of no cursor updates (app reports 'idle' status)
```

The heartbeat is a `saveRecords` call that updates the `lastSeen` field on the
user's presence record. This piggybacks on CKSyncEngine's batched saves --
the record is enqueued via `enqueueSave`, not sent as a standalone operation.

**Rate limit analysis:** CloudKit allows ~40 requests/second per user. A single
record save every 30 seconds is negligible. Even with 10 participants in a
zone, that is 10 saves/30s = 0.33 req/s -- well within limits.

For cursor updates (more frequent), the module coalesces: cursor position
changes are buffered for 500ms before enqueueing a save. This means cursor
updates arrive at other clients with ~1-2 second latency (500ms coalesce +
CKSyncEngine batch interval), which is adequate for "User X is here" but not
for Google Docs-style real-time character-by-character cursors.

**This is a deliberate constraint.** CloudKit is not a real-time database.
Sub-second cursor sync is not achievable without an out-of-band channel
(WebSocket, Firebase RTDB, etc.). The design document states this clearly so
callers set correct expectations.

#### How do you handle stale presence entries?

**Answer: Three-layer cleanup.**

1. **Active cleanup (app foreground):** On each heartbeat cycle, the Swift
   layer checks all cached presence entries. Any entry with
   `lastSeen < now - 90s` is marked offline locally and a delete operation is
   enqueued if the stale record belongs to the current user.

2. **Departure cleanup (app background/terminate):** When the sync engine
   stops (`stopSyncEngine`), the module deletes the current user's presence
   record as the final operation. This is best-effort -- if the app is
   force-killed, the record persists until another client cleans it up.

3. **Passive cleanup (other clients):** Any client that observes a presence
   record with `lastSeen` older than the offline threshold treats it as stale
   in the JS event. The JS layer receives `status: 'offline'` and can choose
   to display or hide it. The stale record is not deleted by other clients --
   only the owner deletes their own presence record, avoiding conflicting
   deletes.

Network failures during heartbeat: If a save fails (e.g., network down), the
module does not retry immediately. CKSyncEngine will retry on its next cycle.
If the user is truly offline, other clients will see their `lastSeen` drift
past the threshold and mark them offline. When connectivity resumes, the next
heartbeat restores presence.

#### What is the JS API surface?

```typescript
// --- Types ---

/** Structured cursor position -- app-defined, opaque to the module. */
export interface PresenceCursor {
  /** Application-defined position identifier (e.g., record name being edited). */
  position: string;
  /** Optional structured data (e.g., { field: 'title', offset: 42 }). */
  data?: Record<string, unknown>;
}

/** A single user's presence state in a shared zone. */
export interface PresenceEntry {
  /** CKCurrentUserDefaultName-resolved user record name. */
  userId: string;
  /** Display name provided by the user. */
  displayName: string;
  /** Unix ms timestamp of last heartbeat. */
  lastSeen: number;
  /** Current status. 'offline' is synthesized client-side when lastSeen is stale. */
  status: 'active' | 'idle' | 'editing' | 'offline';
  /** Optional cursor position. Null when no cursor is set. */
  cursor: PresenceCursor | null;
  /** App-specific metadata (avatar URL, color, etc.). */
  metadata: Record<string, unknown> | null;
  /** Whether this entry belongs to the current device's user. */
  isCurrentUser: boolean;
}

/** Options for starting presence tracking. */
export interface PresenceOptions {
  /** Zone name to track presence in. Must be a shared zone. */
  zoneName: string;
  /** Display name for the current user. */
  displayName: string;
  /** Database scope. Default: 'shared'. */
  databaseScope?: DatabaseScope;
  /** Heartbeat interval in ms. Default: 30000. Min: 10000. */
  heartbeatInterval?: number;
  /** Seconds before a user is considered offline. Default: 90. */
  offlineThreshold?: number;
  /** Optional initial metadata. */
  metadata?: Record<string, unknown>;
}

// --- Functions ---

/** Start broadcasting presence and listening for other participants. */
export function startPresence(options: PresenceOptions): Promise<void>;

/** Stop broadcasting presence. Deletes the current user's presence record. */
export function stopPresence(zoneName: string): Promise<void>;

/** Update the current user's cursor position. Coalesced (500ms debounce). */
export function updatePresenceCursor(
  zoneName: string,
  cursor: PresenceCursor | null,
): Promise<void>;

/** Update the current user's status. */
export function updatePresenceStatus(
  zoneName: string,
  status: 'active' | 'idle' | 'editing',
): Promise<void>;

/** Update the current user's metadata. */
export function updatePresenceMetadata(
  zoneName: string,
  metadata: Record<string, unknown>,
): Promise<void>;

/** Get a snapshot of all presence entries for a zone. */
export function getPresenceEntries(
  zoneName: string,
): Promise<PresenceEntry[]>;

/** Subscribe to presence changes. Fires on every heartbeat or cursor update. */
export function addPresenceListener(
  callback: (entries: PresenceEntry[]) => void,
): Subscription;

// --- React Hook ---

/**
 * React hook for presence tracking.
 *
 * Starts presence on mount, stops on unmount. Returns the current list of
 * participants and a setter for the local cursor.
 *
 * @example
 * ```tsx
 * const { entries, setCursor, setStatus } = usePresence({
 *   zoneName: 'my-shared-zone',
 *   displayName: 'Alice',
 * });
 *
 * // Show who is online
 * entries.filter(e => e.status !== 'offline').map(e => <Avatar key={e.userId} ... />)
 *
 * // Update cursor when user taps a record
 * setCursor({ position: recordName });
 * ```
 */
export function usePresence(options: PresenceOptions): {
  entries: PresenceEntry[];
  setCursor: (cursor: PresenceCursor | null) => void;
  setStatus: (status: 'active' | 'idle' | 'editing') => void;
  setMetadata: (metadata: Record<string, unknown>) => void;
};
```

### Swift Architecture

```
ExpoCloudKitModule.swift
  ├── AsyncFunction("startPresence")   →  CloudKitPresenceManager.start()
  ├── AsyncFunction("stopPresence")    →  CloudKitPresenceManager.stop()
  ├── AsyncFunction("updatePresenceCursor")  →  .updateCursor()
  ├── AsyncFunction("updatePresenceStatus")  →  .updateStatus()
  ├── Function("getPresenceEntries")   →  .getEntries()
  └── Events("onPresenceChanged")

CloudKitPresenceManager.swift (new file)
  ├── Manages one PresenceSession per zone
  ├── PresenceSession:
  │     ├── heartbeatTimer: Timer (30s, saves presence record via sync engine)
  │     ├── cursorCoalesceTimer: Timer (500ms debounce)
  │     ├── presenceCache: [String: PresenceEntry]
  │     ├── currentUserRecordName: String
  │     └── offlineThreshold: TimeInterval
  └── Integrates with CloudKitSyncProvider:
        ├── enqueueSave() for heartbeat and cursor updates
        └── Filters incoming records: ExpoPresence → onPresenceChanged,
            everything else → normal sync events
```

```swift
// ios/CloudKitPresenceManager.swift — key types

import CloudKit
import Foundation

/// Record type constant used for presence records in shared zones.
let kPresenceRecordType = "ExpoPresence"

/// Manages presence sessions across multiple shared zones.
/// One instance per ExpoCloudKitModule lifecycle.
final class CloudKitPresenceManager {

  /// Active sessions keyed by zoneName.
  private var sessions: [String: PresenceSession] = [:]

  /// Called by the sync engine when records are fetched.
  /// Returns true if the record was a presence record (and was consumed),
  /// false if it should be forwarded to the normal recordsFetched event.
  func handleFetchedRecord(_ record: CKRecord) -> Bool {
    guard record.recordType == kPresenceRecordType else { return false }
    // Parse, update cache, emit event
    return true
  }

  func start(
    zoneName: String,
    displayName: String,
    database: CKDatabase.Scope,
    syncProvider: CloudKitSyncProvider,
    heartbeatInterval: TimeInterval,
    offlineThreshold: TimeInterval,
    metadata: [String: Any]?
  ) async { /* ... */ }

  func stop(zoneName: String) async { /* ... */ }
}
```

### Risks & Constraints

| Risk | Severity | Mitigation |
|------|----------|------------|
| CloudKit is not real-time; cursor updates have 1-2s latency minimum | Medium | Document clearly; do not promise sub-second updates |
| Presence records count toward zone storage quota (100MB default) | Low | Records are tiny (~200 bytes); 100 users = 20KB |
| Force-killed app leaves stale presence record | Low | Other clients age it out via offlineThreshold; eventual cleanup |
| iOS 16 fallback has 30s poll interval for presence | Medium | Acceptable for "who is online" but poor for cursors; document limitation |
| Heartbeat saves could conflict with business record saves | Low | CKSyncEngine batches all pending saves; no special handling needed |
| Rate limits with many participants + short heartbeats | Low | 30s interval is conservative; min 10s enforced; coalescing for cursors |

---

## Feature K.2: CRDT-Based Conflict Resolution

### Problem

The existing conflict strategies (`serverWins`, `clientWins`, `fieldLevelMerge`,
`manual`) handle conflicts after they occur. For certain field types --
counters, sets, collaborative text -- conflicts are inevitable in multi-user
scenarios and the merge semantics are well-defined. A CRDT layer can resolve
these automatically without user intervention.

### Questions & Answers

#### Which CRDT types are most useful for CloudKit apps?

| CRDT | Use Case | Complexity | Priority |
|------|----------|------------|----------|
| LWW-Register | Single-value fields (title, status) | Low | P0 -- most common |
| G-Counter | Monotonically increasing counters (view count, likes) | Low | P0 |
| PN-Counter | Counters that increment and decrement (inventory, votes) | Low | P0 |
| OR-Set (Observed-Remove Set) | Tag lists, participant lists, selected items | Medium | P1 |
| RGA (Replicated Growable Array) | Collaborative text editing | High | P2 -- defer to Phase L |

**Recommendation:** Ship K.2 with LWW-Register, G-Counter, PN-Counter, and
OR-Set. Defer RGA to a future phase -- collaborative text editing requires
significant additional complexity (operational transform or CRDT-based text
like Yjs/Automerge) that is out of scope for a thin CloudKit wrapper.

#### How are CRDT state vectors stored on a CKRecord?

**Answer: Shadow fields with a `__crdt_` prefix on the same record.**

Three options considered:

| Option | Storage | Pros | Cons |
|--------|---------|------|------|
| A | Single JSON field (`__crdt_state`) containing all CRDT metadata | Simple; one field to manage | Entire CRDT state re-sent on any field change; JSON parsing overhead |
| B | Per-field shadow field (`__crdt_<fieldName>`) | Granular; only changed CRDT state is synced | More fields per record; approaches 750-field limit faster |
| C | Separate shadow CKRecord linked by reference | Clean separation | Two records to keep in sync; reference integrity risk |

**Recommendation: Option B -- per-field shadow fields.**

Each CRDT-enabled field `foo` gets a companion field `__crdt_foo` that stores
the CRDT metadata as a JSON-encoded string. This keeps CRDT state co-located
with the record (no reference integrity issues) and allows field-level sync
(only changed fields are transmitted).

Example record with a PN-Counter field `voteCount`:

```
CKRecord "item-123":
  voteCount:        42          (Number -- materialized value for queries)
  __crdt_voteCount: "{\"type\":\"pn-counter\",\"p\":{\"node-a\":10,\"node-b\":15},\"n\":{\"node-a\":1,\"node-b\":-1, ...}}"
```

The materialized value (`voteCount: 42`) is always kept in sync so that
CloudKit predicates (`NSPredicate`) and sorting work on CRDT fields without
special handling. The shadow field is the source of truth for merge.

**Field size constraint:** CloudKit allows 1MB per field. A PN-Counter with
1000 unique node IDs (one per device, not per user) would be ~50KB of JSON.
This is well within limits for counters and sets. OR-Set with thousands of
elements could approach the limit -- the design includes a compaction step
(see garbage collection below).

#### How does this interact with existing conflictStrategy?

The CRDT layer sits **below** the conflict strategy layer in the resolution
pipeline:

```
CKSyncEngine detects conflict (server rejected save)
  │
  ├── Record has CRDT fields?
  │     YES → CRDTMerger merges CRDT fields using their type-specific
  │     │     algorithms. Non-CRDT fields use the active conflictStrategy.
  │     │     Result: merged record re-enqueued.
  │     │
  │     NO  → Existing conflictStrategy applies unchanged.
  │
  └── (no change to existing behavior for non-CRDT records)
```

When `conflictStrategy` is `manual` and the record has CRDT fields, the CRDT
fields are pre-merged in the conflict payload sent to JS. The JS caller sees
already-resolved CRDT fields and only needs to decide on non-CRDT fields.

This means CRDT resolution is always automatic -- it does not participate in
the manual flow. This is by design: CRDTs are conflict-free by definition;
surfacing them for manual resolution defeats the purpose.

#### What does the Swift merge implementation look like?

```swift
// ios/CRDTMerger.swift (new file)

import CloudKit
import Foundation

/// CRDT type tag stored in the __crdt_ shadow field JSON.
enum CRDTType: String, Codable {
  case lwwRegister = "lww-register"
  case gCounter = "g-counter"
  case pnCounter = "pn-counter"
  case orSet = "or-set"
}

/// Envelope for all CRDT shadow field payloads.
struct CRDTEnvelope: Codable {
  let type: CRDTType
  /// Raw JSON payload -- decoded by type-specific merger.
  let state: Data
}

/// Merges two versions of a CRDT field and returns the merged value + updated
/// shadow state.
///
/// - Parameters:
///   - clientShadow: JSON from the client record's `__crdt_<field>` field
///   - serverShadow: JSON from the server record's `__crdt_<field>` field
/// - Returns: Tuple of (materializedValue, mergedShadowJSON)
enum CRDTMerger {

  static func merge(
    clientShadow: String,
    serverShadow: String
  ) throws -> (Any, String) {
    let clientEnv = try JSONDecoder().decode(CRDTEnvelope.self, from: Data(clientShadow.utf8))
    let serverEnv = try JSONDecoder().decode(CRDTEnvelope.self, from: Data(serverShadow.utf8))

    guard clientEnv.type == serverEnv.type else {
      throw CRDTError.typeMismatch(client: clientEnv.type, server: serverEnv.type)
    }

    switch clientEnv.type {
    case .lwwRegister:
      return try LWWRegisterMerger.merge(client: clientEnv.state, server: serverEnv.state)
    case .gCounter:
      return try GCounterMerger.merge(client: clientEnv.state, server: serverEnv.state)
    case .pnCounter:
      return try PNCounterMerger.merge(client: clientEnv.state, server: serverEnv.state)
    case .orSet:
      return try ORSetMerger.merge(client: clientEnv.state, server: serverEnv.state)
    }
  }
}
```

**LWW-Register** (Last-Writer-Wins Register):

```swift
struct LWWRegisterState: Codable {
  let value: AnyCodable   // The wrapped value
  let timestamp: Double   // Unix ms -- wall clock at write time
  let nodeId: String      // Writer's device/node ID
}

enum LWWRegisterMerger {
  static func merge(client: Data, server: Data) throws -> (Any, String) {
    let c = try JSONDecoder().decode(LWWRegisterState.self, from: client)
    let s = try JSONDecoder().decode(LWWRegisterState.self, from: server)
    // Higher timestamp wins. Tie-break on nodeId (lexicographic).
    let winner = (c.timestamp > s.timestamp) ? c
               : (c.timestamp < s.timestamp) ? s
               : (c.nodeId > s.nodeId ? c : s)
    let json = try JSONEncoder().encode(winner)
    return (winner.value.value, String(data: json, encoding: .utf8)!)
  }
}
```

**G-Counter** (Grow-only Counter):

```swift
struct GCounterState: Codable {
  /// Map of nodeId → count. Merge = max per key.
  var counts: [String: Int]

  var value: Int { counts.values.reduce(0, +) }

  func merged(with other: GCounterState) -> GCounterState {
    var result = counts
    for (node, count) in other.counts {
      result[node] = max(result[node] ?? 0, count)
    }
    return GCounterState(counts: result)
  }
}
```

**PN-Counter** (Positive-Negative Counter):

```swift
struct PNCounterState: Codable {
  var positive: [String: Int]  // increments per node
  var negative: [String: Int]  // decrements per node

  var value: Int {
    positive.values.reduce(0, +) - negative.values.reduce(0, +)
  }

  func merged(with other: PNCounterState) -> PNCounterState {
    var p = positive
    for (node, count) in other.positive { p[node] = max(p[node] ?? 0, count) }
    var n = negative
    for (node, count) in other.negative { n[node] = max(n[node] ?? 0, count) }
    return PNCounterState(positive: p, negative: n)
  }
}
```

**OR-Set** (Observed-Remove Set):

```swift
struct ORSetState: Codable {
  /// Map of element → set of unique tags (nodeId + sequence number).
  /// An element is in the set if it has at least one tag not in `removed`.
  var elements: [String: Set<String>]  // element → {tag, ...}
  var removed: Set<String>             // tombstone tags

  var value: [String] {
    elements.compactMap { (element, tags) in
      tags.subtracting(removed).isEmpty ? nil : element
    }
  }

  func merged(with other: ORSetState) -> ORSetState {
    var merged = elements
    for (element, tags) in other.elements {
      merged[element] = (merged[element] ?? []).union(tags)
    }
    return ORSetState(
      elements: merged,
      removed: removed.union(other.removed)
    )
  }
}
```

#### How do you handle unbounded CRDT state growth (garbage collection)?

Two mechanisms:

1. **Compaction on read.** When a record is fetched and the CRDT shadow field
   exceeds a configurable threshold (default: 100KB), the Swift layer
   compacts it:
   - G-Counter / PN-Counter: Collapse all node entries into a single "compacted"
     node. This is safe because the merge function uses `max` -- after
     compaction, the compacted node's count is the global sum, and the
     counter continues to function correctly for new increments.
   - OR-Set: Remove tombstoned tags from both `elements` and `removed` sets.
     Elements with all tags tombstoned are removed entirely.
   - LWW-Register: No compaction needed -- state is fixed-size.

2. **Node ID reuse.** The module uses a per-device node ID (stored in
   UserDefaults) rather than a per-session ID. This bounds the number of
   unique nodes to the number of physical devices, not the number of app
   launches.

#### What is the TypeScript API for declaring CRDT fields?

```typescript
// --- CRDT Type Declarations ---

/** Supported CRDT types for automatic conflict-free merging. */
export type CRDTFieldType =
  | 'lww-register'
  | 'g-counter'
  | 'pn-counter'
  | 'or-set';

/**
 * Declares a field as CRDT-enabled.
 *
 * Used in the schema declaration passed to sync engine configuration.
 * The module automatically creates and manages the `__crdt_<fieldName>`
 * shadow field on the CKRecord.
 */
export interface CRDTFieldDeclaration {
  /** The CRDT algorithm to use for this field. */
  crdt: CRDTFieldType;
  /**
   * Initial value for new records.
   * - lww-register: any serializable value
   * - g-counter: 0
   * - pn-counter: 0
   * - or-set: []
   */
  initialValue?: unknown;
}

/**
 * Schema declaration for CRDT-enabled record types.
 *
 * Passed to `startSyncEngine` via the new `crdtSchema` option.
 *
 * @example
 * ```typescript
 * await startSyncEngine({
 *   zones: ['collab-zone'],
 *   databases: ['shared'],
 *   crdtSchema: {
 *     'SharedDocument': {
 *       'viewCount': { crdt: 'g-counter' },
 *       'tags': { crdt: 'or-set', initialValue: [] },
 *       'title': { crdt: 'lww-register' },
 *       'rating': { crdt: 'pn-counter', initialValue: 0 },
 *     },
 *   },
 * });
 * ```
 */
export type CRDTSchema = Record<string, Record<string, CRDTFieldDeclaration>>;

// --- SyncEngineConfig Extension ---

export interface SyncEngineConfig {
  // ... existing fields ...

  /**
   * Optional CRDT schema for automatic conflict-free field merging.
   *
   * When provided, fields listed here are merged using their declared CRDT
   * algorithm during conflict resolution, regardless of the `conflictStrategy`
   * setting. Non-CRDT fields still use the configured `conflictStrategy`.
   *
   * CRDT fields have a companion `__crdt_<fieldName>` shadow field on the
   * CKRecord. This shadow field is managed automatically by the module --
   * callers should not read or write it directly.
   */
  crdtSchema?: CRDTSchema;
}

// --- CRDT Operations ---

/**
 * Increment a G-Counter or PN-Counter CRDT field.
 *
 * This is a local operation that updates the in-memory CRDT state and
 * enqueues a save via the sync engine. The materialized value is updated
 * immediately (optimistic).
 */
export function incrementCRDTCounter(
  recordName: string,
  zoneName: string,
  fieldName: string,
  delta?: number,  // default: 1; negative values only valid for pn-counter
): Promise<number>; // returns new materialized value

/**
 * Add an element to an OR-Set CRDT field.
 */
export function addToORSet(
  recordName: string,
  zoneName: string,
  fieldName: string,
  element: string,
): Promise<string[]>; // returns current set contents

/**
 * Remove an element from an OR-Set CRDT field.
 */
export function removeFromORSet(
  recordName: string,
  zoneName: string,
  fieldName: string,
  element: string,
): Promise<string[]>; // returns current set contents

/**
 * Set the value of an LWW-Register CRDT field.
 */
export function setLWWRegister(
  recordName: string,
  zoneName: string,
  fieldName: string,
  value: unknown,
): Promise<void>;
```

### Swift Architecture

```
ExpoCloudKitModule.swift
  ├── AsyncFunction("incrementCRDTCounter")  →  CRDTManager.increment()
  ├── AsyncFunction("addToORSet")            →  CRDTManager.addToSet()
  ├── AsyncFunction("removeFromORSet")       →  CRDTManager.removeFromSet()
  └── AsyncFunction("setLWWRegister")        →  CRDTManager.setRegister()

CRDTManager.swift (new file)
  ├── Holds in-memory CRDT state per record+field
  ├── On local mutation: update state, materialize value, enqueue save
  ├── On conflict: call CRDTMerger to merge client+server shadow fields
  └── On fetch: parse shadow fields, update in-memory state

CRDTMerger.swift (new file)
  ├── Pure functions: merge(clientShadow, serverShadow) → (value, shadow)
  ├── LWWRegisterMerger
  ├── GCounterMerger
  ├── PNCounterMerger
  └── ORSetMerger

Integration point in CloudKitSyncEngineAdapter / CloudKitSyncFallbackAdapter:
  └── In conflict handler, before applying conflictStrategy:
      1. Check if record type + field is in crdtSchema
      2. If yes, merge CRDT fields via CRDTMerger
      3. Apply conflictStrategy to remaining non-CRDT fields
      4. Re-enqueue merged record
```

### Risks & Constraints

| Risk | Severity | Mitigation |
|------|----------|------------|
| Shadow fields double the field count per CRDT field | Medium | 750 fields/record CloudKit limit; in practice apps use <50 fields; document the trade-off |
| CRDT state JSON can grow large (OR-Set with many elements) | Medium | Compaction on read; 100KB threshold; documented 1MB/field hard limit |
| Wall-clock timestamps in LWW-Register can be wrong (device clock skew) | Medium | Use `modificationDate` from CKRecord (server-assigned) as fallback; document that LWW is best-effort |
| Node ID collision (two devices get same UUID) | Very Low | UUIDs have negligible collision probability |
| Callers may read `__crdt_*` fields and be confused | Low | Filter shadow fields from `CloudKitRecord.fields` in Converters.swift; document the convention |
| CRDT operations require the record to exist in local cache | Medium | Fetch-on-miss: if record not in cache, fetch from CloudKit before applying mutation |

---

## Feature K.3: Live Activities / Widgets Integration

### Problem

iOS apps increasingly use Lock Screen Live Activities (ActivityKit, iOS 16.1+)
and Home Screen Widgets (WidgetKit, iOS 14+) to surface real-time information.
CloudKit record changes should be able to drive updates to these surfaces
without the app being in the foreground.

### Questions & Answers

#### How do CloudKit push notifications trigger Live Activity / Widget updates?

**Answer: CKDatabaseSubscription + silent push + App Group shared state.**

The data flow:

```
CloudKit server detects record change
  │
  ├── CKDatabaseSubscription fires silent push (APNs content-available)
  │
  ├── iOS wakes main app (background launch)
  │     │
  │     ├── App fetches changed records via CKSyncEngine / manual fetch
  │     │
  │     ├── App writes updated state to shared UserDefaults (App Group)
  │     │
  │     ├── For Live Activities: App calls Activity.update(content:)
  │     │
  │     └── For Widgets: App calls WidgetCenter.shared.reloadTimelines(ofKind:)
  │
  └── Widget / Live Activity extension reads from shared UserDefaults
```

This is the standard Apple-recommended pattern. The module does not bypass
Apple's push infrastructure -- it provides helpers that wire CloudKit sync
events to the App Group write + extension reload steps.

**Key constraint:** The main app must be launched (even in background) to
process the push. If the app has been terminated and the system decides not to
background-launch it, the update is delayed until the next app launch or
widget timeline reload. This is an iOS platform limitation, not a module
limitation.

#### What is the App Group / shared UserDefaults contract?

The module establishes a shared data channel between the main app and
extensions:

```
App Group container: group.<bundleIdentifier>
  └── UserDefaults suite: group.<bundleIdentifier>
        └── Key: expo.cloudkit.widget.<zoneName>.<recordType>
              Value: JSON-encoded array of record dictionaries
                     (same format as CloudKitRecord but serialized)
```

The module writes to this shared UserDefaults after each sync cycle that
produces changes matching a registered widget/activity binding. The extension
reads from it on timeline reload or activity update.

**Why UserDefaults and not a shared SQLite/CoreData store?**
- UserDefaults is simpler and sufficient for the data sizes involved
  (widgets/activities need a handful of records, not thousands).
- No schema migration complexity.
- Atomic writes via `UserDefaults.synchronize()` (called after batch write).
- Consistent with the module's existing use of UserDefaults for token storage.

**Size constraint:** UserDefaults is backed by a plist. Apple recommends
keeping it under ~1MB total. The module enforces a per-binding limit of 100
records and truncates with a warning if exceeded.

#### How does the module surface this?

**Both a new function set and a config plugin update.**

The config plugin adds:
1. App Group entitlement (`com.apple.security.application-groups`)
2. The App Group identifier to `Info.plist` so the module can read it at
   runtime

New Swift functions handle:
1. Writing sync results to shared UserDefaults
2. Triggering widget timeline reloads
3. Updating Live Activities

#### What is the TypeScript API?

```typescript
// --- Config Plugin Extension ---

export interface WithCloudKitOptions {
  // ... existing options ...

  /**
   * App Group identifier for sharing data with widget/Live Activity extensions.
   *
   * When set, the config plugin adds the App Group entitlement and the module
   * writes sync results to the shared UserDefaults suite.
   *
   * @example "group.com.example.myapp"
   */
  appGroupIdentifier?: string;
}

// --- Widget Binding ---

/**
 * Registers a binding between a CloudKit zone/record type and a WidgetKit
 * widget kind.
 *
 * When records of the specified type change in the zone, the module writes
 * the updated records to the App Group shared UserDefaults and calls
 * `WidgetCenter.shared.reloadTimelines(ofKind:)`.
 *
 * Must be called after `configure()` and before or after `startSyncEngine()`.
 */
export function registerWidgetBinding(options: {
  /** The WidgetKit widget kind string (matches your Widget struct). */
  widgetKind: string;
  /** Zone name to watch. */
  zoneName: string;
  /** Record type(s) to include. Empty array = all types in the zone. */
  recordTypes: string[];
  /** Database scope. Default: 'private'. */
  databaseScope?: DatabaseScope;
  /**
   * Maximum number of records to store in shared UserDefaults per binding.
   * Default: 50. Max: 100.
   */
  maxRecords?: number;
  /**
   * Optional predicate to filter records (same syntax as queryRecords).
   * Only matching records are written to shared UserDefaults.
   */
  predicate?: string;
  /**
   * Sort key for determining which records to keep when maxRecords is exceeded.
   * Default: 'modificationDate' (most recently modified are kept).
   */
  sortKey?: string;
}): Promise<void>;

/** Removes a widget binding. Clears the shared UserDefaults for this binding. */
export function removeWidgetBinding(widgetKind: string): Promise<void>;

/**
 * Manually triggers a widget timeline reload for the specified kind.
 * Useful when the app makes a local change that should be reflected
 * immediately without waiting for a sync cycle.
 */
export function reloadWidgetTimeline(widgetKind: string): Promise<void>;

// --- Live Activity Binding ---

/**
 * Registers a Live Activity that should be updated when CloudKit records change.
 *
 * The module does NOT create the Live Activity (that requires ActivityKit
 * which must be called from the app's own Swift code). Instead, it bridges
 * sync events so that when matching records change, the module writes updated
 * data to the App Group and emits an `onLiveActivityUpdate` event that the
 * app can use to call `Activity.update()`.
 *
 * This design avoids requiring the module to know about the app's
 * ActivityAttributes type (which is app-specific and not generic).
 */
export function registerLiveActivityBinding(options: {
  /** Opaque activity ID (from ActivityKit's Activity.id). */
  activityId: string;
  /** Zone name to watch. */
  zoneName: string;
  /** Record type(s) that feed this activity. */
  recordTypes: string[];
  /** Database scope. Default: 'private'. */
  databaseScope?: DatabaseScope;
}): Promise<void>;

/** Unregisters a Live Activity binding. */
export function removeLiveActivityBinding(activityId: string): Promise<void>;

/**
 * Event emitted when records matching a Live Activity binding change.
 *
 * The app should handle this event by calling ActivityKit's
 * `Activity.update(content:)` with the updated data.
 */
export interface LiveActivityUpdateEvent {
  type: 'liveActivityUpdate';
  /** The activity ID that was registered. */
  activityId: string;
  /** Changed records matching the binding. */
  records: CloudKitRecord[];
}

/** Subscribe to Live Activity update events. */
export function addLiveActivityListener(
  callback: (event: LiveActivityUpdateEvent) => void,
): Subscription;
```

#### How do you handle the 15-minute push budget and 12-hour Live Activity maximum?

**The module does not manage ActivityKit lifecycle -- the app does.**

This is a deliberate design choice:
- `ActivityAttributes` are app-specific (custom structs).
- Creating, updating, and ending Live Activities requires app-specific logic.
- The 12-hour maximum and 15-minute push budget are ActivityKit constraints
  that the app must manage.

The module's role is limited to:
1. Detecting when relevant CloudKit records change.
2. Writing the data to shared UserDefaults.
3. Emitting an event so the app can call `Activity.update()`.

The module does include a helper that checks whether a Live Activity is still
active before emitting the event (via `Activity.activities` enumeration on
iOS 16.2+), avoiding wasted work for expired activities.

**Widget timeline budget:** WidgetKit allows ~40-70 timeline reloads per day
(varies by usage). The module coalesces: if multiple records change in a
single sync cycle, only one `reloadTimelines` call is made. A minimum
interval of 5 minutes between reloads is enforced to avoid burning the budget.

### Swift Architecture

```
ExpoCloudKitModule.swift
  ├── AsyncFunction("registerWidgetBinding")         →  ExtensionBridgeManager
  ├── AsyncFunction("removeWidgetBinding")           →  ExtensionBridgeManager
  ├── AsyncFunction("reloadWidgetTimeline")          →  ExtensionBridgeManager
  ├── AsyncFunction("registerLiveActivityBinding")   →  ExtensionBridgeManager
  ├── AsyncFunction("removeLiveActivityBinding")     →  ExtensionBridgeManager
  └── Events("onLiveActivityUpdate")

CloudKitExtensionBridgeManager.swift (new file)
  ├── widgetBindings: [String: WidgetBinding]
  ├── activityBindings: [String: ActivityBinding]
  ├── sharedDefaults: UserDefaults  (App Group suite)
  ├── lastWidgetReload: [String: Date]  (coalescing tracker)
  │
  ├── handleSyncedRecords(_ records: [CKRecord], zone: String, scope: ...)
  │     Checks all bindings, writes matches to shared UserDefaults,
  │     triggers widget reloads and emits Live Activity events.
  │
  └── Integration point: called from sync engine's recordsFetched handler
        (same place that presence filtering hooks in)

Config Plugin (plugin/withCloudKit.ts)
  └── New option: appGroupIdentifier
        ├── Adds com.apple.security.application-groups entitlement
        └── Writes identifier to Info.plist for runtime access
```

```swift
// ios/CloudKitExtensionBridgeManager.swift — key structure

import CloudKit
import Foundation
#if canImport(WidgetKit)
import WidgetKit
#endif

struct WidgetBinding {
  let widgetKind: String
  let zoneName: String
  let recordTypes: Set<String>  // empty = all types
  let databaseScope: CKDatabase.Scope
  let maxRecords: Int
  let sortKey: String
}

struct ActivityBinding {
  let activityId: String
  let zoneName: String
  let recordTypes: Set<String>
  let databaseScope: CKDatabase.Scope
}

final class CloudKitExtensionBridgeManager {

  private let sharedDefaults: UserDefaults
  private var widgetBindings: [String: WidgetBinding] = [:]   // keyed by widgetKind
  private var activityBindings: [String: ActivityBinding] = [] // keyed by activityId
  private var lastReloadTime: [String: Date] = [:]
  private let minReloadInterval: TimeInterval = 300  // 5 minutes

  init?(appGroupIdentifier: String) {
    guard let defaults = UserDefaults(suiteName: appGroupIdentifier) else {
      return nil
    }
    self.sharedDefaults = defaults
  }

  /// Called after each sync cycle with newly fetched/changed records.
  func handleSyncedRecords(
    _ records: [CKRecord],
    zoneName: String,
    scope: CKDatabase.Scope,
    eventEmitter: ((String, [String: Any]) -> Void)?
  ) {
    // Check widget bindings
    for (_, binding) in widgetBindings {
      guard binding.zoneName == zoneName,
            binding.databaseScope == scope else { continue }

      let matching = records.filter { record in
        binding.recordTypes.isEmpty || binding.recordTypes.contains(record.recordType)
      }
      guard !matching.isEmpty else { continue }

      writeToSharedDefaults(matching, binding: binding)
      throttledReload(widgetKind: binding.widgetKind)
    }

    // Check activity bindings
    for (_, binding) in activityBindings {
      guard binding.zoneName == zoneName,
            binding.databaseScope == scope else { continue }

      let matching = records.filter { record in
        binding.recordTypes.isEmpty || binding.recordTypes.contains(record.recordType)
      }
      guard !matching.isEmpty else { continue }

      let dicts = matching.map { Converters.toDictionary($0) }
      eventEmitter?("onLiveActivityUpdate", [
        "activityId": binding.activityId,
        "records": dicts,
      ])
    }
  }

  private func writeToSharedDefaults(_ records: [CKRecord], binding: WidgetBinding) {
    let key = "expo.cloudkit.widget.\(binding.zoneName).\(binding.widgetKind)"
    let dicts = records.prefix(binding.maxRecords).map { Converters.toDictionary($0) }
    if let data = try? JSONSerialization.data(withJSONObject: dicts) {
      sharedDefaults.set(data, forKey: key)
    }
  }

  private func throttledReload(widgetKind: String) {
    #if canImport(WidgetKit)
    let now = Date()
    if let last = lastReloadTime[widgetKind],
       now.timeIntervalSince(last) < minReloadInterval {
      return  // Too soon, skip this reload
    }
    lastReloadTime[widgetKind] = now
    WidgetCenter.shared.reloadTimelines(ofKind: widgetKind)
    #endif
  }
}
```

### Risks & Constraints

| Risk | Severity | Mitigation |
|------|----------|------------|
| App must be background-launched to process push; iOS may defer this | Medium | Platform limitation; document that updates are best-effort, not guaranteed real-time |
| Widget timeline reload budget (~40-70/day) can be exhausted | Medium | 5-minute minimum interval enforced; coalescing within sync cycles |
| UserDefaults size limit (~1MB) for shared suite | Low | 100-record cap per binding; records are typically <1KB each |
| ActivityAttributes are app-specific; module cannot create/update Activities directly | Low | By design: module emits event, app calls ActivityKit. Document this clearly |
| App Group entitlement requires correct provisioning profile | Medium | Config plugin automates entitlement; document manual setup for bare workflow |
| Live Activity 12-hour max / 8-hour stale period | Low | Not the module's concern; app manages lifecycle. Module checks `Activity.activities` before emitting |
| WidgetKit import not available in all build targets | Low | `#if canImport(WidgetKit)` guard; no-op when unavailable |

---

## Phasing Recommendation

### Build Order

```
Phase K.1 (Presence & Cursors)          Effort: Medium    Dependencies: None
Phase K.2 (CRDT Conflict Resolution)    Effort: Large     Dependencies: None
Phase K.3 (Live Activities / Widgets)   Effort: Medium    Dependencies: Config plugin update

Recommended order: K.3 → K.1 → K.2
```

**Why K.3 first:**
- Widgets are the most requested feature for CloudKit apps (data display
  without opening the app).
- Implementation is straightforward: hook into existing sync events, write to
  shared UserDefaults, call WidgetCenter.
- The config plugin change (App Group entitlement) is a prerequisite for K.1's
  potential future extension-based presence, so shipping it early de-risks
  the dependency.
- Effort is well-bounded: one new manager class, one config plugin update, a
  handful of exported functions.

**Why K.1 second:**
- Presence is high-value for collaboration UX.
- Builds on existing sync infrastructure with minimal new CloudKit API usage.
- The PresenceManager pattern is straightforward (timer + record CRUD).
- Risk is low -- the main uncertainty is latency expectations, which are
  mitigated by documentation.

**Why K.2 last:**
- CRDTs are the most complex feature and the hardest to get right.
- Incorrect merge logic can silently corrupt data.
- Requires extensive unit testing of each CRDT type's merge semantics.
- The OR-Set implementation in particular has subtle edge cases around
  concurrent add/remove of the same element.
- Deferring allows K.1 and K.3 to ship and gather feedback before committing
  to the CRDT API surface.

### Sub-phasing

**K.3 (Live Activities / Widgets):**
1. K.3.1: Config plugin `appGroupIdentifier` support + shared UserDefaults write
2. K.3.2: `registerWidgetBinding` / `removeWidgetBinding` / `reloadWidgetTimeline`
3. K.3.3: `registerLiveActivityBinding` / `removeLiveActivityBinding` + event

**K.1 (Presence & Cursors):**
1. K.1.1: `CloudKitPresenceManager` + `startPresence` / `stopPresence` (heartbeat only)
2. K.1.2: `updatePresenceCursor` with coalescing + `onPresenceChanged` event
3. K.1.3: `usePresence` React hook + stale entry cleanup

**K.2 (CRDT Conflict Resolution):**
1. K.2.1: `CRDTMerger` with LWW-Register and G-Counter (simplest CRDTs)
2. K.2.2: PN-Counter + `incrementCRDTCounter` JS API
3. K.2.3: OR-Set + `addToORSet` / `removeFromORSet` JS API
4. K.2.4: Integration with conflict resolution pipeline + `crdtSchema` config
5. K.2.5: Compaction / garbage collection

---

## New Files Summary

| File | Feature | Purpose |
|------|---------|---------|
| `ios/CloudKitPresenceManager.swift` | K.1 | Presence session management, heartbeat timer, cursor coalescing |
| `ios/CRDTMerger.swift` | K.2 | Pure CRDT merge functions for all supported types |
| `ios/CRDTManager.swift` | K.2 | In-memory CRDT state, local mutations, conflict integration |
| `ios/CloudKitExtensionBridgeManager.swift` | K.3 | Widget/Activity binding registry, shared UserDefaults writer |
| `src/presence.ts` | K.1 | TypeScript API for presence functions + usePresence hook |
| `src/crdt.ts` | K.2 | TypeScript API for CRDT operations + schema types |
| `src/extensions.ts` | K.3 | TypeScript API for widget/activity bindings |

All new Swift files follow existing patterns:
- Manager class instantiated lazily by `ExpoCloudKitModule`
- Integration via sync engine event hooks (same pattern as `syncCompleted`)
- `#if canImport(ExpoModulesCore)` guard for SPM compatibility
- Error bridging via `ExpoModulesCore.Exception` subclasses

---

## Open Questions

1. **Should presence records use encrypted fields?** If the shared zone uses
   E2EE, presence metadata (display name, cursor position) would be visible
   to Apple unless encrypted. The trade-off is that encrypted fields cannot
   be queried via predicates. Recommendation: follow the zone's encryption
   policy -- if the zone uses encrypted fields, presence should too.

2. **Should CRDT shadow fields be encrypted?** If the business field is
   encrypted, the shadow field should be too, since it contains the field
   value. This adds complexity to the merge path (decrypt before merge,
   re-encrypt after). Defer to K.2.4.

3. **Should the module provide a Swift-only Widget helper?** A lightweight
   struct that reads from the shared UserDefaults and vends `CloudKitRecord`
   arrays would save widget extension authors from parsing JSON manually.
   This would live in the SPM target. Recommend yes, but defer to K.3.3.

4. **What happens to presence when a user is removed from a share?** The
   presence record becomes inaccessible. The module should handle
   `CKError.zoneNotFound` / `CKError.participantMayNeedVerification`
   gracefully during presence heartbeat saves. Implement in K.1.1.
