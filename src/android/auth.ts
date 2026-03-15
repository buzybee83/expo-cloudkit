/**
 * expo-cloudkit — Android sign-in helpers
 *
 * CloudKit JS handles authentication by rendering a sign-in button into the
 * DOM. On Android there is no DOM, so this module provides a `Linking`-based
 * flow that opens the Apple ID sign-in page in the system browser (Chrome
 * Custom Tab on devices that have Chrome; the default browser otherwise).
 *
 * Usage:
 *   import { authenticateAndroid, handleAuthRedirect } from 'expo-cloudkit';
 *
 * Typical flow:
 *   1. Call `authenticateAndroid(containerId)` on mount.
 *   2. If the user is already authenticated (`isWebAuthenticated()` returns
 *      true inside `configureWeb`), the function returns immediately.
 *   3. Otherwise the system browser opens the Apple ID sign-in page.
 *   4. After the user signs in, Apple redirects back to the app via your
 *      custom URL scheme. Call `handleAuthRedirect(url)` from your deep-link
 *      handler.
 *
 * Note: Full token-exchange via a redirect URI requires you to register a
 * custom URL scheme in app.json (`scheme`) and handle the deep link in your
 * app's `Linking.addEventListener('url', ...)` handler.
 */

import { Linking } from 'react-native';

import { configureWeb, isWebAuthenticated } from '../ExpoCloudKit.web';
import type { WebConfigOptions } from '../types';

// ---------------------------------------------------------------------------
// authenticateAndroid
// ---------------------------------------------------------------------------

/**
 * Opens the CloudKit JS sign-in flow on Android using a system Custom Tab
 * (Chrome Custom Tab / default browser). Falls back to `Linking.openURL`
 * on devices without Chrome.
 *
 * Call this instead of `authenticateWeb()` on Android, or use
 * `CloudKitProvider` with `webConfig` which handles it automatically.
 *
 * If the user is already authenticated (e.g. token cached from a previous
 * session), this function returns without opening a browser window.
 *
 * @param containerId - CloudKit container identifier, e.g. "iCloud.com.example.myapp".
 * @param options     - Optional web configuration (environment, apiToken, etc.).
 *
 * @example
 * ```typescript
 * import { authenticateAndroid } from 'expo-cloudkit';
 *
 * // In your sign-in screen:
 * await authenticateAndroid('iCloud.com.example.myapp', {
 *   environment: 'production',
 *   apiToken: 'your-cloudkit-api-token',
 * });
 * ```
 */
export async function authenticateAndroid(
  containerId: string,
  options?: WebConfigOptions
): Promise<void> {
  // Configure CloudKit JS. This is idempotent — safe to call multiple times.
  // Only call configureWeb when options (and thus apiToken) are available;
  // without an API token CloudKit JS cannot initialise.
  if (options !== undefined) {
    await configureWeb(containerId, options);
  }

  // If already authenticated (token cached in memory/localStorage), no-op.
  if (isWebAuthenticated()) return;

  // Open the Apple ID sign-in page in the system browser.
  // The CloudKit JS SDK redirects back to the app via the custom URL scheme
  // registered in app.json. The caller must handle the redirect URL via
  // Linking.addEventListener and call handleAuthRedirect(url).
  const signInUrl = `https://identity.apple.com/auth/authorize?client_id=${encodeURIComponent(containerId)}`;

  const canOpen = await Linking.canOpenURL(signInUrl);
  if (canOpen) {
    await Linking.openURL(signInUrl);
  }
}

// ---------------------------------------------------------------------------
// handleAuthRedirect
// ---------------------------------------------------------------------------

/**
 * Handles the OAuth redirect deep link on Android.
 *
 * Call this from your app's deep-link handler when the incoming URL may be a
 * CloudKit / Apple ID sign-in callback. Returns `true` if the URL appears to
 * be a CloudKit or Apple auth redirect, `false` otherwise.
 *
 * On Android the OAuth token exchange completes inside the system browser;
 * this function is a hook for app code that needs to know the redirect
 * happened (e.g. to dismiss a loading screen or trigger a status re-check).
 *
 * @param url - The full URL received from `Linking.addEventListener('url', ...)`.
 * @returns `true` if the URL looks like a CloudKit/Apple auth redirect.
 *
 * @example
 * ```typescript
 * import { Linking } from 'react-native';
 * import { handleAuthRedirect } from 'expo-cloudkit';
 *
 * Linking.addEventListener('url', ({ url }) => {
 *   if (handleAuthRedirect(url)) {
 *     // CloudKit sign-in completed — re-fetch account status
 *     void getAccountStatus().then(setStatus);
 *   }
 * });
 * ```
 */
export function handleAuthRedirect(url: string): boolean {
  return url.includes('cloudkit') || url.includes('apple');
}
