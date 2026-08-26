import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { IdempotencyConflictError } from '../src/repositories/asset-repository.js';
import { SqliteAssetRepository } from '../src/repositories/sqlite-asset-repository.js';
import { AssetService } from '../src/services/asset-service.js';
import { SearchService } from '../src/services/search-service.js';

describe('SqliteAssetRepository migrations', () => {
  it('migrates a persistent legacy database without losing data or idempotency', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'infomemory-migration-'));
    const databasePath = join(directory, 'legacy.sqlite');
    try {
      seedLegacyDatabase(databasePath);
      const repository = new SqliteAssetRepository(databasePath);
      try {
        const search = new SearchService(repository);
        const migratedSearch = await search.search(
          { tenantId: 'tenant-a', userId: 'alice' },
          { query: '迁移可搜索' },
        );
        expect(migratedSearch.evidence[0]?.assetId).toBe('legacy-asset');

        const assets = new AssetService(repository, {
          idFactory: () => 'new-asset',
          now: () => new Date('2026-08-20T00:00:00.000Z'),
        });
        await expect(assets.ingest(
          { tenantId: 'tenant-a', userId: 'alice' },
          {
            title: '迁移可搜索档案 password=legacy-title-secret',
            content: '这是一条迁移后仍然可搜索的历史记录。 password=legacy-content-secret',
            idempotencyKey: 'legacy-key',
            visibility: 'owner',
          },
        )).rejects.toBeInstanceOf(IdempotencyConflictError);

        const repeated = await assets.ingest(
          { tenantId: 'tenant-a', userId: 'alice' },
          {
            title: '迁移可搜索档案 password=legacy-title-secret',
            content: '这是一条迁移后仍然可搜索的历史记录。 password=legacy-content-secret',
            idempotencyKey: 'new-key-after-legacy',
            visibility: 'owner',
          },
        );
        expect(repeated).toMatchObject({
          created: false,
          deduplicatedBy: 'content_hash',
          asset: { id: 'legacy-asset', ownerId: 'alice' },
        });
        await expect(assets.ingest(
          { tenantId: 'tenant-a', userId: 'alice' },
          {
            title: '不同的请求',
            content: '不能复用旧幂等键。',
            idempotencyKey: 'legacy-key',
            visibility: 'owner',
          },
        )).rejects.toBeInstanceOf(IdempotencyConflictError);
      } finally {
        repository.close();
      }

      const migrated = new DatabaseSync(databasePath);
      try {
        const version = migrated.prepare('PRAGMA user_version').get() as { user_version: number };
        const columns = migrated.prepare('PRAGMA table_info(asset_ingestions)').all() as Array<{ name: string }>;
        const assetCount = migrated.prepare('SELECT COUNT(*) AS count FROM assets').get() as { count: number };
        expect(version.user_version).toBe(5);
        expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
          'actor_id',
          'operation',
          'request_fingerprint',
          'created_at',
        ]));
        expect(Number(assetCount.count)).toBe(1);

        const asset = migrated.prepare(`
          SELECT title, redacted_content, secret_finding_count
          FROM assets WHERE id = 'legacy-asset'
        `).get() as { title: string; redacted_content: string; secret_finding_count: number };
        expect(asset.title).toContain('[REDACTED:password]');
        expect(asset.title).not.toContain('legacy-title-secret');
        expect(asset.redacted_content).toContain('[REDACTED:password]');
        expect(asset.redacted_content).not.toContain('legacy-content-secret');
        expect(Number(asset.secret_finding_count)).toBeGreaterThanOrEqual(2);

        const source = migrated.prepare(`
          SELECT source_identity, external_id, source_url
          FROM asset_sources
          WHERE asset_id = 'legacy-asset' AND external_id IS NOT NULL
          ORDER BY source_identity ASC
          LIMIT 1
        `).get() as { source_identity: string; external_id: string; source_url: string };
        expect(source.source_identity).not.toContain('legacy-source-secret');
        expect(source.external_id).toBe('password=[REDACTED:password]');
        expect(source.source_url).toContain('token=REDACTED');
        expect(source.source_url).not.toContain('legacy-source-secret');

        const reminder = migrated.prepare(`
          SELECT title FROM reminders WHERE id = 'legacy-reminder'
        `).get() as { title: string };
        expect(reminder.title).toBe('提醒 password=[REDACTED:password]');
        expect(reminder.title).not.toContain('legacy-reminder-secret');
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function seedLegacyDatabase(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE assets (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('tenant', 'owner')),
        title TEXT NOT NULL,
        redacted_content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        secret_finding_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE asset_sources (
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        source_identity TEXT NOT NULL,
        source_type TEXT NOT NULL,
        external_id TEXT,
        source_url TEXT,
        PRIMARY KEY (asset_id, source_identity)
      );
      CREATE TABLE asset_ingestions (
        tenant_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        PRIMARY KEY (tenant_id, idempotency_key)
      );
      INSERT INTO assets (
        id, tenant_id, owner_id, visibility, title, redacted_content,
        content_hash, secret_finding_count, created_at
      ) VALUES (
        'legacy-asset', 'tenant-a', 'alice', 'owner',
        '迁移可搜索档案 password=legacy-title-secret',
        '这是一条迁移后仍然可搜索的历史记录。 password=legacy-content-secret',
        'legacy-hash', 0,
        '2026-08-19T00:00:00.000Z'
      );
      INSERT INTO asset_sources (
        asset_id, source_identity, source_type, external_id, source_url
      ) VALUES (
        'legacy-asset', 'manual:password=legacy-source-secret:https://legacy.example/path',
        'manual', 'password=legacy-source-secret',
        'https://legacy.example/path?access_token=legacy-source-secret'
      );
      CREATE TABLE reminders (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        remind_at TEXT NOT NULL,
        status TEXT NOT NULL,
        precision TEXT NOT NULL,
        source_asset_id TEXT,
        source_event_id TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO reminders (
        id, tenant_id, user_id, title, starts_at, remind_at, status,
        precision, source_asset_id, source_event_id, created_at
      ) VALUES (
        'legacy-reminder', 'tenant-a', 'alice', '提醒 password=legacy-reminder-secret',
        '2026-08-21T00:00:00.000Z', '2026-08-20T23:30:00.000Z', 'scheduled',
        'exact', 'legacy-asset', NULL, '2026-08-19T00:00:00.000Z'
      );
      INSERT INTO asset_ingestions (tenant_id, idempotency_key, asset_id)
      VALUES ('tenant-a', 'legacy-key', 'legacy-asset');
      PRAGMA user_version = 0;
    `);
  } finally {
    database.close();
  }
}
