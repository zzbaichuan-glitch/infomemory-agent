import { afterEach, describe, expect, it } from 'vitest';

import { generateAccessToken } from '../src/auth/access-token.js';
import { buildApp } from '../src/app.js';
import { InMemoryRateLimiter } from '../src/plugins/rate-limit.js';

const authSecret = 'test-auth-secret-that-is-at-least-32-bytes';

describe('API rate limiting', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => app?.close());

  it('returns 429 within a fixed window and permits requests after reset', async () => {
    let now = 10_000;
    app = await buildApp({
      rateLimit: {
        maxRequests: 2,
        windowMs: 1_000,
        now: () => now,
        keyGenerator: () => 'test-client',
      },
    });
    const request = () => app!.inject({
      method: 'GET',
      url: '/v1/assets',
      headers: {
        'x-tenant-id': 'tenant-a',
        'x-user-id': 'alice',
      },
    });

    expect((await request()).statusCode).toBe(200);
    expect((await request()).statusCode).toBe(200);
    const limited = await request();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('1');
    expect(limited.json()).toEqual({
      error: 'rate_limit_exceeded',
      message: 'Too many requests; retry later',
      requestId: expect.any(String),
    });

    now = 11_000;
    expect((await request()).statusCode).toBe(200);
  });

  it('uses stable verified identity so rotating bearer tokens cannot bypass the limit', async () => {
    app = await buildApp({
      authentication: {
        mode: 'bearer',
        secret: authSecret,
        issuer: 'https://auth.infomemory.test',
        audience: 'infomemory-api',
        now: () => 1_800_000_100,
      },
      rateLimit: {
        maxRequests: 1,
        windowMs: 60_000,
        now: () => 10_000,
      },
    });
    const token = (jti: string) => generateAccessToken({
      secret: authSecret,
      issuer: 'https://auth.infomemory.test',
      audience: 'infomemory-api',
      tenantId: 'tenant-a',
      userId: 'alice',
      roles: ['member'],
      jti,
      issuedAt: 1_800_000_000,
      expiresAt: 1_800_000_300,
    });
    const request = (accessToken: string) => app!.inject({
      method: 'GET',
      url: '/v1/assets',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect((await request(token('token-a'))).statusCode).toBe(200);
    expect((await request(token('token-b'))).statusCode).toBe(429);
  });

  it('does not make separate authenticated users behind one NAT share a bucket', async () => {
    app = await buildApp({
      authentication: {
        mode: 'bearer',
        secret: authSecret,
        issuer: 'https://auth.infomemory.test',
        audience: 'infomemory-api',
        now: () => 1_800_000_100,
      },
      rateLimit: { maxRequests: 1, windowMs: 60_000, now: () => 10_000 },
    });
    const tokenFor = (userId: string) => generateAccessToken({
      secret: authSecret,
      issuer: 'https://auth.infomemory.test',
      audience: 'infomemory-api',
      tenantId: 'tenant-a',
      userId,
      roles: ['member'],
      issuedAt: 1_800_000_000,
      expiresAt: 1_800_000_300,
    });
    const request = (userId: string) => app!.inject({
      method: 'GET',
      url: '/v1/assets',
      headers: { authorization: `Bearer ${tokenFor(userId)}` },
    });

    expect((await request('alice')).statusCode).toBe(200);
    expect((await request('bob')).statusCode).toBe(200);
    expect((await request('alice')).statusCode).toBe(429);
  });

  it('does not evict active keys when the key capacity is full', () => {
    const limiter = new InMemoryRateLimiter({ maxRequests: 1, windowMs: 1_000, maxKeys: 2 });

    expect(limiter.consume('alice', 10_000).allowed).toBe(true);
    expect(limiter.consume('bob', 10_000).allowed).toBe(true);
    const blocked = limiter.consume('attacker', 10_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(1);
    expect(limiter.consume('alice', 10_000).allowed).toBe(false);
    expect(limiter.consume('bob', 10_000).allowed).toBe(false);
  });

  it('keeps a network bucket for unauthenticated Feishu callbacks', async () => {
    app = await buildApp({
      feishuVerificationToken: 'verification-token',
      rateLimit: { maxRequests: 1, windowMs: 60_000, now: () => 10_000 },
    });
    const request = () => app!.inject({
      method: 'POST',
      url: '/v1/connectors/feishu/events',
      payload: {
        type: 'url_verification',
        token: 'verification-token',
        challenge: 'challenge',
      },
    });

    expect((await request()).statusCode).toBe(200);
    expect((await request()).statusCode).toBe(429);
  });
});
