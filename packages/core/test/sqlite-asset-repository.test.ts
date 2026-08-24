import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AssetService } from '../src/services/asset-service.js';
import { SqliteAssetRepository } from '../src/repositories/sqlite-asset-repository.js';

describe('SqliteAssetRepository access boundaries', () => {
  let repository: SqliteAssetRepository;
  let service: AssetService;

  beforeEach(() => {
    repository = new SqliteAssetRepository(':memory:');
    service = new AssetService(repository);
  });

  afterEach(() => repository.close());

  it('never returns assets from another tenant', async () => {
    const asset = await service.ingest({ tenantId: 'tenant-a', userId: 'alice' }, {
      title: 'A 租户文档',
      content: '仅属于 A 租户。',
      idempotencyKey: 'a-1',
      visibility: 'tenant',
    });

    await expect(repository.findById(
      { tenantId: 'tenant-b', userId: 'bob' },
      asset.asset.id,
    )).resolves.toBeNull();
    await expect(repository.list(
      { tenantId: 'tenant-b', userId: 'bob' },
    )).resolves.toEqual([]);
  });

  it('shares tenant-visible assets but isolates owner-visible assets', async () => {
    const tenantAsset = await service.ingest({ tenantId: 'tenant-a', userId: 'alice' }, {
      title: '团队资料',
      content: '团队成员可见。',
      idempotencyKey: 'tenant-asset',
      visibility: 'tenant',
    });
    const privateAsset = await service.ingest({ tenantId: 'tenant-a', userId: 'alice' }, {
      title: '个人草稿',
      content: '仅上传者可见。',
      idempotencyKey: 'private-asset',
      visibility: 'owner',
    });

    const bobAssets = await repository.list({ tenantId: 'tenant-a', userId: 'bob' });

    expect(bobAssets.map((asset) => asset.id)).toContain(tenantAsset.asset.id);
    expect(bobAssets.map((asset) => asset.id)).not.toContain(privateAsset.asset.id);
    await expect(repository.findById(
      { tenantId: 'tenant-a', userId: 'bob' },
      privateAsset.asset.id,
    )).resolves.toBeNull();
  });

  it('requires a scoped access context on every read method', () => {
    expect(repository.list.length).toBeGreaterThanOrEqual(1);
    expect(repository.findById.length).toBeGreaterThanOrEqual(2);
  });

  it('supports filtered cursor pagination, scoped reads, and owner deletion', async () => {
    let counter = 0;
    const pagedService = new AssetService(repository, {
      idFactory: () => `asset-${String(++counter).padStart(2, '0')}`,
      now: () => new Date(Date.UTC(2026, 7, 19, 0, 0, counter)),
    });
    for (let index = 0; index < 5; index += 1) {
      await pagedService.ingest({ tenantId: 'tenant-a', userId: 'alice' }, {
        title: `分页资产 ${index}`,
        content: `第 ${index} 条唯一内容。`,
        idempotencyKey: `page-${index}`,
        visibility: index === 0 ? 'tenant' : 'owner',
        source: index % 2 === 0
          ? { type: 'feishu_document', externalId: `doc-${index}` }
          : { type: 'manual', externalId: `manual-${index}` },
      });
    }

    const firstPage = await pagedService.listPage(
      { tenantId: 'tenant-a', userId: 'alice' },
      { limit: 2 },
    );
    const secondPage = await pagedService.listPage(
      { tenantId: 'tenant-a', userId: 'alice' },
      { limit: 2, cursor: firstPage.nextCursor },
    );
    const offsetPage = await pagedService.listPage(
      { tenantId: 'tenant-a', userId: 'alice' },
      { limit: 2, offset: 2 },
    );
    const documents = await pagedService.listPage(
      { tenantId: 'tenant-a', userId: 'alice' },
      { limit: 10, sourceType: 'feishu_document' },
    );

    expect(firstPage.assets.map((asset) => asset.id)).toEqual(['asset-05', 'asset-04']);
    expect(secondPage.assets.map((asset) => asset.id)).toEqual(['asset-03', 'asset-02']);
    expect(offsetPage.assets.map((asset) => asset.id)).toEqual(['asset-03', 'asset-02']);
    expect(documents.assets).toHaveLength(3);
    await expect(pagedService.getById(
      { tenantId: 'tenant-a', userId: 'bob' },
      'asset-05',
    )).resolves.toBeNull();
    await expect(pagedService.deleteOwned(
      { tenantId: 'tenant-a', userId: 'bob' },
      'asset-05',
    )).resolves.toBe(false);
    await expect(pagedService.deleteOwned(
      { tenantId: 'tenant-a', userId: 'alice' },
      'asset-05',
    )).resolves.toBe(true);
    await expect(pagedService.getById(
      { tenantId: 'tenant-a', userId: 'alice' },
      'asset-05',
    )).resolves.toBeNull();
    const afterDeleteSearch = await repository.search(
      { tenantId: 'tenant-a', userId: 'alice' },
      '分页资产 4',
    );
    expect(afterDeleteSearch.some((hit) => hit.asset.id === 'asset-05')).toBe(false);
  });

  it('claims connector event receipts exactly once per tenant and connector', async () => {
    const input = {
      tenantId: 'tenant-a',
      connector: 'feishu',
      eventId: 'event-1',
      receivedAt: '2026-08-19T00:00:00.000Z',
    };

    await expect(repository.claimConnectorEventReceipt(input)).resolves.toEqual({
      claimed: true,
      receivedAt: input.receivedAt,
    });
    await expect(repository.claimConnectorEventReceipt({
      ...input,
      receivedAt: '2026-08-19T00:01:00.000Z',
    })).resolves.toEqual({
      claimed: false,
      receivedAt: input.receivedAt,
    });
    await expect(repository.claimConnectorEventReceipt({
      ...input,
      tenantId: 'tenant-b',
    })).resolves.toMatchObject({ claimed: true });
    await expect(repository.claimConnectorEventReceipt({
      ...input,
      connector: 'local-folder',
    })).resolves.toMatchObject({ claimed: true });
    await expect(repository.releaseConnectorEventReceipt({
      ...input,
      receivedAt: '2026-08-19T00:01:00.000Z',
    })).resolves.toBe(false);
    await expect(repository.releaseConnectorEventReceipt(input)).resolves.toBe(true);
    await expect(repository.claimConnectorEventReceipt({
      ...input,
      receivedAt: '2026-08-19T00:02:00.000Z',
    })).resolves.toEqual({
      claimed: true,
      receivedAt: '2026-08-19T00:02:00.000Z',
    });
  });
});
