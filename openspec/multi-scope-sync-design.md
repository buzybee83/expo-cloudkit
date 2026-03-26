# Design: Multi-Database-Scope Sync Engine

**Date**: 2026-03-19
**Status**: Proposed
**Author**: architect

---

## Context

The current `startSyncEngine()` accepts a single `database?: DatabaseScope` value. Apps that need to sync both the private and shared databases (the most common multi-scope scenario -- e.g., a notes app where the user owns private notes and also sees shared notes from collaborators) must call `startSyncEngine()` twice. However, the module holds a single `syncProvider` reference, so the second call stops the first engine before starting the second. There is no way to run both scopes simultaneously.

This design adds first-class support for syncing multiple database scopes from a single `startSyncEngine()` call.

---

## Question 1: CKSyncEngine Multi-Instance Safety

**Answer: Yes, multiple CKSyncEngine instances are safe and expected.**

`CKSyncEngine.Configuration` takes a `database: CKDatabase` parameter. Each engine instance is scoped to exactly one database. Apple's WWDC23 session "Build better document-based apps" and the CKSyncEngine documentation both demonstrate using separate engines for private and shared databases. The key constraints:

1. **One engine per database scope.** Do not create two engines pointing at the same `CKDatabase`.
2. **Separate state serializations.** Each engine has its own `CKSyncEngine.State.Serialization` that must be persisted independently.
3. **Delegate lifecycle is per-engine.** Each engine calls its own delegate. The delegate can be the same object or separate objects.
4. **No cross-engine ordering guarantees.** Fetch/send cycles on different engines are independent.

The current `ChangeTokenStore` has a bug for multi-scope: `saveSyncEngineState()` / `loadSyncEngineState()` use the key `expo.cloudkit.<containerID>.syncEngineState` with no scope qualifier. Two engines would overwrite each other's state. This must be fixed to include the scope in the key.

---

## Question 2: Architecture -- One Provider Per Scope (Recommended)

### Options Considered

| Option | Description | Pros | Cons | Effort | Risk |
|--------|-------------|------|------|--------|------|
| **A: Dictionary of providers** | Hold `[DatabaseScope: CloudKitSyncProvider]` in the module | Simple, each provider is independent, no new abstractions | Module must iterate the dictionary for fan-out operations | Small | Low |
| B: MultiScopeSyncProvider wrapper | New class that wraps N providers, presents as one `CloudKitSyncProvider` | Single reference, clean from module's perspective | New abstraction layer, merged state is ambiguous (what does `state` mean when one scope is syncing and the other is idle?), conflict resolution routing gets complex | Medium | Medium |
| C: Single engine with zone routing | One engine that syncs zones from multiple databases | Not possible -- `CKSyncEngine` is scoped to one `CKDatabase` | N/A | N/A | N/A |

**Recommendation: Option A -- Dictionary of providers.**

Reasoning:
- It mirrors how CKSyncEngine actually works (one per database).
- No new abstractions to design, test, or debug.
- The module already knows how to manage a single provider; a dictionary is a minimal generalization.
- State per scope is unambiguous -- each provider reports its own state independently.
- Option B creates a false simplification. When private is syncing and shared is idle, what state does the wrapper report? Every consumer of the wrapper's state would need to understand this was a composite, which defeats the purpose.

### Swift Changes

**ExpoCloudKitModule.swift:**
```swift
// Before:
private var syncProvider: CloudKitSyncProvider?

// After:
private var syncProviders: [CKDatabase.Scope: CloudKitSyncProvider] = [:]
```

**ChangeTokenStore -- scope-qualified CKSyncEngine state key:**
```swift
// Before:
func key("syncEngineState")  // "expo.cloudkit.<id>.syncEngineState"

// After:
func key("syncEngineState.\(scopeStr)")  // "expo.cloudkit.<id>.syncEngineState.private"
```

This is a breaking change for persisted state. On first launch after upgrade, the old unqualified key will not be found, triggering a full re-sync for users who were using CKSyncEngine. This is acceptable per CLAUDE.md ("no backwards compatibility needed -- no users of the module yet").

---

## Question 3: API Surface

### Recommended Approach: Replace `database` with `databases`

```typescript
export interface SyncEngineConfig {
  zones: string[];
  /**
   * Which database scope(s) to sync.
   *
   * Pass a single value or an array. When multiple scopes are given,
   * the module creates one sync engine per scope internally.
   *
   * Default: 'private'.
   */
  databases?: DatabaseScope | DatabaseScope[];
  /**
   * @deprecated Use `databases` instead. Kept for backwards compatibility.
   * If both `database` and `databases` are set, `databases` wins.
   */
  database?: DatabaseScope;
  automaticallySync?: boolean;
  resolveConflicts?: boolean;
}
```

**Migration path:**
- `database: 'private'` still works -- the native side normalizes it to `databases: ['private']`.
- `databases: ['private', 'shared']` is the new multi-scope form.
- `databases: 'private'` (single string, not array) also works for convenience.
- If both `database` and `databases` are present, `databases` takes precedence and `database` is ignored.

**Why not a separate `startMultiScopeSyncEngine()` function?**
Because there is nothing fundamentally different about the multi-scope case. It is the same operation repeated per scope. A separate function would double the API surface for no conceptual gain and force callers to choose between two functions that do the same thing.

---

## Question 4: Event Routing -- Add `databaseScope` to All Events

Every sync event must include a `databaseScope` field so callers can distinguish which engine produced it.

### TypeScript Changes

```typescript
export interface SyncStateChangedEvent {
  type: 'stateChanged';
  /** Which database scope this state change is for. */
  databaseScope: DatabaseScope;
  state: SyncState;
}

export interface RecordsFetchedEvent {
  type: 'recordsFetched';
  databaseScope: DatabaseScope;
  zoneName: string;
  changedRecords: CloudKitRecord[];
  deletedRecordIDs: RecordIdentifier[];
}

export interface RecordsSentEvent {
  type: 'recordsSent';
  databaseScope: DatabaseScope;
  savedRecords: SavedRecord[];
  failedRecords: Array<{ ... }>;
}

export interface SyncErrorEvent {
  type: 'syncError';
  databaseScope: DatabaseScope;
  error: { code: string; message: string };
}

export interface SyncConflictEvent {
  type: 'conflict';
  databaseScope: DatabaseScope;
  requestId: string;
  clientRecord: RecordToSave;
  serverRecord: RecordToSave;
}

export interface SyncCompletedEvent {
  type: 'syncCompleted';
  databaseScope: DatabaseScope;
  recordCount: number;
  zoneNames: string[];
  isInitialSync: boolean;
}

export interface SyncHealthEvent {
  type: 'syncHealth';
  databaseScope: DatabaseScope;
  sentCount: number;
  receivedCount: number;
  failedCount: number;
  durationMs: number;
  usesSyncEngine: boolean;
}
```

### Backwards Compatibility for Single-Scope Callers

The `databaseScope` field is **always present** on every event, even for single-scope callers. This is a minor additive change, not a breaking one -- existing code that does not reference `event.databaseScope` continues to work unchanged. TypeScript callers will see the new field in autocomplete, which is desirable.

### Swift Implementation

The `SyncProviderEvent` enum does not need to change. Instead, the module's event handler closure captures the scope when creating each provider:

```swift
// In startSyncEngine(), for each scope:
let scopeString = Converters.fromDatabaseScope(scope)  // "private", "shared", etc.

await provider.start(
  zones: zoneIDs,
  database: scope,
  automaticallySync: autoSync,
  eventHandler: { [weak self] event in
    self?.handleSyncEvent(event, databaseScope: scopeString)
  }
)
```

Then `handleSyncEvent` injects `databaseScope` into every payload dictionary before sending to JS:

```swift
func handleSyncEvent(_ event: SyncProviderEvent, databaseScope: String) {
  var payload: [String: Any] = buildPayload(event)
  payload["databaseScope"] = databaseScope
  sendEvent("onSyncEngineEvent", payload)
}
```

This is clean because the scope is captured at provider-creation time and threaded through without modifying the protocol or the adapter implementations.

---

## Question 5: `getSyncState()` with Multiple Scopes

### Recommended: Return a dictionary keyed by scope

```typescript
/**
 * Returns sync state for all running engines.
 *
 * When a single scope is running, the result has one key.
 * When no engine is running, returns an empty object.
 */
export function getSyncState(): Record<DatabaseScope, SyncState> | {};
```

Example returns:
```typescript
// Single scope:
{ private: { usesSyncEngine: true, status: 'idle' } }

// Multi scope:
{
  private: { usesSyncEngine: true, status: 'syncing' },
  shared: { usesSyncEngine: true, status: 'idle' }
}

// Not started:
{}
```

**Why not keep the old flat shape?**

Because a flat `SyncState` cannot represent two scopes in different states (private syncing, shared idle). The dictionary shape is unambiguous and self-describing.

**Breaking change?** Yes -- callers that read `getSyncState().status` will break. But per project rules, no backwards compatibility is needed.

If backwards compatibility were required, we could add a separate `getSyncStates()` function and keep the old one returning the "worst" state. But we do not need that complexity.

### Swift Implementation

```swift
Function("getSyncState") { [weak self] () -> [String: Any] in
  guard let self = self else { return [:] }
  var result: [String: Any] = [:]
  for (scope, provider) in self.syncProviders {
    let scopeStr = Converters.fromDatabaseScope(scope)
    result[scopeStr] = [
      "usesSyncEngine": provider.usesSyncEngine,
      "status": provider.state.rawValue
    ]
  }
  return result
}
```

---

## Question 6: `stopSyncEngine()` -- Accept Optional Scope

```typescript
/**
 * Stops sync engine(s).
 *
 * - No argument: stops all running engines.
 * - With scope: stops only that scope's engine.
 *
 * Rejects if no engine is running (or the specified scope is not running).
 */
export function stopSyncEngine(database?: DatabaseScope): Promise<void>;
```

### Swift Implementation

```swift
AsyncFunction("stopSyncEngine") { [weak self] (config: [String: Any]?, promise: Promise) in
  guard let self = self else {
    promise.reject(CloudKitModuleError.syncEngineNotRunning)
    return
  }

  let scopeStr = (config as? [String: Any])?["database"] as? String

  if let scopeStr = scopeStr {
    // Stop one specific scope
    let scope = Converters.toDatabaseScope(scopeStr)
    guard let provider = self.syncProviders.removeValue(forKey: scope) else {
      promise.reject(CloudKitModuleError.syncEngineNotRunning)
      return
    }
    Task {
      await provider.stop()
      promise.resolve(nil)
    }
  } else {
    // Stop all
    let providers = self.syncProviders
    self.syncProviders.removeAll()
    Task {
      for (_, provider) in providers {
        await provider.stop()
      }
      promise.resolve(nil)
    }
  }
}
```

---

## Question 7: `triggerSync()` -- Fan Out by Default, Accept Optional Scope

```typescript
/**
 * Triggers a sync cycle.
 *
 * - No argument: triggers sync on all running engines.
 * - With scope: triggers sync only on that scope's engine.
 */
export function triggerSync(database?: DatabaseScope): Promise<void>;
```

Fan-out is the right default because when a user taps "refresh," they expect all data to refresh. Scope-specific triggers are useful for targeted sync (e.g., only refresh shared data after accepting a share).

---

## Question 8: iOS 16 Fallback -- Independent Timers Per Scope

With two scopes on the fallback adapter, use **one independent timer per adapter instance** (which is already the case since each `CloudKitSyncFallbackAdapter` actor creates its own timer).

**Why not one shared timer that alternates?**
- Alternating adds coupling between scopes for no benefit.
- Each adapter is already an independent actor with its own timer.
- If one scope's sync cycle takes longer (large private database), it should not delay the shared database poll.
- The additional timer is negligible overhead (one `Timer.scheduledTimer` firing every 30s).

No changes needed to the fallback adapter itself. The module simply creates two instances, each with its own timer, zones, and scope.

---

## Summary of All Changes

### New / Modified Files

| File | Change |
|------|--------|
| `src/types.ts` | Add `databases` to `SyncEngineConfig`, deprecate `database`. Add `databaseScope` to all event interfaces. Change `getSyncState()` return type. |
| `ios/ExpoCloudKitModule.swift` | Replace `syncProvider: CloudKitSyncProvider?` with `syncProviders: [CKDatabase.Scope: CloudKitSyncProvider]`. Update `startSyncEngine`, `stopSyncEngine`, `triggerSync`, `getSyncState`, `enqueuePendingChange`, `resolveSyncConflict`, `handleSyncEvent`. Update `sharedSyncProvider` to handle multiple. |
| `ios/CloudKitSyncProtocol.swift` | **No changes.** The `ChangeTokenStore` needs scope-qualified CKSyncEngine state keys. |
| `ios/CloudKitSyncEngine.swift` | **No changes.** Each instance is already scoped to one database. |
| `ios/CloudKitSyncFallback.swift` | **No changes.** Each instance is already scoped to one database. |
| `src/ExpoCloudKit.ts` (or `.native.ts`) | Update `startSyncEngine` to normalize `database`/`databases` before passing to native. Update `getSyncState` return type. |

### What Does NOT Change

- `CloudKitSyncProvider` protocol -- unmodified.
- `CloudKitSyncEngineAdapter` -- unmodified (already scoped to one database).
- `CloudKitSyncFallbackAdapter` -- unmodified (already scoped to one database).
- `SyncProviderEvent` enum -- unmodified (scope is injected at the module layer).

This is the key insight: the adapter layer is already correctly designed for multi-scope. The only changes are at the module layer (dictionary instead of single reference) and the JS API layer (new field on config, new field on events, new return shape for `getSyncState`).

---

## Risks and Open Questions

### Risk: `enqueuePendingChange` Scope Routing

When a caller enqueues a save or delete, which scope's engine should receive it? Currently the record's zone ID determines routing implicitly (zones in the private database vs. shared database). But a zone name alone is ambiguous -- the same zone name could theoretically exist in both databases (unlikely but possible).

**Recommendation:** Add an optional `database?: DatabaseScope` field to `PendingRecordChange`. If omitted, default to `'private'`. If the caller specifies a scope that has no running engine, silently drop (consistent with current behavior of dropping malformed entries).

```typescript
export type PendingRecordChange =
  | { type: 'save'; record: RecordToSave; database?: DatabaseScope }
  | { type: 'delete'; recordIdentifier: RecordIdentifier; database?: DatabaseScope };
```

### Risk: `resolveSyncConflict` Routing

Conflict request IDs are UUIDs, globally unique across all engines. No routing change needed -- the module iterates all providers and calls `resumeConflictResolution` on each. Only the one holding the matching request ID will act on it; others will log and return.

Actually, for efficiency: store a `[String: CKDatabase.Scope]` mapping of requestId to scope when the conflict event is emitted, then route directly. This avoids iterating all providers.

### Risk: `sharedSyncProvider` (Phase J.1 CloudKitStore)

`ExpoCloudKitModule.sharedSyncProvider` is a single weak reference used by `CloudKitStore` for SwiftUI integration. With multiple providers, this needs to become `sharedSyncProviders: [CKDatabase.Scope: CloudKitSyncProvider]` or a similar structure. Defer this to the implementation phase -- `CloudKitStore` will need minor updates.

### Risk: Background Sync (`registerBackgroundSync`)

The background sync handler currently captures `self?.syncProvider` via a resolver closure. With multiple providers, it should trigger sync on all running providers. The change is straightforward: iterate `syncProviders.values` and call `triggerSync()` on each.

### Open Question: Public Database Sync

`CKSyncEngine` does not support the public database (`CKDatabase.Scope.public`). The fallback adapter could technically poll the public database, but `CKFetchRecordZoneChangesOperation` also does not work on the public database (it has no custom zones). Public database sync requires `CKQuerySubscription` + push notifications, which is a fundamentally different mechanism.

**Recommendation:** Validate the `databases` array at `startSyncEngine()` time and reject if `'public'` is included. Add a clear error message: "Public database sync is not supported by CKSyncEngine. Use subscriptions instead."

---

## Phasing

### MVP (Single PR)

1. Scope-qualify `ChangeTokenStore` CKSyncEngine state key.
2. Replace `syncProvider` with `syncProviders` dictionary in `ExpoCloudKitModule`.
3. Add `databases` field to `SyncEngineConfig`, deprecate `database`.
4. Add `databaseScope` to all sync event payloads.
5. Change `getSyncState()` to return scope-keyed dictionary.
6. Add optional `database` param to `stopSyncEngine()` and `triggerSync()`.
7. Add optional `database` to `PendingRecordChange`.
8. Reject `'public'` in `databases` with clear error.
9. Update `handleSyncEvent` to inject scope.
10. Update background sync to fan out to all providers.

All of this is one coherent change. The adapters do not change. The module layer changes are mechanical (dictionary instead of single reference). The TS type changes are additive except for `getSyncState()`.

### Future (Separate PRs)

- Update `CloudKitStore` (Phase J.1) for multi-scope.
- Update `useSyncHealth` / `useCloudKitSync` hooks for scope-aware state.
- Consider a `useSyncState(database?: DatabaseScope)` hook.

---

## Decision

Adopt Option A: dictionary of providers at the module layer. No new abstractions. Scope is injected into events at the handler level. Adapters are unchanged.

This is the simplest design that solves the problem. It mirrors CKSyncEngine's own architecture (one engine per database). It requires no protocol changes and no new Swift types.
