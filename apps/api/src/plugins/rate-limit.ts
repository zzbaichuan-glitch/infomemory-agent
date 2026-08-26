import { createHash } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';

export interface RateLimitOptions {
  maxRequests?: number;
  windowMs?: number;
  maxKeys?: number;
  now?: () => number;
  keyGenerator?: (request: FastifyRequest) => string;
  hook?: 'onRequest' | 'preHandler';
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
      if (entry) this.#entries.delete(key);
      if (!this.#ensureCapacity(now)) {
        const resetAt = this.#nextResetAt(now);
        return {
          allowed: false,
          limit: this.#maxRequests,
          remaining: 0,
          resetAt,
          retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1_000)),
        };
      }
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

  #ensureCapacity(now: number): boolean {
    if (this.#entries.size < this.#maxKeys) return true;
    for (const [key, entry] of this.#entries) {
      if (entry.resetAt <= now) this.#entries.delete(key);
    }
    return this.#entries.size < this.#maxKeys;
  }

  #nextResetAt(now: number): number {
    let nextResetAt = now + this.#windowMs;
    for (const entry of this.#entries.values()) {
      if (entry.resetAt > now && entry.resetAt < nextResetAt) nextResetAt = entry.resetAt;
    }
    return nextResetAt;
  }
}

export function registerRateLimit(
  app: FastifyInstance,
  options: RateLimitOptions = {},
): void {
  const limiter = new InMemoryRateLimiter(options);
  const now = options.now ?? Date.now;
  const keyGenerator = options.keyGenerator ?? defaultRateLimitKey;
  const hook = options.hook ?? 'preHandler';
  app.addHook(hook, async (request, reply) => {
    if (isHealthRoute(request.url)) return;
    const currentTime = now();
    const identityKey = keyGenerator(request);
    const decision = limiter.consume(identityKey, currentTime);
    reply.header('x-ratelimit-limit', String(decision.limit));
    reply.header('x-ratelimit-remaining', String(decision.remaining));
    reply.header('x-ratelimit-reset', String(Math.ceil(decision.resetAt / 1_000)));
    if (!decision.allowed) throw new RateLimitError(decision.retryAfterSeconds);
  });
}

function defaultRateLimitKey(request: FastifyRequest): string {
  // This hook runs after accessContextPlugin for product routes. The context
  // contains either verified JWT claims or trusted development headers, so a
  // rotating token cannot create a new bucket and a shared NAT IP is irrelevant.
  const accessContext = request.accessContext;
  if (accessContext) {
    return `identity:${digestIdentity(`${accessContext.tenantId}\0${accessContext.userId}`)}`;
  }
  return `network:${request.ip}`;
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
