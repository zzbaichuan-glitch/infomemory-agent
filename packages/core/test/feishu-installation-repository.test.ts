import { describe, expect, it } from 'vitest';

import { SqliteAssetRepository } from '../src/repositories/sqlite-asset-repository.js';

describe('Feishu installation persistence', () => {
  it('atomically consumes OAuth state once and rejects expired state', async () => {
    const repository = new SqliteAssetRepository(':memory:');
    try {
      await repository.createFeishuOAuthState({
        stateHash: 'state-hash-1',
        appId: 'cli_test',
        redirectUri: 'https://example.test/oauth/callback',
        tenantId: 'tenant-a',
        userId: 'admin-a',
        createdAt: '2030-01-01T00:00:00.000Z',
        expiresAt: '2030-01-01T00:10:00.000Z',
      });

      await expect(repository.consumeFeishuOAuthState(
        'state-hash-1',
        '2030-01-01T00:01:00.000Z',
      )).resolves.toMatchObject({
        stateHash: 'state-hash-1',
        tenantId: 'tenant-a',
        userId: 'admin-a',
        consumedAt: '2030-01-01T00:01:00.000Z',
      });
      await expect(repository.consumeFeishuOAuthState(
        'state-hash-1',
        '2030-01-01T00:02:00.000Z',
      )).resolves.toBeNull();

      await repository.createFeishuOAuthState({
        stateHash: 'state-hash-expired',
        appId: 'cli_test',
        redirectUri: 'https://example.test/oauth/callback',
        createdAt: '2030-01-01T00:00:00.000Z',
        expiresAt: '2030-01-01T00:10:00.000Z',
      });
      await expect(repository.consumeFeishuOAuthState(
        'state-hash-expired',
        '2030-01-01T00:10:00.000Z',
      )).resolves.toBeNull();
    } finally {
      repository.close();
    }
  });

  it('upserts an installation and revokes it within the tenant/app key', async () => {
    const repository = new SqliteAssetRepository(':memory:');
    try {
      const first = await repository.upsertFeishuInstallation({
        tenantId: 'tenant-a',
        appId: 'cli_test',
        tenantName: '示例企业',
        encryptedAccessToken: 'v1.cipher.access',
        encryptedRefreshToken: 'v1.cipher.refresh',
        accessTokenExpiresAt: '2030-01-01T01:00:00.000Z',
        refreshTokenExpiresAt: '2030-01-02T00:00:00.000Z',
        scopes: ['im:message', 'docx:read', 'im:message'],
        installedByUserId: 'admin-a',
        installedAt: '2030-01-01T00:00:00.000Z',
      });
      expect(first).toMatchObject({
        tenantId: 'tenant-a',
        appId: 'cli_test',
        encryptedAccessToken: 'v1.cipher.access',
        scopes: ['docx:read', 'im:message'],
        status: 'active',
      });

      const updated = await repository.upsertFeishuInstallation({
        tenantId: 'tenant-a',
        appId: 'cli_test',
        encryptedAccessToken: 'v1.cipher.access-2',
        scopes: ['calendar:read'],
        installedAt: '2030-01-02T00:00:00.000Z',
      });
      expect(updated).toMatchObject({
        encryptedAccessToken: 'v1.cipher.access-2',
        scopes: ['calendar:read'],
        status: 'active',
        createdAt: '2030-01-01T00:00:00.000Z',
        updatedAt: '2030-01-02T00:00:00.000Z',
      });
      expect(updated).not.toHaveProperty('accessToken');

      await expect(repository.revokeFeishuInstallation(
        'tenant-a',
        'cli_test',
        '2030-01-03T00:00:00.000Z',
      )).resolves.toBe(true);
      const revoked = await repository.findFeishuInstallation('tenant-a', 'cli_test');
      expect(revoked).toMatchObject({
        status: 'revoked',
        revokedAt: '2030-01-03T00:00:00.000Z',
        encryptedAccessToken: '',
      });
      expect(revoked).not.toHaveProperty('encryptedRefreshToken');
      expect(revoked).not.toHaveProperty('accessTokenExpiresAt');
      expect(revoked).not.toHaveProperty('refreshTokenExpiresAt');
      await expect(repository.revokeFeishuInstallation(
        'tenant-a',
        'cli_test',
        '2030-01-04T00:00:00.000Z',
      )).resolves.toBe(false);

      // Re-install an active record and verify compare-and-set rotation.
      const active = await repository.upsertFeishuInstallation({
        tenantId: 'tenant-a',
        appId: 'cli_test',
        encryptedAccessToken: 'v1.access.3',
        encryptedRefreshToken: 'v1.refresh.3',
        scopes: [],
        installedAt: '2030-01-05T00:00:00.000Z',
      });
      await expect(repository.rotateFeishuInstallationTokens({
        tenantId: 'tenant-a',
        appId: 'cli_test',
        expectedUpdatedAt: active.updatedAt,
        expectedEncryptedRefreshToken: active.encryptedRefreshToken,
        encryptedAccessToken: 'v1.access.4',
        // Deliberately omit refresh token: old ciphertext must be retained.
        updatedAt: '2030-01-05T00:01:00.000Z',
      })).resolves.toBe(true);
      const rotated = await repository.findFeishuInstallation('tenant-a', 'cli_test');
      expect(rotated).toMatchObject({
        encryptedAccessToken: 'v1.access.4',
        encryptedRefreshToken: 'v1.refresh.3',
        updatedAt: '2030-01-05T00:01:00.000Z',
      });
      await expect(repository.rotateFeishuInstallationTokens({
        tenantId: 'tenant-a',
        appId: 'cli_test',
        expectedUpdatedAt: active.updatedAt,
        expectedEncryptedRefreshToken: active.encryptedRefreshToken,
        encryptedAccessToken: 'v1.stale',
        updatedAt: '2030-01-05T00:02:00.000Z',
      })).resolves.toBe(false);
    } finally {
      repository.close();
    }
  });
});
