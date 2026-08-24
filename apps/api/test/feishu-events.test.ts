import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';

describe('Feishu callback foundation', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let messenger: { sendText: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    messenger = { sendText: vi.fn().mockResolvedValue({ messageId: 'outbound-message-1' }) };
    app = await buildApp({
      databasePath: ':memory:',
      logger: false,
      feishuVerificationToken: 'expected-token',
      feishuMessenger: messenger,
    });
  });

  afterEach(async () => app.close());

  it('responds to a valid URL verification challenge', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/connectors/feishu/events',
      payload: {
        type: 'url_verification',
        token: 'expected-token',
        challenge: 'challenge-value',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ challenge: 'challenge-value' });
  });

  it('rejects callbacks with an invalid verification token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/connectors/feishu/events',
      payload: {
        type: 'url_verification',
        token: 'wrong-token',
        challenge: 'challenge-value',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: 'feishu_verification_failed',
      message: 'Feishu callback verification failed',
      requestId: expect.any(String),
    });
  });

  it('acknowledges unsupported event types without storing them', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/connectors/feishu/events',
      payload: eventPayload({ eventType: 'contact.user.updated_v3' }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      code: 0,
      processed: false,
      reason: 'unsupported_event',
    });
  });

  it('normalizes inbound text and deduplicates repeated event delivery', async () => {
    const event = eventPayload({
      eventId: 'event-text-1',
      text: '请注意，明天 14:30 开会讨论上线方案。',
    });

    const first = await app.inject({
      method: 'POST',
      url: '/v1/connectors/feishu/events',
      payload: event,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/connectors/feishu/events',
      payload: event,
    });
    const assets = await app.inject({
      method: 'GET',
      url: '/v1/assets',
      headers: {
        'x-tenant-id': 'tenant-key-1',
        'x-user-id': 'open-id-1',
      },
    });

    expect(first.json()).toMatchObject({
      code: 0,
      processed: true,
      reminder: { status: 'scheduled', precision: 'exact' },
      notificationSent: true,
    });
    expect(messenger.sendText).toHaveBeenCalledWith(
      'open-id-1',
      expect.stringContaining('已识别到会议'),
    );
    expect(second.json()).toMatchObject({
      code: 0,
      processed: false,
      reason: 'duplicate_event',
    });
    expect(assets.json().assets).toHaveLength(1);
    expect(assets.json().assets[0]).toMatchObject({
      ownerId: 'open-id-1',
      redactedContent: '请注意，明天 14:30 开会讨论上线方案。',
      visibility: 'owner',
    });

    const reminders = await app.inject({
      method: 'GET',
      url: '/v1/reminders',
      headers: {
        'x-tenant-id': 'tenant-key-1',
        'x-user-id': 'open-id-1',
      },
    });
    expect(reminders.json().reminders).toHaveLength(1);
  });

  it('does not store unsupported message types', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/connectors/feishu/events',
      payload: eventPayload({ messageType: 'image' }),
    });

    expect(response.json()).toMatchObject({
      code: 0,
      processed: false,
      reason: 'unsupported_message_type',
    });
  });

  it('executes idempotent search commands without polluting the memory index', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/assets',
      headers: {
        'x-tenant-id': 'tenant-key-1',
        'x-user-id': 'open-id-1',
        'idempotency-key': 'seed-command-search',
      },
      payload: {
        title: '数据库配置',
        content: '生产数据库由平台组维护。',
        visibility: 'owner',
      },
    });
    messenger.sendText.mockClear();
    const command = eventPayload({
      eventId: 'command-search-1',
      text: '搜索 数据库配置',
    });

    const first = await app.inject({
      method: 'POST',
      url: '/v1/connectors/feishu/events',
      payload: command,
    });
    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/connectors/feishu/events',
      payload: command,
    });
    const assets = await app.inject({
      method: 'GET',
      url: '/v1/assets',
      headers: {
        'x-tenant-id': 'tenant-key-1',
        'x-user-id': 'open-id-1',
      },
    });

    expect(first.json()).toMatchObject({
      code: 0,
      processed: true,
      notificationSent: true,
    });
    expect(duplicate.json()).toMatchObject({
      code: 0,
      processed: false,
      reason: 'duplicate_event',
    });
    expect(messenger.sendText).toHaveBeenCalledOnce();
    expect(messenger.sendText).toHaveBeenCalledWith(
      'open-id-1',
      expect.stringContaining('[S1] 数据库配置'),
    );
    expect(assets.json().assets).toHaveLength(1);
  });

  it('derives asset and reminder metadata only from redacted text', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/connectors/feishu/events',
      payload: eventPayload({
        eventId: 'secret-reminder-event',
        text: 'password=abcd 明天 14:30 开会讨论发布。',
      }),
    });
    const assets = await app.inject({
      method: 'GET',
      url: '/v1/assets',
      headers: {
        'x-tenant-id': 'tenant-key-1',
        'x-user-id': 'open-id-1',
      },
    });

    expect(response.body).not.toContain('abcd');
    expect(assets.body).not.toContain('abcd');
    expect(response.json().reminder.title).toContain('[REDACTED:password]');
    expect(messenger.sendText.mock.calls.flat().join('\n')).not.toContain('abcd');
  });
});

function eventPayload(options: {
  eventId?: string;
  eventType?: string;
  messageType?: string;
  text?: string;
} = {}): Record<string, unknown> {
  return {
    schema: '2.0',
    header: {
      event_id: options.eventId ?? 'event-default',
      event_type: options.eventType ?? 'im.message.receive_v1',
      tenant_key: 'tenant-key-1',
      token: 'expected-token',
    },
    event: {
      sender: {
        sender_id: { open_id: 'open-id-1' },
      },
      message: {
        message_id: 'message-id-1',
        chat_id: 'chat-id-1',
        chat_type: 'p2p',
        message_type: options.messageType ?? 'text',
        content: JSON.stringify({ text: options.text ?? '请保存星海项目的部署结论。' }),
      },
    },
  };
}
