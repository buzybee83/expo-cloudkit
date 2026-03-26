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

  /**
   * Optional BGTask identifier for background CloudKit sync.
   *
   * When set, the plugin:
   *   1. Adds the identifier to `BGTaskSchedulerPermittedIdentifiers` in Info.plist.
   *   2. Adds `fetch` and `processing` to `UIBackgroundModes` in Info.plist.
   *
   * Pass the same string to `registerBackgroundSync(taskIdentifier)` at runtime.
   *
   * A common convention is `$(PRODUCT_BUNDLE_IDENTIFIER).cloudkit-sync`, but any
   * reverse-DNS string works as long as it is unique within the app and matches
   * the value passed to `registerBackgroundSync()`.
   *
   * @example
   * ```json
   * { "backgroundSyncTaskIdentifier": "com.example.myapp.cloudkit-sync" }
   * ```
   */
  backgroundSyncTaskIdentifier?: string;

  /**
   * Optional App Group identifier for Phase K.3 Live Activities and Widgets
   * integration.
   *
   * When set, the plugin adds the `com.apple.security.application-groups`
   * entitlement with this identifier. This allows the main app target and
   * widget/Live Activity extension targets to share data via a common
   * `UserDefaults` suite (used by `configureExtensionBridge`).
   *
   * Format: "group.com.example.yourapp"
   *
   * The identifier must be provisioned in your Apple Developer account and
   * added to all targets (main app + widget extensions) that need to read
   * or write the shared CloudKit record cache.
   *
   * @example
   * ```json
   * { "appGroupIdentifier": "group.com.example.myapp" }
   * ```
   */
  appGroupIdentifier?: string;
}

// ---------------------------------------------------------------------------
// Main plugin
// ---------------------------------------------------------------------------

const withCloudKitPlugin: ConfigPlugin<WithCloudKitOptions> = (config, options) => {
  const {
    containerIds,
    iCloudContainerEnvironment = 'Production',
    backgroundSyncTaskIdentifier,
    appGroupIdentifier,
  } = options;

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

    // Phase K.3 — App Group entitlement for WidgetKit / Live Activity bridge.
    // Allows the main app and widget/extension targets to share a UserDefaults suite.
    if (appGroupIdentifier) {
      const existingGroups: string[] =
        (config.modResults['com.apple.security.application-groups'] as string[]) ?? [];
      if (!existingGroups.includes(appGroupIdentifier)) {
        config.modResults['com.apple.security.application-groups'] = [
          ...existingGroups,
          appGroupIdentifier,
        ];
      }
    }

    return config;
  });

  // Step 2: Add background modes and optional BGTaskScheduler identifier.
  // remote-notification: Required for CKSyncEngine to wake the app on push.
  // fetch + processing:  Required for BGAppRefreshTask (background sync).
  config = withInfoPlist(config, (config) => {
    // UIBackgroundModes -------------------------------------------------------
    const existingModes: string[] =
      (config.modResults['UIBackgroundModes'] as string[]) ?? [];

    const requiredModes = ['remote-notification'];
    if (backgroundSyncTaskIdentifier) {
      // BGAppRefreshTask requires both 'fetch' and 'processing'.
      requiredModes.push('fetch', 'processing');
    }

    const mergedModes = Array.from(new Set([...existingModes, ...requiredModes]));
    config.modResults['UIBackgroundModes'] = mergedModes;

    // BGTaskSchedulerPermittedIdentifiers -------------------------------------
    // The system uses this allowlist to validate BGTask identifiers at launch.
    // If the identifier is not listed here the task handler registration is
    // silently ignored and background launches will never occur.
    if (backgroundSyncTaskIdentifier) {
      const existingIdentifiers: string[] =
        (config.modResults['BGTaskSchedulerPermittedIdentifiers'] as string[]) ?? [];

      if (!existingIdentifiers.includes(backgroundSyncTaskIdentifier)) {
        config.modResults['BGTaskSchedulerPermittedIdentifiers'] = [
          ...existingIdentifiers,
          backgroundSyncTaskIdentifier,
        ];
      }
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
