import {
  AnswerService,
  AssetService,
  SearchService,
  ReminderService,
  ReminderNotificationWorker,
  ConnectorQueueWorker,
  type ConnectorOutboxRecord,
  type ReminderNotifier,
  SqliteAssetRepository,
  type LlmAnswerGenerator,
} from '@infomemory/core';
import Fastify, { type FastifyInstance } from 'fastify';

import { FeishuEventService } from './feishu/feishu-event-service.js';
import { FeishuCommandService } from './feishu/feishu-command-service.js';
import type { FeishuMessenger } from './feishu/feishu-client.js';
import {
  FeishuOAuthService,
  type FeishuOAuthServiceOptions,
} from './feishu/feishu-oauth-service.js';
import { registerErrorHandling } from './http/error-handling.js';
import { registerJsonMediaTypeGuard } from './http/media-type.js';
import { registerRawBodyCapture } from './http/raw-body.js';
import type { SafeLoggerOptions } from './logging.js';
import {
  accessContextPlugin,
  type AuthenticationOptions,
  validateAuthenticationOptions,
} from './plugins/access-context.js';
import {
  registerRateLimit,
  type RateLimitOptions,
} from './plugins/rate-limit.js';
import { registerAnswerRoute } from './routes/answers.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerFeishuEventRoute } from './routes/feishu-events.js';
import { registerHealthRoute } from './routes/health.js';
import { registerOpenApiRoute } from './routes/openapi.js';
import { registerSearchRoute } from './routes/search.js';
import { registerReminderRoutes } from './routes/reminders.js';
import { registerConnectorQueueRoutes } from './routes/connector-queue.js';
import { registerWorkbenchRoutes } from './routes/workbench.js';
import {
  registerFeishuOAuthCallbackRoute,
  registerFeishuOAuthSecuredRoutes,
} from './routes/feishu-oauth.js';

export interface BuildAppOptions {
  databasePath?: string;
  logger?: boolean | SafeLoggerOptions;
  nodeEnv?: 'development' | 'test' | 'production';
  authentication?: AuthenticationOptions;
  timeZone?: string;
  bodyLimitBytes?: number;
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
  rateLimit?: RateLimitOptions | false;
  readinessCheck?: () => Promise<void>;
  llmGenerator?: LlmAnswerGenerator;
  llmEnabled?: boolean;
  feishuVerificationToken?: string;
  feishuOAuthConfigured?: boolean;
  feishuEncryptKey?: string;
  feishuMessenger?: FeishuMessenger;
  /** Inject a fully configured OAuth service in tests or custom deployments. */
  feishuOAuthService?: FeishuOAuthService;
  /** Convenience production configuration; token exchange uses FeishuOAuthClient. */
  feishuOAuth?: FeishuOAuthServiceOptions;
  reminderNotifier?: ReminderNotifier;
  reminderWorkerEnabled?: boolean;
  reminderPollIntervalMs?: number;
  /** Connector ingress mode; production defaults to async, dev/test to sync. */
  feishuProcessingMode?: 'sync' | 'async';
  connectorWorkerEnabled?: boolean;
  connectorWorkerIntervalMs?: number;
  connectorWorkerBatchSize?: number;
  connectorWorkerLeaseMs?: number;
  connectorMaxAttempts?: number;
  connectorBackoffBaseMs?: number;
  connectorBackoffMaxMs?: number;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const authentication = options.authentication ?? {
    mode: 'trusted_headers' as const,
    environment: options.nodeEnv ?? 'development',
  };
  const rateLimitOptions = options.rateLimit;
  validateAuthenticationOptions(authentication);
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: positiveInteger(options.bodyLimitBytes, 4 * 1_024 * 1_024),
    requestTimeout: positiveInteger(options.requestTimeoutMs, 30_000),
    connectionTimeout: positiveInteger(options.connectionTimeoutMs, 125_000),
    keepAliveTimeout: 72_000,
  });
  // Preserve the exact Feishu webhook bytes for signature verification while
  // allowing Fastify to continue exposing the parsed JSON body to handlers.
  registerRawBodyCapture(app, {
    pathPrefix: '/v1/connectors/feishu/events',
    maxBytes: positiveInteger(options.bodyLimitBytes, 4 * 1_024 * 1_024),
  });
  const repository = new SqliteAssetRepository(options.databasePath ?? ':memory:');
  const feishuProcessingMode = options.feishuProcessingMode
    ?? ((options.nodeEnv ?? 'development') === 'production' ? 'async' : 'sync');
  const feishuOAuth = options.feishuOAuthService
    ?? (options.feishuOAuth
      ? new FeishuOAuthService(repository, {
        ...options.feishuOAuth,
        environment: options.nodeEnv ?? 'development',
      })
      : undefined);
  const assetService = new AssetService(repository);
  const searchService = new SearchService(repository);
  const answerService = new AnswerService(searchService, options.llmGenerator);
  const feishuCommands = new FeishuCommandService(searchService, answerService);
  const reminderService = new ReminderService(repository, {
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  });
  const reminderWorker = options.reminderWorkerEnabled && options.reminderNotifier
    ? new ReminderNotificationWorker(repository, options.reminderNotifier, {
      ...(options.reminderPollIntervalMs !== undefined
        ? { intervalMs: options.reminderPollIntervalMs }
        : {}),
      onError: (error) => app.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'reminder notification failed'),
    })
    : undefined;
  const feishuEvents = new FeishuEventService(
    assetService,
    reminderService,
    {
      ...(options.feishuVerificationToken
        ? { verificationToken: options.feishuVerificationToken }
        : {}),
      ...(options.feishuEncryptKey ? { encryptKey: options.feishuEncryptKey } : {}),
      ...(options.feishuMessenger ? { messenger: options.feishuMessenger } : {}),
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
      commandService: feishuCommands,
      eventReceipts: repository,
    },
  );
  const connectorWorkerEnabled = options.connectorWorkerEnabled
    ?? feishuProcessingMode === 'async';
  const connectorWorker = connectorWorkerEnabled
    ? new ConnectorQueueWorker(repository, {
      ...(options.connectorWorkerIntervalMs !== undefined
        ? { intervalMs: options.connectorWorkerIntervalMs } : {}),
      ...(options.connectorWorkerBatchSize !== undefined
        ? { batchSize: options.connectorWorkerBatchSize } : {}),
      ...(options.connectorWorkerLeaseMs !== undefined
        ? { leaseMs: options.connectorWorkerLeaseMs } : {}),
      ...(options.connectorMaxAttempts !== undefined
        ? { maxAttempts: options.connectorMaxAttempts } : {}),
      ...(options.connectorBackoffBaseMs !== undefined
        ? { backoffBaseMs: options.connectorBackoffBaseMs } : {}),
      ...(options.connectorBackoffMaxMs !== undefined
        ? { backoffMaxMs: options.connectorBackoffMaxMs } : {}),
      processors: {
        feishu: async (record) => feishuEvents.processQueued(record.payload),
      },
      dispatchers: options.feishuMessenger ? {
        feishu: async (record) => dispatchFeishuOutbox(options.feishuMessenger!, record),
      } : {},
      onError: (error, kind, recordId) => app.log.error({
        errorName: error instanceof Error ? error.name : 'UnknownError',
        kind,
        recordId,
      }, 'connector queue processing failed'),
    })
    : undefined;

  app.addHook('onClose', async () => {
    reminderWorker?.stop();
    connectorWorker?.stop();
    await Promise.all([
      reminderWorker?.stopAndDrain(),
      connectorWorker?.stopAndDrain(),
    ]);
    repository.close();
  });
  registerErrorHandling(app);
  registerJsonMediaTypeGuard(app);

  registerHealthRoute(app, {
    llmEnabled: options.llmEnabled ?? Boolean(options.llmGenerator),
    feishuConfigured: Boolean(options.feishuVerificationToken || options.feishuOAuthConfigured),
    feishuNotificationsEnabled: Boolean(options.feishuMessenger),
    feishuOAuthEnabled: Boolean(feishuOAuth),
    exposeDetails: (options.nodeEnv ?? 'development') !== 'production',
    readinessCheck: options.readinessCheck ?? (async () => {
      await repository.list({ tenantId: '__health__', userId: '__health__' }, { limit: 1 });
    }),
  });
  await registerOpenApiRoute(app);
  await registerWorkbenchRoutes(app);

  await app.register(async (secured) => {
    await accessContextPlugin(secured, authentication);
    // Authentication runs before this preHandler, so product traffic is
    // bucketed by the verified tenant/user identity rather than a NAT IP.
    if (rateLimitOptions !== false) registerRateLimit(secured, rateLimitOptions);
    registerAssetRoutes(secured, assetService, repository);
    registerSearchRoute(secured, searchService);
    registerAnswerRoute(secured, answerService);
    registerReminderRoutes(secured, reminderService);
    registerConnectorQueueRoutes(secured, repository);
    if (feishuOAuth) registerFeishuOAuthSecuredRoutes(secured, feishuOAuth);
  }, { prefix: '/v1' });

  await app.register(async (feishu) => {
    // Feishu callbacks are intentionally unauthenticated at the HTTP layer;
    // keep a small IP bucket for this public ingress path.
    if (rateLimitOptions !== false) {
      const publicRateLimitOptions: RateLimitOptions = { hook: 'onRequest' };
      if (rateLimitOptions?.maxRequests !== undefined) {
        publicRateLimitOptions.maxRequests = rateLimitOptions.maxRequests;
      }
      if (rateLimitOptions?.windowMs !== undefined) {
        publicRateLimitOptions.windowMs = rateLimitOptions.windowMs;
      }
      if (rateLimitOptions?.maxKeys !== undefined) {
        publicRateLimitOptions.maxKeys = rateLimitOptions.maxKeys;
      }
      if (rateLimitOptions?.now !== undefined) publicRateLimitOptions.now = rateLimitOptions.now;
      registerRateLimit(feishu, publicRateLimitOptions);
    }
    registerFeishuEventRoute(feishu, feishuEvents, {
      processingMode: feishuProcessingMode,
      queue: repository,
    });
    if (feishuOAuth) registerFeishuOAuthCallbackRoute(feishu, feishuOAuth);
  }, { prefix: '/v1/connectors/feishu' });

  reminderWorker?.start();
  connectorWorker?.start();

  return app;
}

async function dispatchFeishuOutbox(
  messenger: FeishuMessenger,
  record: ConnectorOutboxRecord,
): Promise<void> {
  const payload = record.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Feishu outbox payload is invalid');
  }
  const text = (payload as Record<string, unknown>).text;
  if (typeof text !== 'string' || !text.trim()) throw new Error('Feishu outbox text is missing');
  await messenger.sendText(record.destination, text);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('Fastify limits and timeouts must be positive integers');
  }
  return value;
}
