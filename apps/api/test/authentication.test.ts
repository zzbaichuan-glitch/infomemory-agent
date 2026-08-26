import { createHmac } from 'node:crypto';

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  generateAccessToken,
  verifyAccessToken,
} from '../src/auth/access-token.js';
import { buildApp } from '../src/app.js';
import { registerErrorHandling } from '../src/http/error-handling.js';
import {
  accessContextPlugin,
  requirePermission,
} from '../src/plugins/access-context.js';

const secret = 'test-auth-secret-that-is-at-least-32-bytes';

describe('HS256 access tokens', () => {
  it('generates and verifies the complete access principal', () => {
    const token = generateAccessToken({
      secret,
      issuer: 'https://auth.infomemory.test',
      audience: 'infomemory-api',
      tenantId: 'tenant-a',
      userId: 'alice',
      roles: ['member', 'knowledge_admin'],
      jti: 'token-1',
      issuedAt: 1_800_000_000,
      expiresAt: 1_800_000_300,
    });

    expect(verifyAccessToken(token, {
      secret,
      issuer: 'https://auth.infomemory.test',
      audience: 'infomemory-api',
      now: () => 1_800_000_100,
    })).toEqual({
      tenantId: 'tenant-a',
      userId: 'alice',
      roles: ['member', 'knowledge_admin'],
      tokenId: 'token-1',
      issuedAt: 1_800_000_000,
      expiresAt: 1_800_000_300,
    });
  });

  it('derives the API access context from a bearer token', async () => {
    const app = await buildApp({
      authentication: {
        mode: 'bearer',
        secret,
        issuer: 'https://auth.infomemory.test',
        audience: 'infomemory-api',
        now: () => 1_800_000_100,
      },
    });
    const token = generateAccessToken({
      secret,
      issuer: 'https://auth.infomemory.test',
      audience: 'infomemory-api',
      tenantId: 'tenant-a',
      userId: 'alice',
      roles: ['member'],
      issuedAt: 1_800_000_000,
      expiresAt: 1_800_000_300,
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/assets',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ assets: [] });
    } finally {
      await app.close();
    }
  });

  it('fails closed when trusted headers are selected for production', async () => {
    await expect(buildApp({ nodeEnv: 'production' })).rejects.toThrow(
      'trusted_headers authentication is forbidden in production',
    );
  });

  it('fails at startup when bearer verification settings are unsafe', async () => {
    await expect(buildApp({
      authentication: {
        mode: 'bearer',
        secret: 'too-short',
        issuer: 'https://auth.infomemory.test',
        audience: 'infomemory-api',
      },
    })).rejects.toThrow('32 to 4096 bytes');
    await expect(buildApp({
      authentication: {
        mode: 'bearer',
        secret: ' '.repeat(64),
        issuer: 'https://auth.infomemory.test',
        audience: 'infomemory-api',
      },
    })).rejects.toThrow('32 to 4096 bytes');
  });

  it('returns a stable 401 response when a bearer token is missing', async () => {
    const app = await buildApp({
      authentication: {
        mode: 'bearer',
        secret,
        issuer: 'https://auth.infomemory.test',
        audience: 'infomemory-api',
      },
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/assets' });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: 'authentication_required',
        message: 'A bearer access token is required',
        requestId: expect.any(String),
      });
    } finally {
      await app.close();
    }
  });

  it('rejects algorithm substitution, tampering, expiry, and issuer mismatch', () => {
    const valid = generateAccessToken({
      secret,
      issuer: 'https://auth.infomemory.test',
      audience: 'infomemory-api',
      tenantId: 'tenant-a',
      userId: 'alice',
      roles: ['member'],
      issuedAt: 1_800_000_000,
      expiresAt: 1_800_000_300,
    });
    const claims = {
      iss: 'https://auth.infomemory.test',
      aud: 'infomemory-api',
      iat: 1_800_000_000,
      exp: 1_800_000_300,
      tenant: 'tenant-a',
      sub: 'alice',
      roles: ['member'],
      jti: 'token-1',
    };
    const substitutedAlgorithm = signRawToken({ alg: 'HS512', typ: 'JWT' }, claims);
    const [header, payload, signature] = valid.split('.') as [string, string, string];
    const tampered = `${header}.${payload}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
    const verification = {
      secret,
      issuer: 'https://auth.infomemory.test',
      audience: 'infomemory-api',
      now: () => 1_800_000_100,
    };

    expect(() => verifyAccessToken(substitutedAlgorithm, verification)).toThrow('invalid');
    expect(() => verifyAccessToken(tampered, verification)).toThrow('invalid');
    expect(() => verifyAccessToken(valid, { ...verification, now: () => 1_800_000_300 }))
      .toThrow('expired');
    expect(() => verifyAccessToken(valid, { ...verification, issuer: 'https://evil.test' }))
      .toThrow('invalid');
  });

  it('enforces reusable permissions while allowing granting roles and admin', async () => {
    const app = Fastify({ logger: false });
    registerErrorHandling(app);
    await app.register(async (secured) => {
      await accessContextPlugin(secured, {
        mode: 'bearer',
        secret,
        issuer: 'https://auth.infomemory.test',
        audience: 'infomemory-api',
        now: () => 1_800_000_100,
      });
      secured.get('/protected', async (request) => {
        requirePermission(request, 'asset:share_tenant', 'knowledge_manager');
        return { allowed: true };
      });
    });
    const requestAs = (roles: string[]) => app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${generateAccessToken({
        secret,
        issuer: 'https://auth.infomemory.test',
        audience: 'infomemory-api',
        tenantId: 'tenant-a',
        userId: 'alice',
        roles,
        issuedAt: 1_800_000_000,
        expiresAt: 1_800_000_300,
      })}` },
    });

    try {
      const denied = await requestAs(['member']);
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({
        error: 'authorization_forbidden',
        requestId: expect.any(String),
      });
      expect((await requestAs(['knowledge_manager'])).statusCode).toBe(200);
      expect((await requestAs(['admin'])).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('requires a tenant-share permission on the real asset ingestion route', async () => {
    const app = await buildApp({
      authentication: {
        mode: 'bearer',
        secret,
        issuer: 'https://auth.infomemory.test',
        audience: 'infomemory-api',
        now: () => 1_800_000_100,
      },
    });
    const tokenFor = (roles: string[]) => generateAccessToken({
      secret,
      issuer: 'https://auth.infomemory.test',
      audience: 'infomemory-api',
      tenantId: 'tenant-a',
      userId: 'alice',
      roles,
      issuedAt: 1_800_000_000,
      expiresAt: 1_800_000_300,
    });
    const createAs = (roles: string[], key: string) => app.inject({
      method: 'POST',
      url: '/v1/assets',
      headers: {
        authorization: `Bearer ${tokenFor(roles)}`,
        'idempotency-key': key,
      },
      payload: {
        title: '租户共享资料',
        content: '只有获授权角色可以发布。',
        visibility: 'tenant',
      },
    });

    try {
      const denied = await createAs(['member'], 'member-share');
      const allowed = await createAs(['knowledge_manager'], 'manager-share');

      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ error: 'authorization_forbidden' });
      expect(allowed.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });
});

function signRawToken(header: object, claims: object): string {
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const encodedClaims = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const input = `${encodedHeader}.${encodedClaims}`;
  const signature = createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${signature}`;
}
