import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LlmAnswerGenerator } from '../src/llm/llm-answer-generator.js';
import { SqliteAssetRepository } from '../src/repositories/sqlite-asset-repository.js';
import { AnswerService } from '../src/services/answer-service.js';
import { AssetService } from '../src/services/asset-service.js';
import { SearchService } from '../src/services/search-service.js';

const alice = { tenantId: 'tenant-a', userId: 'alice' };

describe('AnswerService', () => {
  let repository: SqliteAssetRepository;
  let assets: AssetService;
  let search: SearchService;

  beforeEach(() => {
    repository = new SqliteAssetRepository(':memory:');
    assets = new AssetService(repository);
    search = new SearchService(repository);
  });

  afterEach(() => repository.close());

  it('refuses to invent an answer when there is no evidence', async () => {
    const service = new AnswerService(search);

    const result = await service.answer(alice, { query: '不存在的客户问题' });

    expect(result.status).toBe('no_evidence');
    expect(result.answer).toContain('未找到');
    expect(result.evidence).toEqual([]);
  });

  it('returns evidence-only output when the LLM is disabled', async () => {
    await seedEvidence();
    const service = new AnswerService(search);

    const result = await service.answer(alice, { query: '数据库配置由谁维护' });

    expect(result.status).toBe('evidence_only');
    expect(result.degradedReason).toBe('llm_disabled');
    expect(result.evidence).toHaveLength(1);
    expect(result.answer).toContain('来源');
  });

  it('accepts a generated answer only when it cites retrieved evidence', async () => {
    await seedEvidence();
    const generator: LlmAnswerGenerator = {
      generate: vi.fn().mockResolvedValue('平台组负责维护数据库配置。[S1]'),
    };
    const service = new AnswerService(search, generator);

    const result = await service.answer(alice, { query: '数据库配置由谁维护' });

    expect(result.status).toBe('answered');
    expect(result.answer).toContain('[S1]');
    expect(generator.generate).toHaveBeenCalledOnce();
  });

  it('degrades safely when generation fails or omits citations', async () => {
    await seedEvidence();
    const failing = new AnswerService(search, {
      generate: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    });
    const uncited = new AnswerService(search, {
      generate: vi.fn().mockResolvedValue('平台组负责维护。'),
    });

    const failedResult = await failing.answer(alice, { query: '数据库配置' });
    const uncitedResult = await uncited.answer(alice, { query: '数据库配置' });

    expect(failedResult).toMatchObject({
      status: 'evidence_only',
      degradedReason: 'llm_error',
    });
    expect(uncitedResult).toMatchObject({
      status: 'evidence_only',
      degradedReason: 'missing_citations',
    });
  });

  it('rejects answers with uncited claims or references outside the evidence set', async () => {
    await seedEvidence();
    const partiallyCited = new AnswerService(search, {
      generate: vi.fn().mockResolvedValue('平台组负责维护。[S1]\n密码已经完成轮换。'),
    });
    const invalidReference = new AnswerService(search, {
      generate: vi.fn().mockResolvedValue('平台组负责维护。[S2]'),
    });

    await expect(partiallyCited.answer(alice, { query: '数据库配置' }))
      .resolves.toMatchObject({
        status: 'evidence_only',
        degradedReason: 'missing_citations',
      });
    await expect(invalidReference.answer(alice, { query: '数据库配置' }))
      .resolves.toMatchObject({
        status: 'evidence_only',
        degradedReason: 'missing_citations',
      });
  });

  it('never sends secrets from a user query to the LLM generator', async () => {
    await assets.ingest(alice, {
      title: '数据库密码轮换说明',
      content: '数据库密码由平台组负责轮换。',
      idempotencyKey: 'password-rotation',
      visibility: 'tenant',
    });
    const generate = vi.fn().mockResolvedValue('平台组负责轮换。[S1]');
    const service = new AnswerService(search, { generate });

    await service.answer(alice, {
      query: '数据库密码 password=synthetic-query-secret 由谁轮换',
    });

    expect(generate).toHaveBeenCalledOnce();
    const input = generate.mock.calls[0]?.[0] as { query: string };
    expect(input.query).not.toContain('synthetic-query-secret');
    expect(input.query).toContain('[REDACTED:password]');
  });

  async function seedEvidence(): Promise<void> {
    await assets.ingest(alice, {
      title: '数据库配置说明',
      content: '生产数据库配置由平台组维护。',
      idempotencyKey: 'database-config',
      visibility: 'tenant',
    });
  }
});
