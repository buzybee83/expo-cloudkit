# Phase D: DX Improvements — Unified Design

**Date**: 2026-03-10
**Status**: Proposed
**Author**: architect agent

## Overview

Three interdependent features that share a query cache and event bus:

1. **CloudKitProvider** — React context sharing container config, account status, sync state, and a query cache
2. **useCloudKitSubscription** — Hook that manages CKQuerySubscription lifecycle and triggers cache invalidation
3. **Optimistic updates** — Immediate local state mutations in `useCloudKitRecord` / `useCloudKitQuery` with rollback

All three converge on one shared piece of infrastructure: a **query cache** that lives in the Provider context. Without the Provider, the hooks continue to work as they do today (standalone, no shared cache, no cross-hook invalidation). With the Provider, hooks register their queries in the cache and can be invalidated by subscriptions or optimistic mutations.

---

## 1. CloudKitProvider

### Context Shape

```typescript
/**
 * Internal context value. Not exported directly — consumed via hooks.
 */
interface CloudKitContextValue {
  /** Container identifier passed to configure(). */
  containerId: string;

  /** Reactive account status. Updates when onAccountStatusChanged fires. */
  accountStatus: AccountStatus | 'loading';

  /** Current sync state, if useCloudKitSync is active within the tree. */
  syncState: SyncState;

  /** The query cache instance (see Section 4). */
  queryCache: QueryCache;
}
```

### Provider Props

```typescript
interface CloudKitProviderProps {
  /**
   * CloudKit container identifier, e.g. "iCloud.com.example.myapp".
   * Calls configure() on mount. Required.
   */
  containerId: string;

  /**
   * Database scope used as the default for all hooks in the tree.
   * Individual hooks can still override this. Default: 'private'.
   */
  defaultDatabase?: DatabaseScope;

  /**
   * When true, the Provider calls getAccountStatus() on mount and
   * subscribes to onAccountStatusChanged for live updates.
   * Default: true.
   */
  observeAccountStatus?: boolean;

  children: React.ReactNode;
}
```

### Provider Internal Behavior

On mount:
1. Call `configure(containerId)`.
2. If `observeAccountStatus` is true (default), call `getAccountStatus()` and set context. Register `addAccountStatusListener` — update `accountStatus` on every change event. Clean up listener on unmount.
3. Create a `QueryCache` instance (see Section 4) and provide it via context.

On `containerId` change:
- Re-run `configure()`. Reset account status to `'loading'`. Re-fetch.

### How Existing Hooks Consume It

The Provider is **opt-in**. Hooks use a `useCloudKitContext()` internal hook:

```typescript
/**
 * Returns the CloudKitContextValue if a Provider exists, or undefined.
 * Never throws — absence of Provider is a valid state.
 */
function useCloudKitContext(): CloudKitContextValue | undefined;
```

Hooks use this to:
- Read `defaultDatabase` (fallback when the hook's own `database` prop is omitted).
- Register/deregister themselves in `queryCache` for invalidation.
- Skip calling `configure()` themselves (the Provider already did it).

When no Provider exists, hooks behave exactly as they do today. Zero breaking changes.

### Convenience Hooks Exposed to Consumers

```typescript
/**
 * Returns the current iCloud account status from the nearest CloudKitProvider.
 * Throws if no CloudKitProvider exists in the tree.
 */
function useAccountStatus(): AccountStatus | 'loading';

/**
 * Returns the container ID from the nearest CloudKitProvider.
 * Throws if no CloudKitProvider exists in the tree.
 */
function useContainerId(): string;
```

These are thin reads from context. They throw on missing Provider because they have no sensible fallback.

---

## 2. useCloudKitSubscription

### Full Signature

```typescript
interface UseCloudKitSubscriptionOptions {
  /**
   * Optional predicate filter for the subscription.
   * Maps to CKQuerySubscription predicate. Omit to match all records.
   */
  predicate?: QueryPredicate;

  /** Zone to scope the subscription. Omit for default zone. */
  zoneName?: string;

  /** Database scope. Falls back to Provider's defaultDatabase, then 'private'. */
  database?: DatabaseScope;

  /** Fires on record creation. Default: true. */
  firesOnCreation?: boolean;

  /** Fires on record update. Default: true. */
  firesOnUpdate?: boolean;

  /** Fires on record deletion. Default: true. */
  firesOnDeletion?: boolean;

  /**
   * When false, the subscription is not created. Allows conditional activation.
   * Default: true.
   */
  enabled?: boolean;

  /**
   * Called when a matching push notification arrives.
   * Fires AFTER any automatic cache invalidation.
   */
  onNotification?: (event: QuerySubscriptionEvent) => void;
}

interface UseCloudKitSubscriptionReturn {
  /**
   * The CloudKit-assigned subscription ID, or undefined if not yet created
   * or if enabled is false.
   */
  subscriptionId: string | undefined;

  /** True while the subscription is being saved to or deleted from CloudKit. */
  loading: boolean;

  /** Error from the most recent save or delete attempt. */
  error: CloudKitError | undefined;
}

function useCloudKitSubscription(
  recordType: string,
  options?: UseCloudKitSubscriptionOptions
): UseCloudKitSubscriptionReturn;
```

### Lifecycle

**Mount (enabled=true):**
1. Call `saveQuerySubscription({ recordType, predicate, firesOnRecordCreation, firesOnRecordUpdate, firesOnRecordDeletion, zoneName, database })`.
2. Store the returned `subscriptionId`.
3. Register an `addSubscriptionListener` that filters events by `subscriptionId`.
4. On matching event: invalidate all `useCloudKitQuery` cache entries with the same `recordType` (via `queryCache.invalidate(recordType)`), then call `onNotification` if provided.

**Unmount:**
1. Call `deleteSubscription(subscriptionId, database)`. Fire-and-forget — do not block unmount on network.
2. Remove the subscription listener.

**recordType or predicate change:**
1. Delete old subscription (fire-and-forget).
2. Create new subscription with updated parameters.
3. Update listener filter.

**enabled flips false:**
1. Delete subscription, remove listener, set `subscriptionId` to undefined.

### Cache Invalidation Mechanism

When a push arrives matching this subscription:

```typescript
// Inside the subscription listener callback
queryCache.invalidateByRecordType(recordType);
```

This causes all active `useCloudKitQuery` hooks watching that `recordType` to `refetch()`. The cache design is in Section 4.

### Without Provider

If no `CloudKitProvider` exists, cache invalidation is skipped. The `onNotification` callback still fires, so the caller can manually trigger refetches. The subscription lifecycle (create/delete) works identically.

---

## 3. Optimistic Updates

### useCloudKitRecord Additions

```typescript
/** Status of an optimistic update. */
type OptimisticStatus = 'idle' | 'pending' | 'committed' | 'rolled-back';

interface UseCloudKitRecordReturn extends CloudKitHookState<CloudKitRecord> {
  refetch: () => Promise<CloudKitRecord | undefined>;

  /**
   * Optimistically updates the record's fields in local state, then
   * persists to CloudKit via saveRecords(). On error, rolls back to
   * the previous local state and sets optimisticError.
   *
   * Only the provided fields are merged — omitted fields are untouched.
   * Requires data to be loaded (data !== undefined).
   *
   * @returns The saved record on success, or undefined on failure.
   */
  update: (fields: Record<string, RecordField>) => Promise<CloudKitRecord | undefined>;

  /** Current optimistic update status. */
  optimisticStatus: OptimisticStatus;

  /**
   * Error from the most recent failed optimistic update.
   * Cleared on the next successful update or refetch.
   * Contains the CloudKitError (often CONFLICT) so callers can handle it.
   */
  optimisticError: CloudKitError | undefined;
}
```

**`update()` state machine:**

```
idle ─── update() called ──→ pending
                               │
                   saveRecords succeeds ──→ committed ──→ idle (on next update/refetch)
                               │
                   saveRecords fails ──→ rolled-back ──→ idle (on next update/refetch)
```

**Implementation sketch:**

```typescript
const update = useCallback(async (fields: Record<string, RecordField>) => {
  if (!state.data) return undefined;

  const previousData = state.data;
  const mergedFields = { ...previousData.fields, ...fields };

  // 1. Optimistic: update local state immediately
  setState(prev => ({
    ...prev,
    data: { ...previousData, fields: mergedFields },
  }));
  setOptimisticStatus('pending');
  setOptimisticError(undefined);

  try {
    // 2. Persist to CloudKit
    const [saved] = await saveRecords([{
      recordType: previousData.recordType,
      recordName: previousData.recordName,
      zoneName: previousData.zoneName,
      changeTag: previousData.changeTag ?? undefined,
      fields: mergedFields,
    }], database);

    // 3. Commit: replace local data with server response (has updated changeTag)
    const committed: CloudKitRecord = {
      ...previousData,
      ...saved,
      fields: saved.fields,
    };
    setState(prev => ({
      ...prev,
      data: committed,
    }));
    setOptimisticStatus('committed');

    // Also update queryCache if Provider is present
    queryCache?.updateRecord(committed);

    return committed;
  } catch (err) {
    // 4. Rollback: restore previous data
    setState(prev => ({
      ...prev,
      data: previousData,
    }));
    const cloudKitError = err instanceof CloudKitError
      ? err
      : CloudKitError.fromNativeError(err);
    setOptimisticError(cloudKitError);
    setOptimisticStatus('rolled-back');
    return undefined;
  }
}, [state.data, database, queryCache]);
```

### useCloudKitQuery Additions

```typescript
interface UseCloudKitQueryReturn extends CloudKitHookState<CloudKitRecord[]> {
  refetch: () => Promise<CloudKitRecord[] | undefined>;
  fetchMore: () => Promise<void>;
  hasMore: boolean;

  /**
   * Optimistically adds a record to the local result set, then saves it
   * to CloudKit. On failure, removes it from the local set.
   *
   * The record is prepended to the array (newest-first assumption).
   * If the record has no recordName, a temporary UUID is assigned locally
   * and replaced with the server-assigned name on commit.
   *
   * @returns The saved record on success, or undefined on failure.
   */
  optimisticAdd: (record: RecordToSave) => Promise<CloudKitRecord | undefined>;

  /**
   * Optimistically removes a record from the local result set, then
   * deletes it from CloudKit. On failure, restores it to the set.
   *
   * @returns true on success, false on failure (record is restored).
   */
  optimisticRemove: (recordName: string) => Promise<boolean>;

  /**
   * Number of records currently in a pending optimistic state.
   * 0 means all displayed records are committed.
   */
  pendingCount: number;

  /**
   * Set of recordNames that are currently in a pending optimistic state.
   * Callers can use this to render a "saving..." indicator per-record.
   */
  pendingRecordNames: ReadonlySet<string>;

  /**
   * Errors from failed optimistic operations, keyed by the recordName
   * that failed. Cleared on the next successful operation or refetch.
   */
  optimisticErrors: ReadonlyMap<string, CloudKitError>;
}
```

**`optimisticAdd()` flow:**

1. Generate a temporary `recordName` if not provided (e.g. `__temp_${uuid}`).
2. Build a temporary `CloudKitRecord` from the `RecordToSave` and prepend it to `data`.
3. Add the temp name to `pendingRecordNames`.
4. Call `saveRecords([record], database)`.
5. On success: replace the temp record with the server response (real recordName, changeTag, dates). Remove from `pendingRecordNames`.
6. On failure: remove the temp record from `data`. Add error to `optimisticErrors`.

**`optimisticRemove()` flow:**

1. Find and remove the record from `data`. Add recordName to `pendingRecordNames`.
2. Call `deleteRecords([{ recordName, zoneName }], database)`.
3. On success: remove from `pendingRecordNames`. Done.
4. On failure: restore the record to its original position in `data`. Remove from `pendingRecordNames`. Add error to `optimisticErrors`.

### Detecting Pending Records in UI

```tsx
const { data, pendingRecordNames } = useCloudKitQuery('Note');

return data?.map(record => (
  <NoteRow
    key={record.recordName}
    record={record}
    isPending={pendingRecordNames.has(record.recordName)}
  />
));
```

### Rollback Visibility

Callers are notified of rollback through two channels:

1. **`optimisticStatus` / `optimisticErrors`** — programmatic detection.
2. **Data change** — the record disappears from the array (optimisticAdd failure) or reappears (optimisticRemove failure). React re-renders naturally.

No toast/alert is shown by the library. Callers decide how to present failures.

---

## 4. Shared Infrastructure: QueryCache

The QueryCache is the one new piece of shared infrastructure. It is intentionally minimal.

### What It Is

A simple in-memory registry of active query hooks and their refetch functions. It is NOT a full data cache (no stale-time, no deduplication of identical queries). The hooks themselves own their data via `useState`. The QueryCache only enables **cross-hook invalidation**.

### Interface

```typescript
/**
 * Internal — not part of the public API.
 * Created once per CloudKitProvider instance.
 */
class QueryCache {
  /**
   * Register an active query hook. Returns an unregister function.
   * Called in useEffect — cleanup calls unregister.
   */
  register(entry: QueryCacheEntry): () => void;

  /**
   * Triggers refetch on all registered queries matching the recordType.
   * Called by useCloudKitSubscription when a push arrives.
   */
  invalidateByRecordType(recordType: string): void;

  /**
   * Triggers refetch on all registered queries.
   * Called by useCloudKitSubscription for database-level subscriptions.
   */
  invalidateAll(): void;

  /**
   * Notifies registered queries that a specific record was updated.
   * Used by optimistic update commit to keep query results fresh
   * without a full refetch.
   */
  updateRecord(record: CloudKitRecord): void;

  /**
   * Notifies registered queries that a record was deleted.
   */
  removeRecord(recordType: string, recordName: string): void;
}

interface QueryCacheEntry {
  /** Unique key for this hook instance (generated via useId or useRef). */
  id: string;
  /** The record type this query watches. undefined for single-record hooks. */
  recordType: string | undefined;
  /** Trigger a refetch. */
  refetch: () => void;
  /**
   * Directly patch a single record in the hook's data without refetching.
   * Used for optimistic update propagation.
   * Return false if the record is not in this hook's data.
   */
  patchRecord?: (record: CloudKitRecord) => boolean;
  /**
   * Directly remove a record from the hook's data without refetching.
   * Return false if the record was not found.
   */
  removeRecord?: (recordName: string) => boolean;
}
```

### Why Not a Full Cache (like React Query)?

1. **Scope** — This is a CloudKit native module, not a state management library. Adding TTL, deduplication, garbage collection, and stale-time logic would double the codebase size for minimal gain.
2. **CloudKit semantics** — CloudKit's change tokens and subscriptions are the authoritative invalidation mechanism. A JS-side cache layer would fight with them.
3. **Simplicity** — The QueryCache is ~60 lines of code. It is a pub/sub bus with a registry, nothing more.

---

## 5. New File Structure

```
src/
  CloudKitProvider.tsx     # CloudKitProvider component + context + useAccountStatus + useContainerId
  QueryCache.ts            # QueryCache class (internal, not exported from index.ts)
  useCloudKitSubscription.ts  # useCloudKitSubscription hook
  hooks.ts                 # Updated: useCloudKitRecord and useCloudKitQuery gain optimistic APIs
  index.ts                 # Updated: exports new public APIs
  types.ts                 # Updated: new types for optimistic state
```

### New Exports from `index.ts`

```typescript
// Phase D — DX Improvements
export { CloudKitProvider } from './CloudKitProvider';
export type { CloudKitProviderProps } from './CloudKitProvider';
export { useAccountStatus, useContainerId } from './CloudKitProvider';
export { useCloudKitSubscription } from './useCloudKitSubscription';
export type {
  UseCloudKitSubscriptionOptions,
  UseCloudKitSubscriptionReturn,
} from './useCloudKitSubscription';

// Updated re-exports from hooks.ts (return types changed — additive, not breaking)
```

---

## 6. New Types for `types.ts`

```typescript
/** Status of an optimistic mutation on a single record. */
export type OptimisticStatus = 'idle' | 'pending' | 'committed' | 'rolled-back';
```

No other new types in `types.ts`. The hook-specific return types live in their respective files (following the existing pattern where `UseCloudKitRecordReturn` is in `hooks.ts`).

---

## 7. Inter-Feature Dependencies & Implementation Order

### Dependency Graph

```
                  QueryCache (internal)
                   /        \
                  /          \
   CloudKitProvider     useCloudKitSubscription
          |                     |
          |    (cache invalidation)
          |                     |
          └─── Optimistic updates in hooks ───┘
                (cache patch/remove)
```

### Implementation Order

**Step 1: QueryCache** (no dependencies, ~60 LOC)
- `src/QueryCache.ts`
- Pure TypeScript class, no React dependency.
- Can be unit-tested in isolation.

**Step 2: CloudKitProvider** (depends on QueryCache)
- `src/CloudKitProvider.tsx`
- Creates QueryCache instance, provides it via context.
- Manages account status subscription.
- Exposes `useAccountStatus()` and `useContainerId()`.
- **Test**: render Provider, verify `useAccountStatus` returns 'loading' then updates.

**Step 3: Update useCloudKitRecord and useCloudKitQuery for cache registration** (depends on QueryCache + Provider)
- Modify `src/hooks.ts`.
- Both hooks call `useCloudKitContext()` and register themselves in the cache.
- No optimistic API yet — just cache registration and invalidation response.
- This is the riskiest step because it modifies existing code. Changes must be additive only.
- **Test**: two useCloudKitQuery hooks for the same recordType; invalidating one refetches both.

**Step 4: useCloudKitSubscription** (depends on QueryCache)
- `src/useCloudKitSubscription.ts`
- Creates/deletes subscriptions on mount/unmount.
- On push arrival, calls `queryCache.invalidateByRecordType()`.
- **Test**: mount hook, verify saveQuerySubscription called; simulate push event, verify cache invalidation.

**Step 5: Optimistic updates** (depends on cache registration from Step 3)
- Modify `src/hooks.ts` again.
- Add `update()` to `useCloudKitRecord`.
- Add `optimisticAdd()`, `optimisticRemove()` to `useCloudKitQuery`.
- Use `queryCache.updateRecord()` and `queryCache.removeRecord()` for cross-hook sync.
- **Test**: call `update()`, verify immediate state change, then verify commit/rollback.

### What Blocks What

| Step | Blocked by | Can parallelize with |
|------|-----------|---------------------|
| 1. QueryCache | nothing | nothing |
| 2. CloudKitProvider | Step 1 | nothing |
| 3. Cache registration in hooks | Steps 1, 2 | nothing |
| 4. useCloudKitSubscription | Step 1 | Steps 2, 3 |
| 5. Optimistic updates | Step 3 | Step 4 |

Steps 4 and 5 can be built in parallel once Step 3 is complete.

---

## 8. Backwards Compatibility

All changes are additive:

- **No Provider?** Hooks work exactly as before. `useCloudKitContext()` returns undefined, cache registration is skipped, no cross-hook invalidation.
- **New return fields** (`update`, `optimisticStatus`, `optimisticAdd`, etc.) are additions to existing return types. Existing destructuring patterns are unaffected.
- **No new required props** on any existing hook.
- **New hooks** (`useCloudKitSubscription`, `useAccountStatus`, `useContainerId`) are additive exports.

This is a **minor version bump** (0.4.0).

---

## 9. Open Questions / Deferred Decisions

1. **Should `useCloudKitSubscription` deduplicate subscriptions?** If two components mount `useCloudKitSubscription('Note')`, should we create one or two CKQuerySubscriptions? CloudKit de-duplicates on the server, but we'd still make two save calls. **Decision: defer.** Two save calls is fine for now. Add ref-counting later if it becomes a problem.

2. **Should optimistic updates work without Provider?** Yes. The `update()` / `optimisticAdd()` / `optimisticRemove()` functions operate on the hook's own local state regardless. Without Provider, cross-hook propagation (`queryCache.updateRecord()`) is skipped — only the originating hook sees the change.

3. **Should the QueryCache persist across Provider remounts?** No. The cache is ephemeral — it only tracks currently-mounted hooks. There is no stale data to persist.

4. **Should `useCloudKitSubscription` create the subscription eagerly or lazily?** Eagerly on mount. CloudKit subscriptions survive app restarts (they're server-side), so creating them on mount aligns with user expectation. The hook cleans up on unmount.

---

## 10. Decision Record

### Decision: Introduce CloudKitProvider with QueryCache for cross-hook coordination

**Context**: The existing hooks are fully standalone — each manages its own data and has no awareness of other hooks. This means (a) subscription-driven refetches require manual wiring, (b) optimistic updates in one hook don't propagate to queries showing the same data, and (c) there's no shared place for account status.

**Decision**: Add an opt-in `CloudKitProvider` that owns a `QueryCache` — a lightweight pub/sub registry enabling cross-hook invalidation and optimistic update propagation. The Provider also manages account status reactively. All new functionality is additive; existing hook usage without Provider is unchanged.

**Consequences**:
- Enables: subscription-driven automatic refetch, optimistic updates with cross-hook sync, shared account status.
- Constrains: the QueryCache is deliberately not a full data cache. If callers need TTL, deduplication, or persistence, they should use React Query or similar on top.
- Risk: modifying `hooks.ts` (Steps 3, 5) touches existing code. Must be done carefully with additive-only changes and thorough testing.
