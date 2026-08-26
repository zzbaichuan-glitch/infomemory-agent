import {
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

const HEADER = Object.freeze({ alg: 'HS256', typ: 'JWT' });
const HEADER_KEYS = ['alg', 'typ'] as const;
const CLAIM_KEYS = ['iss', 'aud', 'iat', 'exp', 'tenant', 'sub', 'roles', 'jti'] as const;
const MINIMUM_SECRET_BYTES = 32;
const MAXIMUM_TOKEN_LENGTH = 16_384;

export interface GenerateAccessTokenOptions {
  secret: string;
  issuer: string;
  audience: string;
  tenantId: string;
  userId: string;
  roles: string[];
  jti?: string;
  issuedAt?: number;
  expiresAt?: number;
  expiresInSeconds?: number;
  now?: () => number;
}

export interface VerifyAccessTokenOptions {
  secret: string;
  issuer: string;
  audience: string;
  now?: () => number;
  clockToleranceSeconds?: number;
}

export interface AuthenticatedPrincipal {
  tenantId: string;
  userId: string;
  roles: string[];
  tokenId: string;
  issuedAt: number;
  expiresAt: number;
}

interface AccessTokenClaims {
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  tenant: string;
  sub: string;
  roles: string[];
  jti: string;
}

export class AccessTokenError extends Error {
  constructor(message = 'Access token is invalid') {
    super(message);
    this.name = 'AccessTokenError';
  }
}

export function generateAccessToken(options: GenerateAccessTokenOptions): string {
  const secret = validateSecret(options.secret);
  const issuedAt = options.issuedAt ?? (options.now?.() ?? Math.floor(Date.now() / 1_000));
  const expiresAt = options.expiresAt
    ?? issuedAt + (options.expiresInSeconds ?? 3_600);
  const claims = validateClaims({
    iss: options.issuer,
    aud: options.audience,
    iat: issuedAt,
    exp: expiresAt,
    tenant: options.tenantId,
    sub: options.userId,
    roles: options.roles,
    jti: options.jti ?? randomUUID(),
  });
  const encodedHeader = encodeJson(HEADER);
  const encodedClaims = encodeJson(claims);
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = sign(signingInput, secret).toString('base64url');
  return `${signingInput}.${signature}`;
}

export function verifyAccessToken(
  token: string,
  options: VerifyAccessTokenOptions,
): AuthenticatedPrincipal {
  const secret = validateSecret(options.secret);
  if (!token || token.length > MAXIMUM_TOKEN_LENGTH) throw new AccessTokenError();
  const segments = token.split('.');
  if (segments.length !== 3) throw new AccessTokenError();
  const [encodedHeader, encodedClaims, encodedSignature] = segments;
  if (!encodedHeader || !encodedClaims || !encodedSignature) throw new AccessTokenError();

  const header = decodeJson(encodedHeader);
  if (!hasOnlyKeys(header, HEADER_KEYS) || header.alg !== 'HS256' || header.typ !== 'JWT') {
    throw new AccessTokenError();
  }

  const expectedSignature = sign(`${encodedHeader}.${encodedClaims}`, secret);
  const receivedSignature = decodeBase64Url(encodedSignature);
  const comparableSignature = Buffer.alloc(expectedSignature.length);
  receivedSignature.copy(comparableSignature, 0, 0, expectedSignature.length);
  const signatureMatches = timingSafeEqual(expectedSignature, comparableSignature)
    && receivedSignature.length === expectedSignature.length;
  if (!signatureMatches) throw new AccessTokenError();

  const claimsRecord = decodeJson(encodedClaims);
  if (!hasOnlyKeys(claimsRecord, CLAIM_KEYS)) throw new AccessTokenError();
  const claims = validateClaims(claimsRecord);
  if (claims.iss !== validateIdentifier(options.issuer)
    || claims.aud !== validateIdentifier(options.audience)) {
    throw new AccessTokenError();
  }

  const now = options.now?.() ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(now) || now < 0) throw new AccessTokenError();
  const tolerance = options.clockToleranceSeconds ?? 0;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 300) {
    throw new AccessTokenError('Clock tolerance is invalid');
  }
  if (claims.iat > now + tolerance || claims.exp <= now - tolerance) {
    throw new AccessTokenError('Access token is expired or not active');
  }

  return {
    tenantId: claims.tenant,
    userId: claims.sub,
    roles: [...claims.roles],
    tokenId: claims.jti,
    issuedAt: claims.iat,
    expiresAt: claims.exp,
  };
}

function sign(value: string, secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(value, 'utf8').digest();
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(decodeBase64Url(value).toString('utf8')) as unknown;
    if (!isRecord(parsed)) throw new AccessTokenError();
    return parsed;
  } catch (error) {
    if (error instanceof AccessTokenError) throw error;
    throw new AccessTokenError();
  }
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new AccessTokenError();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length === 0 || decoded.toString('base64url') !== value) {
    throw new AccessTokenError();
  }
  return decoded;
}

function validateClaims(value: Record<string, unknown>): AccessTokenClaims {
  const issuedAt = integerClaim(value.iat);
  const expiresAt = integerClaim(value.exp);
  if (expiresAt <= issuedAt) throw new AccessTokenError();
  if (!Array.isArray(value.roles) || value.roles.length > 100) throw new AccessTokenError();
  const roles = value.roles.map((role) => validateIdentifier(role, 100));
  if (new Set(roles).size !== roles.length) throw new AccessTokenError();
  return {
    iss: validateIdentifier(value.iss, 500),
    aud: validateIdentifier(value.aud, 500),
    iat: issuedAt,
    exp: expiresAt,
    tenant: validateIdentifier(value.tenant, 200),
    sub: validateIdentifier(value.sub, 200),
    roles,
    jti: validateIdentifier(value.jti, 500),
  };
}

function validateSecret(value: string): Buffer {
  if (typeof value !== 'string') throw new AccessTokenError('Access token secret is invalid');
  const secret = Buffer.from(value, 'utf8');
  if (value.trim().length === 0 || secret.length < MINIMUM_SECRET_BYTES) {
    throw new AccessTokenError('Access token secret must contain at least 32 bytes');
  }
  return secret;
}

function integerClaim(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AccessTokenError();
  }
  return value;
}

function validateIdentifier(value: unknown, maximumLength = 500): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > maximumLength
    || value !== value.trim()) {
    throw new AccessTokenError();
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}
