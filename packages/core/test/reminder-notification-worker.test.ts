import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SqliteAssetRepository } from '../src/repositories/sqlite-asset-repository.js';
import { ReminderNotificationWorker } from '../src/services/reminder-notification-worker.js';

const dueReminder = {
  id: 'reminder-due',
  context: { tenantId: 'tenant-a', userId: 'alice' },
  title: '明天的会议',
  startsAt: '2026-08-20T06:30:00.000Z',
  remindAt: '2026-08-20T06:00:00.000Z',
  status: 'scheduled' as const,
  precision: 'exact' as const,
  sourceEventId: 'event-due',
  createdAt: '2026-08-19T02:00:00.000Z',
};

describe('ReminderNotificationWorker', () => {
  let repository: SqliteAssetRepository;

  beforeEach(() => {
    repository = new SqliteAssetRepository(':memory:');
  });

  afterEach(() => repository.close());

  it('claims and sends a due reminder only once', async () => {
    await repository.createReminder(dueReminder);
    const notify = vi.fn().mockResolvedValue(undefined);
    const worker = new ReminderNotificationWorker(repository, { notify }, {
      now: () => new Date('2026-08-20T06:01:00.000Z'),
      intervalMs: 60_000,
    });

    await expect(worker.tick()).resolves.toBe(1);
    await expect(worker.tick()).resolves.toBe(0);
    expect(notify).toHaveBeenCalledOnce();
  });

  it('releases failed deliveries so the next tick can retry', async () => {
    await repository.createReminder({ ...dueReminder, id: 'reminder-retry' });
    const notify = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(undefined);
    const errors = vi.fn();
    const worker = new ReminderNotificationWorker(repository, { notify }, {
      now: () => new Date('2026-08-20T06:01:00.000Z'),
      intervalMs: 60_000,
      onError: errors,
    });

    await expect(worker.tick()).resolves.toBe(0);
    await expect(worker.tick()).resolves.toBe(1);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalledOnce();
  });

  it('drains an active notification before shutdown completes', async () => {
    await repository.createReminder({ ...dueReminder, id: 'reminder-drain' });
    const started = deferred();
    const release = deferred();
    const worker = new ReminderNotificationWorker(repository, {
      notify: async () => {
        started.resolve();
        await release.promise;
      },
    }, {
      now: () => new Date('2026-08-20T06:01:00.000Z'),
      intervalMs: 60_000,
    });

    const tick = worker.tick();
    await started.promise;
    const drained = worker.stopAndDrain();
    let complete = false;
    void drained.then(() => { complete = true; });
    await Promise.resolve();
    expect(complete).toBe(false);

    release.resolve();
    await expect(drained).resolves.toBeUndefined();
    await expect(tick).resolves.toBe(1);
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return {
    promise,
    resolve: () => resolve?.(),
  };
}
