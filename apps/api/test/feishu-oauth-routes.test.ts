import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SqliteAssetRepository } from '@infomemory/core';

import { buildApp } from '../src/app.js';
import { generateAccessToken } from '../src/auth/access-token.js';
import { Aes256GcmSecretCipher } from '../src/feishu/credential-cipher.js';
import {
  FeishuOAuthService,
  type FeishuOAuthTokenResponse,
} from '../src/feishu/feishu-oauth-service.js';

describe('Feishu OAuth HTTP routes', () => {
  const bearerSecret = 'test-bearer-secret-that-is-at-least-32-bytes';
  const bearerIssuer = 'https://auth.infomemory.test';
  const bearerAudience = 'infomemory-api';
  let app: Awaited<ReturnType<typeof buildApp>>;
  let repository: SqliteAssetRepository;

  beforeEach(async () => {
    repository = new SqliteAssetRepository(':memory:');
    const exchanged: FeishuOAuthTokenResponse = {
      tenantId: 'tenant-a',
      accessToken: 'access-token-secret',
      refreshToken: 'refresh-token-secret',
      scopes: ['im:message'],
      openId: 'ou_admin',
    };
    const service = new FeishuOAuthService(repository, {
      appId: 'cli_test',
      redirectUri: 'https://app.test/feishu/callback',
      cipher: new Aes256GcmSecretCipher('01234567890123456789012345678901'),
      randomBytes: () => Buffer.alloc(32, 3),
      exchanger: {
        exchangeCode: vi.fn(async () => exchanged),
        refreshToken: vi.fn(async () => ({
          tenantId: 'tenant-a',
          accessToken: 'rotated-access-token',
          refreshToken: 'rotated-refresh-token',
          scopes: ['im:message'],
        })),
      },
    });
    app = await buildApp({
      databasePath: ':memory:',
      logger: false,
      feishuOAuthService: service,
    });
  });

  afterEach(async () => {
    await app.close();
    repository.close();
  });

  it('requires authentication for start and exposes no credentials', async () => {
    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/v1/connectors/feishu/oauth/start',
    });
    expect(unauthenticated.statusCode).toBe(401);

    const started = await app.inject({
      method: 'GET',
      url: '/v1/connectors/feishu/oauth/start?returnTo=%2Fsettings%2Fintegrations',
      headers: { 'x-tenant-id': 'tenant-a', 'x-user-id': 'admin-a' },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      authorizationUrl: expect.stringContaining('open-apis/authen/v1/authorize'),
      stateExpiresAt: expect.any(String),
    });
    expect(started.body).not.toContain('access-token-secret');
  });

  it('requires a tenant administrator to read installation metadata', async () => {
    const bearerApp = await buildApp({
      databasePath: ':memory:',
      logger: false,
      feishuOAuthService: new FeishuOAuthService(repository, {
        appId: 'cli_test',
        redirectUri: 'https://app.test/feishu/callback',
        cipher: new Aes256GcmSecretCipher('01234567890123456789012345678901'),
        exchanger: { exchangeCode: vi.fn() },
      }),
      authentication: {
        mode: 'bearer',
        secret: bearerSecret,
        issuer: bearerIssuer,
        audience: bearerAudience,
      },
    });
    const tokenFor = (roles: string[]) => generateAccessToken({
      secret: bearerSecret,
      issuer: bearerIssuer,
      audience: bearerAudience,
      tenantId: 'tenant-a',
      userId: 'admin-a',
      roles,
    });
    try {
      const denied = await bearerApp.inject({
        method: 'GET',
        url: '/v1/connectors/feishu/installation',
        headers: { authorization: `Bearer ${tokenFor(['member'])}` },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ error: 'authorization_forbidden' });

      const allowed = await bearerApp.inject({
        method: 'GET',
        url: '/v1/connectors/feishu/installation',
        headers: { authorization: `Bearer ${tokenFor(['tenant_admin'])}` },
      });
      expect(allowed.statusCode).toBe(404);
      expect(allowed.json()).toMatchObject({ error: 'feishu_installation_not_found' });
    } finally {
      await bearerApp.close();
    }
  });

  it('completes callback, reports installation metadata, and supports revocation', async () => {
    const started = await app.inject({
      method: 'GET',
      url: '/v1/connectors/feishu/oauth/start',
      headers: { 'x-tenant-id': 'tenant-a', 'x-user-id': 'admin-a' },
    });
    const state = new URL(started.json().authorizationUrl).searchParams.get('state') ?? '';
    const callback = await app.inject({
      method: 'GET',
      url: `/v1/connectors/feishu/oauth/callback?code=synthetic-code&state=${encodeURIComponent(state)}`,
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.json()).toMatchObject({
      installation: {
        tenantId: 'tenant-a',
        status: 'active',
        installedByUserId: 'admin-a',
      },
    });
    expect(callback.body).not.toContain('access-token-secret');
    expect(callback.body).not.toContain('encryptedAccessToken');

    const metadata = await app.inject({
      method: 'GET',
      url: '/v1/connectors/feishu/installation',
      headers: { 'x-tenant-id': 'tenant-a', 'x-user-id': 'admin-a' },
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json().installation).not.toHaveProperty('encryptedAccessToken');

    const revoked = await app.inject({
      method: 'DELETE',
      url: '/v1/connectors/feishu/installation',
      headers: { 'x-tenant-id': 'tenant-a', 'x-user-id': 'admin-a' },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({ revoked: true, tenantId: 'tenant-a' });
    const after = await app.inject({
      method: 'GET',
      url: '/v1/connectors/feishu/installation',
      headers: { 'x-tenant-id': 'tenant-a', 'x-user-id': 'admin-a' },
    });
    expect(after.json().installation.status).toBe('revoked');
  });

  it('redirects browser installs only to the state-bound first-party path', async () => {
    const started = await app.inject({
      method: 'GET',
      url: '/v1/connectors/feishu/oauth/start?returnTo=%2Fapp%2F',
      headers: { 'x-tenant-id': 'tenant-a', 'x-user-id': 'admin-a' },
    });
    const state = new URL(started.json().authorizationUrl).searchParams.get('state') ?? '';
    const callback = await app.inject({
      method: 'GET',
      url: `/v1/connectors/feishu/oauth/callback?code=synthetic-code&state=${encodeURIComponent(state)}`,
    });
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe('/app/?feishu=connected');
    expect(callback.body).not.toContain('access-token-secret');
  });

  it('refreshes an installed tenant through a protected route without returning tokens', async () => {
    const started = await app.inject({
      method: 'GET',
      url: '/v1/connectors/feishu/oauth/start',
      headers: { 'x-tenant-id': 'tenant-a', 'x-user-id': 'admin-a' },
    });
    const state = new URL(started.json().authorizationUrl).searchParams.get('state') ?? '';
    await app.inject({
      method: 'GET',
      url: `/v1/connectors/feishu/oauth/callback?code=synthetic-code&state=${encodeURIComponent(state)}`,
    });
    const refreshed = await app.inject({
      method: 'POST',
      url: '/v1/connectors/feishu/installation/refresh',
      headers: { 'x-tenant-id': 'tenant-a', 'x-user-id': 'admin-a' },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().installation).toMatchObject({ tenantId: 'tenant-a', status: 'active' });
    expect(refreshed.body).not.toContain('rotated-access-token');
    expect(refreshed.body).not.toContain('encryptedAccessToken');
  });

  it('returns browser-denied installs to the workbench and consumes the state once', async () => {
    const started = await app.inject({
      method: 'GET',
      url: '/v1/connectors/feishu/oauth/start?returnTo=%2Fapp%2F',
      headers: { 'x-tenant-id': 'tenant-a', 'x-user-id': 'admin-a' },
    });
    const state = new URL(started.json().authorizationUrl).searchParams.get('state') ?? '';
    const denied = await app.inject({
      method: 'GET',
      url: `/v1/connectors/feishu/oauth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    });
    expect(denied.statusCode).toBe(303);
    expect(denied.headers.location).toBe('/app/?feishu=error');
    expect(denied.body).not.toContain('access_denied');

    const replay = await app.inject({
      method: 'GET',
      url: `/v1/connectors/feishu/oauth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({ error: 'feishu_oauth_state_invalid' });
    expect(replay.body).not.toContain('access_denied');
  });

  it('does not leak callback provider errors or accept a missing state', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/v1/connectors/feishu/oauth/callback?code=synthetic-code',
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: 'feishu_oauth_callback_invalid' });

    const denied = await app.inject({
      method: 'GET',
      url: '/v1/connectors/feishu/oauth/callback?error=access_denied&state=invalid',
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json()).toMatchObject({ error: 'feishu_oauth_state_invalid' });
    expect(denied.body).not.toContain('access_denied');

    const missingDenied = await app.inject({
      method: 'GET',
      url: '/v1/connectors/feishu/oauth/callback?error=access_denied',
    });
    expect(missingDenied.statusCode).toBe(400);
    expect(missingDenied.json()).toMatchObject({ error: 'feishu_oauth_callback_invalid' });
    expect(missingDenied.body).not.toContain('access_denied');

    const noReturnToStart = await app.inject({
      method: 'GET',
      url: '/v1/connectors/feishu/oauth/start',
      headers: { 'x-tenant-id': 'tenant-a', 'x-user-id': 'admin-a' },
    });
    const noReturnToState = new URL(noReturnToStart.json().authorizationUrl).searchParams.get('state') ?? '';
    const noReturnToDenied = await app.inject({
      method: 'GET',
      url: `/v1/connectors/feishu/oauth/callback?error=access_denied&error_description=secret-provider-detail&state=${encodeURIComponent(noReturnToState)}`,
    });
    expect(noReturnToDenied.statusCode).toBe(502);
    expect(noReturnToDenied.json()).toMatchObject({
      error: 'feishu_oauth_provider_failed',
      message: 'The Feishu authorization was denied',
    });
    expect(noReturnToDenied.body).not.toContain('access_denied');
    expect(noReturnToDenied.body).not.toContain('secret-provider-detail');
  });
});
