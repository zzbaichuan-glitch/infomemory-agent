import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';

export async function registerOpenApiRoute(app: FastifyInstance): Promise<void> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const document = await readFile(resolve(projectRoot, 'docs/api/openapi.yaml'), 'utf8');
  app.get('/openapi.yaml', async (_request, reply) => reply
    .type('application/yaml; charset=utf-8')
    .send(document));
}
