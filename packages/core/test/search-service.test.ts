import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteAssetRepository } from '../src/repositories/sqlite-asset-repository.js';
import { AssetService } from '../src/services/asset-service.js';
import { SearchService } from '../src/services/search-service.js';

const alice = { tenantId: 'tenant-a', userId: 'alice' };

describe('SearchService', () => {
  let repository: SqliteAssetRepository;
  let assets: AssetService;
  let search: SearchService;

  beforeEach(() => {
    repository = new SqliteAssetRepository(':memory:');
    assets = new AssetService(repository);
    search = new SearchService(repository);
  });

  afterEach(() => repository.close());

  it('ranks an exact title phrase above token-only content matches', async () => {
    const exact = await assets.ingest(alice, {
      title: '星海项目数据库配置',
      content: '配置由平台组维护。',
      idempotencyKey: 'exact',
      visibility: 'tenant',
    });
    await assets.ingest(alice, {
      title: '星海项目周报',
      content: '本周讨论了数据库迁移和应用配置。',
      idempotencyKey: 'tokens',
      visibility: 'tenant',
    });

    const result = await search.search(alice, { query: '数据库配置' });

    expect(result.mode).toBe('keyword');
    expect(result.evidence[0]?.assetId).toBe(exact.asset.id);
    expect(result.evidence[0]?.citationId).toBe(`asset:${exact.asset.id}`);
    expect(result.evidence[0]?.snippet).toContain('配置由平台组维护');
  });

  it('inherits tenant and owner visibility from the repository', async () => {
    await assets.ingest(alice, {
      title: '个人部署草稿',
      content: '仅 Alice 可见的部署计划。',
      idempotencyKey: 'private',
      visibility: 'owner',
    });

    const sameTenant = await search.search(
      { tenantId: 'tenant-a', userId: 'bob' },
      { query: '部署' },
    );
    const otherTenant = await search.search(
      { tenantId: 'tenant-b', userId: 'alice' },
      { query: '部署' },
    );

    expect(sameTenant.evidence).toEqual([]);
    expect(otherTenant.evidence).toEqual([]);
  });

  it('enforces the result limit and creates source-aware snippets', async () => {
    for (let index = 0; index < 3; index += 1) {
      await assets.ingest(alice, {
        title: `项目风险 ${index}`,
        content: `这是第 ${index} 条项目风险记录，需要负责人确认。`,
        idempotencyKey: `risk-${index}`,
        visibility: 'tenant',
        source: {
          type: 'feishu_message',
          externalId: `message-${index}`,
          url: `https://example.feishu.cn/message/${index}`,
        },
      });
    }

    const result = await search.search(alice, { query: '项目风险', limit: 2 });

    expect(result.evidence).toHaveLength(2);
    expect(result.evidence[0]?.sources[0]?.type).toBe('feishu_message');
    expect(result.evidence[0]?.snippet.length).toBeLessThanOrEqual(180);
  });

  it('rejects empty queries', async () => {
    await expect(search.search(alice, { query: '   ' })).rejects.toThrow('query');
  });

  it('redacts secrets from the returned search query', async () => {
    const result = await search.search(alice, {
      query: '部署 password=synthetic-search-secret',
    });

    expect(result.query).toBe('部署 password=[REDACTED:password]');
    expect(result.query).not.toContain('synthetic-search-secret');
  });

  it('supports a single-character Chinese query without a full-table scan', async () => {
    await assets.ingest(alice, {
      title: '会议安排',
      content: '明天开会，请项目负责人参加。',
      idempotencyKey: 'single-character-query',
      visibility: 'tenant',
    });

    const result = await search.search(alice, { query: '会' });

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.title).toBe('会议安排');
  });

  it('finds an older matching asset after more than 500 newer assets exist', async () => {
    const oldest = await assets.ingest(alice, {
      title: '远古唯一关键词档案',
      content: '这条证据必须通过 FTS5 从完整授权集合中找到。',
      idempotencyKey: 'oldest-searchable',
      visibility: 'tenant',
    });
    for (let index = 0; index < 501; index += 1) {
      await assets.ingest(alice, {
        title: `普通资料 ${index}`,
        content: `这是无关的普通记录 ${index}。`,
        idempotencyKey: `newer-${index}`,
        visibility: 'tenant',
      });
    }

    const result = await search.search(alice, { query: '远古唯一关键词' });

    expect(result.evidence[0]?.assetId).toBe(oldest.asset.id);
    expect(result.evidence.some((item) => item.assetId === oldest.asset.id)).toBe(true);
  });
});
