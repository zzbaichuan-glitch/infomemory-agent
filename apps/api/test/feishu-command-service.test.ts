import { describe, expect, it, vi } from 'vitest';

import {
  FeishuCommandService,
  parseFeishuCommand,
} from '../src/feishu/feishu-command-service.js';

const context = { tenantId: 'tenant-a', userId: 'alice' };

describe('FeishuCommandService', () => {
  it('parses Chinese, slash, English, and mention-prefixed commands', () => {
    expect(parseFeishuCommand('帮助')).toEqual({ type: 'help' });
    expect(parseFeishuCommand('/search deployment')).toEqual({
      type: 'search',
      query: 'deployment',
    });
    expect(parseFeishuCommand('@_user_1 知澜 问 数据库由谁维护')).toEqual({
      type: 'answer',
      query: '数据库由谁维护',
    });
    expect(parseFeishuCommand('这是一条需要保存的普通消息')).toBeNull();
  });

  it('formats permission-scoped search evidence', async () => {
    const search = vi.fn().mockResolvedValue({
      mode: 'keyword',
      query: '数据库',
      evidence: [{
        citationId: 'asset:1',
        assetId: '1',
        title: '数据库配置',
        snippet: '生产数据库由平台组维护。',
        score: 10,
        sources: [{ type: 'feishu_document', url: 'https://example.feishu.cn/docx/1' }],
        createdAt: '2026-08-23T00:00:00.000Z',
      }],
    });
    const service = new FeishuCommandService(
      { search },
      { answer: vi.fn() },
    );

    const result = await service.execute(context, '搜索 数据库');

    expect(search).toHaveBeenCalledWith(context, { query: '数据库', limit: 5 });
    expect(result).toContain('[S1] 数据库配置');
    expect(result).toContain('https://example.feishu.cn/docx/1');
  });

  it('renders grounded answers and makes degradation explicit', async () => {
    const answer = vi.fn().mockResolvedValue({
      status: 'evidence_only',
      answer: '已找到 1 条相关来源（[S1]），请打开来源核验。',
      degradedReason: 'llm_disabled',
      evidence: [{
        citationId: 'asset:1',
        assetId: '1',
        title: '平台组说明',
        snippet: '平台组负责维护。',
        score: 10,
        sources: [],
        createdAt: '2026-08-23T00:00:00.000Z',
      }],
    });
    const service = new FeishuCommandService(
      { search: vi.fn() },
      { answer },
    );

    const result = await service.execute(context, '问 谁负责维护');

    expect(result).toContain('来源：');
    expect(result).toContain('安全降级模式：llm_disabled');
  });
});
