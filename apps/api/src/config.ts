import { z } from 'zod';

const booleanValue = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false' || value === '') return false;
  return value;
}, z.boolean());

const optionalString = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().min(1).optional(),
);

const optionalAuthSecret = z.preprocess(
  (value) => typeof value === 'string' && value === '' ? undefined : value,
  z.string()
    .max(4_096)
    .refine((value) => value.trim().length > 0, {
      message: 'AUTH_SECRET must not be blank',
    })
    .refine((value) => Buffer.byteLength(value, 'utf8') >= 32, {
      message: 'AUTH_SECRET must contain at least 32 bytes',
    })
    .optional(),
);

const optionalAuthIdentifier = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().min(1).max(500).optional(),
);

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  DATABASE_PATH: z.string().trim().min(1).default('./var/infomemory.sqlite'),
  HTTP_BODY_LIMIT_BYTES: z.coerce.number().int().min(1_024).max(16 * 1_024 * 1_024)
    .default(4 * 1_024 * 1_024),
  HTTP_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  HTTP_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(125_000),
  RATE_LIMIT_ENABLED: booleanValue.default(true),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(100_000).default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  RATE_LIMIT_MAX_KEYS: z.coerce.number().int().min(100).max(1_000_000).default(10_000),
  APP_TIMEZONE: z.string().trim().min(1).max(100).default('Asia/Shanghai')
    .refine(isSupportedTimeZone, { message: 'APP_TIMEZONE must be a valid IANA time zone' }),
  AUTH_MODE: z.enum(['trusted_headers', 'bearer']).default('trusted_headers'),
  AUTH_SECRET: optionalAuthSecret,
  AUTH_ISSUER: optionalAuthIdentifier,
  AUTH_AUDIENCE: optionalAuthIdentifier,
  LLM_ENABLED: booleanValue.default(false),
  LLM_BASE_URL: z.url().default('https://llm-gw.bupt.edu.cn/v1'),
  LLM_API_KEY: optionalString,
  LLM_MODEL: optionalString,
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(15_000),
  FEISHU_VERIFICATION_TOKEN: optionalString,
  FEISHU_APP_ID: optionalString,
  FEISHU_APP_SECRET: optionalString,
  FEISHU_API_BASE_URL: z.url().default('https://open.feishu.cn'),
  FEISHU_API_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
  FEISHU_OAUTH_ENABLED: booleanValue.default(false),
  FEISHU_OAUTH_REDIRECT_URI: optionalString,
  FEISHU_OAUTH_AUTHORIZATION_BASE_URL: z.url().default('https://accounts.feishu.cn'),
  FEISHU_OAUTH_TOKEN_URL: z.url().default('https://accounts.feishu.cn/oauth/v3/token'),
  FEISHU_OAUTH_SCOPES: optionalString,
  FEISHU_TOKEN_ENCRYPTION_KEY: optionalString,
  FEISHU_OAUTH_STATE_TTL_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(600_000),
  FEISHU_ENCRYPT_KEY: optionalString,
  FEISHU_NOTIFICATIONS_ENABLED: booleanValue.default(false),
  REMINDER_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(15_000),
  CONNECTOR_PROCESSING_MODE: z.enum(['sync', 'async']).optional(),
  CONNECTOR_WORKER_ENABLED: booleanValue.optional(),
  CONNECTOR_WORKER_INTERVAL_MS: z.coerce.number().int().min(250).max(3_600_000).default(5_000),
  CONNECTOR_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(25),
  CONNECTOR_WORKER_LEASE_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(300_000),
  CONNECTOR_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(8),
  CONNECTOR_BACKOFF_BASE_MS: z.coerce.number().int().min(1).max(86_400_000).default(1_000),
  CONNECTOR_BACKOFF_MAX_MS: z.coerce.number().int().min(1).max(7 * 86_400_000).default(300_000),
}).superRefine((value, context) => {
  if (value.NODE_ENV === 'production' && value.AUTH_MODE === 'trusted_headers') {
    context.addIssue({
      code: 'custom',
      path: ['AUTH_MODE'],
      message: 'AUTH_MODE=trusted_headers is forbidden in production',
    });
  }
  if (value.AUTH_MODE === 'bearer') {
    if (!value.AUTH_SECRET) {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_SECRET'],
        message: 'AUTH_SECRET is required when AUTH_MODE=bearer',
      });
    }
    if (!value.AUTH_ISSUER) {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_ISSUER'],
        message: 'AUTH_ISSUER is required when AUTH_MODE=bearer',
      });
    }
    if (!value.AUTH_AUDIENCE) {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_AUDIENCE'],
        message: 'AUTH_AUDIENCE is required when AUTH_MODE=bearer',
      });
    }
  }
  if (value.LLM_ENABLED) {
    if (value.NODE_ENV === 'production' && new URL(value.LLM_BASE_URL).protocol !== 'https:') {
      context.addIssue({
        code: 'custom',
        path: ['LLM_BASE_URL'],
        message: 'LLM_BASE_URL must use HTTPS in production',
      });
    }
    if (!value.LLM_API_KEY) {
      context.addIssue({
        code: 'custom',
        path: ['LLM_API_KEY'],
        message: 'LLM_API_KEY is required when LLM_ENABLED=true',
      });
    }
    if (!value.LLM_MODEL) {
      context.addIssue({
        code: 'custom',
        path: ['LLM_MODEL'],
        message: 'LLM_MODEL is required when LLM_ENABLED=true',
      });
    }
  }
  if (value.FEISHU_NOTIFICATIONS_ENABLED) {
    if (value.NODE_ENV === 'production'
      && new URL(value.FEISHU_API_BASE_URL).protocol !== 'https:') {
      context.addIssue({
        code: 'custom',
        path: ['FEISHU_API_BASE_URL'],
        message: 'FEISHU_API_BASE_URL must use HTTPS in production',
      });
    }
    if (!value.FEISHU_VERIFICATION_TOKEN) {
      context.addIssue({
        code: 'custom',
        path: ['FEISHU_VERIFICATION_TOKEN'],
        message: 'FEISHU_VERIFICATION_TOKEN is required when FEISHU_NOTIFICATIONS_ENABLED=true',
      });
    }
    if (!value.FEISHU_APP_ID) {
      context.addIssue({
        code: 'custom',
        path: ['FEISHU_APP_ID'],
        message: 'FEISHU_APP_ID is required when FEISHU_NOTIFICATIONS_ENABLED=true',
      });
    }
    if (!value.FEISHU_APP_SECRET) {
      context.addIssue({
        code: 'custom',
        path: ['FEISHU_APP_SECRET'],
        message: 'FEISHU_APP_SECRET is required when FEISHU_NOTIFICATIONS_ENABLED=true',
      });
    }
  }
  // Any explicitly configured Feishu ingress/client (except an OAuth-only
  // installation flow) must have the webhook verification token available at
  // startup. Without this guard the process starts successfully but every
  // webhook request fails later in FeishuEventService.prepare/handle.
  const oauthOnly = value.FEISHU_OAUTH_ENABLED
    && !value.FEISHU_NOTIFICATIONS_ENABLED
    && value.CONNECTOR_PROCESSING_MODE !== 'async'
    && !value.FEISHU_ENCRYPT_KEY;
  const feishuWebhookConfigured = Boolean(
    value.FEISHU_APP_ID
      || value.FEISHU_APP_SECRET
      || value.FEISHU_NOTIFICATIONS_ENABLED
      || value.CONNECTOR_PROCESSING_MODE === 'async'
      || value.FEISHU_ENCRYPT_KEY,
  );
  if (feishuWebhookConfigured && !oauthOnly && !value.FEISHU_VERIFICATION_TOKEN) {
    context.addIssue({
      code: 'custom',
      path: ['FEISHU_VERIFICATION_TOKEN'],
      message: 'FEISHU_VERIFICATION_TOKEN is required when Feishu webhook ingress is configured',
    });
  }
  if (value.FEISHU_OAUTH_ENABLED) {
    if (!value.FEISHU_APP_ID) {
      context.addIssue({
        code: 'custom',
        path: ['FEISHU_APP_ID'],
        message: 'FEISHU_APP_ID is required when FEISHU_OAUTH_ENABLED=true',
      });
    }
    if (!value.FEISHU_APP_SECRET) {
      context.addIssue({
        code: 'custom',
        path: ['FEISHU_APP_SECRET'],
        message: 'FEISHU_APP_SECRET is required when FEISHU_OAUTH_ENABLED=true',
      });
    }
    if (!value.FEISHU_OAUTH_REDIRECT_URI) {
      context.addIssue({
        code: 'custom',
        path: ['FEISHU_OAUTH_REDIRECT_URI'],
        message: 'FEISHU_OAUTH_REDIRECT_URI is required when FEISHU_OAUTH_ENABLED=true',
      });
    } else {
      try {
        const redirect = new URL(value.FEISHU_OAUTH_REDIRECT_URI);
        if (!['http:', 'https:'].includes(redirect.protocol)
          || redirect.username || redirect.password || redirect.hash
          || (value.NODE_ENV === 'production' && redirect.protocol !== 'https:')) {
          context.addIssue({
            code: 'custom',
            path: ['FEISHU_OAUTH_REDIRECT_URI'],
            message: 'FEISHU_OAUTH_REDIRECT_URI must be a safe HTTPS URL in production',
          });
        }
      } catch {
        context.addIssue({
          code: 'custom',
          path: ['FEISHU_OAUTH_REDIRECT_URI'],
          message: 'FEISHU_OAUTH_REDIRECT_URI must be a valid URL',
        });
      }
    }
    for (const [path, rawUrl] of [
      ['FEISHU_OAUTH_AUTHORIZATION_BASE_URL', value.FEISHU_OAUTH_AUTHORIZATION_BASE_URL],
      ['FEISHU_OAUTH_TOKEN_URL', value.FEISHU_OAUTH_TOKEN_URL],
    ] as const) {
      try {
        const parsedUrl = new URL(rawUrl);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)
          || parsedUrl.username || parsedUrl.password || parsedUrl.hash
          || (value.NODE_ENV === 'production' && parsedUrl.protocol !== 'https:')) {
          context.addIssue({
            code: 'custom',
            path: [path],
            message: `${path} must be a safe HTTPS URL in production`,
          });
        }
      } catch {
        context.addIssue({
          code: 'custom',
          path: [path],
          message: `${path} must be a valid URL`,
        });
      }
    }
    if (!value.FEISHU_TOKEN_ENCRYPTION_KEY
      || Buffer.byteLength(value.FEISHU_TOKEN_ENCRYPTION_KEY, 'utf8') < 32) {
      context.addIssue({
        code: 'custom',
        path: ['FEISHU_TOKEN_ENCRYPTION_KEY'],
        message: 'FEISHU_TOKEN_ENCRYPTION_KEY must contain at least 32 bytes when OAuth is enabled',
      });
    }
  }
  if (value.CONNECTOR_BACKOFF_MAX_MS < value.CONNECTOR_BACKOFF_BASE_MS) {
    context.addIssue({
      code: 'custom',
      path: ['CONNECTOR_BACKOFF_MAX_MS'],
      message: 'CONNECTOR_BACKOFF_MAX_MS must be greater than or equal to CONNECTOR_BACKOFF_BASE_MS',
    });
  }
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databasePath: string;
  httpBodyLimitBytes: number;
  httpRequestTimeoutMs: number;
  httpConnectionTimeoutMs: number;
  rateLimitEnabled: boolean;
  rateLimitMaxRequests: number;
  rateLimitWindowMs: number;
  rateLimitMaxKeys: number;
  appTimeZone: string;
  authMode: 'trusted_headers' | 'bearer';
  authSecret?: string;
  authIssuer?: string;
  authAudience?: string;
  llmEnabled: boolean;
  llmBaseUrl: string;
  llmApiKey?: string;
  llmModel?: string;
  llmTimeoutMs: number;
  feishuVerificationToken?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuApiBaseUrl: string;
  feishuApiTimeoutMs: number;
  feishuOAuthEnabled: boolean;
  feishuOAuthRedirectUri?: string;
  feishuOAuthAuthorizationBaseUrl: string;
  feishuOAuthTokenUrl: string;
  feishuOAuthScopes: string[];
  feishuTokenEncryptionKey?: string;
  feishuOAuthStateTtlMs: number;
  feishuEncryptKey?: string;
  feishuNotificationsEnabled: boolean;
  reminderPollIntervalMs: number;
  connectorProcessingMode: 'sync' | 'async';
  connectorWorkerEnabled: boolean;
  connectorWorkerIntervalMs: number;
  connectorWorkerBatchSize: number;
  connectorWorkerLeaseMs: number;
  connectorMaxAttempts: number;
  connectorBackoffBaseMs: number;
  connectorBackoffMaxMs: number;
}

export function loadAppConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    databasePath: parsed.DATABASE_PATH,
    httpBodyLimitBytes: parsed.HTTP_BODY_LIMIT_BYTES,
    httpRequestTimeoutMs: parsed.HTTP_REQUEST_TIMEOUT_MS,
    httpConnectionTimeoutMs: parsed.HTTP_CONNECTION_TIMEOUT_MS,
    rateLimitEnabled: parsed.RATE_LIMIT_ENABLED,
    rateLimitMaxRequests: parsed.RATE_LIMIT_MAX_REQUESTS,
    rateLimitWindowMs: parsed.RATE_LIMIT_WINDOW_MS,
    rateLimitMaxKeys: parsed.RATE_LIMIT_MAX_KEYS,
    appTimeZone: parsed.APP_TIMEZONE,
    authMode: parsed.AUTH_MODE,
    ...(parsed.AUTH_SECRET ? { authSecret: parsed.AUTH_SECRET } : {}),
    ...(parsed.AUTH_ISSUER ? { authIssuer: parsed.AUTH_ISSUER } : {}),
    ...(parsed.AUTH_AUDIENCE ? { authAudience: parsed.AUTH_AUDIENCE } : {}),
    llmEnabled: parsed.LLM_ENABLED,
    llmBaseUrl: parsed.LLM_BASE_URL,
    llmTimeoutMs: parsed.LLM_TIMEOUT_MS,
    ...(parsed.LLM_API_KEY ? { llmApiKey: parsed.LLM_API_KEY } : {}),
    ...(parsed.LLM_MODEL ? { llmModel: parsed.LLM_MODEL } : {}),
    ...(parsed.FEISHU_VERIFICATION_TOKEN
      ? { feishuVerificationToken: parsed.FEISHU_VERIFICATION_TOKEN }
      : {}),
    ...(parsed.FEISHU_APP_ID ? { feishuAppId: parsed.FEISHU_APP_ID } : {}),
    ...(parsed.FEISHU_APP_SECRET
      ? { feishuAppSecret: parsed.FEISHU_APP_SECRET }
      : {}),
    feishuApiBaseUrl: parsed.FEISHU_API_BASE_URL,
    feishuApiTimeoutMs: parsed.FEISHU_API_TIMEOUT_MS,
    feishuOAuthEnabled: parsed.FEISHU_OAUTH_ENABLED,
    feishuOAuthStateTtlMs: parsed.FEISHU_OAUTH_STATE_TTL_MS,
    feishuOAuthAuthorizationBaseUrl: parsed.FEISHU_OAUTH_AUTHORIZATION_BASE_URL,
    feishuOAuthTokenUrl: parsed.FEISHU_OAUTH_TOKEN_URL,
    feishuOAuthScopes: parseScopes(parsed.FEISHU_OAUTH_SCOPES),
    feishuNotificationsEnabled: parsed.FEISHU_NOTIFICATIONS_ENABLED,
    reminderPollIntervalMs: parsed.REMINDER_POLL_INTERVAL_MS,
    connectorProcessingMode: parsed.CONNECTOR_PROCESSING_MODE
      ?? (parsed.NODE_ENV === 'production' ? 'async' : 'sync'),
    connectorWorkerEnabled: parsed.CONNECTOR_WORKER_ENABLED
      ?? (parsed.CONNECTOR_PROCESSING_MODE === 'async'
        || (parsed.CONNECTOR_PROCESSING_MODE === undefined && parsed.NODE_ENV === 'production')),
    connectorWorkerIntervalMs: parsed.CONNECTOR_WORKER_INTERVAL_MS,
    connectorWorkerBatchSize: parsed.CONNECTOR_WORKER_BATCH_SIZE,
    connectorWorkerLeaseMs: parsed.CONNECTOR_WORKER_LEASE_MS,
    connectorMaxAttempts: parsed.CONNECTOR_MAX_ATTEMPTS,
    connectorBackoffBaseMs: parsed.CONNECTOR_BACKOFF_BASE_MS,
    connectorBackoffMaxMs: parsed.CONNECTOR_BACKOFF_MAX_MS,
    ...(parsed.FEISHU_ENCRYPT_KEY ? { feishuEncryptKey: parsed.FEISHU_ENCRYPT_KEY } : {}),
    ...(parsed.FEISHU_OAUTH_REDIRECT_URI
      ? { feishuOAuthRedirectUri: parsed.FEISHU_OAUTH_REDIRECT_URI } : {}),
    ...(parsed.FEISHU_TOKEN_ENCRYPTION_KEY
      ? { feishuTokenEncryptionKey: parsed.FEISHU_TOKEN_ENCRYPTION_KEY } : {}),
  };
}

function isSupportedTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function parseScopes(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(/[\s,]+/u).map((item) => item.trim()).filter(Boolean))].sort();
}
