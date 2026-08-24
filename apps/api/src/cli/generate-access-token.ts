import { config as loadEnvironment } from 'dotenv';

import { generateAccessToken } from '../auth/access-token.js';

loadEnvironment({ path: ['.env.local', '.env'], quiet: true });

try {
  const argumentsMap = parseArguments(process.argv.slice(2));
  const tenantId = required(argumentsMap, 'tenant');
  const userId = required(argumentsMap, 'user');
  const roles = (argumentsMap.get('roles') ?? 'member')
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
  if (roles.length === 0) throw new Error('--roles must contain at least one role');
  const expiresInSeconds = parseDuration(argumentsMap.get('expires-in') ?? '8h');
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET must be set in the environment or .env.local');

  const token = generateAccessToken({
    secret,
    issuer: process.env.AUTH_ISSUER?.trim() || 'infomemory-agent',
    audience: process.env.AUTH_AUDIENCE?.trim() || 'infomemory-api',
    tenantId,
    userId,
    roles,
    expiresInSeconds,
  });

  process.stdout.write(`${token}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : 'Token generation failed';
  process.stderr.write(`Unable to generate access token: ${message}\n`);
  process.stderr.write(
    'Usage: npm run token -- --tenant <tenant> --user <user> '
      + '[--roles member,asset:share_tenant] [--expires-in 8h]\n',
  );
  process.exitCode = 1;
}

function parseArguments(values: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid argument near ${name ?? '<end>'}`);
    }
    const key = name.slice(2);
    if (!['tenant', 'user', 'roles', 'expires-in'].includes(key) || parsed.has(key)) {
      throw new Error(`Unknown or repeated argument: ${name}`);
    }
    parsed.set(key, value);
  }
  return parsed;
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key)?.trim();
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function parseDuration(value: string): number {
  const match = /^(\d+)(m|h|d)$/u.exec(value.trim());
  if (!match?.[1] || !match[2]) {
    throw new Error('--expires-in must use a value such as 30m, 8h, or 7d');
  }
  const amount = Number(match[1]);
  const unitSeconds = match[2] === 'm' ? 60 : match[2] === 'h' ? 3_600 : 86_400;
  const seconds = amount * unitSeconds;
  if (!Number.isSafeInteger(seconds) || seconds < 300 || seconds > 30 * 86_400) {
    throw new Error('--expires-in must be between 5 minutes and 30 days');
  }
  return seconds;
}
