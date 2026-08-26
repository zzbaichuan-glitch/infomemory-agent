import { afterEach, describe, expect, it } from 'vitest';

import {
  ConnectorQueueWorker,
  SqliteAssetRepository,
} from '../src/index.js';

describe('durable connector queue', () => {
  const repositories: SqliteAssetRepository[] = [];
  afterEach(() => {
    for (const repository of repositories.splice(0)) repository.close();
  });

  function createRepository(): SqliteAssetRepository {
    const repository = new SqliteAssetRepository(':memory:');
    repositories.push(repository);
    return repository;
  }

  it('deduplicates inbox event ids and stores only redacted payloads', async () => {
    const repository = createRepository();
    const first = await repository.enqueueConnectorInbox({
      tenantId: 'tenant-a',
      connector: 'feishu',
      eventId: 'event-1',
      receivedAt: '2026-01-01T00:00:00.000Z',
      payload: { token: 'super-secret', accessToken: 'camel-secret', nested: 'password=abcd', text: 'hello' },
    });
    const duplicate = await repository.enqueueConnectorInbox({
      tenantId: 'tenant-a',
      connector: 'feishu',
      eventId: 'event-1',
      payload: { token: 'super-secret', accessToken: 'camel-secret', nested: 'password=abcd', text: 'hello' },
    });
    const conflict = await repository.enqueueConnectorInbox({
      tenantId: 'tenant-a',
      connector: 'feishu',
      eventId: 'event-1',
      payload: { token: 'super-secret', accessToken: 'camel-secret', nested: 'password=abcd', text: 'changed' },
    });
    expect(first.created).toBe(true);
    expect(duplicate).toMatchObject({ created: false, duplicate: true, conflict: false, id: first.id });
    expect(conflict).toMatchObject({ created: false, duplicate: false, conflict: true, id: first.id });
    expect(JSON.stringify(first.record.payload)).not.toContain('super-secret');
    expect(JSON.stringify(first.record.payload)).not.toContain('camel-secret');
    expect(JSON.stringify(first.record.payload)).not.toContain('abcd');
  });

  it('atomically completes inbox and deduplicates outbox writes', async () => {
    const repository = createRepository();
    const queued = await repository.enqueueConnectorInbox({
      tenantId: 'tenant-a', connector: 'feishu', eventId: 'event-2', payload: { text: 'x' },
      receivedAt: '2026-01-01T00:00:00.000Z',
    });
    const [claimed] = await repository.claimConnectorInbox({
      now: '2026-01-01T00:00:01.000Z', leaseMs: 60_000,
    });
    expect(claimed?.claimToken).toBeTruthy();
    const completed = await repository.completeConnectorInbox({
      id: queued.id,
      claimToken: claimed?.claimToken ?? '',
      processedAt: '2026-01-01T00:00:02.000Z',
      outbox: [{
        tenantId: 'tenant-a', connector: 'feishu', dedupeKey: 'reply:event-2',
        destination: 'open-id', payload: { text: 'reply', authorization: 'secret' },
      }],
    });
    expect(completed).toBe(true);
    const stats = await repository.getConnectorQueueStats('feishu');
    expect(stats.inbox.completed).toBe(1);
    expect(stats.outbox.queued).toBe(1);
    const outbox = await repository.claimConnectorOutbox({ now: '2026-01-01T00:00:03.000Z' });
    expect(outbox).toHaveLength(1);
    expect(JSON.stringify(outbox[0]?.payload)).not.toContain('authorization":"secret');
    const sent = await repository.completeConnectorOutbox(
      outbox[0]?.id ?? '', outbox[0]?.claimToken ?? '', '2026-01-01T00:00:04.000Z',
    );
    expect(sent).toBe(true);
    expect((await repository.getConnectorQueueStats('feishu')).outbox.sent).toBe(1);
  });

  it('rejects outbox links to a different inbox even within the same tenant', async () => {
    const repository = createRepository();
    const first = await repository.enqueueConnectorInbox({
      tenantId: 'tenant-a', connector: 'test', eventId: 'event-link-1', payload: {},
      receivedAt: '2026-01-01T00:00:00.000Z',
    });
    const second = await repository.enqueueConnectorInbox({
      tenantId: 'tenant-a', connector: 'test', eventId: 'event-link-2', payload: {},
      receivedAt: '2026-01-01T00:00:00.000Z',
    });
    const claimed = (await repository.claimConnectorInbox({ now: '2026-01-01T00:00:01.000Z' }))
      .find((record) => record.id === first.id);
    await expect(repository.completeConnectorInbox({
      id: first.id,
      claimToken: claimed?.claimToken ?? 'missing-claim-token',
      outbox: [{
        tenantId: 'tenant-a', connector: 'test', dedupeKey: 'link-conflict', destination: 'sink',
        payload: {}, sourceInboxId: second.id,
      }],
    })).rejects.toThrow(/source inbox/i);
  });

  it('reclaims expired leases and dead-letters after max attempts', async () => {
    const repository = createRepository();
    const queued = await repository.enqueueConnectorInbox({
      tenantId: 'tenant-a', connector: 'test', eventId: 'event-3', payload: { text: 'x' },
      receivedAt: '2026-01-01T00:00:00.000Z',
    });
    const [first] = await repository.claimConnectorInbox({ now: '2026-01-01T00:00:01.000Z', leaseMs: 1_000 });
    expect(first?.attempts).toBe(1);
    const [reclaimed] = await repository.claimConnectorInbox({ now: '2026-01-01T00:00:03.000Z', leaseMs: 1_000 });
    expect(reclaimed?.attempts).toBe(2);
    const failed = await repository.failConnectorInbox({
      id: queued.id,
      claimToken: reclaimed?.claimToken ?? '',
      error: new Error('password=do-not-store'),
      failedAt: '2026-01-01T00:00:04.000Z',
      maxAttempts: 2,
    });
    expect(failed).toMatchObject({ updated: true, status: 'dead_letter', attempts: 2 });
    const stats = await repository.getConnectorQueueStats('test');
    expect(stats.inbox.dead_letter).toBe(1);
  });

  it('does not let an operator retry a live lease across tenants', async () => {
    const repository = createRepository();
    const queued = await repository.enqueueConnectorInbox({
      tenantId: 'tenant-a', connector: 'test', eventId: 'event-live', payload: { text: 'x' },
      receivedAt: '2026-01-01T00:00:00.000Z',
    });
    const [claimed] = await repository.claimConnectorInbox({
      now: '2026-01-01T00:00:01.000Z', leaseMs: 60_000,
    });
    expect(await repository.retryConnectorInbox(queued.id, '2026-01-01T00:00:02.000Z', 'tenant-b')).toBe(false);
    expect(await repository.retryConnectorInbox(queued.id, '2026-01-01T00:00:02.000Z', 'tenant-a')).toBe(false);
    expect(claimed?.status).toBe('processing');
    expect(await repository.cancelConnectorInbox(queued.id, '2026-01-01T00:00:02.000Z', 'tenant-b')).toBe(false);
    expect(await repository.cancelConnectorInbox(queued.id, '2026-01-01T00:00:02.000Z', 'tenant-a')).toBe(false);
    await repository.failConnectorInbox({
      id: queued.id,
      claimToken: claimed?.claimToken ?? '',
      error: 'operator test',
      failedAt: '2026-01-01T00:00:03.000Z',
      maxAttempts: 10,
    });
    expect(await repository.cancelConnectorInbox(queued.id, '2026-01-01T00:00:04.000Z', 'tenant-a')).toBe(true);
  });

  it('runs inbox processors and outbox dispatchers with idempotent output', async () => {
    const repository = createRepository();
    await repository.enqueueConnectorInbox({
      tenantId: 'tenant-a', connector: 'test', eventId: 'event-4', payload: { value: 1 },
      receivedAt: '2026-01-01T00:00:00.000Z',
    });
    const dispatched: string[] = [];
    const worker = new ConnectorQueueWorker(repository, {
      processors: {
        test: async (record) => ({ outbox: [{
          tenantId: record.tenantId,
          connector: record.connector,
          dedupeKey: `reply:${record.eventId}`,
          destination: 'sink',
          payload: { ok: true },
        }] }),
      },
      dispatchers: { test: async (record) => { dispatched.push(record.dedupeKey); } },
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    await expect(worker.tick()).resolves.toEqual({ inbox: 1, outbox: 1 });
    await expect(worker.tick()).resolves.toEqual({ inbox: 0, outbox: 0 });
    expect(dispatched).toEqual(['reply:event-4']);
    expect((await repository.getConnectorQueueStats('test')).outbox.sent).toBe(1);
  });

  it('drains an active connector tick before shutdown releases the repository', async () => {
    const repository = createRepository();
    await repository.enqueueConnectorInbox({
      tenantId: 'tenant-a', connector: 'test', eventId: 'event-drain', payload: { value: 1 },
      receivedAt: '2026-01-01T00:00:00.000Z',
    });
    const started = deferred();
    const release = deferred();
    const worker = new ConnectorQueueWorker(repository, {
      processors: {
        test: async () => {
          started.resolve();
          await release.promise;
        },
      },
      now: () => new Date('2026-01-01T00:00:00.000Z'),
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
    await expect(tick).resolves.toEqual({ inbox: 1, outbox: 0 });
    expect((await repository.getConnectorQueueStats('test')).inbox.completed).toBe(1);
  });

  it('rejects invalid caller supplied payload hashes', async () => {
    const repository = createRepository();
    await expect(repository.enqueueConnectorInbox({
      tenantId: 't', connector: 'c', eventId: 'e', payload: { x: 1 }, payloadHash: 'sha256:nope',
    })).rejects.toThrow(/hash/i);
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
