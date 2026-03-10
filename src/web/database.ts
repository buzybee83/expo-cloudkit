/**
 * Database scope helper for CloudKit JS.
 *
 * Resolves a `DatabaseScope` string to the correct CloudKit JS `Database`
 * object on a container. This isolates the scope→database mapping from
 * the main web implementation file.
 *
 * SSR-safe: no module-scope access to browser globals.
 */

import type { DatabaseScope } from '../types';

/**
 * Resolves a `DatabaseScope` string to the corresponding CloudKit JS database
 * object on the given container.
 *
 * @param container - A CloudKit JS Container instance.
 * @param scope     - 'private' | 'public' | 'shared'. Defaults to 'private'.
 * @returns The CloudKit JS Database object for the given scope.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveDatabase(container: any, scope: DatabaseScope = 'private'): any {
  switch (scope) {
    case 'public':
      return container.publicCloudDatabase;
    case 'shared':
      return container.sharedCloudDatabase;
    case 'private':
    default:
      return container.privateCloudDatabase;
  }
}
