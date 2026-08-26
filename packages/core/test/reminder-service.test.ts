import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteAssetRepository } from '../src/repositories/sqlite-asset-repository.js';
import { ReminderService } from '../src/services/reminder-service.js';

const context = { tenantId: 'tenant-a', userId: 'alice' };
const now = new Date('2026-08-19T02:00:00.000Z'); // 10:00 in Asia/Shanghai

describe('ReminderService', () => {
  let repository: SqliteAssetRepository;
  let service: ReminderService;
  let idCounter: number;

  beforeEach(() => {
    repository = new SqliteAssetRepository(':memory:');
    idCounter = 0;
    service = new ReminderService(repository, {
      now: () => now,
      idFactory: () => `reminder-${++idCounter}`,
    });
  });

  afterEach(() => repository.close());

  it('creates a private reminder and deduplicates the source event', async () => {
    const first = await service.observeMessage(context, {
      text: '明天 14:30 开会讨论上线方案。',
      sourceEventId: 'event-1',
    });
    const second = await service.observeMessage(context, {
      text: '明天 14:30 开会讨论上线方案。',
      sourceEventId: 'event-1',
    });

    expect(first?.status).toBe('scheduled');
    expect(second?.id).toBe(first?.id);
    await expect(service.list({ tenantId: 'tenant-b', userId: 'bob' })).resolves.toEqual([]);
  });

  it('redacts secrets before deriving an observed reminder title', async () => {
    const reminder = await service.observeMessage(context, {
      text: '明天 14:30 开会讨论上线方案，password=observed-secret。',
      sourceEventId: 'event-secret-title',
    });

    expect(reminder?.title).toContain('[REDACTED:password]');
    expect(reminder?.title).not.toContain('observed-secret');
  });

  it('persists default Asia/Shanghai instants independently of the process time zone', async () => {
    const reminder = await service.observeMessage(context, {
      text: '明天 14:30 开会讨论上线方案。',
      sourceEventId: 'event-time-zone',
    });

    expect(reminder).toMatchObject({
      startsAt: '2026-08-20T06:30:00.000Z',
      remindAt: '2026-08-20T06:00:00.000Z',
      status: 'scheduled',
    });
  });

  it('honors a configured IANA time zone', async () => {
    const utcService = new ReminderService(repository, {
      now: () => now,
      idFactory: () => 'reminder-utc',
      timeZone: 'UTC',
    });
    const reminder = await utcService.observeMessage(context, {
      text: '明天 14:30 开会。',
      sourceEventId: 'event-utc',
    });

    expect(reminder?.startsAt).toBe('2026-08-20T14:30:00.000Z');
  });

  it('does not persist invalid or explicitly past meeting times', async () => {
    await expect(service.observeMessage(context, {
      text: '2026年2月31日 14点开会。',
      sourceEventId: 'event-invalid',
    })).resolves.toBeNull();
    await expect(service.observeMessage(context, {
      text: '今天 09:30 开会。',
      sourceEventId: 'event-past',
    })).resolves.toBeNull();

    await expect(service.list(context)).resolves.toEqual([]);
  });

  it('supports confirmation and completion status transitions', async () => {
    const reminder = await service.observeMessage(context, {
      text: '下午要开会。',
      sourceEventId: 'event-2',
    });
    expect(reminder?.status).toBe('needs_confirmation');

    const confirmed = await service.updateStatus(context, reminder?.id ?? '', 'scheduled');
    const completed = await service.updateStatus(context, reminder?.id ?? '', 'completed');
    expect(confirmed?.status).toBe('scheduled');
    expect(completed?.status).toBe('completed');
  });

  it('creates manually scheduled reminders and redacts their titles', async () => {
    const reminder = await service.schedule(context, {
      title: '发布会 password=abcd',
      startsAt: '2026-08-19T04:00:00.000Z',
    });

    expect(reminder).toMatchObject({
      title: '发布会 password=[REDACTED:password]',
      startsAt: '2026-08-19T04:00:00.000Z',
      remindAt: '2026-08-19T03:30:00.000Z',
      status: 'scheduled',
      precision: 'exact',
    });
  });

  it('rejects past reminders, invalid remind times, and terminal status reopening', async () => {
    await expect(service.schedule(context, {
      title: '过去的会议',
      startsAt: '2026-08-19T01:00:00.000Z',
    })).rejects.toThrow('startsAt');
    await expect(service.schedule(context, {
      title: '提醒过晚',
      startsAt: '2026-08-19T04:00:00.000Z',
      remindAt: '2026-08-19T05:00:00.000Z',
    })).rejects.toThrow('remindAt');

    const reminder = await service.schedule(context, {
      title: '终态会议',
      startsAt: '2026-08-19T04:00:00.000Z',
    });
    await service.updateStatus(context, reminder.id, 'completed');
    await expect(service.updateStatus(context, reminder.id, 'scheduled'))
      .rejects.toThrow('cannot transition');
  });

  it('only exposes confirmed scheduled reminders as due', async () => {
    const pending = await service.observeMessage(context, {
      text: '下午要开会。',
      sourceEventId: 'event-pending',
    });
    const exact = await service.observeMessage(context, {
      text: '今天 10:30 开会。',
      sourceEventId: 'event-exact',
    });

    expect(pending?.status).toBe('needs_confirmation');
    expect(exact?.status).toBe('scheduled');
    const due = await service.listDue(context, new Date('2026-08-19T08:00:00.000Z'));
    expect(due).toHaveLength(1);
    expect(due.every((item) => item.status === 'scheduled')).toBe(true);
  });
});
