import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';

describe('InfoMemory API', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    app = await buildApp({
      databasePath: ':memory:',
      logger: false,
      feishuVerificationToken: 'verification-token-for-tests',
    });
  });

  afterEach(async () => app.close());

  it('reports truthful health and capability information', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      service: 'infomemory-api',
      searchMode: 'sqlite_fts5',
      llmEnabled: false,
    });
  });

  it('requires tenant and user headers for product endpoints', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/assets' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: 'access_context_required',
      message: 'x-tenant-id and x-user-id headers are required',
      requestId: expect.any(String),
    });
  });

  it('ingests redacted assets and lists them within the tenant boundary', async () => {
    const secret = ['sk', 'apiTestExample1234567890ABCDEFG'].join('-');
    const created = await app.inject({
      method: 'POST',
      url: '/v1/assets',
      headers: accessHeaders('tenant-a', 'alice', { 'idempotency-key': 'api-asset-1' }),
      payload: {
        title: '配置说明',
        content: `密钥：${secret}`,
        visibility: 'tenant',
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(secret);
    expect(created.json().asset.secretFindingCount).toBe(1);

    const sameTenant = await app.inject({
      method: 'GET',
      url: '/v1/assets',
      headers: accessHeaders('tenant-a', 'bob'),
    });
    const otherTenant = await app.inject({
      method: 'GET',
      url: '/v1/assets',
      headers: accessHeaders('tenant-b', 'bob'),
    });

    expect(sameTenant.json().assets).toHaveLength(1);
    expect(otherTenant.json().assets).toEqual([]);
  });

  it('searches evidence and degrades answers when the LLM is disabled', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/assets',
      headers: accessHeaders('tenant-a', 'alice', { 'idempotency-key': 'project-1' }),
      payload: {
        title: '星海项目数据库配置',
        content: '生产数据库配置由平台组维护。',
        visibility: 'tenant',
      },
    });

    const searched = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: accessHeaders('tenant-a', 'alice'),
      payload: { query: '数据库配置' },
    });
    const answered = await app.inject({
      method: 'POST',
      url: '/v1/answers',
      headers: accessHeaders('tenant-a', 'alice'),
      payload: { query: '数据库配置由谁维护' },
    });

    expect(searched.statusCode).toBe(200);
    expect(searched.json()).toMatchObject({ mode: 'keyword' });
    expect(searched.json().evidence).toHaveLength(1);
    expect(answered.json()).toMatchObject({
      status: 'evidence_only',
      degradedReason: 'llm_disabled',
    });
  });

  it('returns stable validation errors without echoing submitted content', async () => {
    const sensitiveInput = 'do-not-echo-this-value';
    const response = await app.inject({
      method: 'POST',
      url: '/v1/assets',
      headers: accessHeaders('tenant-a', 'alice'),
      payload: { title: '', content: sensitiveInput },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'validation_error' });
    expect(response.body).not.toContain(sensitiveInput);
  });

  it('lists private reminders and supports confirmation/completion updates', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/connectors/feishu/events',
      payload: {
        type: 'url_verification',
        token: 'verification-token-for-tests',
        challenge: 'unused',
      },
    });
    expect(created.statusCode).toBe(200);

    const event = {
      header: {
        event_id: 'reminder-api-event',
        event_type: 'im.message.receive_v1',
        tenant_key: 'tenant-a',
        token: 'verification-token-for-tests',
      },
      event: {
        sender: { sender_id: { open_id: 'alice' } },
        message: {
          message_id: 'reminder-message',
          message_type: 'text',
          content: JSON.stringify({ text: '下午要开会，先帮我记着。' }),
        },
      },
    };
    const ingested = await app.inject({
      method: 'POST',
      url: '/v1/connectors/feishu/events',
      payload: event,
    });
    const reminder = ingested.json().reminder as { id: string; status: string };
    expect(reminder.status).toBe('needs_confirmation');

    const updated = await app.inject({
      method: 'POST',
      url: `/v1/reminders/${reminder.id}/status`,
      headers: accessHeaders('tenant-a', 'alice'),
      payload: { status: 'completed' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().reminder.status).toBe('completed');
    const hidden = await app.inject({
      method: 'GET',
      url: '/v1/reminders',
      headers: accessHeaders('tenant-a', 'bob'),
    });
    expect(hidden.json().reminders).toEqual([]);
  });

  it('scopes idempotency keys to the actor and rejects payload conflicts', async () => {
    const alice = await app.inject({
      method: 'POST',
      url: '/v1/assets',
      headers: accessHeaders('tenant-a', 'alice', { 'idempotency-key': 'shared-key' }),
      payload: { title: 'Alice 私有资产', content: '仅 Alice 可见。', visibility: 'owner' },
    });
    const bob = await app.inject({
      method: 'POST',
      url: '/v1/assets',
      headers: accessHeaders('tenant-a', 'bob', { 'idempotency-key': 'shared-key' }),
      payload: { title: 'Bob 私有资产', content: '仅 Bob 可见。', visibility: 'owner' },
    });
    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/assets',
      headers: accessHeaders('tenant-a', 'alice', { 'idempotency-key': 'shared-key' }),
      payload: { title: '不同请求', content: '不能复用相同 key。', visibility: 'owner' },
    });

    expect(alice.statusCode).toBe(201);
    expect(bob.statusCode).toBe(201);
    expect(bob.json().asset).toMatchObject({ ownerId: 'bob', title: 'Bob 私有资产' });
    expect(bob.body).not.toContain('Alice 私有资产');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: 'idempotency_conflict',
      requestId: expect.any(String),
    });
  });

  it('paginates, reads, and owner-deletes assets without weakening access control', async () => {
    const createdIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/assets',
        headers: accessHeaders('tenant-a', 'alice', {
          'idempotency-key': `pagination-${index}`,
        }),
        payload: {
          title: `分页资产 ${index}`,
          content: `分页检索内容 ${index}`,
          visibility: 'owner',
        },
      });
      createdIds.push(response.json().asset.id as string);
    }

    const firstPage = await app.inject({
      method: 'GET',
      url: '/v1/assets?limit=2&visibility=owner',
      headers: accessHeaders('tenant-a', 'alice'),
    });
    const cursor = firstPage.json().nextCursor as string;
    const secondPage = await app.inject({
      method: 'GET',
      url: `/v1/assets?limit=2&cursor=${encodeURIComponent(cursor)}`,
      headers: accessHeaders('tenant-a', 'alice'),
    });
    const targetId = createdIds[0] ?? '';
    const hidden = await app.inject({
      method: 'GET',
      url: `/v1/assets/${targetId}`,
      headers: accessHeaders('tenant-a', 'bob'),
    });
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/assets/${targetId}`,
      headers: accessHeaders('tenant-a', 'alice'),
    });
    const afterDelete = await app.inject({
      method: 'GET',
      url: `/v1/assets/${targetId}`,
      headers: accessHeaders('tenant-a', 'alice'),
    });

    expect(firstPage.json().assets).toHaveLength(2);
    expect(cursor).toEqual(expect.any(String));
    expect(secondPage.json().assets).toHaveLength(1);
    expect(hidden.statusCode).toBe(404);
    expect(deleted.json()).toEqual({ deleted: true, id: targetId });
    expect(afterDelete.statusCode).toBe(404);
  });

  it('creates manual reminders and rejects reopening a terminal reminder', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/reminders',
      headers: accessHeaders('tenant-a', 'alice'),
      payload: {
        title: '发布会 password=abcd',
        startsAt: '2030-08-24T06:30:00.000Z',
        remindAt: '2030-08-24T06:00:00.000Z',
      },
    });
    const reminder = created.json().reminder as { id: string; title: string };
    const completed = await app.inject({
      method: 'POST',
      url: `/v1/reminders/${reminder.id}/status`,
      headers: accessHeaders('tenant-a', 'alice'),
      payload: { status: 'completed' },
    });
    const reopened = await app.inject({
      method: 'POST',
      url: `/v1/reminders/${reminder.id}/status`,
      headers: accessHeaders('tenant-a', 'alice'),
      payload: { status: 'scheduled' },
    });

    expect(created.statusCode).toBe(201);
    expect(reminder.title).toBe('发布会 password=[REDACTED:password]');
    expect(completed.json().reminder.status).toBe('completed');
    expect(reopened.statusCode).toBe(409);
    expect(reopened.json()).toMatchObject({
      error: 'invalid_reminder_transition',
      requestId: expect.any(String),
    });
  });
});

function accessHeaders(
  tenantId: string,
  userId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'x-tenant-id': tenantId,
    'x-user-id': userId,
    ...extra,
  };
}
