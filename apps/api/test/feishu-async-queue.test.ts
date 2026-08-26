import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import {
  AnswerService,
  AssetService,
  ReminderService,
  SearchService,
  SqliteAssetRepository,
} from '@infomemory/core';
import { FeishuCommandService } from '../src/feishu/feishu-command-service.js';
import { FeishuEventService } from '../src/feishu/feishu-event-service.js';

describe('Feishu durable async ingress', () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });

  it('ACKs after enqueue and worker processes the redacted event', async () => {
    const messenger = { sendText: vi.fn().mockResolvedValue({ messageId: 'out-1' }) };
    const app = await buildApp({
      databasePath: ':memory:',
      logger: false,
      nodeEnv: 'test',
      feishuProcessingMode: 'async',
      connectorWorkerEnabled: true,
      connectorWorkerIntervalMs: 250,
      feishuVerificationToken: 'expected-token',
      feishuMessenger: messenger,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST', url: '/v1/connectors/feishu/events',
      payload: eventPayload({ eventId: 'async-1', text: '请保存异步消息 password=async-secret' }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ code: 0, queued: true, processed: false, inboxId: expect.any(String) });
    // start() schedules an immediate tick; allow it to finish without waiting
    // for the configured interval.
    await new Promise((resolve) => setTimeout(resolve, 350));
    const assets = await app.inject({
      method: 'GET', url: '/v1/assets',
      headers: { 'x-tenant-id': 'tenant-key-1', 'x-user-id': 'open-id-1' },
    });
    expect(assets.json().assets).toHaveLength(1);
    expect(assets.body).not.toContain('async-secret');
  });

  it('queues rich-text post messages and persists their visible text', async () => {
    const app = await buildApp({
      databasePath: ':memory:',
      logger: false,
      nodeEnv: 'test',
      feishuProcessingMode: 'async',
      connectorWorkerEnabled: true,
      connectorWorkerIntervalMs: 250,
      feishuVerificationToken: 'expected-token',
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/connectors/feishu/events',
      payload: eventPayload({
        eventId: 'async-post-1',
        messageType: 'post',
        content: richPostContent([
          '项目部署说明：演示环境由知澜团队维护。',
          '发布负责人是王小明。',
        ]),
      }),
    });

    expect(response.json()).toMatchObject({ code: 0, queued: true, processed: false });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const assets = await app.inject({
      method: 'GET',
      url: '/v1/assets',
      headers: { 'x-tenant-id': 'tenant-key-1', 'x-user-id': 'open-id-1' },
    });
    expect(assets.json().assets).toHaveLength(1);
    expect(assets.json().assets[0]).toMatchObject({
      redactedContent: '项目部署说明：演示环境由知澜团队维护。\n发布负责人是王小明。',
    });
  });

  it('does not persist callback verification tokens in queue payloads', async () => {
    const app = await buildApp({
      databasePath: ':memory:', logger: false, nodeEnv: 'test',
      feishuProcessingMode: 'async', connectorWorkerEnabled: false,
      feishuVerificationToken: 'expected-token',
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST', url: '/v1/connectors/feishu/events',
      payload: eventPayload({ eventId: 'async-secret-1', text: '消息正文' }),
    });
    expect(response.json()).toMatchObject({ queued: true });
    const stats = await app.inject({
      method: 'GET', url: '/v1/admin/connectors/queue',
      headers: { 'x-tenant-id': 'tenant-key-1', 'x-user-id': 'operator' },
    });
    expect(stats.statusCode).toBe(200);
    expect(stats.body).not.toContain('expected-token');
  });

  it('deduplicates Feishu retries by stable message_id even when event_id changes', async () => {
    const app = await buildApp({
      databasePath: ':memory:', logger: false, nodeEnv: 'test',
      feishuProcessingMode: 'async', connectorWorkerEnabled: false,
      feishuVerificationToken: 'expected-token',
    });
    apps.push(app);
    const first = await app.inject({
      method: 'POST', url: '/v1/connectors/feishu/events',
      payload: eventPayload({
        eventId: 'delivery-a', messageId: 'stable-message', text: 'same message',
      }),
    });
    const second = await app.inject({
      method: 'POST', url: '/v1/connectors/feishu/events',
      payload: eventPayload({
        eventId: 'delivery-b', messageId: 'stable-message', text: 'same message',
      }),
    });
    expect(first.json()).toMatchObject({ queued: true, processed: false });
    expect(second.json()).toMatchObject({
      queued: false,
      processed: false,
      reason: 'duplicate_event',
      inboxId: first.json().inboxId,
    });
    const stats = await app.inject({
      method: 'GET', url: '/v1/admin/connectors/queue',
      headers: { 'x-tenant-id': 'tenant-key-1', 'x-user-id': 'operator' },
    });
    expect(stats.json().inbox.queued).toBe(1);
  });

  it('scopes queue statistics and operator mutations to the authenticated tenant', async () => {
    const app = await buildApp({
      databasePath: ':memory:', logger: false, nodeEnv: 'test',
      feishuProcessingMode: 'async', connectorWorkerEnabled: false,
      feishuVerificationToken: 'expected-token',
    });
    apps.push(app);
    const queued = await app.inject({
      method: 'POST', url: '/v1/connectors/feishu/events',
      payload: eventPayload({ eventId: 'tenant-isolation-1', text: 'tenant A message' }),
    });
    const inboxId = queued.json().inboxId as string;
    const otherTenantStats = await app.inject({
      method: 'GET', url: '/v1/admin/connectors/queue',
      headers: { 'x-tenant-id': 'tenant-b', 'x-user-id': 'operator' },
    });
    expect(otherTenantStats.json().inbox.queued).toBe(0);
    const otherTenantRetry = await app.inject({
      method: 'POST', url: `/v1/admin/connectors/queue/inbox/${inboxId}/retry`,
      headers: { 'x-tenant-id': 'tenant-b', 'x-user-id': 'operator' },
    });
    expect(otherTenantRetry.statusCode).toBe(404);
    const ownerStats = await app.inject({
      method: 'GET', url: '/v1/admin/connectors/queue',
      headers: { 'x-tenant-id': 'tenant-key-1', 'x-user-id': 'operator' },
    });
    expect(ownerStats.json().inbox.queued).toBe(1);
  });

  it('recreates command output after a crash before inbox completion', async () => {
    const repository = new SqliteAssetRepository(':memory:');
    const messenger = { sendText: vi.fn().mockResolvedValue({ messageId: 'out-1' }) };
    try {
      const search = new SearchService(repository);
      const commands = new FeishuCommandService(search, new AnswerService(search));
      const service = new FeishuEventService(
        new AssetService(repository),
        new ReminderService(repository),
        { verificationToken: 'expected-token', commandService: commands, eventReceipts: repository, messenger },
      );
      const prepared = service.prepare(eventPayload({ eventId: 'command-crash-1', text: '帮助' }));
      if (prepared.kind !== 'event') throw new Error('event was not prepared');
      const queued = await repository.enqueueConnectorInbox({
        tenantId: prepared.event.tenantId, connector: 'feishu', eventId: prepared.event.eventId,
        payload: prepared.event, receivedAt: '2026-01-01T00:00:00.000Z',
      });
      const [first] = await repository.claimConnectorInbox({ now: '2026-01-01T00:00:01.000Z', leaseMs: 1_000 });
      expect(first).toBeTruthy();
      // Process side effects, then simulate a process crash before complete.
      const firstResult = await service.processQueued(first?.payload);
      expect(firstResult.outbox).toHaveLength(1);
      const [reclaimed] = await repository.claimConnectorInbox({ now: '2026-01-01T00:00:03.000Z', leaseMs: 1_000 });
      expect(reclaimed?.attempts).toBe(2);
      const secondResult = await service.processQueued(reclaimed?.payload);
      expect(secondResult.outbox).toHaveLength(1);
      await expect(repository.completeConnectorInbox({
        id: queued.id, claimToken: reclaimed?.claimToken ?? '',
        processedAt: '2026-01-01T00:00:04.000Z', outbox: secondResult.outbox,
      })).resolves.toBe(true);
      const stats = await repository.getConnectorQueueStats('feishu', 'tenant-key-1');
      expect(stats.inbox.completed).toBe(1);
      expect(stats.outbox.queued).toBe(1);
    } finally {
      repository.close();
    }
  });

  it('does not create a Feishu outbox or scheduled reminder when open_id is absent', async () => {
    const repository = new SqliteAssetRepository(':memory:');
    const messenger = { sendText: vi.fn().mockResolvedValue({ messageId: 'out-1' }) };
    try {
      const service = new FeishuEventService(
        new AssetService(repository),
        new ReminderService(repository),
        { verificationToken: 'expected-token', messenger },
      );
      const prepared = service.prepare(eventPayload({
        eventId: 'missing-open-id-async',
        text: '明天 14:30 开会讨论上线方案。',
        senderId: { union_id: 'union-id-async', user_id: 'user-id-async' },
      }));
      if (prepared.kind !== 'event') throw new Error('event was not prepared');

      const processed = await service.processQueued(prepared.event);
      expect(processed.result).toMatchObject({
        type: 'ack',
        processed: true,
        reason: 'notification_target_unavailable',
      });
      expect(processed.outbox).toBeUndefined();
      expect(messenger.sendText).not.toHaveBeenCalled();
      const reminders = await repository.listReminders(
        { tenantId: 'tenant-key-1', userId: 'union-id-async' },
        { limit: 50 },
      );
      expect(reminders).toHaveLength(0);
    } finally {
      repository.close();
    }
  });
});

function eventPayload(options: {
  eventId: string;
  messageId?: string;
  text?: string;
  messageType?: string;
  content?: string;
  senderId?: Record<string, string>;
}): Record<string, unknown> {
  return {
    schema: '2.0',
    header: {
      event_id: options.eventId,
      event_type: 'im.message.receive_v1',
      tenant_key: 'tenant-key-1',
      token: 'expected-token',
    },
    event: {
      sender: { sender_id: options.senderId ?? { open_id: 'open-id-1' } },
      message: {
        message_id: options.messageId ?? `message-${options.eventId}`,
        message_type: options.messageType ?? 'text',
        content: options.content ?? JSON.stringify({ text: options.text ?? '默认消息正文' }),
      },
    },
  };
}

function richPostContent(lines: string[]): string {
  return JSON.stringify({
    zh_cn: {
      title: '',
      content: lines.map((text) => [{ tag: 'text', text }]),
    },
  });
}
