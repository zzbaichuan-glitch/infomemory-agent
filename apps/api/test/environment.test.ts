import { describe, expect, it } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  projectEnvironmentPaths,
  projectRootFromModule,
} from '../src/config/environment.js';

describe('project environment loading', () => {
  it('resolves .env files from the monorepo root', () => {
    // The helper is defined four levels below the monorepo root
    // (`apps/api/src/config`), while this test itself lives in `apps/api/test`.
    // Build representative source and emitted-module URLs so this assertion
    // cannot pass merely because the test's own directory happens to have the
    // same depth as the implementation module.
    const sourceConfigUrl = new URL('../src/config/environment.ts', import.meta.url).href;
    const emittedConfigUrl = new URL('../dist/config/environment.js', import.meta.url).href;
    const expectedRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

    expect(projectRootFromModule(sourceConfigUrl)).toBe(expectedRoot);
    expect(projectRootFromModule(emittedConfigUrl)).toBe(expectedRoot);

    const root = projectRootFromModule(sourceConfigUrl);
    const paths = projectEnvironmentPaths(sourceConfigUrl);

    expect(paths).toEqual([
      join(root, '.env.local'),
      join(root, '.env'),
    ]);
  });
});
