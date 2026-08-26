import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

import type {
  FeishuInstallation,
  FeishuInstallationRepository,
} from '@infomemory/core';

import {
  Aes256GcmSecretCipher,
  type SecretCipher,
} from './credential-cipher.js';

export type FeishuOAuthFetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface FeishuOAuthTokenResponse {
  /** Some OAuth v3 responses omit tenant_key; the bound state can supply it. */
  tenantId?: string;
  tenantName?: string;
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  refreshTokenExpiresInSeconds?: number;
  scopes: string[];
  openId?: string;
  unionId?: string;
}

/** Provider seam: production uses FeishuOAuthClient; tests can inject a fake. */
export interface FeishuOAuthCodeExchanger {
  exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string,
  ): Promise<FeishuOAuthTokenResponse>;
  refreshToken?(refreshToken: string): Promise<FeishuOAuthTokenResponse>;
}

export interface FeishuOAuthClientOptions {
  baseUrl: string;
  appId: string;
  appSecret: string;
  /** OAuth v3 token endpoint. Override for a regional/proxy endpoint. */
  tokenEndpoint?: string;
  /** Use the legacy JSON exchange only for explicitly configured old tenants. */
  protocol?: 'v3' | 'legacy';
  environment?: 'development' | 'test' | 'production';
  timeoutMs?: number;
  fetch?: FeishuOAuthFetchLike;
}

export class FeishuOAuthError extends Error {
  readonly code:
    | 'feishu_oauth_not_configured'
    | 'feishu_oauth_state_invalid'
    | 'feishu_oauth_provider_failed'
    | 'feishu_oauth_callback_invalid'
    | 'feishu_oauth_tenant_mismatch'
    | 'feishu_oauth_refresh_unavailable'
    | 'feishu_oauth_refresh_conflict';

  constructor(
    code: FeishuOAuthError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'FeishuOAuthError';
    this.code = code;
  }
}

export interface FeishuOAuthServiceOptions {
  appId: string;
  appSecret?: string;
  redirectUri: string;
  /** API base used only as a backwards-compatible default for legacy setups. */
  baseUrl?: string;
  /** Feishu OAuth authorization host; defaults to accounts.feishu.cn. */
  authorizationBaseUrl?: string;
  /** Feishu OAuth v3 token endpoint; defaults to accounts.feishu.cn/oauth/v3/token. */
  tokenEndpoint?: string;
  protocol?: 'v3' | 'legacy';
  scopes?: string[];
  /** Enable PKCE S256 for OAuth v3 (secure default). */
  pkce?: boolean;
  stateTtlMs?: number;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  exchanger?: FeishuOAuthCodeExchanger;
  cipher?: SecretCipher;
  /** Raw key convenience for the default AES-GCM cipher. */
  tokenEncryptionKey?: string;
  fetch?: FeishuOAuthFetchLike;
  timeoutMs?: number;
  environment?: 'development' | 'test' | 'production';
}

export interface FeishuOAuthStartInput {
  tenantId?: string;
  userId?: string;
  returnTo?: string;
}

export interface FeishuOAuthStartResult {
  authorizationUrl: string;
  stateExpiresAt: string;
}

export interface FeishuOAuthCallbackResult {
  installation: PublicFeishuInstallation;
  returnTo?: string;
}

export interface FeishuOAuthErrorCallbackResult {
  /** A validated first-party path captured when the OAuth flow started. */
  returnTo?: string;
}

/** Fields safe to send to a browser/API client; credential ciphertext is not included. */
export interface PublicFeishuInstallation {
  tenantId: string;
  appId: string;
  tenantName?: string;
  scopes: string[];
  openId?: string;
  unionId?: string;
  installedByUserId?: string;
  status: 'active' | 'revoked';
  createdAt: string;
  updatedAt: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  revokedAt?: string;
}

export class FeishuOAuthClient implements FeishuOAuthCodeExchanger {
  readonly #baseUrl: string;
  readonly #tokenEndpoint: string;
  readonly #protocol: 'v3' | 'legacy';
  readonly #appId: string;
  readonly #appSecret: string;
  readonly #timeoutMs: number;
  readonly #fetch: FeishuOAuthFetchLike;

  constructor(options: FeishuOAuthClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl, options.environment);
    this.#protocol = options.protocol ?? 'v3';
    this.#tokenEndpoint = options.tokenEndpoint
      ? normalizeAbsoluteUrl(options.tokenEndpoint, 'Feishu OAuth token endpoint', options.environment)
      : this.#protocol === 'v3'
        ? 'https://accounts.feishu.cn/oauth/v3/token'
        : `${this.#baseUrl}/open-apis/authen/v1/oidc/access_token`;
    this.#appId = required(options.appId, 'Feishu app ID');
    this.#appSecret = required(options.appSecret, 'Feishu app secret');
    this.#timeoutMs = Math.max(1_000, options.timeoutMs ?? 10_000);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string,
  ): Promise<FeishuOAuthTokenResponse> {
    const safeCode = required(code, 'authorization code');
    const safeRedirectUri = required(redirectUri, 'redirect URI');
    const init: RequestInit = this.#protocol === 'legacy'
      ? {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: safeCode,
          app_id: this.#appId,
          app_secret: this.#appSecret,
          redirect_uri: safeRedirectUri,
        }),
      }
      : createV3TokenRequest({
        code: safeCode,
        clientId: this.#appId,
        clientSecret: this.#appSecret,
        redirectUri: safeRedirectUri,
        ...(codeVerifier ? { codeVerifier } : {}),
      });
    const payload = await this.#requestJson(this.#tokenEndpoint, init);
    return parseTokenResponse(payload);
  }

  async refreshToken(refreshToken: string): Promise<FeishuOAuthTokenResponse> {
    const safeRefreshToken = required(refreshToken, 'refresh token');
    const init: RequestInit = this.#protocol === 'legacy'
      ? {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: safeRefreshToken,
          app_id: this.#appId,
          app_secret: this.#appSecret,
        }),
      }
      : {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: safeRefreshToken,
          client_id: this.#appId,
          client_secret: this.#appSecret,
        }).toString(),
      };
    const payload = await this.#requestJson(this.#tokenEndpoint, init);
    return parseTokenResponse(payload);
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
      if (!response.ok) {
        throw new FeishuOAuthError(
          'feishu_oauth_provider_failed',
          `Feishu OAuth provider returned HTTP ${response.status}`,
        );
      }
      try {
        return await response.json();
      } catch {
        throw new FeishuOAuthError(
          'feishu_oauth_provider_failed',
          'Feishu OAuth provider returned an invalid response',
        );
      }
    } catch (error) {
      if (error instanceof FeishuOAuthError) throw error;
      if (controller.signal.aborted) {
        throw new FeishuOAuthError(
          'feishu_oauth_provider_failed',
          'Feishu OAuth provider request timed out',
        );
      }
      throw new FeishuOAuthError(
        'feishu_oauth_provider_failed',
        'Feishu OAuth provider request failed',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class FeishuOAuthService {
  readonly #repository: FeishuInstallationRepository;
  readonly #appId: string;
  readonly #redirectUri: string;
  readonly #stateTtlMs: number;
  readonly #now: () => Date;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #exchanger: FeishuOAuthCodeExchanger;
  readonly #cipher: SecretCipher | undefined;
  readonly #authorizationBaseUrl: string;
  readonly #scopes: string[];
  readonly #pkce: boolean;

  constructor(
    repository: FeishuInstallationRepository,
    options: FeishuOAuthServiceOptions,
  ) {
    this.#repository = repository;
    this.#appId = required(options.appId, 'Feishu app ID');
    this.#redirectUri = normalizeRedirectUri(options.redirectUri, options.environment);
    this.#stateTtlMs = boundedPositive(options.stateTtlMs ?? 10 * 60_000, 60_000, 60 * 60_000);
    this.#now = options.now ?? (() => new Date());
    this.#randomBytes = options.randomBytes ?? randomBytes;
    const protocol = options.protocol ?? 'v3';
    this.#authorizationBaseUrl = normalizeBaseUrl(
      options.authorizationBaseUrl
        ?? (protocol === 'v3' ? 'https://accounts.feishu.cn' : (options.baseUrl ?? 'https://open.feishu.cn')),
      options.environment,
    );
    this.#scopes = uniqueStrings(options.scopes ?? []);
    this.#pkce = options.pkce ?? protocol === 'v3';
    this.#exchanger = options.exchanger ?? new FeishuOAuthClient({
      baseUrl: options.baseUrl ?? 'https://open.feishu.cn',
      appId: this.#appId,
      appSecret: options.appSecret ?? '',
      protocol,
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.tokenEndpoint ? { tokenEndpoint: options.tokenEndpoint } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    this.#cipher = options.cipher
      ?? (options.tokenEncryptionKey
        ? new Aes256GcmSecretCipher(options.tokenEncryptionKey)
        : undefined);
  }

  async start(input: FeishuOAuthStartInput = {}): Promise<FeishuOAuthStartResult> {
    const now = this.#now();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.#stateTtlMs).toISOString();
    const state = this.#randomBytes(32).toString('base64url');
    const stateHash = hashState(state);
    const returnTo = input.returnTo ? validateReturnTo(input.returnTo) : undefined;
    let encryptedCodeVerifier: string | undefined;
    let codeChallenge: string | undefined;
    if (this.#pkce) {
      if (!this.#cipher) {
        throw new FeishuOAuthError(
          'feishu_oauth_not_configured',
          'Feishu OAuth token encryption is not configured',
        );
      }
      const codeVerifier = this.#randomBytes(32).toString('base64url');
      try {
        encryptedCodeVerifier = this.#cipher.encrypt(codeVerifier);
      } catch {
        throw new FeishuOAuthError(
          'feishu_oauth_not_configured',
          'Feishu OAuth state could not be protected',
        );
      }
      codeChallenge = hashStateBase64Url(codeVerifier);
    }
    await this.#repository.createFeishuOAuthState({
      stateHash,
      appId: this.#appId,
      redirectUri: this.#redirectUri,
      ...(input.tenantId ? { tenantId: required(input.tenantId, 'tenant ID') } : {}),
      ...(input.userId ? { userId: required(input.userId, 'user ID') } : {}),
      ...(returnTo ? { returnTo } : {}),
      ...(encryptedCodeVerifier ? { encryptedCodeVerifier } : {}),
      createdAt,
      expiresAt,
    });
    const authorization = new URL('/open-apis/authen/v1/authorize', this.#authorizationBaseUrl);
    authorization.searchParams.set('client_id', this.#appId);
    authorization.searchParams.set('response_type', 'code');
    authorization.searchParams.set('redirect_uri', this.#redirectUri);
    authorization.searchParams.set('state', state);
    if (codeChallenge) {
      authorization.searchParams.set('code_challenge', codeChallenge);
      authorization.searchParams.set('code_challenge_method', 'S256');
    }
    if (this.#scopes.length > 0) authorization.searchParams.set('scope', this.#scopes.join(' '));
    return { authorizationUrl: authorization.toString(), stateExpiresAt: expiresAt };
  }

  async callback(code: string, state: string): Promise<FeishuOAuthCallbackResult> {
    const safeCode = required(code, 'authorization code');
    const safeState = required(state, 'OAuth state');
    if (safeState.length > 512) throw new FeishuOAuthError(
      'feishu_oauth_state_invalid',
      'The Feishu OAuth state is invalid or expired',
    );
    const now = this.#now();
    const stored = await this.#repository.consumeFeishuOAuthState(
      hashState(safeState),
      now.toISOString(),
    );
    if (!stored || stored.appId !== this.#appId || stored.redirectUri !== this.#redirectUri) {
      throw new FeishuOAuthError(
        'feishu_oauth_state_invalid',
        'The Feishu OAuth state is invalid or expired',
      );
    }
    if (!this.#cipher) {
      // Never exchange a code if we cannot durably protect the resulting
      // credentials. The state is consumed so a caller cannot replay it later.
      throw new FeishuOAuthError(
        'feishu_oauth_not_configured',
        'Feishu OAuth token encryption is not configured',
      );
    }
    let codeVerifier: string | undefined;
    if (this.#pkce) {
      if (!stored.encryptedCodeVerifier) {
        throw new FeishuOAuthError(
          'feishu_oauth_state_invalid',
          'The Feishu OAuth state is invalid or expired',
        );
      }
      try {
        codeVerifier = this.#cipher.decrypt(stored.encryptedCodeVerifier);
      } catch {
        throw new FeishuOAuthError(
          'feishu_oauth_state_invalid',
          'The Feishu OAuth state is invalid or expired',
        );
      }
    }
    let exchanged: FeishuOAuthTokenResponse;
    try {
      exchanged = await this.#exchanger.exchangeCode(
        safeCode,
        this.#redirectUri,
        codeVerifier,
      );
    } catch (error) {
      if (error instanceof FeishuOAuthError) throw error;
      throw new FeishuOAuthError(
        'feishu_oauth_provider_failed',
        'Feishu OAuth code exchange failed',
      );
    }
    const tenantId = exchanged.tenantId ?? stored.tenantId;
    if (!tenantId) {
      throw new FeishuOAuthError(
        'feishu_oauth_provider_failed',
        'Feishu OAuth provider response did not identify a tenant',
      );
    }
    if (stored.tenantId && exchanged.tenantId && stored.tenantId !== exchanged.tenantId) {
      throw new FeishuOAuthError(
        'feishu_oauth_tenant_mismatch',
        'The Feishu authorization belongs to a different tenant',
      );
    }
    const installedAt = now.toISOString();
    const accessTokenExpiresAt = expiryFromSeconds(now, exchanged.expiresInSeconds);
    const refreshTokenExpiresAt = expiryFromSeconds(now, exchanged.refreshTokenExpiresInSeconds);
    let encryptedAccessToken: string;
    let encryptedRefreshToken: string | undefined;
    try {
      encryptedAccessToken = this.#cipher.encrypt(exchanged.accessToken);
      encryptedRefreshToken = exchanged.refreshToken
        ? this.#cipher.encrypt(exchanged.refreshToken)
        : undefined;
    } catch {
      throw new FeishuOAuthError(
        'feishu_oauth_not_configured',
        'Feishu OAuth credentials could not be protected',
      );
    }
    let installation: FeishuInstallation;
    try {
      installation = await this.#repository.upsertFeishuInstallation({
        tenantId,
        appId: this.#appId,
        ...(exchanged.tenantName ? { tenantName: exchanged.tenantName } : {}),
        encryptedAccessToken,
        ...(encryptedRefreshToken ? { encryptedRefreshToken } : {}),
        ...(accessTokenExpiresAt ? { accessTokenExpiresAt } : {}),
        ...(refreshTokenExpiresAt ? { refreshTokenExpiresAt } : {}),
        scopes: exchanged.scopes,
        ...(exchanged.openId ? { openId: exchanged.openId } : {}),
        ...(exchanged.unionId ? { unionId: exchanged.unionId } : {}),
        ...(stored.userId ? { installedByUserId: stored.userId } : {}),
        installedAt,
      });
    } catch {
      throw new FeishuOAuthError(
        'feishu_oauth_callback_invalid',
        'The Feishu installation could not be saved',
      );
    }
    return {
      installation: toPublicInstallation(installation),
      ...(stored.returnTo ? { returnTo: stored.returnTo } : {}),
    };
  }

  /**
   * Consume a provider-denied callback without exchanging a code. OAuth
   * providers can redirect with `error` instead of `code`; consuming the
   * one-time state still prevents replay and lets browser flows return to the
   * validated local workbench path. Provider error text is deliberately not
   * accepted or persisted.
   */
  async callbackError(stateInput: string): Promise<FeishuOAuthErrorCallbackResult> {
    const safeState = required(stateInput, 'OAuth state');
    if (safeState.length > 512) throw new FeishuOAuthError(
      'feishu_oauth_state_invalid',
      'The Feishu OAuth state is invalid or expired',
    );
    const stored = await this.#repository.consumeFeishuOAuthState(
      hashState(safeState),
      this.#now().toISOString(),
    );
    if (!stored || stored.appId !== this.#appId || stored.redirectUri !== this.#redirectUri) {
      throw new FeishuOAuthError(
        'feishu_oauth_state_invalid',
        'The Feishu OAuth state is invalid or expired',
      );
    }
    return stored.returnTo ? { returnTo: stored.returnTo } : {};
  }

  /**
   * Rotate a tenant's OAuth access token using its encrypted refresh token.
   * A compare-and-set on the installation row prevents two concurrent
   * refreshes from overwriting a newer provider rotation.
   */
  async refresh(tenantId: string): Promise<PublicFeishuInstallation> {
    const safeTenantId = required(tenantId, 'tenant ID');
    const current = await this.#repository.findFeishuInstallation(safeTenantId, this.#appId);
    if (!current || current.status !== 'active' || !current.encryptedRefreshToken) {
      throw new FeishuOAuthError(
        'feishu_oauth_refresh_unavailable',
        'No active Feishu refresh session exists for the current tenant',
      );
    }
    if (!this.#cipher || !this.#exchanger.refreshToken) {
      throw new FeishuOAuthError(
        'feishu_oauth_not_configured',
        'Feishu OAuth refresh is not configured',
      );
    }
    let refreshToken: string;
    try {
      refreshToken = this.#cipher.decrypt(current.encryptedRefreshToken);
    } catch {
      throw new FeishuOAuthError(
        'feishu_oauth_refresh_unavailable',
        'The Feishu refresh session is invalid',
      );
    }
    let exchanged: FeishuOAuthTokenResponse;
    try {
      exchanged = await this.#exchanger.refreshToken(refreshToken);
    } catch (error) {
      if (error instanceof FeishuOAuthError) throw error;
      throw new FeishuOAuthError(
        'feishu_oauth_provider_failed',
        'Feishu OAuth token refresh failed',
      );
    }
    if (exchanged.tenantId && exchanged.tenantId !== safeTenantId) {
      throw new FeishuOAuthError(
        'feishu_oauth_tenant_mismatch',
        'The Feishu refresh response belongs to a different tenant',
      );
    }
    let encryptedAccessToken: string;
    let encryptedRefreshToken: string | undefined;
    try {
      encryptedAccessToken = this.#cipher.encrypt(exchanged.accessToken);
      if (exchanged.refreshToken) encryptedRefreshToken = this.#cipher.encrypt(exchanged.refreshToken);
    } catch {
      throw new FeishuOAuthError(
        'feishu_oauth_not_configured',
        'Feishu OAuth credentials could not be protected',
      );
    }
    const now = this.#now();
    const currentTime = Date.parse(current.updatedAt);
    const updatedAt = new Date(Math.max(
      now.getTime(),
      Number.isFinite(currentTime) ? currentTime + 1 : now.getTime(),
    )).toISOString();
    const accessTokenExpiresAt = expiryFromSeconds(now, exchanged.expiresInSeconds);
    const refreshTokenExpiresAt = expiryFromSeconds(now, exchanged.refreshTokenExpiresInSeconds);
    const rotated = await this.#repository.rotateFeishuInstallationTokens({
      tenantId: safeTenantId,
      appId: this.#appId,
      expectedUpdatedAt: current.updatedAt,
      expectedEncryptedRefreshToken: current.encryptedRefreshToken,
      encryptedAccessToken,
      ...(encryptedRefreshToken ? { encryptedRefreshToken } : {}),
      ...(accessTokenExpiresAt ? { accessTokenExpiresAt } : {}),
      ...(refreshTokenExpiresAt ? { refreshTokenExpiresAt } : {}),
      ...(exchanged.scopes.length > 0 ? { scopes: exchanged.scopes } : {}),
      updatedAt,
    });
    if (!rotated) {
      throw new FeishuOAuthError(
        'feishu_oauth_refresh_conflict',
        'Another refresh is already applying newer Feishu credentials',
      );
    }
    const installation = await this.#repository.findFeishuInstallation(safeTenantId, this.#appId);
    if (!installation) {
      throw new FeishuOAuthError(
        'feishu_oauth_callback_invalid',
        'The Feishu installation could not be loaded after refresh',
      );
    }
    return toPublicInstallation(installation);
  }

  async getInstallation(tenantId: string): Promise<PublicFeishuInstallation | null> {
    const installation = await this.#repository.findFeishuInstallation(
      required(tenantId, 'tenant ID'),
      this.#appId,
    );
    return installation ? toPublicInstallation(installation) : null;
  }

  async revokeInstallation(tenantId: string): Promise<boolean> {
    return this.#repository.revokeFeishuInstallation(
      required(tenantId, 'tenant ID'),
      this.#appId,
      this.#now().toISOString(),
    );
  }
}

export function toPublicInstallation(value: FeishuInstallation): PublicFeishuInstallation {
  const result: PublicFeishuInstallation = {
    tenantId: value.tenantId,
    appId: value.appId,
    scopes: [...value.scopes],
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  const optional: Array<[keyof PublicFeishuInstallation, string | undefined]> = [
    ['tenantName', value.tenantName],
    ['openId', value.openId],
    ['unionId', value.unionId],
    ['installedByUserId', value.installedByUserId],
    ['accessTokenExpiresAt', value.accessTokenExpiresAt],
    ['refreshTokenExpiresAt', value.refreshTokenExpiresAt],
    ['revokedAt', value.revokedAt],
  ];
  for (const [key, item] of optional) {
    if (item !== undefined) {
      (result as unknown as Record<string, unknown>)[key] = item;
    }
  }
  return result;
}

function parseTokenResponse(payload: unknown): FeishuOAuthTokenResponse {
  const outer = recordSchema.safeParse(payload);
  if (!outer.success) throw new FeishuOAuthError(
    'feishu_oauth_provider_failed',
    'Feishu OAuth provider returned an invalid response',
  );
  const body = recordSchema.safeParse(outer.data.data).success
    ? outer.data.data as Record<string, unknown>
    : outer.data;
  const code = typeof outer.data.code === 'number' ? outer.data.code : 0;
  if (code !== 0) throw new FeishuOAuthError(
    'feishu_oauth_provider_failed',
    'Feishu OAuth provider rejected the authorization code',
  );
  const tenantId = firstString(body.tenant_key, body.tenant_id, body.tenantId);
  const accessToken = firstString(body.access_token, body.user_access_token);
  if (!accessToken) throw new FeishuOAuthError(
    'feishu_oauth_provider_failed',
    'Feishu OAuth provider response did not contain required credentials',
  );
  const scopes = parseScopes(body.scope ?? body.scopes);
  const result: FeishuOAuthTokenResponse = {
    accessToken,
    scopes,
  };
  if (tenantId) result.tenantId = tenantId;
  const tenantName = firstString(body.tenant_name, body.tenantName);
  const refreshToken = firstString(body.refresh_token, body.refreshToken);
  const expiresInSeconds = positiveNumber(body.expires_in, body.expire, body.expiresIn);
  const refreshTokenExpiresInSeconds = positiveNumber(
    body.refresh_token_expires_in,
    body.refreshTokenExpiresIn,
  );
  const openId = firstString(body.open_id, body.openId);
  const unionId = firstString(body.union_id, body.unionId);
  if (tenantName) result.tenantName = tenantName;
  if (refreshToken) result.refreshToken = refreshToken;
  if (expiresInSeconds) result.expiresInSeconds = expiresInSeconds;
  if (refreshTokenExpiresInSeconds) result.refreshTokenExpiresInSeconds = refreshTokenExpiresInSeconds;
  if (openId) result.openId = openId;
  if (unionId) result.unionId = unionId;
  return result;
}

function createV3TokenRequest(input: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier?: string;
}): RequestInit {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
  });
  if (input.codeVerifier) form.set('code_verifier', input.codeVerifier);
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  };
}

const recordSchema = z.record(z.string(), z.unknown());

function parseScopes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueStrings(value.filter((item): item is string => typeof item === 'string'));
  }
  if (typeof value === 'string') return uniqueStrings(value.split(/[\s,]+/u));
  return [];
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim();
}

function positiveNumber(...values: unknown[]): number | undefined {
  const value = values.find((item): item is number => typeof item === 'number'
    && Number.isFinite(item) && item > 0 && item <= 31_536_000);
  return value;
}

function expiryFromSeconds(now: Date, seconds: number | undefined): string | undefined {
  return seconds ? new Date(now.getTime() + seconds * 1_000).toISOString() : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function hashState(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashStateBase64Url(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function validateReturnTo(value: string): string {
  const normalized = required(value, 'return URL');
  if (normalized.length > 500 || !normalized.startsWith('/') || normalized.startsWith('//')
    || /[\u0000-\u001f\u007f#]/u.test(normalized)) {
    throw new FeishuOAuthError(
      'feishu_oauth_callback_invalid',
      'The OAuth return URL must be a local path',
    );
  }
  return normalized;
}

function normalizeRedirectUri(
  value: string,
  environment: FeishuOAuthServiceOptions['environment'] = 'development',
): string {
  const normalized = required(value, 'Feishu OAuth redirect URI');
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new FeishuOAuthError('feishu_oauth_not_configured', 'Feishu OAuth redirect URI is invalid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.hash || (environment === 'production' && parsed.protocol !== 'https:')) {
    throw new FeishuOAuthError('feishu_oauth_not_configured', 'Feishu OAuth redirect URI is invalid');
  }
  return parsed.toString();
}

function normalizeBaseUrl(
  value: string,
  environment: FeishuOAuthServiceOptions['environment'] = 'development',
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new FeishuOAuthError('feishu_oauth_not_configured', 'Feishu OAuth base URL is invalid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || (environment === 'production' && parsed.protocol !== 'https:')) {
    throw new FeishuOAuthError('feishu_oauth_not_configured', 'Feishu OAuth base URL is invalid');
  }
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
  return parsed.toString().replace(/\/$/u, '');
}

function normalizeAbsoluteUrl(
  value: string,
  label: string,
  environment: FeishuOAuthServiceOptions['environment'] = 'development',
): string {
  const normalized = required(value, label);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new FeishuOAuthError('feishu_oauth_not_configured', `${label} is invalid`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.hash || (environment === 'production' && parsed.protocol !== 'https:')) {
    throw new FeishuOAuthError('feishu_oauth_not_configured', `${label} is invalid`);
  }
  return parsed.toString();
}

function required(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new FeishuOAuthError('feishu_oauth_not_configured', `${label} is required`);
  }
  return value.trim();
}

function boundedPositive(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new FeishuOAuthError('feishu_oauth_not_configured', 'Feishu OAuth state TTL is invalid');
  }
  return value;
}
