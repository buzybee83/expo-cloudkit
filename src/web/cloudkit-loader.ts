/**
 * Lazy loader for tsl-apple-cloudkit.
 *
 * Wraps `import('tsl-apple-cloudkit')` in a singleton promise so the ~200KB
 * CloudKit JS bundle is loaded at most once and only when actually needed
 * (i.e. when the caller first invokes `loadCloudKit()` or `getContainer()`).
 *
 * Bundlers (webpack, Vite, Metro web) automatically code-split this into a
 * separate chunk. If the package is not installed the promise rejects with a
 * clear installation instruction.
 *
 * SSR-safe: nothing is accessed at module scope.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CloudKitModule = any;

let ckPromise: Promise<CloudKitModule> | undefined;

/**
 * Returns a promise that resolves to the tsl-apple-cloudkit module.
 *
 * The first call triggers the dynamic import; subsequent calls reuse the same
 * promise. On failure the promise is cleared so the next call retries.
 */
export function loadCloudKit(): Promise<CloudKitModule> {
  if (!ckPromise) {
    ckPromise = import(
      // @ts-expect-error — tsl-apple-cloudkit is an optional peer dependency
      // with no guaranteed TypeScript declarations. We type the module as any.
      'tsl-apple-cloudkit'
    ).catch((err: unknown) => {
      ckPromise = undefined;
      throw new Error(
        'expo-cloudkit web support requires tsl-apple-cloudkit. ' +
          'Install it: npm install tsl-apple-cloudkit\n' +
          String(err)
      );
    });
  }
  return ckPromise;
}

/**
 * Returns the CloudKit container for the given container identifier.
 *
 * Loads CloudKit JS lazily on first call. The returned container is the
 * raw `CloudKit.Container` object from tsl-apple-cloudkit — callers may call
 * any CloudKit JS container methods on it.
 *
 * @param containerId - CloudKit container identifier, e.g. "iCloud.com.example.myapp"
 */
export async function getContainer(containerId: string): Promise<CloudKitModule> {
  const ck = await loadCloudKit();
  // tsl-apple-cloudkit exposes the CloudKit global via the default export or
  // via a named CloudKit property. Handle both.
  const CloudKit: CloudKitModule = ck.default ?? ck.CloudKit ?? ck;
  return CloudKit.getDefaultContainer
    ? CloudKit.getDefaultContainer()
    : CloudKit.Container
      ? new CloudKit.Container(containerId)
      : CloudKit;
}
