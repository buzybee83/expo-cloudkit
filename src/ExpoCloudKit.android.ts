/**
 * expo-cloudkit — Android platform override
 *
 * Android routes to the CloudKit JS web implementation for all operations that
 * CloudKit JS supports. Native-only operations (CKSyncEngine conflict
 * resolution and sync-health events) throw `CloudKitNotSupportedError` because
 * they depend on iOS system APIs with no CloudKit JS equivalent.
 *
 * Metro resolves `.android.ts` before `.ts`, so imports of `./ExpoCloudKit`
 * inside Android bundles land here automatically — no Metro config changes are
 * required.
 *
 * DO NOT import from `expo-modules-core` here. This file must be buildable in
 * environments that do not have the native module installed.
 */

// Re-export every function the web implementation provides. This covers all
// ~57 functions that have a CloudKit JS equivalent (record CRUD, zones, push
// subscriptions, sharing, offline queue, multi-container, etc.).
export * from './ExpoCloudKit.web';

// ---------------------------------------------------------------------------
// Native-only stubs
// ---------------------------------------------------------------------------
// The two functions below exist in ExpoCloudKit.native.ts but have no
// equivalent in CloudKit JS. They are re-exported here as stubs so that
// TypeScript callers on Android get the correct types, and receive a clear
// error at runtime instead of a cryptic "not a function" crash.

import { CloudKitNotSupportedError } from './errors';
import type { RecordToSave, SyncHealthEvent, Subscription } from './types';

/**
 * Resolves a CKSyncEngine conflict on iOS by supplying the winning record.
 *
 * Not available on Android — CKSyncEngine is an iOS 17+ system API.
 *
 * @throws {CloudKitNotSupportedError} Always — this operation requires iOS.
 */
export function resolveSyncConflict(
  _requestId: string,
  _resolvedRecord: RecordToSave | null
): void {
  throw new CloudKitNotSupportedError();
}

/**
 * Subscribes to CKSyncEngine health events emitted by the iOS sync provider.
 *
 * Not available on Android — returns a no-op subscription so callers that
 * unconditionally call `.remove()` do not crash.
 *
 * @returns A no-op `Subscription` whose `remove()` is a no-op.
 */
export function addSyncHealthListener(
  _callback: (event: SyncHealthEvent) => void
): Subscription {
  return { remove: () => {} };
}
