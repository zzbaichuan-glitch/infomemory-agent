import { config as loadEnvironment } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve environment files relative to the monorepo root, not the caller's
 * current working directory. This keeps `npm run start` and the token CLI
 * consistent when invoked from a workspace, IDE, or service manager.
 */
export function projectRootFromModule(moduleUrl: string = import.meta.url): string {
  // This helper lives in `apps/api/src/config` (and is emitted to
  // `apps/api/dist/config`), so four parent segments reach the monorepo root.
  return resolve(dirname(fileURLToPath(moduleUrl)), '../../../..');
}

export function projectEnvironmentPaths(moduleUrl: string = import.meta.url): string[] {
  const root = projectRootFromModule(moduleUrl);
  return [resolve(root, '.env.local'), resolve(root, '.env')];
}

export function loadProjectEnvironment(moduleUrl: string = import.meta.url): void {
  loadEnvironment({ path: projectEnvironmentPaths(moduleUrl), quiet: true });
}
