import { z } from 'zod';

import type { Reminder } from '@infomemory/core';

export type FeishuFetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface FeishuMessenger {
  sendText(receiveId: string, text: string): Promise<{ messageId: string }>;
}

export interface FeishuClientOptions {
  baseUrl: string;
  appId: string;
  appSecret: string;
  timeoutMs?: number;
  fetch?: FeishuFetchLike;
  now?: () => number;
}

export class FeishuApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeishuApiError';
  }
}

interface TokenState {
  value: string;
  expiresAt: number;
}

const tokenResponseSchema = z.object({
  code: z.number(),
  tenant_access_token: z.string().trim().min(1).optional(),
  expire: z.number().int().positive().optional(),
});

const messageResponseSchema = z.object({
  code: z.number(),
  data: z.object({ message_id: z.string().trim().min(1).optional() }).optional(),
});

export class FeishuClient implements FeishuMessenger {
  readonly #baseUrl: string;
  readonly #appId: string;
  readonly #appSecret: string;
  readonly #timeoutMs: number;
  readonly #fetch: FeishuFetchLike;
  readonly #now: () => number;
  #token: TokenState | undefined;

  constructor(options: FeishuClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#appId = requireValue(options.appId, 'Feishu app ID');
    this.#appSecret = requireValue(options.appSecret, 'Feishu app secret');
    this.#timeoutMs = Math.max(1_000, options.timeoutMs ?? 10_000);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? (() => Date.now());
  }

  async sendText(receiveId: string, text: string): Promise<{ messageId: string }> {
    const safeReceiveId = requireValue(receiveId, 'Feishu receive ID');
    const safeText = z.string().trim().min(1).max(10_000).parse(text);
    const token = await this.#getTenantAccessToken();
    const payload = await this.#requestJson(
      `${this.#baseUrl}/open-apis/im/v1/messages?receive_id_type=open_id`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          receive_id: safeReceiveId,
          msg_type: 'text',
          content: JSON.stringify({ text: safeText }),
        }),
      },
    );
    const parsed = messageResponseSchema.safeParse(payload);
    if (!parsed.success || parsed.data.code !== 0 || !parsed.data.data?.message_id) {
      throw new FeishuApiError('Feishu send message returned an invalid response');
    }
    return { messageId: parsed.data.data.message_id };
  }

  async #getTenantAccessToken(): Promise<string> {
    const now = this.#now();
    if (this.#token && this.#token.expiresAt > now + 60_000) return this.#token.value;
    const payload = await this.#requestJson(
      `${this.#baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: this.#appId, app_secret: this.#appSecret }),
      },
    );
    const parsed = tokenResponseSchema.safeParse(payload);
    if (!parsed.success || parsed.data.code !== 0 || !parsed.data.tenant_access_token) {
      throw new FeishuApiError('Feishu token request returned an invalid response');
    }
    const expiresIn = parsed.data.expire ?? 7_200;
    this.#token = {
      value: parsed.data.tenant_access_token,
      expiresAt: now + expiresIn * 1_000,
    };
    return this.#token.value;
  }

  async #requestJson(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, {
        ...init,
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw new FeishuApiError(`Feishu API returned HTTP ${response.status}`);
      try {
        return await response.json();
      } catch {
        throw new FeishuApiError('Feishu API returned an invalid response');
      }
    } catch (error) {
      if (controller.signal.aborted) throw new FeishuApiError('Feishu API request timed out');
      if (error instanceof FeishuApiError) throw error;
      throw new FeishuApiError('Feishu API request failed');
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function formatReminderNotification(
  reminder: Reminder,
  timeZone = 'Asia/Shanghai',
): string {
  const startsAt = new Date(reminder.startsAt);
  const formatted = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(startsAt);
  if (reminder.precision === 'exact' && reminder.status === 'scheduled') {
    return `知澜提醒：${reminder.title}\n会议时间：${formatted}\n请提前准备。`;
  }
  return `知澜提醒：我从群消息中发现可能的会议安排。\n候选时间：${formatted}\n请确认后我再按这个时间提醒你。`;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FeishuApiError('Feishu API base URL is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new FeishuApiError('Feishu API base URL must use HTTP or HTTPS');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function requireValue(value: string, label: string): string {
  if (!value.trim()) throw new FeishuApiError(`${label} is required`);
  return value.trim();
}
