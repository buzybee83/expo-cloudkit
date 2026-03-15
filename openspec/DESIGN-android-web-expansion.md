# Design: Android & Web Platform Expansion

**Date**: 2026-03-10
**Status**: Proposed
**Author**: architect agent

---

## Context

expo-cloudkit is a fully-featured iOS CloudKit module (Phases A-D complete, 40+ exported APIs). The question is whether and how to expand to Android and web. CloudKit has no native SDK outside Apple platforms, but Apple provides CloudKit Web Services (REST API at `api.apple-cloudkit.com`) and CloudKit JS (browser SDK loaded from Apple's CDN).

This document evaluates three options, analyzes the constraints, and makes a recommendation.

---

## Current API Surface Inventory

Before evaluating options, here is the complete expo-cloudkit API surface (48 exports from `src/index.ts`) categorized by implementability on non-iOS platforms via CloudKit Web Services REST API.

### Implementable via CloudKit Web Services REST API

These map directly to documented REST endpoints:

| expo-cloudkit API | REST Endpoint | Notes |
|---|---|---|
| `configure()` | N/A (client-side config) | Set container ID + API token |
| `getAccountStatus()` | `users/caller` | Returns auth state |
| `createZone()` | `zones/modify` | Full parity |
| `deleteZone()` | `zones/modify` | Full parity |
| `fetchZones()` | `zones/list` | Full parity |
| `saveRecords()` | `records/modify` | Full parity |
| `fetchRecord()` | `records/lookup` | Full parity |
| `queryRecords()` | `records/query` | Full parity, cursor pagination |
| `deleteRecords()` | `records/modify` | Full parity |
| `fetchRecordZoneChanges()` | `changes/zone` | Sync tokens work identically |
| `downloadAsset()` | `assets/upload` + URL fetch | Assets have download URLs |
| `saveQuerySubscription()` | `subscriptions/modify` | Creates subscription on server |
| `saveDatabaseSubscription()` | `subscriptions/modify` | Creates subscription on server |
| `deleteSubscription()` | `subscriptions/modify` | Full parity |
| `fetchSubscriptions()` | `subscriptions/list` | Full parity |
| `acceptShare()` | `records/accept` | Full parity |
| `fetchRecordWithReferences()` | `records/lookup` (multiple) | Implementable in JS |

**Total: 17 functions (core CRUD, zones, subscriptions, basic sharing)**

### NOT Implementable on non-iOS (iOS-only primitives)

| expo-cloudkit API | Why iOS-only |
|---|---|
| `addAccountStatusListener()` | iOS `NSNotificationCenter` observer |
| `isSyncEngineAvailable()` | `CKSyncEngine` is iOS 17+ only |
| `startSyncEngine()` | `CKSyncEngine` / iOS 16 fallback timer |
| `getSyncState()` | In-memory native state |
| `triggerSync()` | `CKSyncEngine` |
| `enqueuePendingChange()` | `CKSyncEngine` queue |
| `addSyncEngineListener()` | Native event emitter |
| `stopSyncEngine()` | `CKSyncEngine` |
| `createShare()` | `CKModifyRecordsOperation` for CKShare (could be REST, but auth is complex) |
| `deleteShare()` | Same |
| `presentSharingUI()` | `UICloudSharingController` (UIKit) |
| `fetchShareParticipants()` | `CKShare` record inspection |
| `updateSharePermission()` | `CKShare` modification |
| `removeShareParticipant()` | `CKShare` modification |
| `fetchSharedDatabaseZones()` | Shared database enumeration |
| `addShareAcceptedListener()` | iOS universal link handler |
| `addAssetProgressListener()` | Native progress callbacks |
| `addBatchProgressListener()` | Native per-record callbacks |
| `addSubscriptionListener()` | APNs push delivery |
| `addOfflineQueueListener()` | Native event emitter |
| `enqueueOfflineOperation()` | Native persistent queue |
| `drainOfflineQueue()` | Native queue processor |
| `getOfflineQueueStatus()` | Native queue state |
| `clearOfflineQueue()` | Native queue management |
| `retryFailedOperations()` | Native queue management |
| `__debugDumpContainerInfo()` | Native introspection |
| `__debugListZones()` | Native introspection |
| `__debugFetchRawRecord()` | Native introspection |
| `__debugClearZone()` | Native batch delete |

**Total: 29 functions (sync engine, sharing UI, offline queue, push delivery, progress events, debug)**

### React Hooks & Provider (JS-layer, platform-agnostic in theory)

| API | Could work cross-platform? |
|---|---|
| `useCloudKitRecord()` | Yes, if underlying CRUD works |
| `useCloudKitQuery()` | Yes, if underlying query works |
| `useCloudKitSync()` | No (depends on sync engine) |
| `CloudKitProvider` | Yes, but `accountStatus` listener is iOS-only |
| `useAccountStatus()` | Partially (poll, no live updates) |
| `useContainerId()` | Yes |
| `useCloudKitSubscription()` | No (depends on APNs push delivery) |

---

## Option Analysis

### Option A: CloudKit Web Services (REST API) on Android + Web

**What it means**: Implement a JS-only CloudKit REST client that handles authentication (Apple ID OAuth) and calls the same REST endpoints that CloudKit JS uses. Ship this as an alternative backend for Android and web, selected automatically by platform.

**Auth flow**: CloudKit Web Services requires an API token (created in CloudKit Dashboard) for public database access, and Apple ID sign-in (OAuth) for private/shared database access. On Android, this means launching a web-based Apple OAuth flow (`expo-auth-session`), receiving a redirect, and passing the resulting web auth token to subsequent REST calls.

| Pros | Cons |
|---|---|
| Full record CRUD parity on all platforms | Auth is complex: Apple ID OAuth on Android requires server-side secret rotation every 6 months |
| Uses Apple's official, stable REST API | Only 17 of 48 APIs are implementable; 60% of the surface throws `NotSupported` anyway |
| Public database access is straightforward (API token only) | No push notification delivery on Android/web (subscriptions can be created but notifications go to APNs only) |
| Change token-based sync works via REST | Doubles the testing surface: every CRUD function needs iOS native + REST codepaths |
| | CloudKit JS is CDN-hosted, not an npm package; `tsl-apple-cloudkit` is the community wrapper |
| | Maintenance burden on a solo maintainer is substantial |

**Effort**: Large (3-6 weeks for auth + CRUD + tests + docs)
**Risk**: High (auth complexity, API token management, ongoing maintenance of dual codepaths)

### Option B: Graceful Degradation with Capability Detection

**What it means**: Keep the current behavior (throw `CloudKitNotSupportedError` on non-iOS) but enhance the developer experience with explicit capability detection APIs and documentation guiding users to alternative backends for cross-platform apps.

| Pros | Cons |
|---|---|
| Zero new code to maintain | Does not help Android/web users at all |
| No auth complexity | Users may perceive the library as incomplete |
| Clear, honest API contract | |
| Users who need cross-platform can pair expo-cloudkit (iOS) with another backend (Supabase, Firebase, etc.) | |

**Effort**: Small (1-2 days for docs + capability APIs)
**Risk**: Low

### Option C: Hybrid -- REST for CRUD, iOS-only for Advanced Features

**What it means**: Implement CloudKit Web Services REST calls for the core CRUD operations (configure, zones, records, queries) on Android and web. Everything else (sync engine, sharing, offline queue, push delivery) remains iOS-only and throws `CloudKitNotSupportedError` on other platforms.

| Pros | Cons |
|---|---|
| The most-used APIs (CRUD) work everywhere | Still need to solve Apple ID OAuth on Android |
| Advanced features remain native-only (simpler) | 17 functions get REST implementations; 29 still throw |
| Incremental: can ship public-database-only first (API token auth, no OAuth needed) | Two codepaths for 17 functions = 2x testing |
| Hooks (`useCloudKitRecord`, `useCloudKitQuery`) gain cross-platform value | `useCloudKitSync` and `useCloudKitSubscription` remain iOS-only |
| | CloudKit private database on Android requires Apple ID OAuth, which most Android users will not have configured |

**Effort**: Medium-Large (2-4 weeks)
**Risk**: Medium

---

## Critical Constraint: The Apple ID Authentication Problem

This is the elephant in the room and it deserves its own section.

CloudKit private and shared databases require the user to be signed into iCloud. On iOS, this is handled transparently by the OS -- the user is already signed in. On Android and web, there is no iCloud account. The user must:

1. Sign in with Apple ID via OAuth (web-based flow)
2. The app must have an Apple Developer account with a Services ID configured for web auth
3. The server-side secret key must be rotated every 6 months (Apple mandate)
4. The resulting session token must be passed with every CloudKit REST request

**The fundamental problem**: Most Android users do not have Apple IDs. Those who do are unlikely to sign in with Apple ID to use a data sync feature. This means CloudKit on Android is only useful for:

- **Public database access** (no auth required beyond an API token)
- **Cross-platform apps where iOS is primary** and the Android user has an Apple ID (rare edge case)

For the public database, the auth story is simple: create an API token in CloudKit Dashboard, embed it in the app. No user sign-in required. This is a viable and useful feature.

For private/shared databases on Android, the auth story is hostile to users and hostile to developers.

---

## Recommendation: Option B (Graceful Degradation) with a Scoped Option C Spike

### Primary recommendation: Option B

I recommend **Option B** as the primary strategy. Here is why:

1. **The audience mismatch is fundamental.** CloudKit is Apple's ecosystem play. Android users do not have iCloud accounts. Building REST bridges to CloudKit for Android private data is solving a problem that almost no one has. The users who need cross-platform sync should use a cross-platform backend (Supabase, Firebase, Convex, etc.) and pair it with expo-cloudkit on iOS only when they need iCloud-specific features (CKSyncEngine, sharing).

2. **Maintenance burden is disproportionate.** This is an OSS project with one maintainer. Dual codepaths for 17 functions, each requiring separate auth handling, error mapping, and testing, would roughly double the maintenance surface. Every CloudKit REST API change or deprecation becomes a second thing to track.

3. **The current behavior is correct and clear.** `CloudKitNotSupportedError` with a descriptive message is the right contract. The existing `isCloudKitAvailable()` / `isSyncEngineAvailable()` pattern is the right capability detection model.

### What to ship under Option B

Add to the public API:

```typescript
/** Returns true if CloudKit native APIs are available (iOS only). */
export function isCloudKitAvailable(): boolean;

/** Returns a map of feature → availability for the current platform. */
export function getCapabilities(): {
  cloudkit: boolean;
  syncEngine: boolean;
  pushSubscriptions: boolean;
  sharing: boolean;
  sharingUI: boolean;
  offlineQueue: boolean;
};
```

Add a documentation section to README: **"Cross-Platform Strategy"** explaining:
- expo-cloudkit is iOS-native by design
- For cross-platform apps, use a cross-platform backend for shared data and expo-cloudkit for iOS-specific features
- Link to guides for pairing expo-cloudkit with Firebase, Supabase, etc.

### Secondary recommendation: Scoped public-database REST spike (deferred)

If there is demonstrated user demand (GitHub issues, feature requests), a **public-database-only REST client** is the one expansion worth considering. This is because:

- Public database requires only an API token (no Apple ID OAuth, no user sign-in)
- Public database is useful for read-only shared content (e.g., a CMS, app configuration, public catalogs)
- The implementation is straightforward: `fetch()` calls to `api.apple-cloudkit.com` with an API token header
- It could work on Android, web, and even server-side Node.js

This would be a separate, opt-in import:

```typescript
import { createCloudKitWebClient } from 'expo-cloudkit/web';

const client = createCloudKitWebClient({
  containerId: 'iCloud.com.example.myapp',
  apiToken: 'your-api-token-from-dashboard',
  environment: 'production', // or 'development'
});

// Only public database operations
const result = await client.queryRecords('public', 'Article', {
  field: 'category',
  comparator: '=',
  value: 'news',
});
```

**Why a separate import**: The REST client should not be bundled with the native module. It is a different codepath with different auth, different error shapes, and different capabilities. Keeping it in a sub-path export (`expo-cloudkit/web`) makes the boundary explicit and avoids bloating the iOS-only bundle.

**When to build this**: Only if 5+ GitHub issues request it, or if the maintainer personally needs it for a project. Do not build it speculatively.

---

## API Surface Per Platform (Recommended State)

| Feature Category | iOS | Android | Web |
|---|---|---|---|
| Container config | Native | Not supported | Not supported |
| Account status | Native | Not supported | Not supported |
| Zone CRUD | Native | Not supported | Not supported |
| Record CRUD | Native | Not supported | Not supported |
| Queries | Native | Not supported | Not supported |
| CKSyncEngine | Native (17+) | Not supported | Not supported |
| iOS 16 fallback sync | Native | Not supported | Not supported |
| Push subscriptions | Native | Not supported | Not supported |
| CKShare / sharing | Native | Not supported | Not supported |
| Sharing UI | Native | Not supported | Not supported |
| Offline queue | Native | Not supported | Not supported |
| Asset upload/download | Native | Not supported | Not supported |
| React hooks | Full | No-op (errors) | No-op (errors) |
| Capability detection | Full | Returns all false | Returns all false |

If the public-database spike ships later:

| Feature Category | iOS | Android | Web |
|---|---|---|---|
| Public DB queries (via `expo-cloudkit/web`) | REST | REST | REST |
| Public DB record CRUD (via `expo-cloudkit/web`) | REST | REST | REST |
| Everything else | Native | Not supported | Not supported |

---

## Auth Strategy Summary

| Scenario | Auth Method | Complexity | Recommendation |
|---|---|---|---|
| iOS native (current) | OS-level iCloud sign-in | None (transparent) | Keep as-is |
| Public DB on any platform | API token from CloudKit Dashboard | Low (embed token) | Build only if demanded |
| Private DB on Android/web | Apple ID OAuth + server secret rotation | Very high | Do not build |
| Shared DB on Android/web | Apple ID OAuth + CKShare semantics | Extremely high | Do not build |

---

## Implementation Phases (if public-database spike is approved)

### Phase 1: Public DB REST client (1 week)
- New file: `src/web/CloudKitWebClient.ts`
- Implements: `queryRecords`, `fetchRecord`, `saveRecords` (public DB only)
- Auth: API token header only
- Error mapping: REST error codes to `CloudKitError` / `CloudKitErrorCode`
- No native code changes required

### Phase 2: Public DB zones + subscriptions (3 days)
- Adds: `fetchZones`, `createZone`, `fetchSubscriptions` for public DB
- Subscriptions create server-side but cannot deliver pushes on Android/web

### Phase 3: Documentation + examples (2 days)
- README section on cross-platform usage
- Example showing public DB read-only catalog pattern

---

## Trade-offs Acknowledged

**What we are giving up:**
- Android/web users cannot use expo-cloudkit for private data sync (they need a different backend)
- No single unified API for all platforms (the React hooks only work on iOS)
- The public-database spike, if built, is a separate API surface from the main module

**Why this is acceptable:**
- CloudKit is inherently an Apple ecosystem technology
- The users who choose CloudKit have already chosen the Apple ecosystem
- Attempting to paper over this with REST bridges creates a worse experience than being honest about platform boundaries
- The maintenance cost of dual codepaths is not justified by the user demand

---

## Decision

**Recommended**: Option B (graceful degradation with capability detection).

Ship `isCloudKitAvailable()` and `getCapabilities()`. Document the cross-platform strategy. Defer the public-database REST client until there is demonstrated demand.

This decision can be revisited when:
- Apple ships a cross-platform CloudKit SDK (unlikely but not impossible)
- 5+ GitHub issues request Android/web support with concrete use cases
- The maintainer needs public-database access from a non-iOS client for their own project

---

## Sources

- [CloudKit Web Services Reference](https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/index.html)
- [CloudKit JS Documentation](https://developer.apple.com/documentation/cloudkitjs)
- [Obtaining an API Token for CloudKit](https://developer.apple.com/documentation/cloudkit/obtaining-an-api-token-for-an-icloud-container)
- [tsl-apple-cloudkit npm package](https://www.npmjs.com/package/tsl-apple-cloudkit)
- [expo-apple-authentication](https://docs.expo.dev/versions/latest/sdk/apple-authentication/)
- [Expo Authentication Guide](https://docs.expo.dev/develop/authentication/)
- [CKTool JS (WWDC22)](https://developer.apple.com/videos/play/wwdc2022/10116/)
