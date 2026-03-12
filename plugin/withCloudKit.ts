/**
 * expo-cloudkit config plugin
 *
 * Automatically configures the host Expo app's Xcode project with the
 * entitlements and capabilities required for CloudKit:
 *
 *   - com.apple.developer.icloud-container-identifiers
 *   - com.apple.developer.icloud-services = ["CloudKit"]
 *   - Background Modes: remote-notification
 *
 * Usage in app.json / app.config.js:
 * ```json
 * {
 *   "plugins": [
 *     ["expo-cloudkit", { "containerIds": ["iCloud.com.example.myapp"] }]
 *   ]
 * }
 * ```
 *
 * The plugin does NOT handle the "Push Notifications" capability — that is
 * managed by expo-notifications. If you use CKSyncEngine (Phase B), add
 * expo-notifications to your project as well.
 */

import {
  ConfigPlugin,
  createRunOncePlugin,
  withEntitlementsPlist,
  withInfoPlist,
} from '@expo/config-plugins';

// ---------------------------------------------------------------------------
// Plugin options
// ---------------------------------------------------------------------------

export interface WithCloudKitOptions {
  /**
   * One or more CloudKit container identifiers.
   * Format: "iCloud.com.example.yourapp"
   *
   * These must match the containers configured in your Apple Developer account
   * at developer.apple.com → Certificates, Identifiers & Profiles → Identifiers.
   */
  containerIds: string[];

  /**
   * The iCloud container environment for the entitlement.
   * Use 'Development' for debug builds and 'Production' for release/EAS builds.
   * Default: 'Production' (Xcode requires a string, not an array).
   */
  iCloudContainerEnvironment?: 'Development' | 'Production';
}

// ---------------------------------------------------------------------------
// Main plugin
// ---------------------------------------------------------------------------

const withCloudKitPlugin: ConfigPlugin<WithCloudKitOptions> = (config, options) => {
  const { containerIds, iCloudContainerEnvironment = 'Production' } = options;

  if (!containerIds || containerIds.length === 0) {
    throw new Error(
      '[expo-cloudkit] The config plugin requires at least one container ID. ' +
        'Add ["expo-cloudkit", { "containerIds": ["iCloud.com.example.myapp"] }] to your plugins.'
    );
  }

  // Validate container ID format
  for (const id of containerIds) {
    if (!id.startsWith('iCloud.')) {
      throw new Error(
        `[expo-cloudkit] Invalid container ID: "${id}". ` +
          'Container IDs must start with "iCloud." (e.g. "iCloud.com.example.myapp").'
      );
    }
  }

  // Step 1: Add iCloud entitlements
  config = withEntitlementsPlist(config, (config) => {
    // iCloud container identifiers
    config.modResults['com.apple.developer.icloud-container-identifiers'] = containerIds;

    // iCloud services — must include CloudKit
    const existingServices: string[] =
      (config.modResults['com.apple.developer.icloud-services'] as string[]) ?? [];

    if (!existingServices.includes('CloudKit')) {
      config.modResults['com.apple.developer.icloud-services'] = [
        ...existingServices,
        'CloudKit',
      ];
    }

    // iCloud container environment — must be a string, not an array.
    // Xcode requires exactly 'Development' or 'Production'.
    config.modResults['com.apple.developer.icloud-container-environment'] =
      iCloudContainerEnvironment;

    return config;
  });

  // Step 2: Add background modes for remote notifications
  // Required for CKSyncEngine to wake the app on remote change notifications.
  config = withInfoPlist(config, (config) => {
    const existingModes: string[] =
      (config.modResults['UIBackgroundModes'] as string[]) ?? [];

    if (!existingModes.includes('remote-notification')) {
      config.modResults['UIBackgroundModes'] = [
        ...existingModes,
        'remote-notification',
      ];
    }

    return config;
  });

  return config;
};

// Wrap with createRunOncePlugin to prevent duplicate execution when the
// plugin appears multiple times in a config chain.
export const withCloudKit = createRunOncePlugin(
  withCloudKitPlugin,
  'expo-cloudkit',
  '0.1.0'
);

export default withCloudKit;
