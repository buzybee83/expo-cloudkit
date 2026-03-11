# expo-cloudkit — Universal Web Example

A standalone Expo Router app that demonstrates expo-cloudkit on **both iOS and web**,
using the same TypeScript API for both platforms.

## What this demonstrates

| Screen | API used |
|--------|----------|
| Home (`/`) | `useAccountStatus`, `useContainerId`, `authenticateWeb`, `isCloudKitAvailable` |
| Notes (`/notes`) | `useCloudKitQuery` (optimisticAdd, optimisticRemove, pendingRecordNames), `useCloudKitSubscription` |
| Note detail (`/note/[id]`) | `useCloudKitRecord` (update, optimisticStatus, optimisticError) |

Components:
- `AccountBanner` — reactive status badge + web "Sign in with Apple" button
- `NoteCard` — record row with pending indicator, Platform-adaptive delete button
- `ErrorBanner` — displays `CloudKitError.code` + `error.message`

## Prerequisites

### 1. Apple Developer account

You need an active Apple Developer membership to use CloudKit.

### 2. iCloud container

Create a container at [developer.apple.com](https://developer.apple.com/account/resources/identifiers/list/cloudkit).
The example uses `iCloud.com.example.cloudkit-demo` — replace this with your own container ID in:
- `app.json` → `plugins[0][1].iCloudContainers`
- `app/_layout.tsx` → `CONTAINER_ID`

### 3. CloudKit API token (web only)

On web, CloudKit JS requires an API token:

1. Open [CloudKit Dashboard](https://icloud.developer.apple.com/)
2. Select your container
3. Go to **API Access** → **Tokens**
4. Create a new token with "Web Services" access
5. Copy the token

Create `.env` in this directory:
```
EXPO_PUBLIC_CLOUDKIT_API_TOKEN=your_token_here
```

The `EXPO_PUBLIC_` prefix makes it available in Expo's Metro bundler at build time.

### 4. CloudKit schema

Create a `Note` record type in your container (CloudKit Dashboard → Schema → Record Types):

| Field name | Type |
|------------|------|
| `title` | String |
| `body` | String |

Create a custom zone named `Notes` (CloudKit Dashboard → Zones).

## Running the app

```bash
# Install dependencies
npm install

# iOS
npm run ios

# Web
npm run web
```

## How the API works on each platform

### iOS
- `CloudKitProvider` calls `configure(containerId)` which sets up `CKContainer.default()`
- `getAccountStatus()` checks the device's iCloud account automatically
- No sign-in UI needed — uses the iCloud account from Settings

### Web
- `CloudKitProvider` calls `configureWeb(containerId, { apiToken, environment })` on mount
- This loads the CloudKit JS library from Apple's CDN and initialises the container
- The `apiToken` grants access to the **public** database without user sign-in
- Call `authenticateWeb()` (wraps CloudKit JS's `SignInButton`) for **private** database access
- The auth session is persisted to `localStorage` when `persistSession: true`

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `EXPO_PUBLIC_CLOUDKIT_API_TOKEN` | Web only | API token from CloudKit Dashboard |

## Troubleshooting

**"couldNotDetermine" on web before signing in**
The account status is `couldNotDetermine` until the user completes web sign-in. This is expected — the API token grants public database access without sign-in, but private database queries require authentication.

**"noAccount" on iOS Simulator**
Sign in to iCloud in the simulator via Settings → Apple ID. The device must have an active iCloud account.

**Notes zone not found**
Create the `Notes` zone in CloudKit Dashboard → your container → private database → Zones. Zone creation can also be done programmatically with `createZone('Notes')` from expo-cloudkit.
