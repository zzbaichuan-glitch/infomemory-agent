import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

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
  FeishuInstallation,
  FeishuInstallationRepository,
  FeishuOAuthState,
  PersistFeishuInstallationInput,
  PersistFeishuOAuthStateInput,
  RotateFeishuInstallationTokensInput,
} from './feishu-installation-repository.js';
import { FeishuOAuthStateConflictError } from './feishu-installation-repository.js';
import {
  connectorQueueId,
  nextConnectorRetryAt,
  sanitizeQueueError,
  serializeConnectorPayload,
  type ConnectorInboxRecord,
  type ConnectorInboxStatus,
  type ConnectorOutboxRecord,
  type ConnectorOutboxStatus,
  type ConnectorQueueClaimOptions,
  type ConnectorQueueFailureInput,
  type ConnectorQueueFailureResult,
  type ConnectorQueueRepository,
  type ConnectorQueueStats,
  type ConnectorQueueStatusCounts,
  type CompleteConnectorInboxInput,
  type EnqueueConnectorInboxInput,
  type EnqueueConnectorInboxResult,
  type EnqueueConnectorOutboxResult,
  type PersistConnectorOutboxInput,
} from './connector-queue-repository.js';
import type {
  PersistReminderInput,
  ReminderDeliveryRepository,
  ReminderListOptions,
  ReminderRepository,
} from './reminder-repository.js';
import {
  createFtsIndexText,
  createFtsMatchExpression,
  isSingleHanTerm,
  searchTerms,
} from '../search/search-text.js';
import {
  sanitizeContent,
  sanitizeSourceReference,
  sanitizeTitle,
} from '../security/metadata-sanitizer.js';

type Row = Record<string, unknown>;
const CURRENT_SCHEMA_VERSION = 8;

export class SqliteAssetRepository implements
  AssetRepository,
  ReminderRepository,
  ReminderDeliveryRepository,
  ConnectorEventReceiptRepository,
  ConnectorQueueRepository,
  FeishuInstallationRepository {
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
        // Legacy rows have no trustworthy request digest. Fail closed instead
        // of binding an arbitrary new payload to an old idempotency key.
        if (!storedFingerprint || !storedFingerprint.startsWith('v2:')) {
          throw new IdempotencyConflictError();
        }
        if (storedFingerprint !== input.requestFingerprint) {
          throw new IdempotencyConflictError();
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
    const terms = searchTerms(query);
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    // SQLite's bm25() uses statistics from every row in the FTS index. Even
    // when the final WHERE clause is tenant-scoped, an unauthorized document
    // can therefore influence an authorized result's score and ordering. Use
    // a document-local token overlap score instead; it is computed only from
    // rows that pass the access predicate and never exposes global FTS stats.
    const singleCharacterTerms = terms.filter(isSingleHanTerm);
    const scoreTerms = terms.flatMap((term) => isSingleHanTerm(term)
      ? [
        `(CASE WHEN instr(a.title, ?) > 0 THEN 8 ELSE 0 END)`,
        `(CASE WHEN instr(a.redacted_content, ?) > 0 THEN 1 ELSE 0 END)`,
      ]
      : [
        `(CASE WHEN instr(' ' || coalesce(f.title_terms, '') || ' ', ' ' || ? || ' ') > 0 THEN 8 ELSE 0 END)`,
        `(CASE WHEN instr(' ' || coalesce(f.content_terms, '') || ' ', ' ' || ? || ' ') > 0 THEN 1 ELSE 0 END)`,
      ]);
    const scoreExpression = scoreTerms.join(' + ');
    const scoreValues = terms.flatMap((term) => [term, term]);
    const fallbackClause = singleCharacterTerms.length > 0
      ? singleCharacterTerms
        .map(() => '(instr(a.title, ?) > 0 OR instr(a.redacted_content, ?) > 0)')
        .join(' OR ')
      : '0';
    const fallbackValues = singleCharacterTerms.flatMap((term) => [term, term]);
    const rows = this.#database.prepare(`
      SELECT a.*, (${scoreExpression}) AS search_score
      FROM assets a
      LEFT JOIN assets_fts f ON a.id = f.asset_id
      WHERE a.tenant_id = ?
        AND (a.visibility = 'tenant' OR a.owner_id = ?)
        AND (a.id IN (SELECT asset_id FROM assets_fts WHERE assets_fts MATCH ?)
          OR ${fallbackClause})
      ORDER BY search_score DESC, a.created_at DESC, a.id ASC
      LIMIT ?
    `).all(
      ...scoreValues,
      context.tenantId,
      context.userId,
      matchExpression,
      ...fallbackValues,
      limit,
    ) as Row[];

    return rows.map((row) => ({
      asset: this.#mapAsset(row),
      score: Math.max(1, Number(row.search_score)),
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

  async createFeishuOAuthState(input: PersistFeishuOAuthStateInput): Promise<void> {
    // Keep this table bounded during normal operation.  Cleanup is best
    // effort; it is intentionally separate from state validation below.
    this.#database.prepare(`
      DELETE FROM feishu_oauth_states
      WHERE expires_at <= ? OR consumed_at IS NOT NULL
    `).run(input.createdAt);
    try {
      this.#database.prepare(`
        INSERT INTO feishu_oauth_states (
          state_hash, app_id, redirect_uri, tenant_id, user_id, return_to,
          encrypted_code_verifier, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.stateHash,
        input.appId,
        input.redirectUri,
        input.tenantId ?? null,
        input.userId ?? null,
        input.returnTo ?? null,
        input.encryptedCodeVerifier ?? null,
        input.createdAt,
        input.expiresAt,
      );
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) {
        throw new FeishuOAuthStateConflictError();
      }
      throw error;
    }
  }

  async consumeFeishuOAuthState(
    stateHash: string,
    now: string,
  ): Promise<FeishuOAuthState | null> {
    this.#database.exec('BEGIN IMMEDIATE;');
    try {
      const row = this.#database.prepare(`
        SELECT state_hash, app_id, redirect_uri, tenant_id, user_id,
               return_to, encrypted_code_verifier, created_at, expires_at
        FROM feishu_oauth_states
        WHERE state_hash = ?
          AND consumed_at IS NULL
          AND expires_at > ?
        LIMIT 1
      `).get(stateHash, now) as Row | undefined;
      if (!row) {
        this.#database.exec('COMMIT;');
        return null;
      }
      const result = this.#database.prepare(`
        UPDATE feishu_oauth_states
        SET consumed_at = ?
        WHERE state_hash = ?
          AND consumed_at IS NULL
          AND expires_at > ?
      `).run(now, stateHash, now);
      if (Number(result.changes) !== 1) {
        this.#database.exec('COMMIT;');
        return null;
      }
      this.#database.exec('COMMIT;');
      return this.#mapFeishuOAuthState({ ...row, consumed_at: now });
    } catch (error) {
      this.#database.exec('ROLLBACK;');
      throw error;
    }
  }

  async upsertFeishuInstallation(
    input: PersistFeishuInstallationInput,
  ): Promise<FeishuInstallation> {
    const scopes = uniqueSortedStrings(input.scopes);
    this.#database.prepare(`
      INSERT INTO feishu_installations (
        tenant_id, app_id, tenant_name, encrypted_access_token,
        encrypted_refresh_token, access_token_expires_at,
        refresh_token_expires_at, scopes_json, open_id, union_id,
        installed_by_user_id, status, created_at, updated_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
      ON CONFLICT (tenant_id, app_id) DO UPDATE SET
        tenant_name = excluded.tenant_name,
        encrypted_access_token = excluded.encrypted_access_token,
        encrypted_refresh_token = COALESCE(
          excluded.encrypted_refresh_token,
          feishu_installations.encrypted_refresh_token
        ),
        access_token_expires_at = excluded.access_token_expires_at,
        refresh_token_expires_at = COALESCE(
          excluded.refresh_token_expires_at,
          feishu_installations.refresh_token_expires_at
        ),
        scopes_json = excluded.scopes_json,
        open_id = excluded.open_id,
        union_id = excluded.union_id,
        installed_by_user_id = excluded.installed_by_user_id,
        status = 'active',
        updated_at = excluded.updated_at,
        revoked_at = NULL
    `).run(
      input.tenantId,
      input.appId,
      input.tenantName ?? null,
      input.encryptedAccessToken,
      input.encryptedRefreshToken ?? null,
      input.accessTokenExpiresAt ?? null,
      input.refreshTokenExpiresAt ?? null,
      JSON.stringify(scopes),
      input.openId ?? null,
      input.unionId ?? null,
      input.installedByUserId ?? null,
      input.installedAt,
      input.installedAt,
    );
    const installation = await this.findFeishuInstallation(input.tenantId, input.appId);
    if (!installation) throw new Error('Feishu installation was not persisted');
    return installation;
  }

  async rotateFeishuInstallationTokens(
    input: RotateFeishuInstallationTokensInput,
  ): Promise<boolean> {
    const result = this.#database.prepare(`
      UPDATE feishu_installations
      SET encrypted_access_token = ?,
          encrypted_refresh_token = COALESCE(?, encrypted_refresh_token),
          access_token_expires_at = COALESCE(?, access_token_expires_at),
          refresh_token_expires_at = COALESCE(?, refresh_token_expires_at),
          scopes_json = COALESCE(?, scopes_json),
          updated_at = ?,
          status = 'active',
          revoked_at = NULL
      WHERE tenant_id = ?
        AND app_id = ?
        AND status = 'active'
        AND updated_at = ?
        AND (
          (? IS NULL AND encrypted_refresh_token IS NULL)
          OR encrypted_refresh_token = ?
        )
    `).run(
      input.encryptedAccessToken,
      input.encryptedRefreshToken ?? null,
      input.accessTokenExpiresAt ?? null,
      input.refreshTokenExpiresAt ?? null,
      input.scopes && input.scopes.length > 0
        ? JSON.stringify(uniqueSortedStrings(input.scopes))
        : null,
      input.updatedAt,
      input.tenantId,
      input.appId,
      input.expectedUpdatedAt,
      input.expectedEncryptedRefreshToken ?? null,
      input.expectedEncryptedRefreshToken ?? null,
    );
    return Number(result.changes) === 1;
  }

  async findFeishuInstallation(
    tenantId: string,
    appId?: string,
  ): Promise<FeishuInstallation | null> {
    const row = appId
      ? this.#database.prepare(`
        SELECT * FROM feishu_installations
        WHERE tenant_id = ? AND app_id = ?
        LIMIT 1
      `).get(tenantId, appId) as Row | undefined
      : this.#database.prepare(`
        SELECT * FROM feishu_installations
        WHERE tenant_id = ?
        ORDER BY updated_at DESC, app_id ASC
        LIMIT 1
      `).get(tenantId) as Row | undefined;
    return row ? this.#mapFeishuInstallation(row) : null;
  }

  async revokeFeishuInstallation(
    tenantId: string,
    appId: string,
    revokedAt: string,
  ): Promise<boolean> {
    const result = this.#database.prepare(`
      UPDATE feishu_installations
      SET status = 'revoked',
          encrypted_access_token = '',
          encrypted_refresh_token = NULL,
          access_token_expires_at = NULL,
          refresh_token_expires_at = NULL,
          revoked_at = ?,
          updated_at = ?
      WHERE tenant_id = ? AND app_id = ? AND status = 'active'
    `).run(revokedAt, revokedAt, tenantId, appId);
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

  async deleteReminder(context: AccessContext, id: string): Promise<boolean> {
    const result = this.#database.prepare(`
      DELETE FROM reminders
      WHERE id = ? AND tenant_id = ? AND user_id = ?
    `).run(id, context.tenantId, context.userId);
    return Number(result.changes) === 1;
  }

  async updateReminderStatus(
    context: AccessContext,
    id: string,
    status: ReminderStatus,
    expectedStatus?: ReminderStatus,
  ): Promise<Reminder | null> {
    const expectedClause = expectedStatus ? ' AND status = ?' : '';
    const result = this.#database.prepare(`
      UPDATE reminders SET status = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ?
      ${expectedClause}
    `).run(
      ...(
        expectedStatus
          ? [status, id, context.tenantId, context.userId, expectedStatus]
          : [status, id, context.tenantId, context.userId]
      ),
    );
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

  async enqueueConnectorInbox(
    input: EnqueueConnectorInboxInput,
  ): Promise<EnqueueConnectorInboxResult> {
    const serialized = serializeConnectorPayload(input.payload);
    if (input.payloadHash && input.payloadHash !== serialized.hash) {
      throw new Error('Connector payload hash does not match the sanitized payload');
    }
    const receivedAt = normalizeQueueTimestamp(input.receivedAt ?? new Date().toISOString(), 'receivedAt');
    const id = input.id ?? connectorQueueId('inbox');
    this.#assertQueueIdentity(input.tenantId, input.connector, input.eventId);
    this.#assertQueueTimestamp(receivedAt, 'receivedAt');
    this.#assertQueueId(id, 'inbox id');
    this.#database.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.#database.prepare(`
        SELECT * FROM connector_inbox
        WHERE tenant_id = ? AND connector = ? AND event_id = ?
        LIMIT 1
      `).get(input.tenantId, input.connector, input.eventId) as Row | undefined;
      if (existing) {
        const record = this.#mapConnectorInbox(existing);
        this.#database.exec('COMMIT;');
        return {
          id: record.id,
          created: false,
          duplicate: record.payloadHash === serialized.hash,
          conflict: record.payloadHash !== serialized.hash,
          status: record.status,
          record,
        };
      }
      this.#database.prepare(`
        INSERT INTO connector_inbox (
          id, tenant_id, connector, event_id, payload_json, payload_hash,
          status, attempts, available_at, claimed_at, claim_token,
          lease_expires_at, last_error, processed_at, dead_lettered_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        id,
        input.tenantId,
        input.connector,
        input.eventId,
        serialized.json,
        serialized.hash,
        receivedAt,
        receivedAt,
        receivedAt,
      );
      const row = this.#database.prepare('SELECT * FROM connector_inbox WHERE id = ?').get(id) as Row | undefined;
      if (!row) throw new Error('Connector inbox row was not persisted');
      const record = this.#mapConnectorInbox(row);
      this.#database.exec('COMMIT;');
      return { id, created: true, duplicate: false, conflict: false, status: record.status, record };
    } catch (error) {
      this.#database.exec('ROLLBACK;');
      // A concurrent writer may have won the unique race. Return its row as a
      // normal idempotent result instead of leaking SQLite implementation errors.
      if (String(error).includes('UNIQUE constraint failed')) {
        const existing = this.#database.prepare(`
          SELECT * FROM connector_inbox
          WHERE tenant_id = ? AND connector = ? AND event_id = ?
          LIMIT 1
        `).get(input.tenantId, input.connector, input.eventId) as Row | undefined;
        if (existing) {
          const record = this.#mapConnectorInbox(existing);
          return {
            id: record.id,
            created: false,
            duplicate: record.payloadHash === serialized.hash,
            conflict: record.payloadHash !== serialized.hash,
            status: record.status,
            record,
          };
        }
      }
      throw error;
    }
  }

  async claimConnectorInbox(
    options: ConnectorQueueClaimOptions = {},
  ): Promise<ConnectorInboxRecord[]> {
    const now = normalizeQueueTimestamp(options.now ?? new Date().toISOString(), 'now');
    this.#assertQueueTimestamp(now, 'now');
    const limit = boundedQueueInteger(options.limit, 1, 200, 25);
    const leaseMs = boundedQueueInteger(options.leaseMs, 1_000, 86_400_000, 300_000);
    const leaseExpiresAt = queueTimeAfter(now, leaseMs);
    this.#database.exec('BEGIN IMMEDIATE;');
    try {
      const rows = this.#database.prepare(`
        SELECT * FROM connector_inbox
        WHERE available_at <= ?
          AND (
            status IN ('queued', 'retrying')
            OR (status = 'processing' AND lease_expires_at <= ?)
          )
        ORDER BY available_at ASC, created_at ASC, id ASC
        LIMIT ?
      `).all(now, now, limit) as Row[];
      const claimed: ConnectorInboxRecord[] = [];
      for (const row of rows) {
        const claimToken = randomUUID();
        const result = this.#database.prepare(`
          UPDATE connector_inbox
          SET status = 'processing', attempts = attempts + 1,
              claimed_at = ?, claim_token = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = ?
            AND available_at <= ?
            AND (
              status IN ('queued', 'retrying')
              OR (status = 'processing' AND lease_expires_at <= ?)
            )
        `).run(now, claimToken, leaseExpiresAt, now, String(row.id), now, now);
        if (Number(result.changes) !== 1) continue;
        const claimedRow = this.#database.prepare('SELECT * FROM connector_inbox WHERE id = ?').get(String(row.id)) as Row | undefined;
        if (claimedRow) claimed.push(this.#mapConnectorInbox(claimedRow));
      }
      this.#database.exec('COMMIT;');
      return claimed;
    } catch (error) {
      this.#database.exec('ROLLBACK;');
      throw error;
    }
  }

  async completeConnectorInbox(input: CompleteConnectorInboxInput): Promise<boolean> {
    const processedAt = normalizeQueueTimestamp(input.processedAt ?? new Date().toISOString(), 'processedAt');
    this.#assertQueueId(input.id, 'inbox id');
    this.#assertQueueId(input.claimToken, 'inbox claim token');
    this.#assertQueueTimestamp(processedAt, 'processedAt');
    this.#database.exec('BEGIN IMMEDIATE;');
    try {
      const current = this.#database.prepare(`
        SELECT tenant_id FROM connector_inbox
        WHERE id = ? AND status = 'processing' AND claim_token = ?
        LIMIT 1
      `).get(input.id, input.claimToken) as Row | undefined;
      if (!current) {
        this.#database.exec('COMMIT;');
        return false;
      }
      for (const outbox of input.outbox ?? []) {
        if (outbox.tenantId !== String(current.tenant_id)) {
          throw new Error('Connector outbox tenant must match its inbox tenant');
        }
        if (outbox.sourceInboxId && outbox.sourceInboxId !== input.id) {
          throw new Error('Connector outbox source inbox must match the completing inbox');
        }
        this.#insertConnectorOutbox(
          outbox.sourceInboxId ? outbox : { ...outbox, sourceInboxId: input.id },
          outbox.availableAt ?? processedAt,
        );
      }
      const result = this.#database.prepare(`
        UPDATE connector_inbox
        SET status = 'completed', processed_at = ?, claimed_at = NULL,
            claim_token = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'processing' AND claim_token = ?
      `).run(processedAt, processedAt, input.id, input.claimToken);
      this.#database.exec('COMMIT;');
      return Number(result.changes) === 1;
    } catch (error) {
      this.#database.exec('ROLLBACK;');
      throw error;
    }
  }

  async failConnectorInbox(input: ConnectorQueueFailureInput): Promise<ConnectorQueueFailureResult> {
    return this.#failConnectorQueueRow('connector_inbox', input);
  }

  async retryConnectorInbox(id: string, availableAt = new Date().toISOString(), tenantId?: string): Promise<boolean> {
    availableAt = normalizeQueueTimestamp(availableAt, 'availableAt');
    this.#assertQueueId(id, 'inbox id');
    this.#assertQueueTimestamp(availableAt, 'availableAt');
    const tenantClause = tenantId ? ' AND tenant_id = ?' : '';
    const result = this.#database.prepare(`
      UPDATE connector_inbox
      SET status = 'queued', attempts = 0, available_at = ?,
          claimed_at = NULL, claim_token = NULL, lease_expires_at = NULL,
          last_error = NULL, dead_lettered_at = NULL, updated_at = ?
      WHERE id = ? AND status IN ('retrying', 'dead_letter')${tenantClause}
    `).run(...(tenantId ? [availableAt, availableAt, id, tenantId] : [availableAt, availableAt, id]));
    return Number(result.changes) === 1;
  }

  async cancelConnectorInbox(id: string, cancelledAt = new Date().toISOString(), tenantId?: string): Promise<boolean> {
    cancelledAt = normalizeQueueTimestamp(cancelledAt, 'cancelledAt');
    this.#assertQueueId(id, 'inbox id');
    this.#assertQueueTimestamp(cancelledAt, 'cancelledAt');
    const tenantClause = tenantId ? ' AND tenant_id = ?' : '';
    const result = this.#database.prepare(`
      UPDATE connector_inbox
      SET status = 'dead_letter', available_at = ?,
          claimed_at = NULL, claim_token = NULL, lease_expires_at = NULL,
          last_error = 'cancelled_by_operator', dead_lettered_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'retrying')${tenantClause}
    `).run(...(tenantId
      ? [cancelledAt, cancelledAt, cancelledAt, id, tenantId]
      : [cancelledAt, cancelledAt, cancelledAt, id]));
    return Number(result.changes) === 1;
  }

  async enqueueConnectorOutbox(
    input: PersistConnectorOutboxInput,
  ): Promise<EnqueueConnectorOutboxResult> {
    this.#assertQueueIdentity(input.tenantId, input.connector, input.dedupeKey);
    const serialized = serializeConnectorPayload(input.payload);
    const availableAt = normalizeQueueTimestamp(input.availableAt ?? new Date().toISOString(), 'availableAt');
    this.#assertQueueTimestamp(availableAt, 'availableAt');
    this.#assertQueueId(input.id ?? '', 'outbox id', input.id === undefined);
    this.#assertQueueDestination(input.destination);
    this.#database.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.#database.prepare(`
        SELECT * FROM connector_outbox
        WHERE tenant_id = ? AND connector = ? AND dedupe_key = ?
        LIMIT 1
      `).get(input.tenantId, input.connector, input.dedupeKey) as Row | undefined;
      if (existing) {
        const record = this.#mapConnectorOutbox(existing);
        const same = record.payloadHash === serialized.hash
          && record.destination === input.destination;
        this.#database.exec('COMMIT;');
        return {
          id: record.id,
          created: false,
          duplicate: same,
          conflict: !same,
          record,
        };
      }
      this.#insertConnectorOutbox(input, availableAt);
      const row = this.#database.prepare(`
        SELECT * FROM connector_outbox WHERE tenant_id = ? AND connector = ? AND dedupe_key = ?
      `).get(input.tenantId, input.connector, input.dedupeKey) as Row | undefined;
      if (!row) throw new Error('Connector outbox row was not persisted');
      const record = this.#mapConnectorOutbox(row);
      this.#database.exec('COMMIT;');
      return { id: record.id, created: true, duplicate: false, conflict: false, record };
    } catch (error) {
      this.#database.exec('ROLLBACK;');
      if (String(error).includes('UNIQUE constraint failed')) {
        const existing = this.#database.prepare(`
          SELECT * FROM connector_outbox
          WHERE tenant_id = ? AND connector = ? AND dedupe_key = ?
          LIMIT 1
        `).get(input.tenantId, input.connector, input.dedupeKey) as Row | undefined;
        if (existing) {
          const record = this.#mapConnectorOutbox(existing);
          const same = record.payloadHash === serialized.hash
            && record.destination === input.destination;
          return {
            id: record.id,
            created: false,
            duplicate: same,
            conflict: !same,
            record,
          };
        }
      }
      throw error;
    }
  }

  async claimConnectorOutbox(
    options: ConnectorQueueClaimOptions = {},
  ): Promise<ConnectorOutboxRecord[]> {
    const now = normalizeQueueTimestamp(options.now ?? new Date().toISOString(), 'now');
    this.#assertQueueTimestamp(now, 'now');
    const limit = boundedQueueInteger(options.limit, 1, 200, 25);
    const leaseMs = boundedQueueInteger(options.leaseMs, 1_000, 86_400_000, 300_000);
    const leaseExpiresAt = queueTimeAfter(now, leaseMs);
    this.#database.exec('BEGIN IMMEDIATE;');
    try {
      const rows = this.#database.prepare(`
        SELECT * FROM connector_outbox
        WHERE available_at <= ?
          AND (
            status IN ('queued', 'retrying')
            OR (status = 'processing' AND lease_expires_at <= ?)
          )
        ORDER BY available_at ASC, created_at ASC, id ASC
        LIMIT ?
      `).all(now, now, limit) as Row[];
      const claimed: ConnectorOutboxRecord[] = [];
      for (const row of rows) {
        const claimToken = randomUUID();
        const result = this.#database.prepare(`
          UPDATE connector_outbox
          SET status = 'processing', attempts = attempts + 1,
              claimed_at = ?, claim_token = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = ?
            AND available_at <= ?
            AND (
              status IN ('queued', 'retrying')
              OR (status = 'processing' AND lease_expires_at <= ?)
            )
        `).run(now, claimToken, leaseExpiresAt, now, String(row.id), now, now);
        if (Number(result.changes) !== 1) continue;
        const claimedRow = this.#database.prepare('SELECT * FROM connector_outbox WHERE id = ?').get(String(row.id)) as Row | undefined;
        if (claimedRow) claimed.push(this.#mapConnectorOutbox(claimedRow));
      }
      this.#database.exec('COMMIT;');
      return claimed;
    } catch (error) {
      this.#database.exec('ROLLBACK;');
      throw error;
    }
  }

  async completeConnectorOutbox(id: string, claimToken: string, sentAt = new Date().toISOString()): Promise<boolean> {
    sentAt = normalizeQueueTimestamp(sentAt, 'sentAt');
    this.#assertQueueId(id, 'outbox id');
    this.#assertQueueId(claimToken, 'outbox claim token');
    this.#assertQueueTimestamp(sentAt, 'sentAt');
    const result = this.#database.prepare(`
      UPDATE connector_outbox
      SET status = 'sent', sent_at = ?, claimed_at = NULL,
          claim_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'processing' AND claim_token = ?
    `).run(sentAt, sentAt, id, claimToken);
    return Number(result.changes) === 1;
  }

  async failConnectorOutbox(input: ConnectorQueueFailureInput): Promise<ConnectorQueueFailureResult> {
    return this.#failConnectorQueueRow('connector_outbox', input);
  }

  async retryConnectorOutbox(id: string, availableAt = new Date().toISOString(), tenantId?: string): Promise<boolean> {
    availableAt = normalizeQueueTimestamp(availableAt, 'availableAt');
    this.#assertQueueId(id, 'outbox id');
    this.#assertQueueTimestamp(availableAt, 'availableAt');
    const tenantClause = tenantId ? ' AND tenant_id = ?' : '';
    const result = this.#database.prepare(`
      UPDATE connector_outbox
      SET status = 'queued', attempts = 0, available_at = ?,
          claimed_at = NULL, claim_token = NULL, lease_expires_at = NULL,
          last_error = NULL, dead_lettered_at = NULL, updated_at = ?
      WHERE id = ? AND status IN ('retrying', 'dead_letter')${tenantClause}
    `).run(...(tenantId ? [availableAt, availableAt, id, tenantId] : [availableAt, availableAt, id]));
    return Number(result.changes) === 1;
  }

  async cancelConnectorOutbox(id: string, cancelledAt = new Date().toISOString(), tenantId?: string): Promise<boolean> {
    cancelledAt = normalizeQueueTimestamp(cancelledAt, 'cancelledAt');
    this.#assertQueueId(id, 'outbox id');
    this.#assertQueueTimestamp(cancelledAt, 'cancelledAt');
    const tenantClause = tenantId ? ' AND tenant_id = ?' : '';
    const result = this.#database.prepare(`
      UPDATE connector_outbox
      SET status = 'dead_letter', available_at = ?,
          claimed_at = NULL, claim_token = NULL, lease_expires_at = NULL,
          last_error = 'cancelled_by_operator', dead_lettered_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'retrying')${tenantClause}
    `).run(...(tenantId
      ? [cancelledAt, cancelledAt, cancelledAt, id, tenantId]
      : [cancelledAt, cancelledAt, cancelledAt, id]));
    return Number(result.changes) === 1;
  }

  async getConnectorQueueStats(connector?: string, tenantId?: string): Promise<ConnectorQueueStats> {
    if (connector !== undefined) this.#assertQueueIdentity(tenantId ?? '__all__', connector, 'stats');
    if (tenantId !== undefined && (tenantId.trim().length === 0 || tenantId.length > 500)) {
      throw new TypeError('tenantId must be a non-empty string of at most 500 characters');
    }
    const generatedAt = new Date().toISOString();
    const filters = [
      ...(connector ? ['connector = ?'] : []),
      ...(tenantId ? ['tenant_id = ?'] : []),
    ];
    const connectorClause = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
    const params = [
      ...(connector ? [connector] : []),
      ...(tenantId ? [tenantId] : []),
    ];
    const inboxRows = this.#database.prepare(`
      SELECT status, COUNT(*) AS count FROM connector_inbox${connectorClause} GROUP BY status
    `).all(...params) as Row[];
    const outboxRows = this.#database.prepare(`
      SELECT status, COUNT(*) AS count FROM connector_outbox${connectorClause} GROUP BY status
    `).all(...params) as Row[];
    const inbox = queueStatusCounts(inboxRows, ['queued', 'processing', 'retrying', 'completed', 'dead_letter']);
    const outbox = queueStatusCounts(outboxRows, ['queued', 'processing', 'retrying', 'sent', 'dead_letter']);
    const pendingFilters = ["status IN ('queued', 'retrying')", ...(connector ? ['connector = ?'] : []), ...(tenantId ? ['tenant_id = ?'] : [])];
    const pendingParams = [
      ...(connector ? [connector] : []),
      ...(tenantId ? [tenantId] : []),
    ];
    const oldestInbox = this.#database.prepare(`
      SELECT MIN(available_at) AS value FROM connector_inbox
      WHERE ${pendingFilters.join(' AND ')}
    `).get(...pendingParams) as Row;
    const oldestOutbox = this.#database.prepare(`
      SELECT MIN(available_at) AS value FROM connector_outbox
      WHERE ${pendingFilters.join(' AND ')}
    `).get(...pendingParams) as Row;
    return {
      ...(connector ? { connector } : {}),
      inbox,
      outbox,
      oldestInboxAvailableAt: valueOrNull(oldestInbox?.value),
      oldestOutboxAvailableAt: valueOrNull(oldestOutbox?.value),
      generatedAt,
    };
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
        version = 4;
      }
      if (version < 5) {
        this.#migrateSensitiveMetadata();
        this.#database.exec('PRAGMA user_version = 5;');
        version = 5;
      }
      if (version < 6) {
        this.#migrateFeishuInstallations();
        this.#database.exec('PRAGMA user_version = 6;');
        version = 6;
      }
      if (version < 7) {
        this.#migrateConnectorQueues();
        this.#database.exec('PRAGMA user_version = 7;');
        version = 7;
      }
      if (version < 8) {
        this.#migrateFeishuOAuthPkce();
        this.#database.exec('PRAGMA user_version = 8;');
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
    // The schema migration runs the metadata sanitizer in v5 immediately
    // after creating this index. Keeping sanitization in that single step
    // avoids counting already-redacted placeholders twice during a v0/v1
    // upgrade while the enclosing transaction keeps raw rows private.
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

  #migrateSensitiveMetadata(rebuildFts = true): void {
    const assets = this.#database.prepare(`
      SELECT id, title, redacted_content, content_hash, secret_finding_count
      FROM assets
      ORDER BY id ASC
    `).all() as Row[];
    for (const asset of assets) {
      const title = sanitizeTitle(String(asset.title));
      const content = sanitizeContent(String(asset.redacted_content));
      const additionalFindings = title.findingCount + content.findingCount;
      // Recompute from the sanitized value. A legacy 64-character hash may
      // have been derived from raw content and must not prevent safe dedup.
      const contentHash = createHash('sha256')
        .update(content.value, 'utf8')
        .digest('hex');
      this.#database.prepare(`
        UPDATE assets
        SET title = ?, redacted_content = ?,
            content_hash = ?, secret_finding_count = secret_finding_count + ?
        WHERE id = ?
      `).run(
        title.value,
        content.value,
        contentHash,
        additionalFindings,
        String(asset.id),
      );
    }

    const sources = this.#database.prepare(`
      SELECT asset_id, source_identity, source_type, external_id, source_url
      FROM asset_sources
      ORDER BY asset_id ASC, source_identity ASC
    `).all() as Row[];
    for (const source of sources) {
      const sanitized = sanitizeSourceReference({
        type: this.#sourceType(String(source.source_type)),
        ...(source.external_id !== null && source.external_id !== undefined
          ? { externalId: String(source.external_id) }
          : {}),
        ...(source.source_url !== null && source.source_url !== undefined
          ? { url: String(source.source_url) }
          : {}),
      });
      const externalId = sanitized.source.externalId ?? null;
      const sourceUrl = sanitized.source.url ?? null;
      // source_identity is internal but still lives in the database. Replace
      // the legacy raw value with a deterministic digest so secrets cannot
      // survive in an otherwise hidden uniqueness key.
      const currentSourceIdentity = String(source.source_identity);
      const sourceIdentity = currentSourceIdentity.startsWith('legacy:')
        ? currentSourceIdentity
        : `legacy:${createHash('sha256')
          .update(currentSourceIdentity, 'utf8')
          .digest('hex')}`;
      this.#database.prepare(`
        UPDATE asset_sources
        SET source_identity = ?, external_id = ?, source_url = ?
        WHERE asset_id = ? AND source_identity = ?
      `).run(
        sourceIdentity,
        externalId,
        sourceUrl,
        String(source.asset_id),
        String(source.source_identity),
      );
    }

    const reminders = this.#database.prepare(`
      SELECT id, title FROM reminders ORDER BY id ASC
    `).all() as Row[];
    for (const reminder of reminders) {
      const title = sanitizeTitle(String(reminder.title));
      this.#database.prepare(`
        UPDATE reminders SET title = ? WHERE id = ?
      `).run(title.value, String(reminder.id));
    }

    if (rebuildFts && this.#tableExists('assets_fts')) {
      this.#database.exec('DELETE FROM assets_fts;');
      const currentAssets = this.#database.prepare(`
        SELECT id, title, redacted_content FROM assets ORDER BY id ASC
      `).all() as Row[];
      for (const asset of currentAssets) {
        this.#insertFtsAsset(
          String(asset.id),
          String(asset.title),
          String(asset.redacted_content),
        );
      }
    }
  }

  #tableExists(name: string): boolean {
    const row = this.#database.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type IN ('table', 'virtual table') AND name = ? LIMIT 1
    `).get(name) as Row | undefined;
    return Boolean(row);
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

  #migrateFeishuInstallations(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS feishu_oauth_states (
        state_hash TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        tenant_id TEXT,
        user_id TEXT,
        return_to TEXT,
        encrypted_code_verifier TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS feishu_oauth_states_expiry_lookup
        ON feishu_oauth_states (expires_at, consumed_at);

      CREATE TABLE IF NOT EXISTS feishu_installations (
        tenant_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        tenant_name TEXT,
        encrypted_access_token TEXT NOT NULL,
        encrypted_refresh_token TEXT,
        access_token_expires_at TEXT,
        refresh_token_expires_at TEXT,
        scopes_json TEXT NOT NULL DEFAULT '[]',
        open_id TEXT,
        union_id TEXT,
        installed_by_user_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (tenant_id, app_id)
      );
      CREATE INDEX IF NOT EXISTS feishu_installations_status_lookup
        ON feishu_installations (tenant_id, status, updated_at);
    `);
    const stateColumns = this.#database.prepare('PRAGMA table_info(feishu_oauth_states)').all() as Row[];
    if (!stateColumns.some((column) => String(column.name) === 'encrypted_code_verifier')) {
      this.#database.exec('ALTER TABLE feishu_oauth_states ADD COLUMN encrypted_code_verifier TEXT');
    }
  }

  #migrateFeishuOAuthPkce(): void {
    if (!this.#tableExists('feishu_oauth_states')) return;
    const columns = this.#database.prepare('PRAGMA table_info(feishu_oauth_states)').all() as Row[];
    if (columns.some((column) => String(column.name) === 'encrypted_code_verifier')) return;
    this.#database.exec('ALTER TABLE feishu_oauth_states ADD COLUMN encrypted_code_verifier TEXT');
  }

  #migrateConnectorQueues(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS connector_inbox (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        connector TEXT NOT NULL,
        event_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'retrying', 'completed', 'dead_letter')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        available_at TEXT NOT NULL,
        claimed_at TEXT,
        claim_token TEXT,
        lease_expires_at TEXT,
        last_error TEXT,
        processed_at TEXT,
        dead_lettered_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, connector, event_id)
      );
      CREATE INDEX IF NOT EXISTS connector_inbox_claim_lookup
        ON connector_inbox (status, available_at, lease_expires_at, created_at);
      CREATE INDEX IF NOT EXISTS connector_inbox_tenant_lookup
        ON connector_inbox (tenant_id, connector, status, created_at);

      CREATE TABLE IF NOT EXISTS connector_outbox (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        connector TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        destination TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'retrying', 'sent', 'dead_letter')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        available_at TEXT NOT NULL,
        claimed_at TEXT,
        claim_token TEXT,
        lease_expires_at TEXT,
        last_error TEXT,
        sent_at TEXT,
        dead_lettered_at TEXT,
        source_inbox_id TEXT REFERENCES connector_inbox(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, connector, dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS connector_outbox_claim_lookup
        ON connector_outbox (status, available_at, lease_expires_at, created_at);
      CREATE INDEX IF NOT EXISTS connector_outbox_tenant_lookup
        ON connector_outbox (tenant_id, connector, status, created_at);
    `);
  }

  #ensureReminderColumn(name: 'notification_claimed_at' | 'notification_sent_at'): void {
    const columns = this.#database.prepare('PRAGMA table_info(reminders)').all() as Row[];
    if (columns.some((column) => String(column.name) === name)) return;
    this.#database.exec(`ALTER TABLE reminders ADD COLUMN ${name} TEXT`);
  }

  #assertQueueIdentity(tenantId: string, connector: string, key: string): void {
    for (const [label, value] of [['tenantId', tenantId], ['connector', connector], ['queueKey', key]] as const) {
      if (typeof value !== 'string' || value.trim().length === 0 || value.length > 500) {
        throw new TypeError(`${label} must be a non-empty string of at most 500 characters`);
      }
    }
  }

  #assertQueueId(id: string, label: string, allowEmpty = false): void {
    if (allowEmpty && id === '') return;
    if (typeof id !== 'string' || id.trim().length === 0 || id.length > 200) {
      throw new TypeError(`${label} must be a non-empty string of at most 200 characters`);
    }
  }

  #assertQueueTimestamp(value: string, label: string): void {
    if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) {
      throw new TypeError(`${label} must be a valid ISO timestamp`);
    }
  }

  #assertQueueDestination(value: string): void {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > 500) {
      throw new TypeError('Connector outbox destination must be a non-empty string of at most 500 characters');
    }
  }

  #insertConnectorOutbox(input: PersistConnectorOutboxInput, availableAt: string): void {
    availableAt = normalizeQueueTimestamp(availableAt, 'availableAt');
    const serialized = serializeConnectorPayload(input.payload);
    const id = input.id ?? connectorQueueId('outbox');
    this.#assertQueueIdentity(input.tenantId, input.connector, input.dedupeKey);
    this.#assertQueueId(id, 'outbox id');
    this.#assertQueueDestination(input.destination);
    this.#assertQueueTimestamp(availableAt, 'availableAt');
    if (input.sourceInboxId) {
      this.#assertQueueId(input.sourceInboxId, 'source inbox id');
      const source = this.#database.prepare(`
        SELECT tenant_id, connector FROM connector_inbox WHERE id = ? LIMIT 1
      `).get(input.sourceInboxId) as Row | undefined;
      if (!source
        || String(source.tenant_id) !== input.tenantId
        || String(source.connector) !== input.connector) {
        throw new Error('Connector outbox source inbox does not belong to the same tenant/connector');
      }
    }
    try {
      this.#database.prepare(`
        INSERT INTO connector_outbox (
          id, tenant_id, connector, dedupe_key, destination,
          payload_json, payload_hash, status, attempts, available_at,
          claimed_at, claim_token, lease_expires_at, last_error,
          sent_at, dead_lettered_at, source_inbox_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)
      `).run(
        id,
        input.tenantId,
        input.connector,
        input.dedupeKey,
        input.destination,
        serialized.json,
        serialized.hash,
        availableAt,
        input.sourceInboxId ?? null,
        availableAt,
        availableAt,
      );
    } catch (error) {
      if (!String(error).includes('UNIQUE constraint failed')) throw error;
      const existing = this.#database.prepare(`
        SELECT payload_hash, destination FROM connector_outbox
        WHERE tenant_id = ? AND connector = ? AND dedupe_key = ?
        LIMIT 1
      `).get(input.tenantId, input.connector, input.dedupeKey) as Row | undefined;
      if (!existing
        || String(existing.payload_hash) !== serialized.hash
        || String(existing.destination) !== input.destination) {
        throw new Error('Connector outbox dedupe key conflicts with a different payload');
      }
    }
  }

  async #failConnectorQueueRow(
    table: 'connector_inbox' | 'connector_outbox',
    input: ConnectorQueueFailureInput,
  ): Promise<ConnectorQueueFailureResult> {
    const failedAt = input.failedAt ?? new Date().toISOString();
    this.#assertQueueId(input.id, `${table} id`);
    this.#assertQueueId(input.claimToken, `${table} claim token`);
    this.#assertQueueTimestamp(failedAt, 'failedAt');
    const maxAttempts = boundedQueueInteger(input.maxAttempts, 1, 100, 8);
    const backoffBaseMs = boundedQueueInteger(input.backoffBaseMs, 1, 86_400_000, 1_000);
    const backoffMaxMs = boundedQueueInteger(input.backoffMaxMs, backoffBaseMs, 7 * 86_400_000, 300_000);
    const lastError = sanitizeQueueError(input.error);
    this.#database.exec('BEGIN IMMEDIATE;');
    try {
      const row = this.#database.prepare(`
        SELECT attempts FROM ${table}
        WHERE id = ? AND status = 'processing' AND claim_token = ?
        LIMIT 1
      `).get(input.id, input.claimToken) as Row | undefined;
      if (!row) {
        this.#database.exec('COMMIT;');
        return { updated: false };
      }
      const attempts = Number(row.attempts);
      const dead = attempts >= maxAttempts;
      const status = dead ? 'dead_letter' : 'retrying';
      const availableAt = dead
        ? failedAt
        : nextConnectorRetryAt(failedAt, attempts, backoffBaseMs, backoffMaxMs);
      const result = this.#database.prepare(`
        UPDATE ${table}
        SET status = ?, available_at = ?, last_error = ?,
            dead_lettered_at = ?, claimed_at = NULL, claim_token = NULL,
            lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'processing' AND claim_token = ?
      `).run(
        status,
        availableAt,
        lastError,
        dead ? failedAt : null,
        failedAt,
        input.id,
        input.claimToken,
      );
      this.#database.exec('COMMIT;');
      return {
        updated: Number(result.changes) === 1,
        status,
        availableAt,
        attempts,
      };
    } catch (error) {
      this.#database.exec('ROLLBACK;');
      throw error;
    }
  }

  #mapConnectorInbox(row: Row): ConnectorInboxRecord {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      connector: String(row.connector),
      eventId: String(row.event_id),
      payload: parseQueuePayload(row.payload_json),
      payloadHash: String(row.payload_hash),
      status: connectorInboxStatus(String(row.status)),
      attempts: Number(row.attempts),
      availableAt: String(row.available_at),
      claimedAt: nullableString(row.claimed_at),
      claimToken: nullableString(row.claim_token),
      leaseExpiresAt: nullableString(row.lease_expires_at),
      lastError: nullableString(row.last_error),
      processedAt: nullableString(row.processed_at),
      deadLetteredAt: nullableString(row.dead_lettered_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  #mapConnectorOutbox(row: Row): ConnectorOutboxRecord {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      connector: String(row.connector),
      dedupeKey: String(row.dedupe_key),
      destination: String(row.destination),
      payload: parseQueuePayload(row.payload_json),
      payloadHash: String(row.payload_hash),
      status: connectorOutboxStatus(String(row.status)),
      attempts: Number(row.attempts),
      availableAt: String(row.available_at),
      claimedAt: nullableString(row.claimed_at),
      claimToken: nullableString(row.claim_token),
      leaseExpiresAt: nullableString(row.lease_expires_at),
      lastError: nullableString(row.last_error),
      sentAt: nullableString(row.sent_at),
      deadLetteredAt: nullableString(row.dead_lettered_at),
      sourceInboxId: nullableString(row.source_inbox_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
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

  #mapFeishuOAuthState(row: Row): FeishuOAuthState {
    const state: FeishuOAuthState = {
      stateHash: String(row.state_hash),
      appId: String(row.app_id),
      redirectUri: String(row.redirect_uri),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
      consumedAt: String(row.consumed_at),
    };
    if (row.tenant_id !== null && row.tenant_id !== undefined) {
      state.tenantId = String(row.tenant_id);
    }
    if (row.user_id !== null && row.user_id !== undefined) {
      state.userId = String(row.user_id);
    }
    if (row.return_to !== null && row.return_to !== undefined) {
      state.returnTo = String(row.return_to);
    }
    if (row.encrypted_code_verifier !== null && row.encrypted_code_verifier !== undefined) {
      state.encryptedCodeVerifier = String(row.encrypted_code_verifier);
    }
    return state;
  }

  #mapFeishuInstallation(row: Row): FeishuInstallation {
    let scopes: string[] = [];
    try {
      const parsed = JSON.parse(String(row.scopes_json)) as unknown;
      if (Array.isArray(parsed)) {
        scopes = uniqueSortedStrings(parsed.filter((item): item is string => typeof item === 'string'));
      }
    } catch {
      // A corrupt scope cache must not make the installation unusable.
      scopes = [];
    }
    const installation: FeishuInstallation = {
      tenantId: String(row.tenant_id),
      appId: String(row.app_id),
      encryptedAccessToken: String(row.encrypted_access_token),
      scopes,
      status: row.status === 'revoked' ? 'revoked' : 'active',
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
    const optional: Array<[keyof FeishuInstallation, unknown]> = [
      ['tenantName', row.tenant_name],
      ['encryptedRefreshToken', row.encrypted_refresh_token],
      ['accessTokenExpiresAt', row.access_token_expires_at],
      ['refreshTokenExpiresAt', row.refresh_token_expires_at],
      ['openId', row.open_id],
      ['unionId', row.union_id],
      ['installedByUserId', row.installed_by_user_id],
      ['revokedAt', row.revoked_at],
    ];
    for (const [key, value] of optional) {
      if (value !== null && value !== undefined) {
        (installation as unknown as Record<string, unknown>)[key] = String(value);
      }
    }
    return installation;
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

function uniqueSortedStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function boundedQueueInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`Connector queue option must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function queueTimeAfter(value: string, milliseconds: number): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError('Connector queue timestamps must be valid ISO dates');
  return new Date(parsed + milliseconds).toISOString();
}

function normalizeQueueTimestamp(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be a valid ISO timestamp`);
  return new Date(parsed).toISOString();
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function valueOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function parseQueuePayload(value: unknown): unknown {
  try {
    return JSON.parse(String(value));
  } catch {
    // A malformed payload should never crash the worker or leak raw storage;
    // preserve only a safe diagnostic marker for operators.
    return '[REDACTED:invalid_payload]';
  }
}

function connectorInboxStatus(value: string): ConnectorInboxStatus {
  const statuses: ConnectorInboxStatus[] = ['queued', 'processing', 'retrying', 'completed', 'dead_letter'];
  return statuses.includes(value as ConnectorInboxStatus) ? value as ConnectorInboxStatus : 'dead_letter';
}

function connectorOutboxStatus(value: string): ConnectorOutboxStatus {
  const statuses: ConnectorOutboxStatus[] = ['queued', 'processing', 'retrying', 'sent', 'dead_letter'];
  return statuses.includes(value as ConnectorOutboxStatus) ? value as ConnectorOutboxStatus : 'dead_letter';
}

function queueStatusCounts(
  rows: Row[],
  statuses: string[],
): ConnectorQueueStatusCounts<string> {
  const counts: ConnectorQueueStatusCounts<string> = {
    queued: 0,
    processing: 0,
    retrying: 0,
    dead_letter: 0,
  };
  for (const status of statuses) counts[status] = 0;
  for (const row of rows) {
    const status = String(row.status);
    counts[status] = Number(row.count);
  }
  return counts;
}
