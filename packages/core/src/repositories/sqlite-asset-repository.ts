import { DatabaseSync } from 'node:sqlite';

import type {
  AccessContext,
  InformationAsset,
  Reminder,
  ReminderStatus,
  SourceReference,
} from '../domain.js';
import type {
  AssetIngestResult,
  AssetListOptions,
  AssetListPage,
  AssetRepository,
  AssetSearchHit,
  AssetSearchOptions,
  DeduplicatedBy,
  PersistAssetInput,
} from './asset-repository.js';
import {
  IdempotencyConflictError,
  InvalidAssetCursorError,
} from './asset-repository.js';
import type {
  ClaimConnectorEventReceiptInput,
  ConnectorEventReceiptClaim,
  ConnectorEventReceiptRepository,
  ReleaseConnectorEventReceiptInput,
} from './connector-event-repository.js';
import type {
  PersistReminderInput,
  ReminderDeliveryRepository,
  ReminderListOptions,
  ReminderRepository,
} from './reminder-repository.js';
import {
  createFtsIndexText,
  createFtsMatchExpression,
} from '../search/search-text.js';

type Row = Record<string, unknown>;
const CURRENT_SCHEMA_VERSION = 4;

export class SqliteAssetRepository implements
  AssetRepository,
  ReminderRepository,
  ReminderDeliveryRepository,
  ConnectorEventReceiptRepository {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec('PRAGMA foreign_keys = ON;');
    this.#database.exec('PRAGMA journal_mode = WAL;');
    this.#migrateSchema();
  }

  async ingest(input: PersistAssetInput): Promise<AssetIngestResult> {
    this.#database.exec('BEGIN IMMEDIATE;');
    try {
      const idempotent = this.#database.prepare(`
        SELECT asset_id, request_fingerprint
        FROM asset_ingestions
        WHERE tenant_id = ?
          AND actor_id = ?
          AND operation = ?
          AND idempotency_key = ?
      `).get(
        input.context.tenantId,
        input.context.userId,
        input.operation,
        input.idempotencyKey,
      ) as Row | undefined;

      if (idempotent) {
        const assetId = String(idempotent.asset_id);
        const storedFingerprint = idempotent.request_fingerprint === null
          || idempotent.request_fingerprint === undefined
          ? null
          : String(idempotent.request_fingerprint);
        if (storedFingerprint && storedFingerprint !== input.requestFingerprint) {
          throw new IdempotencyConflictError();
        }
        if (!storedFingerprint) {
          this.#database.prepare(`
            UPDATE asset_ingestions
            SET request_fingerprint = ?
            WHERE tenant_id = ? AND actor_id = ? AND operation = ? AND idempotency_key = ?
          `).run(
            input.requestFingerprint,
            input.context.tenantId,
            input.context.userId,
            input.operation,
            input.idempotencyKey,
          );
        }
        const asset = this.#loadAccessibleAssetById(input.context, assetId);
        if (!asset) throw new Error('Idempotent asset is not accessible');
        this.#database.exec('COMMIT;');
        return { asset, created: false, deduplicatedBy: 'idempotency' };
      }

      const duplicate = this.#database.prepare(`
        SELECT id
        FROM assets
        WHERE tenant_id = ?
          AND owner_id = ?
          AND visibility = ?
          AND content_hash = ?
        LIMIT 1
      `).get(
        input.context.tenantId,
        input.context.userId,
        input.visibility,
        input.contentHash,
      ) as Row | undefined;

      if (duplicate) {
        const assetId = String(duplicate.id);
        this.#insertSource(assetId, input.source);
        this.#insertIngestion(input, assetId);
        const result = this.#deduplicatedResult(input.context, assetId, 'content_hash');
        this.#database.exec('COMMIT;');
        return result;
      }

      this.#database.prepare(`
        INSERT INTO assets (
          id, tenant_id, owner_id, visibility, title, redacted_content,
          content_hash, secret_finding_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.context.tenantId,
        input.context.userId,
        input.visibility,
        input.title,
        input.redactedContent,
        input.contentHash,
        input.secretFindingCount,
        input.createdAt,
      );
      this.#insertSource(input.id, input.source);
      this.#insertIngestion(input, input.id);
      this.#insertFtsAsset(
        input.id,
        input.title,
        input.redactedContent,
      );
      const asset = this.#loadAccessibleAssetById(input.context, input.id);
      if (!asset) throw new Error('Asset was not persisted');
      this.#database.exec('COMMIT;');
      return { asset, created: true };
    } catch (error) {
      this.#database.exec('ROLLBACK;');
      throw error;
    }
  }

  async findById(
    context: AccessContext,
    id: string,
  ): Promise<InformationAsset | null> {
    return this.#loadAccessibleAssetById(context, id);
  }

  async list(
    context: AccessContext,
    options: AssetListOptions = {},
  ): Promise<InformationAsset[]> {
    return (await this.listPage(context, options)).assets;
  }

  async listPage(
    context: AccessContext,
    options: AssetListOptions = {},
  ): Promise<AssetListPage> {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 200));
    const offset = Math.max(0, Math.min(options.offset ?? 0, 100_000));
    const clauses = [
      'a.tenant_id = ?',
      "(a.visibility = 'tenant' OR a.owner_id = ?)",
    ];
    const values: Array<string | number> = [context.tenantId, context.userId];

    if (options.visibility) {
      clauses.push('a.visibility = ?');
      values.push(options.visibility);
    }
    if (options.sourceType) {
      clauses.push(`EXISTS (
        SELECT 1 FROM asset_sources source
        WHERE source.asset_id = a.id AND source.source_type = ?
      )`);
      values.push(options.sourceType);
    }
    if (options.createdAfter) {
      clauses.push('a.created_at >= ?');
      values.push(options.createdAfter);
    }
    if (options.createdBefore) {
      clauses.push('a.created_at <= ?');
      values.push(options.createdBefore);
    }
    if (options.cursor) {
      const cursor = decodeAssetCursor(options.cursor);
      clauses.push('(a.created_at < ? OR (a.created_at = ? AND a.id > ?))');
      values.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }

    const rows = this.#database.prepare(`
      SELECT a.*
      FROM assets a
      WHERE ${clauses.join(' AND ')}
      ORDER BY a.created_at DESC, a.id ASC
      LIMIT ? OFFSET ?
    `).all(...values, limit + 1, options.cursor ? 0 : offset) as Row[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const assets = pageRows.map((row) => this.#mapAsset(row));
    const last = pageRows.at(-1);
    return {
      assets,
      ...(hasMore && last
        ? { nextCursor: encodeAssetCursor(String(last.created_at), String(last.id)) }
        : {}),
    };
  }

  async search(
    context: AccessContext,
    query: string,
    options: AssetSearchOptions = {},
  ): Promise<AssetSearchHit[]> {
    const matchExpression = createFtsMatchExpression(query);
    if (!matchExpression) return [];
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const rows = this.#database.prepare(`
      SELECT a.*, bm25(assets_fts, 0.0, 8.0, 1.0) AS search_rank
      FROM assets_fts
      JOIN assets a ON a.id = assets_fts.asset_id
      WHERE assets_fts MATCH ?
        AND a.tenant_id = ?
        AND (a.visibility = 'tenant' OR a.owner_id = ?)
      ORDER BY search_rank ASC, a.created_at DESC, a.id ASC
      LIMIT ?
    `).all(matchExpression, context.tenantId, context.userId, limit) as Row[];

    return rows.map((row) => ({
      asset: this.#mapAsset(row),
      score: Math.max(Number.EPSILON, -Number(row.search_rank)),
    }));
  }

  async deleteOwned(context: AccessContext, id: string): Promise<boolean> {
    const result = this.#database.prepare(`
      DELETE FROM assets
      WHERE id = ? AND tenant_id = ? AND owner_id = ?
    `).run(id, context.tenantId, context.userId);
    return Number(result.changes) === 1;
  }

  async claimConnectorEventReceipt(
    input: ClaimConnectorEventReceiptInput,
  ): Promise<ConnectorEventReceiptClaim> {
    const result = this.#database.prepare(`
      INSERT OR IGNORE INTO connector_event_receipts (
        tenant_id, connector, event_id, received_at
      ) VALUES (?, ?, ?, ?)
    `).run(input.tenantId, input.connector, input.eventId, input.receivedAt);
    if (Number(result.changes) === 1) {
      return { claimed: true, receivedAt: input.receivedAt };
    }
    const existing = this.#database.prepare(`
      SELECT received_at FROM connector_event_receipts
      WHERE tenant_id = ? AND connector = ? AND event_id = ?
      LIMIT 1
    `).get(input.tenantId, input.connector, input.eventId) as Row | undefined;
    if (!existing) throw new Error('Connector event receipt could not be loaded');
    return { claimed: false, receivedAt: String(existing.received_at) };
  }

  async releaseConnectorEventReceipt(
    input: ReleaseConnectorEventReceiptInput,
  ): Promise<boolean> {
    const result = this.#database.prepare(`
      DELETE FROM connector_event_receipts
      WHERE tenant_id = ? AND connector = ? AND event_id = ? AND received_at = ?
    `).run(input.tenantId, input.connector, input.eventId, input.receivedAt);
    return Number(result.changes) === 1;
  }

  async createReminder(input: PersistReminderInput): Promise<Reminder> {
    try {
      this.#database.prepare(`
        INSERT INTO reminders (
          id, tenant_id, user_id, title, starts_at, remind_at, status,
          precision, source_asset_id, source_event_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.context.tenantId,
        input.context.userId,
        input.title,
        input.startsAt,
        input.remindAt,
        input.status,
        input.precision,
        input.sourceAssetId ?? null,
        input.sourceEventId ?? null,
        input.createdAt,
      );
    } catch (error) {
      if (input.sourceEventId && String(error).includes('UNIQUE constraint failed')) {
        const existing = await this.findReminderBySourceEvent(input.context, input.sourceEventId);
        if (existing) return existing;
      }
      throw error;
    }
    const reminder = this.#loadReminderById(input.id);
    if (!reminder) throw new Error('Reminder was not persisted');
    return reminder;
  }

  async findReminderBySourceEvent(
    context: AccessContext,
    sourceEventId: string,
  ): Promise<Reminder | null> {
    const row = this.#database.prepare(`
      SELECT * FROM reminders
      WHERE tenant_id = ? AND user_id = ? AND source_event_id = ?
      LIMIT 1
    `).get(context.tenantId, context.userId, sourceEventId) as Row | undefined;
    return row ? this.#mapReminder(row) : null;
  }

  async findReminder(context: AccessContext, id: string): Promise<Reminder | null> {
    const row = this.#database.prepare(`
      SELECT * FROM reminders
      WHERE id = ? AND tenant_id = ? AND user_id = ?
      LIMIT 1
    `).get(id, context.tenantId, context.userId) as Row | undefined;
    return row ? this.#mapReminder(row) : null;
  }

  async listReminders(
    context: AccessContext,
    options: ReminderListOptions = {},
  ): Promise<Reminder[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const offset = Math.max(0, Math.min(options.offset ?? 0, 100_000));
    const statuses = options.status
      ? Array.isArray(options.status) ? options.status : [options.status]
      : [];
    const clauses = ['tenant_id = ?', 'user_id = ?'];
    const values: Array<string | number> = [context.tenantId, context.userId];
    if (statuses.length > 0) {
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      values.push(...statuses);
    }
    if (options.dueBefore) {
      clauses.push('remind_at <= ?');
      values.push(options.dueBefore);
    }
    const rows = this.#database.prepare(`
      SELECT * FROM reminders
      WHERE ${clauses.join(' AND ')}
      ORDER BY remind_at ASC, starts_at ASC, id ASC
      LIMIT ? OFFSET ?
    `).all(...values, limit, offset) as Row[];
    return rows.map((row) => this.#mapReminder(row));
  }

  async updateReminderStatus(
    context: AccessContext,
    id: string,
    status: ReminderStatus,
  ): Promise<Reminder | null> {
    const result = this.#database.prepare(`
      UPDATE reminders SET status = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ?
    `).run(status, id, context.tenantId, context.userId);
    if (Number(result.changes) === 0) return null;
    return this.findReminder(context, id);
  }

  async claimDueReminders(
    at: string,
    limit = 50,
    leaseMs = 300_000,
  ): Promise<Reminder[]> {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const leaseExpiresAt = new Date(new Date(at).getTime() - Math.max(5_000, leaseMs)).toISOString();
    this.#database.exec('BEGIN IMMEDIATE;');
    try {
      const rows = this.#database.prepare(`
        SELECT * FROM reminders
        WHERE status = 'scheduled'
          AND remind_at <= ?
          AND notification_sent_at IS NULL
          AND (notification_claimed_at IS NULL OR notification_claimed_at <= ?)
        ORDER BY remind_at ASC, starts_at ASC, id ASC
        LIMIT ?
      `).all(at, leaseExpiresAt, safeLimit) as Row[];
      const claimed: Reminder[] = [];
      for (const row of rows) {
        const result = this.#database.prepare(`
          UPDATE reminders
          SET notification_claimed_at = ?
          WHERE id = ?
            AND notification_sent_at IS NULL
            AND (notification_claimed_at IS NULL OR notification_claimed_at <= ?)
        `).run(at, String(row.id), leaseExpiresAt);
        if (Number(result.changes) === 1) {
          claimed.push(this.#mapReminder({ ...row, notification_claimed_at: at }));
        }
      }
      this.#database.exec('COMMIT;');
      return claimed;
    } catch (error) {
      this.#database.exec('ROLLBACK;');
      throw error;
    }
  }

  async markReminderNotificationSent(
    id: string,
    claimedAt: string,
    sentAt: string,
  ): Promise<boolean> {
    const result = this.#database.prepare(`
      UPDATE reminders
      SET notification_sent_at = ?, notification_claimed_at = NULL
      WHERE id = ? AND notification_claimed_at = ? AND notification_sent_at IS NULL
    `).run(sentAt, id, claimedAt);
    return Number(result.changes) === 1;
  }

  async releaseReminderNotificationClaim(id: string, claimedAt: string): Promise<boolean> {
    const result = this.#database.prepare(`
      UPDATE reminders
      SET notification_claimed_at = NULL
      WHERE id = ? AND notification_claimed_at = ? AND notification_sent_at IS NULL
    `).run(id, claimedAt);
    return Number(result.changes) === 1;
  }

  close(): void {
    this.#database.close();
  }

  #migrateSchema(): void {
    const initialVersion = this.#userVersion();
    if (initialVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(`Database schema version ${initialVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}`);
    }

    this.#database.exec('BEGIN IMMEDIATE;');
    try {
      let version = initialVersion;
      if (version === 0) {
        this.#createLegacySchema();
        this.#database.exec('PRAGMA user_version = 1;');
        version = 1;
      }
      if (version === 1) {
        this.#ensureReminderColumn('notification_claimed_at');
        this.#ensureReminderColumn('notification_sent_at');
        this.#database.exec(`
          CREATE INDEX IF NOT EXISTS reminders_delivery_lookup
            ON reminders (status, remind_at, notification_sent_at, notification_claimed_at);
        `);
      }
      if (version < 2) {
        this.#migrateScopedAssetIngestions();
        this.#database.exec('PRAGMA user_version = 2;');
        version = 2;
      }
      if (version < 3) {
        this.#migrateFtsIndex();
        this.#database.exec('PRAGMA user_version = 3;');
        version = 3;
      }
      if (version < 4) {
        this.#migrateConnectorEventReceipts();
        this.#database.exec('PRAGMA user_version = 4;');
      }
      this.#database.exec('COMMIT;');
    } catch (error) {
      this.#database.exec('ROLLBACK;');
      throw error;
    }
  }

  #userVersion(): number {
    const row = this.#database.prepare('PRAGMA user_version').get() as Row;
    return Number(row.user_version);
  }

  #createLegacySchema(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS assets (
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

      CREATE UNIQUE INDEX IF NOT EXISTS assets_safe_content_identity
        ON assets (tenant_id, owner_id, visibility, content_hash);
      CREATE INDEX IF NOT EXISTS assets_access_lookup
        ON assets (tenant_id, visibility, owner_id, created_at);

      CREATE TABLE IF NOT EXISTS asset_sources (
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        source_identity TEXT NOT NULL,
        source_type TEXT NOT NULL,
        external_id TEXT,
        source_url TEXT,
        PRIMARY KEY (asset_id, source_identity)
      );

      CREATE TABLE IF NOT EXISTS asset_ingestions (
        tenant_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        PRIMARY KEY (tenant_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        remind_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('scheduled', 'needs_confirmation', 'completed', 'cancelled')),
        precision TEXT NOT NULL CHECK (precision IN ('exact', 'period', 'inferred')),
        source_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
        source_event_id TEXT,
        notification_claimed_at TEXT,
        notification_sent_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (tenant_id, user_id, source_event_id)
      );
      CREATE INDEX IF NOT EXISTS reminders_due_lookup
        ON reminders (tenant_id, user_id, status, remind_at, starts_at);
    `);
  }

  #migrateScopedAssetIngestions(): void {
    this.#database.exec(`
      ALTER TABLE asset_ingestions RENAME TO asset_ingestions_legacy;
      CREATE TABLE asset_ingestions (
        tenant_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT,
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, actor_id, operation, idempotency_key)
      );
      INSERT INTO asset_ingestions (
        tenant_id, actor_id, operation, idempotency_key,
        request_fingerprint, asset_id, created_at
      )
      SELECT
        legacy.tenant_id,
        assets.owner_id,
        'asset.ingest',
        legacy.idempotency_key,
        NULL,
        legacy.asset_id,
        assets.created_at
      FROM asset_ingestions_legacy legacy
      JOIN assets ON assets.id = legacy.asset_id;
      DROP TABLE asset_ingestions_legacy;
      CREATE INDEX asset_ingestions_asset_lookup
        ON asset_ingestions (asset_id);
    `);
  }

  #migrateFtsIndex(): void {
    this.#database.exec(`
      CREATE VIRTUAL TABLE assets_fts USING fts5(
        asset_id UNINDEXED,
        title_terms,
        content_terms,
        tokenize = 'unicode61'
      );
      CREATE TRIGGER assets_fts_delete
      AFTER DELETE ON assets
      BEGIN
        DELETE FROM assets_fts WHERE asset_id = OLD.id;
      END;
      CREATE INDEX IF NOT EXISTS asset_sources_type_lookup
        ON asset_sources (source_type, asset_id);
    `);
    const assets = this.#database.prepare(`
      SELECT id, title, redacted_content FROM assets
      ORDER BY id ASC
    `).all() as Row[];
    for (const asset of assets) {
      this.#insertFtsAsset(
        String(asset.id),
        String(asset.title),
        String(asset.redacted_content),
      );
    }
  }

  #migrateConnectorEventReceipts(): void {
    this.#database.exec(`
      CREATE TABLE connector_event_receipts (
        tenant_id TEXT NOT NULL,
        connector TEXT NOT NULL,
        event_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, connector, event_id)
      );
      CREATE INDEX connector_event_receipts_received_lookup
        ON connector_event_receipts (received_at);
    `);
  }

  #ensureReminderColumn(name: 'notification_claimed_at' | 'notification_sent_at'): void {
    const columns = this.#database.prepare('PRAGMA table_info(reminders)').all() as Row[];
    if (columns.some((column) => String(column.name) === name)) return;
    this.#database.exec(`ALTER TABLE reminders ADD COLUMN ${name} TEXT`);
  }

  #insertSource(assetId: string, source: SourceReference): void {
    const identity = [source.type, source.externalId ?? '', source.url ?? ''].join(':');
    this.#database.prepare(`
      INSERT OR IGNORE INTO asset_sources (
        asset_id, source_identity, source_type, external_id, source_url
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      assetId,
      identity,
      source.type,
      source.externalId ?? null,
      source.url ?? null,
    );
  }

  #insertIngestion(input: PersistAssetInput, assetId: string): void {
    this.#database.prepare(`
      INSERT INTO asset_ingestions (
        tenant_id, actor_id, operation, idempotency_key,
        request_fingerprint, asset_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.context.tenantId,
      input.context.userId,
      input.operation,
      input.idempotencyKey,
      input.requestFingerprint,
      assetId,
      input.createdAt,
    );
  }

  #insertFtsAsset(assetId: string, title: string, content: string): void {
    this.#database.prepare(`
      INSERT INTO assets_fts (asset_id, title_terms, content_terms)
      VALUES (?, ?, ?)
    `).run(
      assetId,
      createFtsIndexText(title),
      createFtsIndexText(content),
    );
  }

  #deduplicatedResult(
    context: AccessContext,
    assetId: string,
    by: DeduplicatedBy,
  ): AssetIngestResult {
    const asset = this.#loadAccessibleAssetById(context, assetId);
    if (!asset) throw new Error('Deduplicated asset no longer exists');
    return { asset, created: false, deduplicatedBy: by };
  }

  #loadAccessibleAssetById(context: AccessContext, id: string): InformationAsset | null {
    const row = this.#database.prepare(`
      SELECT * FROM assets
      WHERE id = ?
        AND tenant_id = ?
        AND (visibility = 'tenant' OR owner_id = ?)
      LIMIT 1
    `).get(id, context.tenantId, context.userId) as Row | undefined;
    return row ? this.#mapAsset(row) : null;
  }

  #loadReminderById(id: string): Reminder | null {
    const row = this.#database.prepare('SELECT * FROM reminders WHERE id = ? LIMIT 1')
      .get(id) as Row | undefined;
    return row ? this.#mapReminder(row) : null;
  }

  #mapAsset(row: Row): InformationAsset {
    const id = String(row.id);
    const sourceRows = this.#database.prepare(`
      SELECT source_type, external_id, source_url
      FROM asset_sources
      WHERE asset_id = ?
      ORDER BY source_identity ASC
    `).all(id) as Row[];

    return {
      id,
      tenantId: String(row.tenant_id),
      ownerId: String(row.owner_id),
      visibility: row.visibility === 'owner' ? 'owner' : 'tenant',
      title: String(row.title),
      redactedContent: String(row.redacted_content),
      contentHash: String(row.content_hash),
      sources: sourceRows.map((sourceRow) => this.#mapSource(sourceRow)),
      secretFindingCount: Number(row.secret_finding_count),
      createdAt: String(row.created_at),
    };
  }

  #mapSource(row: Row): SourceReference {
    const source: SourceReference = {
      type: this.#sourceType(String(row.source_type)),
    };
    if (row.external_id !== null && row.external_id !== undefined) {
      source.externalId = String(row.external_id);
    }
    if (row.source_url !== null && row.source_url !== undefined) {
      source.url = String(row.source_url);
    }
    return source;
  }

  #mapReminder(row: Row): Reminder {
    const reminder: Reminder = {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      userId: String(row.user_id),
      title: String(row.title),
      startsAt: String(row.starts_at),
      remindAt: String(row.remind_at),
      status: this.#reminderStatus(String(row.status)),
      precision: this.#reminderPrecision(String(row.precision)),
      createdAt: String(row.created_at),
    };
    if (row.source_asset_id !== null && row.source_asset_id !== undefined) {
      reminder.sourceAssetId = String(row.source_asset_id);
    }
    if (row.source_event_id !== null && row.source_event_id !== undefined) {
      reminder.sourceEventId = String(row.source_event_id);
    }
    return reminder;
  }

  #reminderStatus(value: string): ReminderStatus {
    const supported: ReminderStatus[] = ['scheduled', 'needs_confirmation', 'completed', 'cancelled'];
    return supported.includes(value as ReminderStatus) ? value as ReminderStatus : 'scheduled';
  }

  #reminderPrecision(value: string): Reminder['precision'] {
    const supported: Reminder['precision'][] = ['exact', 'period', 'inferred'];
    return supported.includes(value as Reminder['precision'])
      ? value as Reminder['precision']
      : 'inferred';
  }

  #sourceType(value: string): SourceReference['type'] {
    const supported: SourceReference['type'][] = [
      'manual',
      'local_file',
      'feishu_message',
      'feishu_document',
    ];
    return supported.includes(value as SourceReference['type'])
      ? value as SourceReference['type']
      : 'manual';
  }
}

interface AssetCursor {
  createdAt: string;
  id: string;
}

function encodeAssetCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), 'utf8').toString('base64url');
}

function decodeAssetCursor(value: string): AssetCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new InvalidAssetCursorError();
    const createdAt = (parsed as { createdAt?: unknown }).createdAt;
    const id = (parsed as { id?: unknown }).id;
    if (
      typeof createdAt !== 'string'
      || !createdAt
      || !Number.isFinite(Date.parse(createdAt))
      || typeof id !== 'string'
      || !id
    ) {
      throw new InvalidAssetCursorError();
    }
    return { createdAt, id };
  } catch (error) {
    if (error instanceof InvalidAssetCursorError) throw error;
    throw new InvalidAssetCursorError();
  }
}
