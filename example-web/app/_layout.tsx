/**
 * Root layout for the expo-cloudkit universal example app.
 *
 * Wraps the entire navigation tree with CloudKitProvider, which:
 *   - Calls configure() on iOS (native iCloud auth is automatic)
 *   - Calls configureWeb() on web with the provided apiToken
 *   - Exposes useAccountStatus() and useContainerId() to all screens
 *
 * The API token is read from EXPO_PUBLIC_CLOUDKIT_API_TOKEN at build time.
 * Obtain it from: CloudKit Dashboard → API Access → Tokens
 */

import { CloudKitProvider } from 'expo-cloudkit';
import { Stack } from 'expo-router';

const CONTAINER_ID = 'iCloud.com.example.cloudkit-demo';

/**
 * Get the API token from the environment.
 * Set EXPO_PUBLIC_CLOUDKIT_API_TOKEN in your .env file for local development.
 * For production, set it in your CI/CD environment.
 */
const WEB_API_TOKEN = process.env.EXPO_PUBLIC_CLOUDKIT_API_TOKEN ?? '';

export default function RootLayout() {
  return (
    <CloudKitProvider
      containerId={CONTAINER_ID}
      webConfig={{
        apiToken: WEB_API_TOKEN,
        environment: 'development',
        persistSession: true,
      }}
    >
      <Stack>
        <Stack.Screen name="index" options={{ title: 'CloudKit Demo' }} />
        <Stack.Screen name="notes" options={{ title: 'Notes' }} />
        <Stack.Screen name="note/[id]" options={{ title: 'Note Detail' }} />
      </Stack>
    </CloudKitProvider>
  );
}
