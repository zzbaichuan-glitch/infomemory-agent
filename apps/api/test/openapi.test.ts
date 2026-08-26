import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';

describe('OpenAPI document', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    app = await buildApp({ databasePath: ':memory:', logger: false });
  });

  afterEach(async () => app.close());

  it('serves the versioned contract and key routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/openapi.yaml' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/yaml');
    expect(response.body).toContain('version: 0.2.0');
    expect(response.body).toContain('/v1/assets:');
    expect(response.body).toContain('/v1/reminders/{id}:');
    expect(response.body).toContain('operationId: deleteReminder');
    expect(response.body).toContain('/v1/connectors/feishu/events:');
    expect(response.body).not.toContain('AUTH_SECRET');
  });
});
