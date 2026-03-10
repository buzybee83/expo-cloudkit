/**
 * expo-cloudkit — Platform barrel
 *
 * On native (iOS/Android), this re-exports from `ExpoCloudKit.native.ts`,
 * which uses `requireNativeModule` from expo-modules-core.
 *
 * On web, Metro/bundler resolves `ExpoCloudKit.web.ts` instead of this file
 * via the `.web.ts` platform extension convention.
 *
 * This barrel exists so that:
 * - `import { configure } from './ExpoCloudKit'` always works
 * - The web bundle never loads expo-modules-core or react-native APIs
 */

export * from './ExpoCloudKit.native';
