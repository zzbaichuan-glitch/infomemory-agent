#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const HELP = `知澜命令行

环境变量：
  INFOMEMORY_API_URL      API 地址，默认 http://127.0.0.1:3000
  INFOMEMORY_TOKEN        production Bearer Token
  INFOMEMORY_TENANT_ID    development trusted_headers 租户
  INFOMEMORY_USER_ID      development trusted_headers 用户

命令：
  health
  ingest --file <path> [--title <title>] [--visibility owner|tenant]
  assets [--limit 20] [--cursor <cursor>] [--visibility owner|tenant]
         [--source-type manual|local_file|feishu_message|feishu_document]
  get <asset-id>
  delete <asset-id>
  search <query>
  ask <query>
  reminders [--status scheduled,needs_confirmation]
  remind --title <title> --starts-at <ISO> [--remind-at <ISO>]
  reminder-status <reminder-id> scheduled|completed|cancelled
`;

const [command = 'help', ...argumentsList] = process.argv.slice(2);

try {
  const result = await run(command.toLowerCase(), argumentsList);
  if (result !== undefined) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown command failure';
  process.stderr.write(`知澜命令失败：${message}\n`);
  process.exitCode = 1;
}

async function run(selectedCommand, values) {
  switch (selectedCommand) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return undefined;
    case 'health':
      return request('/health/ready', { authenticated: false });
    case 'ingest':
      return ingest(values);
    case 'assets':
      return listAssets(values);
    case 'get':
      return request(`/v1/assets/${encodeURIComponent(requiredPositional(values, 0, 'asset-id'))}`);
    case 'delete':
      return request(`/v1/assets/${encodeURIComponent(requiredPositional(values, 0, 'asset-id'))}`, {
        method: 'DELETE',
      });
    case 'search':
      return query('/v1/search', values);
    case 'ask':
      return query('/v1/answers', values);
    case 'reminders':
      return listReminders(values);
    case 'remind':
      return createReminder(values);
    case 'reminder-status':
      return updateReminderStatus(values);
    default:
      throw new Error(`未知命令“${selectedCommand}”。运行 npm run agent -- --help 查看帮助。`);
  }
}

async function ingest(values) {
  const options = parseOptions(values, new Set(['file', 'title', 'visibility']));
  const file = requiredOption(options, 'file');
  const absolutePath = resolve(file);
  const content = await readFile(absolutePath, 'utf8');
  const title = options.get('title')?.trim() || basename(absolutePath);
  const visibility = options.get('visibility') ?? 'owner';
  if (!['owner', 'tenant'].includes(visibility)) {
    throw new Error('--visibility 必须是 owner 或 tenant');
  }
  const idempotencyKey = `cli:${createHash('sha256')
    .update(JSON.stringify({ title, content, visibility }))
    .digest('hex')}`;
  return request('/v1/assets', {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: {
      title,
      content,
      visibility,
      source: {
        type: 'local_file',
        externalId: basename(absolutePath),
      },
    },
  });
}

async function listAssets(values) {
  const options = parseOptions(values, new Set([
    'limit',
    'cursor',
    'visibility',
    'source-type',
  ]));
  const queryParameters = new URLSearchParams();
  copyOption(options, queryParameters, 'limit');
  copyOption(options, queryParameters, 'cursor');
  copyOption(options, queryParameters, 'visibility');
  copyOption(options, queryParameters, 'source-type', 'sourceType');
  return request(`/v1/assets${queryParameters.size ? `?${queryParameters}` : ''}`);
}

async function query(path, values) {
  const text = values.join(' ').trim();
  if (!text) throw new Error('查询内容不能为空');
  return request(path, { method: 'POST', body: { query: text } });
}

async function listReminders(values) {
  const options = parseOptions(values, new Set(['status', 'limit']));
  const queryParameters = new URLSearchParams();
  copyOption(options, queryParameters, 'status');
  copyOption(options, queryParameters, 'limit');
  return request(`/v1/reminders${queryParameters.size ? `?${queryParameters}` : ''}`);
}

async function createReminder(values) {
  const options = parseOptions(values, new Set(['title', 'starts-at', 'remind-at']));
  const body = {
    title: requiredOption(options, 'title'),
    startsAt: requiredOption(options, 'starts-at'),
  };
  const remindAt = options.get('remind-at');
  if (remindAt) body.remindAt = remindAt;
  return request('/v1/reminders', { method: 'POST', body });
}

async function updateReminderStatus(values) {
  const id = requiredPositional(values, 0, 'reminder-id');
  const status = requiredPositional(values, 1, 'status');
  return request(`/v1/reminders/${encodeURIComponent(id)}/status`, {
    method: 'POST',
    body: { status },
  });
}

async function request(path, options = {}) {
  const baseUrl = new URL(process.env.INFOMEMORY_API_URL ?? 'http://127.0.0.1:3000');
  const url = new URL(path, ensureTrailingSlash(baseUrl));
  const headers = new Headers(options.headers);
  headers.set('accept', 'application/json');
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.authenticated !== false) addAuthentication(headers);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      redirect: 'error',
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = text ? safeJson(text) : { ok: response.ok };
    if (!response.ok) {
      const code = payload && typeof payload === 'object' && 'error' in payload
        ? String(payload.error)
        : `http_${response.status}`;
      const message = payload && typeof payload === 'object' && 'message' in payload
        ? String(payload.message)
        : response.statusText;
      throw new Error(`${code}: ${message}`);
    }
    return payload;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('请求超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function addAuthentication(headers) {
  const token = process.env.INFOMEMORY_TOKEN?.trim();
  if (token) {
    headers.set('authorization', `Bearer ${token}`);
    return;
  }
  const tenantId = process.env.INFOMEMORY_TENANT_ID?.trim();
  const userId = process.env.INFOMEMORY_USER_ID?.trim();
  if (!tenantId || !userId) {
    throw new Error(
      '请设置 INFOMEMORY_TOKEN，或在开发模式设置 INFOMEMORY_TENANT_ID 和 INFOMEMORY_USER_ID',
    );
  }
  headers.set('x-tenant-id', tenantId);
  headers.set('x-user-id', userId);
}

function parseOptions(values, allowed) {
  const options = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`参数格式错误：${name ?? '<end>'}`);
    }
    const key = name.slice(2);
    if (!allowed.has(key) || options.has(key)) throw new Error(`未知或重复参数：${name}`);
    options.set(key, value);
  }
  return options;
}

function requiredOption(options, name) {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`--${name} 为必填参数`);
  return value;
}

function requiredPositional(values, index, label) {
  const value = values[index]?.trim();
  if (!value) throw new Error(`${label} 为必填参数`);
  return value;
}

function copyOption(options, target, optionName, parameterName = optionName) {
  const value = options.get(optionName);
  if (value) target.set(parameterName, value);
}

function ensureTrailingSlash(url) {
  const normalized = new URL(url);
  if (!normalized.pathname.endsWith('/')) normalized.pathname += '/';
  return normalized;
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('服务返回了非 JSON 响应');
  }
}
