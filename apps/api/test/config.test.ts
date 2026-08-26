import { describe, expect, it } from 'vitest';

import { loadAppConfig } from '../src/config.js';

describe('application configuration', () => {
  it('keeps outbound Feishu notifications disabled by default', () => {
    const config = loadAppConfig({});

    expect(config.feishuNotificationsEnabled).toBe(false);
    expect(config.feishuApiBaseUrl).toBe('https://open.feishu.cn');
    expect(config.feishuOAuthEnabled).toBe(false);
    expect(config.feishuOAuthStateTtlMs).toBe(600_000);
    expect(config.feishuOAuthAuthorizationBaseUrl).toBe('https://accounts.feishu.cn');
    expect(config.feishuOAuthTokenUrl).toBe('https://accounts.feishu.cn/oauth/v3/token');
    expect(config.reminderPollIntervalMs).toBe(15_000);
    expect(config).toMatchObject({
      httpBodyLimitBytes: 4 * 1_024 * 1_024,
      httpRequestTimeoutMs: 30_000,
      rateLimitEnabled: true,
      rateLimitMaxRequests: 120,
    });
  });

  it('requires Feishu app credentials when outbound notifications are enabled', () => {
    expect(() => loadAppConfig({
      FEISHU_NOTIFICATIONS_ENABLED: 'true',
    })).toThrow('FEISHU_APP_ID');
  });

  it('rejects encrypted Feishu webhooks without a verification token', () => {
    expect(() => loadAppConfig({
      FEISHU_ENCRYPT_KEY: 'webhook-encryption-key',
    })).toThrow('FEISHU_VERIFICATION_TOKEN');
  });

  it('requires a verification token for configured Feishu clients or async ingress', () => {
    expect(() => loadAppConfig({
      FEISHU_APP_ID: 'cli_test',
      FEISHU_APP_SECRET: 'app-secret',
    })).toThrow('FEISHU_VERIFICATION_TOKEN');
    expect(() => loadAppConfig({
      CONNECTOR_PROCESSING_MODE: 'async',
    })).toThrow('FEISHU_VERIFICATION_TOKEN');
  });

  it('allows OAuth-only setup without enabling webhook ingress', () => {
    expect(loadAppConfig({
      FEISHU_OAUTH_ENABLED: 'true',
      FEISHU_APP_ID: 'cli_test',
      FEISHU_APP_SECRET: 'app-secret',
      FEISHU_OAUTH_REDIRECT_URI: 'https://app.example.test/feishu/callback',
      FEISHU_TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
    })).toMatchObject({
      feishuOAuthEnabled: true,
      connectorProcessingMode: 'sync',
    });
  });

  it('forbids trusted development headers in production', () => {
    expect(() => loadAppConfig({
      NODE_ENV: 'production',
      AUTH_MODE: 'trusted_headers',
    })).toThrow('AUTH_MODE');
  });

  it('loads a complete bearer configuration and application time zone', () => {
    const config = loadAppConfig({
      NODE_ENV: 'production',
      AUTH_MODE: 'bearer',
      AUTH_SECRET: 'production-auth-secret-with-at-least-32-bytes',
      AUTH_ISSUER: 'https://auth.infomemory.example',
      AUTH_AUDIENCE: 'infomemory-api',
      APP_TIMEZONE: 'Asia/Shanghai',
    });

    expect(config).toMatchObject({
      authMode: 'bearer',
      authSecret: 'production-auth-secret-with-at-least-32-bytes',
      authIssuer: 'https://auth.infomemory.example',
      authAudience: 'infomemory-api',
      appTimeZone: 'Asia/Shanghai',
    });
  });

  it('rejects incomplete bearer credentials and invalid IANA time zones', () => {
    expect(() => loadAppConfig({ AUTH_MODE: 'bearer' })).toThrow('AUTH_SECRET');
    expect(() => loadAppConfig({
      AUTH_MODE: 'bearer',
      AUTH_SECRET: ' '.repeat(64),
      AUTH_ISSUER: 'infomemory-agent',
      AUTH_AUDIENCE: 'infomemory-api',
    })).toThrow('AUTH_SECRET');
    expect(() => loadAppConfig({ APP_TIMEZONE: 'Mars/Olympus_Mons' })).toThrow('APP_TIMEZONE');
  });

  it('requires HTTPS for enabled production integrations', () => {
    const auth = {
      NODE_ENV: 'production',
      AUTH_MODE: 'bearer',
      AUTH_SECRET: 'production-auth-secret-with-at-least-32-bytes',
      AUTH_ISSUER: 'infomemory-agent',
      AUTH_AUDIENCE: 'infomemory-api',
    };
    expect(() => loadAppConfig({
      ...auth,
      LLM_ENABLED: 'true',
      LLM_API_KEY: 'synthetic-key',
      LLM_MODEL: 'synthetic-model',
      LLM_BASE_URL: 'http://llm.internal/v1',
    })).toThrow('LLM_BASE_URL');
    expect(() => loadAppConfig({
      ...auth,
      FEISHU_NOTIFICATIONS_ENABLED: 'true',
      FEISHU_VERIFICATION_TOKEN: 'verification',
      FEISHU_APP_ID: 'app-id',
      FEISHU_APP_SECRET: 'app-secret',
      FEISHU_API_BASE_URL: 'http://open.feishu.cn',
    })).toThrow('FEISHU_API_BASE_URL');
  });

  it('requires an exact callback and encryption key for Feishu OAuth', () => {
    expect(() => loadAppConfig({ FEISHU_OAUTH_ENABLED: 'true' }))
      .toThrow('FEISHU_APP_ID');
    expect(() => loadAppConfig({
      FEISHU_OAUTH_ENABLED: 'true',
      FEISHU_APP_ID: 'cli_test',
      FEISHU_APP_SECRET: 'synthetic-secret',
      FEISHU_OAUTH_REDIRECT_URI: 'https://app.example.test/feishu/callback',
    })).toThrow('FEISHU_TOKEN_ENCRYPTION_KEY');
    const config = loadAppConfig({
      FEISHU_OAUTH_ENABLED: 'true',
      FEISHU_APP_ID: 'cli_test',
      FEISHU_APP_SECRET: 'synthetic-secret',
      FEISHU_OAUTH_REDIRECT_URI: 'https://app.example.test/feishu/callback',
      FEISHU_TOKEN_ENCRYPTION_KEY: '01234567890123456789012345678901',
    });
    expect(config).toMatchObject({
      feishuOAuthEnabled: true,
      feishuOAuthRedirectUri: 'https://app.example.test/feishu/callback',
      feishuTokenEncryptionKey: '01234567890123456789012345678901',
      feishuOAuthAuthorizationBaseUrl: 'https://accounts.feishu.cn',
      feishuOAuthTokenUrl: 'https://accounts.feishu.cn/oauth/v3/token',
    });
    expect(() => loadAppConfig({
      NODE_ENV: 'production',
      FEISHU_OAUTH_ENABLED: 'true',
      FEISHU_APP_ID: 'cli_test',
      FEISHU_APP_SECRET: 'synthetic-secret',
      FEISHU_OAUTH_REDIRECT_URI: 'http://app.example.test/feishu/callback',
      FEISHU_TOKEN_ENCRYPTION_KEY: '01234567890123456789012345678901',
    })).toThrow('FEISHU_OAUTH_REDIRECT_URI');
  });
});
