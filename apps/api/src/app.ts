import {
  AnswerService,
  AssetService,
  SearchService,
  ReminderService,
  ReminderNotificationWorker,
  type ReminderNotifier,
  SqliteAssetRepository,
  type LlmAnswerGenerator,
} from '@infomemory/core';
import Fastify, { type FastifyInstance } from 'fastify';

import { FeishuEventService } from './feishu/feishu-event-service.js';
import { FeishuCommandService } from './feishu/feishu-command-service.js';
import type { FeishuMessenger } from './feishu/feishu-client.js';
import { registerErrorHandling } from './http/error-handling.js';
import { registerJsonMediaTypeGuard } from './http/media-type.js';
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
  feishuEncryptKey?: string;
  feishuMessenger?: FeishuMessenger;
  reminderNotifier?: ReminderNotifier;
  reminderWorkerEnabled?: boolean;
  reminderPollIntervalMs?: number;
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
  const repository = new SqliteAssetRepository(options.databasePath ?? ':memory:');
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

  app.addHook('onClose', async () => {
    reminderWorker?.stop();
    repository.close();
  });
  registerErrorHandling(app);
  registerJsonMediaTypeGuard(app);

  registerHealthRoute(app, {
    llmEnabled: options.llmEnabled ?? Boolean(options.llmGenerator),
    feishuConfigured: Boolean(options.feishuVerificationToken),
    feishuNotificationsEnabled: Boolean(options.feishuMessenger),
    exposeDetails: (options.nodeEnv ?? 'development') !== 'production',
    readinessCheck: options.readinessCheck ?? (async () => {
      await repository.list({ tenantId: '__health__', userId: '__health__' }, { limit: 1 });
    }),
  });
  await registerOpenApiRoute(app);

  await app.register(async (secured) => {
    await accessContextPlugin(secured, authentication);
    // Authentication runs before this preHandler, so product traffic is
    // bucketed by the verified tenant/user identity rather than a NAT IP.
    if (rateLimitOptions !== false) registerRateLimit(secured, rateLimitOptions);
    registerAssetRoutes(secured, assetService, repository);
    registerSearchRoute(secured, searchService);
    registerAnswerRoute(secured, answerService);
    registerReminderRoutes(secured, reminderService);
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
    registerFeishuEventRoute(feishu, feishuEvents);
  }, { prefix: '/v1/connectors/feishu' });

  reminderWorker?.start();

  return app;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('Fastify limits and timeouts must be positive integers');
  }
  return value;
}
