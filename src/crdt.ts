/**
 * expo-cloudkit — CRDT mutation helpers (Phase K.2)
 *
 * Re-exports the four CRDT mutation functions from the main module.
 * Import from 'expo-cloudkit' for the full public API, or directly
 * from 'expo-cloudkit/crdt' if you prefer a focused import path.
 *
 * All functions require:
 * 1. `configure()` to have been called.
 * 2. `startSyncEngine({ crdtSchema: { ... } })` to have been called with
 *    the relevant field names registered in the schema.
 *
 * @example
 * ```typescript
 * import { incrementCRDTCounter, addToORSet } from 'expo-cloudkit';
 *
 * // After startSyncEngine({ zones: ['myZone'], crdtSchema: { likes: 'pncounter', tags: 'orset' } })
 * await incrementCRDTCounter({ recordName: 'rec1', zoneName: 'myZone', field: 'likes' });
 * await addToORSet({ recordName: 'rec1', zoneName: 'myZone', field: 'tags', value: 'swift' });
 * ```
 */
export {
  incrementCRDTCounter,
  addToORSet,
  removeFromORSet,
  setLWWRegister,
} from './ExpoCloudKit';
