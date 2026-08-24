import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, isAbsolute } from 'node:path';

import { OpenAiCompatibleClient, type LlmAnswerGenerator } from '@infomemory/core';
import { type ReminderNotifier } from '@infomemory/core';
import { config as loadEnvironment } from 'dotenv';

import { buildApp } from './app.js';
import { loadAppConfig } from './config.js';
import { FeishuClient, formatReminderNotification } from './feishu/feishu-client.js';
import { createLoggerOptions } from './logging.js';

loadEnvironment({ path: ['.env.local', '.env'], quiet: true });
const config = loadAppConfig();
const databasePath = resolveDatabasePath(config.databasePath);
const llmGenerator = createLlmGenerator();
const feishuClient = createFeishuClient();
const app = await buildApp({
  databasePath,
  logger: createLoggerOptions(config.nodeEnv),
  nodeEnv: config.nodeEnv,
  authentication: config.authMode === 'bearer'
    ? {
      mode: 'bearer',
      secret: config.authSecret ?? '',
      issuer: config.authIssuer ?? '',
      audience: config.authAudience ?? '',
    }
    : { mode: 'trusted_headers', environment: config.nodeEnv },
  timeZone: config.appTimeZone,
  bodyLimitBytes: config.httpBodyLimitBytes,
  requestTimeoutMs: config.httpRequestTimeoutMs,
  connectionTimeoutMs: config.httpConnectionTimeoutMs,
  rateLimit: config.rateLimitEnabled ? {
    maxRequests: config.rateLimitMaxRequests,
    windowMs: config.rateLimitWindowMs,
    maxKeys: config.rateLimitMaxKeys,
  } : false,
  llmEnabled: config.llmEnabled,
  ...(llmGenerator ? { llmGenerator } : {}),
  ...(config.feishuVerificationToken
    ? { feishuVerificationToken: config.feishuVerificationToken }
    : {}),
  ...(config.feishuEncryptKey ? { feishuEncryptKey: config.feishuEncryptKey } : {}),
  ...(feishuClient ? { feishuMessenger: feishuClient } : {}),
  ...(feishuClient
    ? { reminderNotifier: createReminderNotifier(feishuClient, config.appTimeZone) }
    : {}),
  reminderWorkerEnabled: Boolean(feishuClient),
  reminderPollIntervalMs: config.reminderPollIntervalMs,
});

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'startup failed');
  await app.close();
  process.exit(1);
}

function createLlmGenerator(): LlmAnswerGenerator | undefined {
  if (!config.llmEnabled) return undefined;
  return new OpenAiCompatibleClient({
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey ?? '',
    model: config.llmModel ?? '',
    timeoutMs: config.llmTimeoutMs,
  });
}

function resolveDatabasePath(value: string): string {
  if (value === ':memory:') return value;
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const absolute = isAbsolute(value) ? value : resolve(projectRoot, value);
  mkdirSync(dirname(absolute), { recursive: true });
  return absolute;
}

function createFeishuClient(): FeishuClient | undefined {
  if (!config.feishuNotificationsEnabled) return undefined;
  return new FeishuClient({
    baseUrl: config.feishuApiBaseUrl,
    appId: config.feishuAppId ?? '',
    appSecret: config.feishuAppSecret ?? '',
    timeoutMs: config.feishuApiTimeoutMs,
  });
}

function createReminderNotifier(
  client: FeishuClient,
  timeZone: string,
): ReminderNotifier {
  return {
    notify: async (reminder) => {
      await client.sendText(
        reminder.userId,
        formatReminderNotification(reminder, timeZone),
      );
    },
  };
}
