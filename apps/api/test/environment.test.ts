import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import {
  projectEnvironmentPaths,
  projectRootFromModule,
} from '../src/config/environment.js';

describe('project environment loading', () => {
  it('resolves .env files from the monorepo root', () => {
    const root = projectRootFromModule(import.meta.url);
    const paths = projectEnvironmentPaths(import.meta.url);

    expect(paths).toEqual([
      join(root, '.env.local'),
      join(root, '.env'),
    ]);
  });
});
