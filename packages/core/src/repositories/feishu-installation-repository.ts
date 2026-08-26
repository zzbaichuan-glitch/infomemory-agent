/**
 * Persistence ports for a Feishu OAuth installation.
 *
 * The core deliberately stores only opaque (already encrypted) credential
 * values.  Encryption/decryption belongs to the API/secret-management layer;
 * this keeps the repository usable with a KMS in production and makes it
 * impossible for a repository implementation to accidentally log plaintext
 * provider tokens.
 */

export interface PersistFeishuOAuthStateInput {
  /** SHA-256 digest of the state value; the raw state is never persisted. */
  stateHash: string;
  appId: string;
  redirectUri: string;
  tenantId?: string;
  userId?: string;
  returnTo?: string;
  /** PKCE verifier encrypted by the API layer; never store plaintext here. */
  encryptedCodeVerifier?: string;
  createdAt: string;
  expiresAt: string;
}

export interface FeishuOAuthState {
  stateHash: string;
  appId: string;
  redirectUri: string;
  tenantId?: string;
  userId?: string;
  returnTo?: string;
  encryptedCodeVerifier?: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string;
}

export interface FeishuInstallation {
  tenantId: string;
  appId: string;
  tenantName?: string;
  /**
   * Opaque ciphertext; never return or log the plaintext token. Revoked audit
   * records use an empty value after local credential material is destroyed.
   */
  encryptedAccessToken: string;
  encryptedRefreshToken?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  scopes: string[];
  openId?: string;
  unionId?: string;
  installedByUserId?: string;
  status: 'active' | 'revoked';
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
}

export interface PersistFeishuInstallationInput {
  tenantId: string;
  appId: string;
  tenantName?: string;
  encryptedAccessToken: string;
  encryptedRefreshToken?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  scopes: string[];
  openId?: string;
  unionId?: string;
  installedByUserId?: string;
  installedAt: string;
}

export interface RotateFeishuInstallationTokensInput {
  tenantId: string;
  appId: string;
  /** Prevents a second concurrent refresh from overwriting a newer rotation. */
  expectedUpdatedAt: string;
  /** The ciphertext read immediately before refresh; binds the CAS to the same token. */
  expectedEncryptedRefreshToken?: string;
  encryptedAccessToken: string;
  encryptedRefreshToken?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  scopes?: string[];
  updatedAt: string;
}

export interface FeishuInstallationRepository {
  /** Insert a one-time CSRF state. Implementations must reject duplicates. */
  createFeishuOAuthState(input: PersistFeishuOAuthStateInput): Promise<void>;

  /**
   * Atomically consume a state. Expired or already consumed states return
   * null. A successful result can never be returned a second time.
   */
  consumeFeishuOAuthState(stateHash: string, now: string): Promise<FeishuOAuthState | null>;

  /** Upsert an installation by (tenant, app), preserving its creation time. */
  upsertFeishuInstallation(input: PersistFeishuInstallationInput): Promise<FeishuInstallation>;

  rotateFeishuInstallationTokens(input: RotateFeishuInstallationTokensInput): Promise<boolean>;

  findFeishuInstallation(
    tenantId: string,
    appId?: string,
  ): Promise<FeishuInstallation | null>;

  revokeFeishuInstallation(
    tenantId: string,
    appId: string,
    revokedAt: string,
  ): Promise<boolean>;
}

export class FeishuOAuthStateConflictError extends Error {
  readonly code = 'feishu_oauth_state_conflict';

  constructor() {
    super('The Feishu OAuth state is already registered');
    this.name = 'FeishuOAuthStateConflictError';
  }
}
