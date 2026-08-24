import type { AccessContext } from '@infomemory/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  AccessTokenError,
  type AuthenticatedPrincipal,
  verifyAccessToken,
} from '../auth/access-token.js';

export type AuthenticationOptions = TrustedHeadersAuthenticationOptions
  | BearerAuthenticationOptions;

export interface TrustedHeadersAuthenticationOptions {
  mode: 'trusted_headers';
  environment: 'development' | 'test' | 'production';
}

export interface BearerAuthenticationOptions {
  mode: 'bearer';
  secret: string;
  issuer: string;
  audience: string;
  now?: () => number;
  clockToleranceSeconds?: number;
}

export interface RequestAuthentication {
  mode: AuthenticationOptions['mode'];
  principal: AuthenticatedPrincipal | null;
}

export class AuthenticationError extends Error {
  constructor(
    readonly code: 'access_context_required' | 'authentication_required' | 'authentication_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class AuthenticationConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationConfigurationError';
  }
}

export class AuthorizationError extends Error {
  readonly code = 'authorization_forbidden';

  constructor(message = 'The authenticated principal is not permitted to perform this action') {
    super(message);
    this.name = 'AuthorizationError';
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    accessContext: AccessContext | null;
    authentication: RequestAuthentication | null;
  }
}

export async function accessContextPlugin(
  app: FastifyInstance,
  options: AuthenticationOptions,
): Promise<void> {
  validateAuthenticationOptions(options);
  app.decorateRequest('accessContext', null);
  app.decorateRequest('authentication', null);
  app.addHook('preHandler', async (request) => {
    if (options.mode === 'trusted_headers') {
      const tenantId = singleHeader(request, 'x-tenant-id', 200);
      const userId = singleHeader(request, 'x-user-id', 200);
      if (!tenantId || !userId) {
        throw new AuthenticationError(
          'access_context_required',
          'x-tenant-id and x-user-id headers are required',
        );
      }
      request.accessContext = { tenantId, userId };
      request.authentication = { mode: 'trusted_headers', principal: null };
      return;
    }

    const authorization = singleHeader(request, 'authorization', 20_000);
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match?.[1]) {
      throw new AuthenticationError(
        'authentication_required',
        'A bearer access token is required',
      );
    }
    let principal: AuthenticatedPrincipal;
    try {
      principal = verifyAccessToken(match[1], options);
    } catch (error) {
      if (!(error instanceof AccessTokenError)) throw error;
      throw new AuthenticationError(
        'authentication_invalid',
        'The bearer access token is invalid or expired',
      );
    }
    request.accessContext = {
      tenantId: principal.tenantId,
      userId: principal.userId,
    };
    request.authentication = { mode: 'bearer', principal };
  });
}

export function validateAuthenticationOptions(options: AuthenticationOptions): void {
  if (options.mode === 'trusted_headers'
    && options.environment !== 'development'
    && options.environment !== 'test') {
    throw new AuthenticationConfigurationError(
      'trusted_headers authentication is forbidden in production',
    );
  }
  if (options.mode === 'bearer') {
    const secretBytes = Buffer.byteLength(options.secret, 'utf8');
    if (secretBytes < 32 || secretBytes > 4_096) {
      throw new AuthenticationConfigurationError(
        'bearer authentication requires a secret containing 32 to 4096 bytes',
      );
    }
    if (!validAuthenticationIdentifier(options.issuer)
      || !validAuthenticationIdentifier(options.audience)) {
      throw new AuthenticationConfigurationError(
        'bearer authentication requires valid issuer and audience identifiers',
      );
    }
  }
}

function validAuthenticationIdentifier(value: string): boolean {
  return Boolean(value) && value === value.trim() && value.length <= 500;
}

export function requireAccessContext(request: FastifyRequest): AccessContext {
  if (!request.accessContext) {
    throw new Error('Access context hook was not registered');
  }
  return request.accessContext;
}

export function requireRole(request: FastifyRequest, ...allowedRoles: string[]): void {
  const authentication = requireAuthentication(request);
  if (authentication.mode === 'trusted_headers') return;
  const roles = authentication.principal?.roles ?? [];
  if (roles.includes('admin') || roles.includes('*')
    || allowedRoles.some((role) => roles.includes(role))) {
    return;
  }
  throw new AuthorizationError();
}

export function requirePermission(
  request: FastifyRequest,
  permission: string,
  ...grantingRoles: string[]
): void {
  const authentication = requireAuthentication(request);
  if (authentication.mode === 'trusted_headers') return;
  const roles = authentication.principal?.roles ?? [];
  if (roles.includes('admin') || roles.includes('*') || roles.includes(permission)
    || grantingRoles.some((role) => roles.includes(role))) {
    return;
  }
  throw new AuthorizationError();
}

function requireAuthentication(request: FastifyRequest): RequestAuthentication {
  if (!request.authentication) {
    throw new Error('Authentication hook was not registered');
  }
  return request.authentication;
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
