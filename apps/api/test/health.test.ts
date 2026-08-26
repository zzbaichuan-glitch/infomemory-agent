import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';

describe('health probes', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => app?.close());

  it('separates liveness from database readiness', async () => {
    app = await buildApp({
      readinessCheck: async () => {
        throw new Error('database unavailable');
      },
    });

    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ status: 'ok', service: 'infomemory-api' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({
      status: 'not_ready',
      service: 'infomemory-api',
      checks: { database: 'error' },
      requestId: expect.any(String),
    });
  });

  it('exposes only non-sensitive connector availability from production health', async () => {
    app = await buildApp({
      nodeEnv: 'production',
      authentication: {
        mode: 'bearer',
        secret: 'production-auth-secret-with-at-least-32-bytes',
        issuer: 'https://auth.infomemory.example',
        audience: 'infomemory-api',
      },
    });

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      service: 'infomemory-api',
      version: '0.3.0',
      connectorCapabilities: { feishuOAuthInstallation: false },
    });
  });

  it('reports Feishu OAuth installation availability without exposing credentials', async () => {
    app = await buildApp({
      feishuOAuth: {
        appId: 'cli_health_test',
        appSecret: 'synthetic-health-secret',
        redirectUri: 'https://app.infomemory.test/v1/connectors/feishu/oauth/callback',
        tokenEncryptionKey: '01234567890123456789012345678901',
      },
    });

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json().connectorCapabilities).toEqual({ feishuOAuthInstallation: true });
    expect(response.body).not.toContain('synthetic-health-secret');
  });
});
