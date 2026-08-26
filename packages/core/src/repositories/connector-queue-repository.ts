import { createHash, randomUUID } from 'node:crypto';

import { redactSecrets } from '../security/secret-redactor.js';

/** States used by the durable connector ingress queue. */
export type ConnectorInboxStatus =
  | 'queued'
  | 'processing'
  | 'retrying'
  | 'completed'
  | 'dead_letter';

/** States used by the durable connector egress queue. */
export type ConnectorOutboxStatus =
  | 'queued'
  | 'processing'
  | 'retrying'
  | 'sent'
  | 'dead_letter';

export interface ConnectorInboxRecord {
  id: string;
  tenantId: string;
  connector: string;
  eventId: string;
  /** The recursively redacted payload accepted at the connector boundary. */
  payload: unknown;
  payloadHash: string;
  status: ConnectorInboxStatus;
  attempts: number;
  availableAt: string;
  claimedAt: string | null;
  claimToken: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  processedAt: string | null;
  deadLetteredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorOutboxRecord {
  id: string;
  tenantId: string;
  connector: string;
  dedupeKey: string;
  destination: string;
  /** The recursively redacted payload accepted for dispatch. */
  payload: unknown;
  payloadHash: string;
  status: ConnectorOutboxStatus;
  attempts: number;
  availableAt: string;
  claimedAt: string | null;
  claimToken: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  sentAt: string | null;
  deadLetteredAt: string | null;
  sourceInboxId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueConnectorInboxInput {
  tenantId: string;
  connector: string;
  eventId: string;
  payload: unknown;
  receivedAt?: string;
  /** Optional caller supplied digest. It is verified against the safe payload. */
  payloadHash?: string;
  id?: string;
}

export interface EnqueueConnectorInboxResult {
  id: string;
  created: boolean;
  duplicate: boolean;
  /** True when an existing event id was presented with a different payload. */
  conflict: boolean;
  status: ConnectorInboxStatus;
  record: ConnectorInboxRecord;
}

export interface PersistConnectorOutboxInput {
  tenantId: string;
  connector: string;
  dedupeKey: string;
  destination: string;
  payload: unknown;
  availableAt?: string;
  sourceInboxId?: string;
  id?: string;
}

export interface EnqueueConnectorOutboxResult {
  id: string;
  created: boolean;
  duplicate: boolean;
  conflict: boolean;
  record: ConnectorOutboxRecord;
}

export interface ConnectorQueueClaimOptions {
  now?: string;
  limit?: number;
  leaseMs?: number;
}

export interface ConnectorQueueFailureInput {
  id: string;
  claimToken: string;
  error: unknown;
  failedAt?: string;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface ConnectorQueueFailureResult {
  updated: boolean;
  status?: ConnectorInboxStatus | ConnectorOutboxStatus;
  availableAt?: string;
  attempts?: number;
}

export interface CompleteConnectorInboxInput {
  id: string;
  claimToken: string;
  processedAt?: string;
  outbox?: PersistConnectorOutboxInput[];
}

export interface ConnectorQueueStatusCounts<TStatus extends string> {
  queued: number;
  processing: number;
  retrying: number;
  completed?: number;
  sent?: number;
  dead_letter: number;
  /** Allows forward-compatible states without making the API unsafe. */
  [status: string]: number | undefined;
}

export interface ConnectorQueueStats {
  connector?: string;
  inbox: ConnectorQueueStatusCounts<ConnectorInboxStatus>;
  outbox: ConnectorQueueStatusCounts<ConnectorOutboxStatus>;
  oldestInboxAvailableAt: string | null;
  oldestOutboxAvailableAt: string | null;
  generatedAt: string;
}

export interface ConnectorQueueRepository {
  enqueueConnectorInbox(input: EnqueueConnectorInboxInput): Promise<EnqueueConnectorInboxResult>;
  claimConnectorInbox(options?: ConnectorQueueClaimOptions): Promise<ConnectorInboxRecord[]>;
  completeConnectorInbox(input: CompleteConnectorInboxInput): Promise<boolean>;
  failConnectorInbox(input: ConnectorQueueFailureInput): Promise<ConnectorQueueFailureResult>;
  /** Requeue a failed/dead-letter row for an operator initiated retry. */
  retryConnectorInbox(id: string, availableAt?: string, tenantId?: string): Promise<boolean>;
  /** Mark an inbox row terminal without exposing its payload. */
  cancelConnectorInbox(id: string, cancelledAt?: string, tenantId?: string): Promise<boolean>;

  enqueueConnectorOutbox(input: PersistConnectorOutboxInput): Promise<EnqueueConnectorOutboxResult>;
  claimConnectorOutbox(options?: ConnectorQueueClaimOptions): Promise<ConnectorOutboxRecord[]>;
  completeConnectorOutbox(
    id: string,
    claimToken: string,
    sentAt?: string,
  ): Promise<boolean>;
  failConnectorOutbox(input: ConnectorQueueFailureInput): Promise<ConnectorQueueFailureResult>;
  retryConnectorOutbox(id: string, availableAt?: string, tenantId?: string): Promise<boolean>;
  cancelConnectorOutbox(id: string, cancelledAt?: string, tenantId?: string): Promise<boolean>;

  /** Stats are optionally tenant-scoped; callers should always pass a tenant in API paths. */
  getConnectorQueueStats(connector?: string, tenantId?: string): Promise<ConnectorQueueStats>;
}

/** Raised when an idempotency key is reused for a different queue payload. */
export class ConnectorQueueConflictError extends Error {
  readonly code = 'connector_queue_conflict';

  constructor(message = 'The connector queue key is already bound to a different payload') {
    super(message);
    this.name = 'ConnectorQueueConflictError';
  }
}

/**
 * A result returned by an inbox processor. Outbox rows are inserted in the
 * same transaction as the inbox completion, so a crash cannot lose a reply.
 */
export interface ConnectorInboxProcessingResult {
  outbox?: PersistConnectorOutboxInput[];
}

export type ConnectorInboxProcessor = (
  record: ConnectorInboxRecord,
) => Promise<ConnectorInboxProcessingResult | void>;

export type ConnectorOutboxDispatcher = (
  record: ConnectorOutboxRecord,
) => Promise<void>;

export interface ConnectorQueueWorkerOptions {
  intervalMs?: number;
  batchSize?: number;
  leaseMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  now?: () => Date;
  processors?: Readonly<Record<string, ConnectorInboxProcessor>>;
  dispatchers?: Readonly<Record<string, ConnectorOutboxDispatcher>>;
  onError?: (error: unknown, kind?: 'inbox' | 'outbox', recordId?: string) => void;
}

/**
 * Small, dependency-free worker for durable connector queues. It deliberately
 * performs one bounded tick at a time; leases and idempotent outbox keys make
 * running several workers safe.
 */
export class ConnectorQueueWorker {
  readonly #intervalMs: number;
  readonly #batchSize: number;
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  readonly #backoffBaseMs: number;
  readonly #backoffMaxMs: number;
  readonly #now: () => Date;
  readonly #processors: Readonly<Record<string, ConnectorInboxProcessor>>;
  readonly #dispatchers: Readonly<Record<string, ConnectorOutboxDispatcher>>;
  readonly #onError: (error: unknown, kind?: 'inbox' | 'outbox', recordId?: string) => void;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #inFlight: Promise<{ inbox: number; outbox: number }> | undefined;

  constructor(
    private readonly repository: ConnectorQueueRepository,
    options: ConnectorQueueWorkerOptions = {},
  ) {
    this.#intervalMs = boundedInteger(options.intervalMs, 250, 3_600_000, 5_000);
    this.#batchSize = boundedInteger(options.batchSize, 1, 200, 25);
    this.#leaseMs = boundedInteger(options.leaseMs, 1_000, 86_400_000, 300_000);
    this.#maxAttempts = boundedInteger(options.maxAttempts, 1, 100, 8);
    this.#backoffBaseMs = boundedInteger(options.backoffBaseMs, 1, 86_400_000, 1_000);
    this.#backoffMaxMs = boundedInteger(options.backoffMaxMs, this.#backoffBaseMs, 7 * 86_400_000, 300_000);
    this.#now = options.now ?? (() => new Date());
    this.#processors = options.processors ?? {};
    this.#dispatchers = options.dispatchers ?? {};
    this.#onError = options.onError ?? (() => undefined);
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick().catch((error: unknown) => this.#report(error));
    }, this.#intervalMs);
    this.#timer.unref?.();
    void this.tick().catch((error: unknown) => this.#report(error));
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Stop scheduling new work and wait for the current bounded tick to settle. */
  async stopAndDrain(): Promise<void> {
    this.stop();
    const inFlight = this.#inFlight;
    if (!inFlight) return;
    try {
      await inFlight;
    } catch (error) {
      // The worker's normal scheduling path already reports failures. During
      // shutdown, retain the durable row/lease for recovery instead of
      // preventing the HTTP server from closing its listener.
      this.#report(error);
    }
  }

  async tick(at = this.#now()): Promise<{ inbox: number; outbox: number }> {
    if (this.#running) return { inbox: 0, outbox: 0 };
    const inFlight = this.#runTick(at);
    this.#inFlight = inFlight;
    try {
      return await inFlight;
    } finally {
      if (this.#inFlight === inFlight) this.#inFlight = undefined;
    }
  }

  async #runTick(at: Date): Promise<{ inbox: number; outbox: number }> {
    this.#running = true;
    const now = at.toISOString();
    let inboxProcessed = 0;
    let outboxProcessed = 0;
    try {
      const inbox = await this.repository.claimConnectorInbox({
        now,
        limit: this.#batchSize,
        leaseMs: this.#leaseMs,
      });
      for (const record of inbox) {
        const processor = this.#processors[record.connector];
        try {
          if (!processor) throw new Error(`No inbox processor configured for ${record.connector}`);
          const result = await processor(record);
          const completed = await this.repository.completeConnectorInbox({
            id: record.id,
            claimToken: record.claimToken ?? '',
            processedAt: this.#now().toISOString(),
            ...(result?.outbox ? { outbox: result.outbox } : {}),
          });
          if (completed) inboxProcessed += 1;
        } catch (error) {
          this.#report(error, 'inbox', record.id);
          try {
            await this.repository.failConnectorInbox({
              id: record.id,
              claimToken: record.claimToken ?? '',
              error,
              failedAt: this.#now().toISOString(),
              maxAttempts: this.#maxAttempts,
              backoffBaseMs: this.#backoffBaseMs,
              backoffMaxMs: this.#backoffMaxMs,
            });
          } catch (failureError) {
            this.#report(failureError, 'inbox', record.id);
          }
        }
      }

      const outbox = await this.repository.claimConnectorOutbox({
        now: this.#now().toISOString(),
        limit: this.#batchSize,
        leaseMs: this.#leaseMs,
      });
      for (const record of outbox) {
        const dispatcher = this.#dispatchers[record.connector];
        try {
          if (!dispatcher) throw new Error(`No outbox dispatcher configured for ${record.connector}`);
          await dispatcher(record);
          const completed = await this.repository.completeConnectorOutbox(
            record.id,
            record.claimToken ?? '',
            this.#now().toISOString(),
          );
          if (completed) outboxProcessed += 1;
        } catch (error) {
          this.#report(error, 'outbox', record.id);
          try {
            await this.repository.failConnectorOutbox({
              id: record.id,
              claimToken: record.claimToken ?? '',
              error,
              failedAt: this.#now().toISOString(),
              maxAttempts: this.#maxAttempts,
              backoffBaseMs: this.#backoffBaseMs,
              backoffMaxMs: this.#backoffMaxMs,
            });
          } catch (failureError) {
            this.#report(failureError, 'outbox', record.id);
          }
        }
      }
      return { inbox: inboxProcessed, outbox: outboxProcessed };
    } finally {
      this.#running = false;
    }
  }

  #report(error: unknown, kind?: 'inbox' | 'outbox', recordId?: string): void {
    try {
      this.#onError(error, kind, recordId);
    } catch {
      // An observability callback must never prevent queue retries or stop the
      // worker loop. The original error is already represented in queue state.
    }
  }
}

/**
 * Recursively removes/redacts secrets before anything is serialized to the
 * durable queue. This is intentionally conservative: unknown sensitive keys
 * are replaced rather than retained, while ordinary strings are passed through
 * the same detector used by asset ingestion.
 */
export function sanitizeConnectorPayload(value: unknown, depth = 0): unknown {
  if (depth > 32) return '[REDACTED:depth_limit]';
  if (typeof value === 'string') return redactSecrets(value).redactedText;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeConnectorPayload(entry, depth + 1));
  if (typeof value !== 'object') return String(value);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      output[key] = '[REDACTED:connector_secret]';
    } else {
      output[key] = sanitizeConnectorPayload(entry, depth + 1);
    }
  }
  return output;
}

export function serializeConnectorPayload(value: unknown): {
  payload: unknown;
  json: string;
  hash: string;
} {
  let payload: unknown;
  try {
    payload = sanitizeConnectorPayload(value);
  } catch {
    throw new TypeError('Connector payload must be JSON serializable');
  }
  let json: string;
  try {
    json = stableJsonStringify(payload);
  } catch {
    throw new TypeError('Connector payload must be JSON serializable');
  }
  if (json === undefined) throw new TypeError('Connector payload must be JSON serializable');
  if (Buffer.byteLength(json, 'utf8') > 4 * 1_024 * 1_024) {
    throw new RangeError('Connector payload exceeds the 4 MiB queue limit');
  }
  return {
    payload,
    json,
    hash: `sha256:${createHash('sha256').update(json, 'utf8').digest('hex')}`,
  };
}

/** Canonical JSON keeps idempotency hashes stable across object key ordering. */
function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const primitive = JSON.stringify(value);
    return primitive === undefined ? JSON.stringify(String(value)) : primitive;
  }
  if (Array.isArray(value)) return `[${value.map((entry) => stableJsonStringify(entry)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`);
  return `{${entries.join(',')}}`;
}

export function sanitizeQueueError(error: unknown, maximumLength = 2_000): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactSecrets(message).redactedText.replace(/[\u0000-\u001f\u007f]/gu, ' ');
  return redacted.length > maximumLength ? `${redacted.slice(0, maximumLength - 1)}…` : redacted;
}

export function nextConnectorRetryAt(
  failedAt: string,
  attempts: number,
  baseMs = 1_000,
  maxMs = 300_000,
): string {
  const exponent = Math.max(0, Math.min(30, attempts - 1));
  const delay = Math.min(maxMs, baseMs * (2 ** exponent));
  const time = Date.parse(failedAt);
  if (!Number.isFinite(time)) return new Date(Date.now() + delay).toISOString();
  return new Date(time + delay).toISOString();
}

const SENSITIVE_KEY_PATTERN = /(?:token|secret|password|passwd|pwd|signature|authorization|apikey|accesskey|encrypt|privatekey)/iu;

function isSensitiveKey(key: string): boolean {
  // Normalize snake_case, kebab-case, and camelCase names so values such as
  // `accessToken` and `verificationToken` cannot bypass redaction.
  return SENSITIVE_KEY_PATTERN.test(key.replace(/[\s_-]/gu, ''));
}

function boundedInteger(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`Connector queue option must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

/** Generate IDs in one place so adapters and tests can use the same format. */
export function connectorQueueId(prefix: 'inbox' | 'outbox' = 'inbox'): string {
  return `${prefix}_${randomUUID()}`;
}
