import { createHash } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';

export interface RateLimitOptions {
  maxRequests?: number;
  windowMs?: number;
  maxKeys?: number;
  now?: () => number;
  keyGenerator?: (request: FastifyRequest) => string;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export class RateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Too many requests');
    this.name = 'RateLimitError';
  }
}

export class InMemoryRateLimiter {
  readonly #maxRequests: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #entries = new Map<string, RateLimitEntry>();

  constructor(options: RateLimitOptions = {}) {
    this.#maxRequests = positiveInteger(options.maxRequests, 120, 'maxRequests');
    this.#windowMs = positiveInteger(options.windowMs, 60_000, 'windowMs');
    this.#maxKeys = positiveInteger(options.maxKeys, 10_000, 'maxKeys');
  }

  consume(key: string, now: number): RateLimitDecision {
    if (!key || !Number.isFinite(now) || now < 0) {
      throw new RangeError('Rate limit key and time must be valid');
    }
    let entry = this.#entries.get(key);
    if (!entry || entry.resetAt <= now) {
      this.#ensureCapacity(now);
      entry = { count: 0, resetAt: now + this.#windowMs };
      this.#entries.set(key, entry);
    }
    entry.count += 1;
    const remaining = Math.max(0, this.#maxRequests - entry.count);
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1_000));
    return {
      allowed: entry.count <= this.#maxRequests,
      limit: this.#maxRequests,
      remaining,
      resetAt: entry.resetAt,
      retryAfterSeconds,
    };
  }

  #ensureCapacity(now: number): void {
    if (this.#entries.size < this.#maxKeys) return;
    for (const [key, entry] of this.#entries) {
      if (entry.resetAt <= now) this.#entries.delete(key);
    }
    if (this.#entries.size < this.#maxKeys) return;
    const oldestKey = this.#entries.keys().next().value as string | undefined;
    if (oldestKey !== undefined) this.#entries.delete(oldestKey);
  }
}

export function registerRateLimit(
  app: FastifyInstance,
  options: RateLimitOptions = {},
): void {
  const limiter = new InMemoryRateLimiter(options);
  const now = options.now ?? Date.now;
  const keyGenerator = options.keyGenerator ?? defaultRateLimitKey;
  app.addHook('onRequest', async (request, reply) => {
    if (isHealthRoute(request.url)) return;
    const currentTime = now();
    const networkKey = `network:${request.ip}`;
    const networkDecision = limiter.consume(networkKey, currentTime);
    const identityKey = keyGenerator(request);
    const identityDecision = identityKey === networkKey
      ? networkDecision
      : limiter.consume(identityKey, currentTime);
    const decision = combineDecisions(networkDecision, identityDecision);
    reply.header('x-ratelimit-limit', String(decision.limit));
    reply.header('x-ratelimit-remaining', String(decision.remaining));
    reply.header('x-ratelimit-reset', String(Math.ceil(decision.resetAt / 1_000)));
    if (!decision.allowed) throw new RateLimitError(decision.retryAfterSeconds);
  });
}

function defaultRateLimitKey(request: FastifyRequest): string {
  const authorization = singleHeader(request, 'authorization', 20_000);
  const bearer = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if (bearer) return `bearer:${digestIdentity(bearer)}`;

  const tenantId = singleHeader(request, 'x-tenant-id', 200);
  const userId = singleHeader(request, 'x-user-id', 200);
  if (tenantId && userId) return `trusted:${digestIdentity(`${tenantId}\0${userId}`)}`;
  return `network:${request.ip}`;
}

function combineDecisions(
  network: RateLimitDecision,
  identity: RateLimitDecision,
): RateLimitDecision {
  return {
    allowed: network.allowed && identity.allowed,
    limit: Math.min(network.limit, identity.limit),
    remaining: Math.min(network.remaining, identity.remaining),
    resetAt: Math.max(network.resetAt, identity.resetAt),
    retryAfterSeconds: Math.max(network.retryAfterSeconds, identity.retryAfterSeconds),
  };
}

function singleHeader(
  request: FastifyRequest,
  name: string,
  maximumLength: number,
): string | null {
  const value = request.headers[name];
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximumLength ? normalized : null;
}

function digestIdentity(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function isHealthRoute(url: string): boolean {
  const pathname = url.split('?', 1)[0];
  return pathname === '/health' || pathname === '/health/live' || pathname === '/health/ready';
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return selected;
}
