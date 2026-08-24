import type {
  AccessContext,
  AnswerResult,
  AnswerService,
  SearchEvidence,
  SearchResult,
  SearchService,
} from '@infomemory/core';

type FeishuCommand =
  | { type: 'help' }
  | { type: 'search'; query: string }
  | { type: 'answer'; query: string };

export interface FeishuCommandServiceOptions {
  searchLimit?: number;
  maxMessageLength?: number;
}

export class FeishuCommandService {
  readonly #searchLimit: number;
  readonly #maxMessageLength: number;

  constructor(
    private readonly searchService: Pick<SearchService, 'search'>,
    private readonly answerService: Pick<AnswerService, 'answer'>,
    options: FeishuCommandServiceOptions = {},
  ) {
    this.#searchLimit = Math.max(1, Math.min(options.searchLimit ?? 5, 10));
    this.#maxMessageLength = Math.max(500, Math.min(options.maxMessageLength ?? 9_500, 10_000));
  }

  async execute(context: AccessContext, text: string): Promise<string | null> {
    const command = parseFeishuCommand(text);
    if (!command) return null;

    if (command.type === 'help') return HELP_MESSAGE;
    if (command.type === 'search') {
      const result = await this.searchService.search(context, {
        query: command.query,
        limit: this.#searchLimit,
      });
      return this.#limit(formatSearchResult(result));
    }
    const result = await this.answerService.answer(context, {
      query: command.query,
      limit: this.#searchLimit,
    });
    return this.#limit(formatAnswerResult(result));
  }

  #limit(value: string): string {
    if (value.length <= this.#maxMessageLength) return value;
    return `${value.slice(0, this.#maxMessageLength - 18)}\n…结果过长，已截断。`;
  }
}

export function parseFeishuCommand(input: string): FeishuCommand | null {
  const text = input
    .normalize('NFKC')
    .replace(/^@_user_\d+\s*/iu, '')
    .trim();
  if (!text) return null;

  if (/^(?:\/\s*)?(?:知澜\s*)?(?:帮助|help)$/iu.test(text)) {
    return { type: 'help' };
  }

  const match = /^(?:\/\s*|知澜\s+)?(搜索|search|问|ask)\s+([\s\S]+)$/iu.exec(text);
  if (!match) return null;
  const query = match[2]?.trim();
  if (!query) return null;
  return /^(?:搜索|search)$/iu.test(match[1] ?? '')
    ? { type: 'search', query }
    : { type: 'answer', query };
}

const HELP_MESSAGE = [
  '知澜可以帮你保存、检索并核验团队信息：',
  '• 搜索 <关键词>：返回你有权查看的证据',
  '• 问 <问题>：根据证据回答，并附 [S1] 引用',
  '• 帮助：查看这份说明',
  '• 普通消息：安全脱敏后保存；识别到会议时间时创建提醒',
  '',
  '示例：搜索 星海项目数据库配置',
  '示例：问 数据库配置由谁维护',
  '',
  '知澜不会绕过来源权限；证据不足或模型不可用时会返回可核验的来源列表。',
].join('\n');

function formatSearchResult(result: SearchResult): string {
  if (result.evidence.length === 0) {
    return `未找到与“${result.query}”相关的已授权来源。`;
  }
  return [
    `找到 ${result.evidence.length} 条已授权来源：`,
    ...result.evidence.flatMap((evidence, index) => evidenceLines(evidence, index)),
  ].join('\n');
}

function formatAnswerResult(result: AnswerResult): string {
  if (result.evidence.length === 0) return result.answer;
  return [
    result.answer,
    '',
    '来源：',
    ...result.evidence.map((evidence, index) =>
      `[S${index + 1}] ${evidence.title} — ${sourceLocator(evidence)}`),
    ...(result.degradedReason ? ['', `当前为安全降级模式：${result.degradedReason}`] : []),
  ].join('\n');
}

function evidenceLines(evidence: SearchEvidence, index: number): string[] {
  return [
    '',
    `[S${index + 1}] ${evidence.title}`,
    evidence.snippet,
    `来源：${sourceLocator(evidence)}`,
  ];
}

function sourceLocator(evidence: SearchEvidence): string {
  return evidence.sources.find((source) => source.url)?.url ?? evidence.citationId;
}
