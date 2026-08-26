import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { SqliteAssetRepository } from '@infomemory/core';

import {
  Aes256GcmSecretCipher,
  SecretCipherConfigurationError,
} from '../src/feishu/credential-cipher.js';
import {
  FeishuOAuthClient,
  FeishuOAuthError,
  FeishuOAuthService,
  type FeishuOAuthTokenResponse,
} from '../src/feishu/feishu-oauth-service.js';

describe('Feishu OAuth security foundation', () => {
  it('encrypts credentials with authenticated encryption and never emits plaintext', () => {
    const cipher = new Aes256GcmSecretCipher('01234567890123456789012345678901');
    const plaintext = 'user-access-token-not-for-response';
    const encrypted = cipher.encrypt(plaintext);
    expect(encrypted).toMatch(/^v1\./u);
    expect(encrypted).not.toContain(plaintext);
    expect(cipher.decrypt(encrypted)).toBe(plaintext);
    expect(() => cipher.decrypt(`${encrypted}.tampered`)).toThrow();
    expect(() => new Aes256GcmSecretCipher('too-short')).toThrow(SecretCipherConfigurationError);
  });

  it('exchanges a code through the provider seam without exposing app secrets', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const appSecret = 'synthetic-feishu-app-secret';
    const client = new FeishuOAuthClient({
      baseUrl: 'https://open.feishu.cn/',
      appId: 'cli_test',
      appSecret,
      fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({
          code: 0,
          data: {
            tenant_key: 'tenant-a',
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            expires_in: 3600,
            scope: 'im:message docx:read',
            open_id: 'ou_admin',
          },
        }), { status: 200 });
      }),
    });
    const response = await client.exchangeCode(
      'authorization-code',
      'https://app.test/callback',
      'pkce-verifier',
    );
    expect(response).toMatchObject({
      tenantId: 'tenant-a',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      scopes: ['docx:read', 'im:message'],
    });
    expect(calls[0]?.url).toBe('https://accounts.feishu.cn/oauth/v3/token');
    const body = new URLSearchParams(String(calls[0]?.init?.body));
    expect(body.get('client_id')).toBe('cli_test');
    expect(body.get('code')).toBe('authorization-code');
    expect(body.get('client_secret')).toBe(appSecret);
    expect(body.get('code_verifier')).toBe('pkce-verifier');

    await client.refreshToken('old-refresh-token');
    const refreshBody = new URLSearchParams(String(calls[1]?.init?.body));
    expect(calls[1]?.url).toBe('https://accounts.feishu.cn/oauth/v3/token');
    expect(refreshBody.get('grant_type')).toBe('refresh_token');
    expect(refreshBody.get('refresh_token')).toBe('old-refresh-token');
    expect(refreshBody.get('client_id')).toBe('cli_test');

    const failing = new FeishuOAuthClient({
      baseUrl: 'https://open.feishu.cn',
      appId: 'cli_test',
      appSecret,
      fetch: vi.fn(async () => new Response(appSecret, { status: 500 })),
    });
    const error = await failing.exchangeCode('code', 'https://app.test/callback')
      .catch((caught: unknown) => caught);
    expect(String(error)).not.toContain(appSecret);
  });

  it('binds state to tenant, consumes it once, and persists only encrypted tokens', async () => {
    const repository = new SqliteAssetRepository(':memory:');
    const cipher = new Aes256GcmSecretCipher('01234567890123456789012345678901');
    const now = new Date('2030-01-01T00:00:00.000Z');
    const exchanged: FeishuOAuthTokenResponse = {
      tenantId: 'tenant-a',
      tenantName: '示例企业',
      accessToken: 'access-token-secret',
      refreshToken: 'refresh-token-secret',
      expiresInSeconds: 3600,
      refreshTokenExpiresInSeconds: 7200,
      scopes: ['im:message'],
      openId: 'ou_admin',
    };
    const exchanger = {
      exchangeCode: vi.fn(async () => exchanged),
      refreshToken: vi.fn(async () => ({
        tenantId: 'tenant-a',
        accessToken: 'rotated-access-token',
        // Provider intentionally omits refresh_token: old one must remain.
        scopes: [],
        expiresInSeconds: 1800,
      })),
    };
    const service = new FeishuOAuthService(repository, {
      appId: 'cli_test',
      redirectUri: 'https://app.test/feishu/callback',
      now: () => now,
      randomBytes: () => Buffer.alloc(32, 7),
      cipher,
      exchanger,
    });

    const start = await service.start({
      tenantId: 'tenant-a',
      userId: 'admin-a',
      returnTo: '/settings/integrations',
    });
    const authorization = new URL(start.authorizationUrl);
    expect(authorization.searchParams.get('client_id')).toBe('cli_test');
    expect(authorization.searchParams.get('redirect_uri')).toBe('https://app.test/feishu/callback');
    expect(authorization.searchParams.get('state')).toBeTruthy();
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(start.authorizationUrl).not.toContain('access-token-secret');

    const result = await service.callback(
      'authorization-code',
      authorization.searchParams.get('state') ?? '',
    );
    expect(exchanger.exchangeCode).toHaveBeenCalledTimes(1);
    const verifier = exchanger.exchangeCode.mock.calls[0]?.[2];
    expect(verifier).toEqual(expect.any(String));
    expect(authorization.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(String(verifier), 'utf8').digest('base64url'),
    );
    expect(result).toMatchObject({
      returnTo: '/settings/integrations',
      installation: {
        tenantId: 'tenant-a',
        status: 'active',
        scopes: ['im:message'],
      },
    });
    expect(JSON.stringify(result)).not.toContain('access-token-secret');
    expect(JSON.stringify(result)).not.toContain('refresh-token-secret');

    const stored = await repository.findFeishuInstallation('tenant-a', 'cli_test');
    expect(stored?.encryptedAccessToken).toBeTruthy();
    expect(stored?.encryptedAccessToken).not.toContain('access-token-secret');
    expect(cipher.decrypt(stored?.encryptedAccessToken ?? '')).toBe('access-token-secret');
    const refreshed = await service.refresh('tenant-a');
    expect(refreshed).toMatchObject({ tenantId: 'tenant-a', status: 'active' });
    expect(JSON.stringify(refreshed)).not.toContain('rotated-access-token');
    const afterRefresh = await repository.findFeishuInstallation('tenant-a', 'cli_test');
    expect(cipher.decrypt(afterRefresh?.encryptedAccessToken ?? '')).toBe('rotated-access-token');
    expect(cipher.decrypt(afterRefresh?.encryptedRefreshToken ?? '')).toBe('refresh-token-secret');
    expect(afterRefresh?.scopes).toEqual(['im:message']);
    await expect(service.callback(
      'authorization-code',
      authorization.searchParams.get('state') ?? '',
    )).rejects.toMatchObject({ code: 'feishu_oauth_state_invalid' });
  });

  it('uses the v3 authorization host and requested scopes, with state as tenant fallback', async () => {
    const repository = new SqliteAssetRepository(':memory:');
    const service = new FeishuOAuthService(repository, {
      appId: 'cli_scoped',
      redirectUri: 'https://app.test/callback',
      scopes: ['docx:read', 'im:message', 'docx:read'],
      cipher: new Aes256GcmSecretCipher('01234567890123456789012345678901'),
      randomBytes: () => Buffer.alloc(32, 6),
      exchanger: {
        exchangeCode: vi.fn(async () => ({
          accessToken: 'v3-access-token',
          scopes: ['docx:read'],
        })),
      },
    });
    const started = await service.start({ tenantId: 'tenant-from-state' });
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.origin).toBe('https://accounts.feishu.cn');
    expect(authorization.searchParams.get('client_id')).toBe('cli_scoped');
    expect(authorization.searchParams.get('response_type')).toBe('code');
    expect(authorization.searchParams.get('scope')).toBe('docx:read im:message');
    const callback = await service.callback(
      'code',
      authorization.searchParams.get('state') ?? '',
    );
    expect(callback.installation.tenantId).toBe('tenant-from-state');
  });

  it('fails closed when token encryption is absent and rejects tenant confusion', async () => {
    const repository = new SqliteAssetRepository(':memory:');
    const exchanger = { exchangeCode: vi.fn(async (): Promise<FeishuOAuthTokenResponse> => ({
      tenantId: 'tenant-b',
      accessToken: 'secret',
      scopes: [],
    })) };
    const service = new FeishuOAuthService(repository, {
      appId: 'cli_test',
      redirectUri: 'https://app.test/callback',
      now: () => new Date('2030-01-01T00:00:00.000Z'),
      randomBytes: () => Buffer.alloc(32, 8),
      exchanger,
    });
    await expect(service.start({ tenantId: 'tenant-a' })).rejects.toMatchObject({
      code: 'feishu_oauth_not_configured',
    });
    expect(exchanger.exchangeCode).not.toHaveBeenCalled();

    const withCipher = new FeishuOAuthService(repository, {
      appId: 'cli_test',
      redirectUri: 'https://app.test/callback',
      now: () => new Date('2030-01-01T00:00:00.000Z'),
      randomBytes: () => Buffer.alloc(32, 9),
      cipher: new Aes256GcmSecretCipher('01234567890123456789012345678901'),
      exchanger,
    });
    const mismatchStart = await withCipher.start({ tenantId: 'tenant-a' });
    const mismatchState = new URL(mismatchStart.authorizationUrl).searchParams.get('state') ?? '';
    await expect(withCipher.callback('code', mismatchState)).rejects.toMatchObject({
      code: 'feishu_oauth_tenant_mismatch',
    });
  });

  it('rejects external OAuth return URLs', async () => {
    const repository = new SqliteAssetRepository(':memory:');
    const service = new FeishuOAuthService(repository, {
      appId: 'cli_test',
      redirectUri: 'https://app.test/callback',
      cipher: new Aes256GcmSecretCipher('01234567890123456789012345678901'),
      exchanger: { exchangeCode: vi.fn() },
    });
    await expect(service.start({ returnTo: 'https://evil.test' })).rejects.toMatchObject({
      code: 'feishu_oauth_callback_invalid',
    });
    await expect(service.start({ returnTo: '//evil.test' })).rejects.toMatchObject({
      code: 'feishu_oauth_callback_invalid',
    });
  });
});
