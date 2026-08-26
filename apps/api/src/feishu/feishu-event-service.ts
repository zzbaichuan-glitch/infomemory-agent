import { createHash, timingSafeEqual } from 'node:crypto';

import {
  AssetService,
  type ConnectorInboxProcessingResult,
  type ConnectorEventReceiptRepository,
  type PersistConnectorOutboxInput,
  ReminderService,
  type Reminder,
} from '@infomemory/core';

import { decodeFeishuPayload, FeishuPayloadError } from './feishu-payload.js';
import {
  FeishuCommandService,
  parseFeishuCommand,
} from './feishu-command-service.js';
import {
  FeishuSignatureError,
  type FeishuSignatureHeaders,
  verifyFeishuSignature,
} from './feishu-signature.js';
import type { FeishuMessenger } from './feishu-client.js';

type UnknownRecord = Record<string, unknown>;

export type FeishuEventResult =
  | { type: 'challenge'; challenge: string }
  | {
    type: 'ack';
    processed: boolean;
    reminder?: Reminder | null;
    notificationSent?: boolean;
    reason?:
      | 'unsupported_event'
      | 'unsupported_message_type'
      | 'invalid_event_payload'
      | 'duplicate_event'
      | 'duplicate_content'
      | 'notification_target_unavailable'
      | 'command_notifications_unavailable'
      | 'command_delivery_failed';
  };

export class FeishuVerificationError extends Error {
  constructor() {
    super('Feishu callback verification failed');
    this.name = 'FeishuVerificationError';
  }
}

export class FeishuConfigurationError extends Error {
  constructor() {
    super('Feishu callback is not configured');
    this.name = 'FeishuConfigurationError';
  }
}

export { FeishuPayloadError, FeishuSignatureError };

export interface FeishuEventServiceOptions {
  verificationToken?: string;
  encryptKey?: string;
  messenger?: FeishuMessenger;
  signatureNow?: () => number;
  signatureToleranceSeconds?: number;
  commandService?: FeishuCommandService;
  eventReceipts?: ConnectorEventReceiptRepository;
  now?: () => Date;
  timeZone?: string;
}

/** Secret-free, validated event data retained in the durable inbox. */
export interface FeishuQueuedEvent {
  kind: 'text';
  eventId: string;
  tenantId: string;
  userId: string;
  openId: string | null;
  messageId: string;
  text: string;
  receivedAt: string;
}

export type FeishuPreparedEvent =
  | { kind: 'challenge'; result: Extract<FeishuEventResult, { type: 'challenge' }> }
  | { kind: 'ack'; result: Extract<FeishuEventResult, { type: 'ack' }> }
  | { kind: 'event'; event: FeishuQueuedEvent };

export interface FeishuProcessedEvent extends ConnectorInboxProcessingResult {
  result: FeishuEventResult;
}

export interface FeishuEventHandleOptions {
  /** Exact wire body used for signature verification when available. */
  rawBody?: string | Buffer;
  /** Set only after the public ingress has already verified the callback. */
  skipVerification?: boolean;
}

export class FeishuEventService {
  constructor(
    private readonly assetService: AssetService,
    private readonly reminderService: ReminderService,
    private readonly options: FeishuEventServiceOptions = {},
  ) {}

  /**
   * Verify/decrypt and normalize an ingress payload. The returned event omits
   * callback tokens, signatures, and encryption material, making it safe to
   * persist in the durable connector inbox.
   */
  prepare(
    payload: unknown,
    signatureHeaders: FeishuSignatureHeaders = {},
    handleOptions: FeishuEventHandleOptions = {},
  ): FeishuPreparedEvent {
    if (!this.options.verificationToken) throw new FeishuConfigurationError();
    const body = asRecord(decodeFeishuPayload(payload, this.options.encryptKey));
    if (!body) {
      return { kind: 'ack', result: { type: 'ack', processed: false, reason: 'invalid_event_payload' } };
    }
    // Feishu's request-URL verification challenge is explicitly excluded from
    // the callback signature requirement. It can still be encrypted, so
    // decrypt first, then require signatures only for ordinary event pushes.
    if (this.options.encryptKey
      && body.type !== 'url_verification'
      && !handleOptions.skipVerification) {
      verifyFeishuSignature(handleOptions.rawBody ?? payload, signatureHeaders, {
        encryptKey: this.options.encryptKey,
        ...(this.options.signatureNow ? { now: this.options.signatureNow } : {}),
        ...(this.options.signatureToleranceSeconds !== undefined
          ? { toleranceSeconds: this.options.signatureToleranceSeconds }
          : {}),
      });
    }
    if (body.type === 'url_verification') {
      this.#verify(stringValue(body.token));
      const challenge = stringValue(body.challenge);
      if (!challenge) {
        return { kind: 'ack', result: { type: 'ack', processed: false, reason: 'invalid_event_payload' } };
      }
      return { kind: 'challenge', result: { type: 'challenge', challenge } };
    }
    const header = asRecord(body.header);
    this.#verify(stringValue(header?.token));
    if (stringValue(header?.event_type) !== 'im.message.receive_v1') {
      return { kind: 'ack', result: { type: 'ack', processed: false, reason: 'unsupported_event' } };
    }
    const event = asRecord(body.event);
    const message = asRecord(event?.message);
    const text = parseInboundMessageText(
      stringValue(message?.message_type),
      stringValue(message?.content),
    );
    if (text === undefined) {
      return { kind: 'ack', result: { type: 'ack', processed: false, reason: 'unsupported_message_type' } };
    }
    const eventId = stringValue(header?.event_id);
    const tenantId = stringValue(header?.tenant_key);
    const sender = asRecord(event?.sender);
    const senderId = asRecord(sender?.sender_id);
    const openId = stringValue(senderId?.open_id);
    const userId = openId ?? stringValue(senderId?.union_id) ?? stringValue(senderId?.user_id);
    const messageId = stringValue(message?.message_id);
    if (!eventId || !tenantId || !userId || !messageId || !text) {
      return { kind: 'ack', result: { type: 'ack', processed: false, reason: 'invalid_event_payload' } };
    }
    return {
      kind: 'event',
      event: {
        kind: 'text', eventId, tenantId, userId, openId, messageId, text,
        receivedAt: (this.options.now?.() ?? new Date()).toISOString(),
      },
    };
  }

  /** Process a trusted, normalized event claimed from the durable inbox. */
  async processQueued(payload: unknown): Promise<FeishuProcessedEvent> {
    const event = parseQueuedEvent(payload);
    if (!event) throw new FeishuPayloadError('Queued Feishu event is invalid');
    return this.#processQueuedEvent(event);
  }

  async #processQueuedEvent(event: FeishuQueuedEvent): Promise<FeishuProcessedEvent> {
    const { tenantId, userId, openId, text, messageId } = event;
    if (this.options.commandService && parseFeishuCommand(text)) {
      if (!this.options.messenger || !openId) {
        // Async workers must not acknowledge a command that cannot be
        // delivered. Throwing leaves the inbox in retry/backoff (and eventually
        // dead-letter) instead of silently losing the user's request.
        throw new FeishuConfigurationError();
      }
      // The inbox's unique event id is the durable dedupe boundary in async
      // mode. Do not claim the legacy receipt before the atomic inbox/outbox
      // completion: a crash after command execution but before completion
      // would otherwise make a retry look like a duplicate and lose its reply.
      const response = await this.options.commandService.execute({ tenantId, userId }, text);
      if (!response) throw new Error('Feishu command could not be executed');
      return {
        result: { type: 'ack', processed: true },
        outbox: [{
          tenantId, connector: 'feishu', dedupeKey: `command:${messageId}`,
          destination: openId, payload: { receiveId: openId, text: response },
        }],
      };
    }
    const result = await this.assetService.ingest(
      { tenantId, userId },
      {
        title: `飞书消息：${singleLine(text).slice(0, 80)}`,
        content: text,
        // Feishu documents that retries may use a different event_id for the
        // same logical message; message_id is the stable idempotency key.
        idempotencyKey: `feishu-message:${messageId}`,
        visibility: 'owner',
        source: { type: 'feishu_message', externalId: messageId },
      },
    );
    // FeishuClient sends with receive_id_type=open_id. If the callback only
    // gives us a union_id/user_id, retaining that value as the asset owner is
    // fine, but creating a scheduled reminder would eventually make the
    // reminder worker pass the wrong identifier to Feishu. Keep the memory,
    // skip connector-specific reminder delivery, and expose a safe reason in
    // the acknowledgement instead.
    const notificationTargetUnavailable = Boolean(this.options.messenger && !openId);
    const reminder = notificationTargetUnavailable
      ? null
      : await this.reminderService.observeMessage(
        { tenantId, userId },
        { text: result.asset.redactedContent, sourceAssetId: result.asset.id, sourceEventId: messageId },
      );
    const outbox: PersistConnectorOutboxInput[] = [];
    // In async mode the outbox dedupe key makes retries safe. Always recreate
    // the notification intent for an existing reminder: a crash after the
    // asset write but before atomic inbox completion must not lose the reply.
    if (reminder && this.options.messenger && openId) {
      outbox.push({
        tenantId, connector: 'feishu', dedupeKey: `reminder:${messageId}:${reminder.id}`,
        destination: openId,
        payload: { receiveId: openId, text: reminderMessage(reminder, this.options.timeZone) },
      });
    }
    const processed: FeishuEventResult = result.created
      ? {
        type: 'ack', processed: true, reminder,
        ...(notificationTargetUnavailable ? { reason: 'notification_target_unavailable' as const } : {}),
      }
      : {
        type: 'ack', processed: false, reminder,
        reason: result.deduplicatedBy === 'idempotency' ? 'duplicate_event' : 'duplicate_content',
      };
    return { result: processed, ...(outbox.length > 0 ? { outbox } : {}) };
  }

  async handle(
    payload: unknown,
    signatureHeaders: FeishuSignatureHeaders = {},
    handleOptions: FeishuEventHandleOptions = {},
  ): Promise<FeishuEventResult> {
    if (!this.options.verificationToken) throw new FeishuConfigurationError();
    const body = asRecord(decodeFeishuPayload(payload, this.options.encryptKey));
    if (!body) return { type: 'ack', processed: false, reason: 'invalid_event_payload' };

    // Request-URL verification is not covered by Feishu's callback signature
    // contract. Decrypting before this check lets encrypted challenges work
    // while preserving signature enforcement for all side-effecting events.
    if (this.options.encryptKey
      && body.type !== 'url_verification'
      && !handleOptions.skipVerification) {
      verifyFeishuSignature(handleOptions.rawBody ?? payload, signatureHeaders, {
        encryptKey: this.options.encryptKey,
        ...(this.options.signatureNow ? { now: this.options.signatureNow } : {}),
        ...(this.options.signatureToleranceSeconds !== undefined
          ? { toleranceSeconds: this.options.signatureToleranceSeconds }
          : {}),
      });
    }

    if (body.type === 'url_verification') {
      this.#verify(stringValue(body.token));
      const challenge = stringValue(body.challenge);
      if (!challenge) {
        return { type: 'ack', processed: false, reason: 'invalid_event_payload' };
      }
      return { type: 'challenge', challenge };
    }

    const header = asRecord(body.header);
    this.#verify(stringValue(header?.token));
    if (stringValue(header?.event_type) !== 'im.message.receive_v1') {
      return { type: 'ack', processed: false, reason: 'unsupported_event' };
    }

    const event = asRecord(body.event);
    const message = asRecord(event?.message);
    const text = parseInboundMessageText(
      stringValue(message?.message_type),
      stringValue(message?.content),
    );
    if (text === undefined) {
      return { type: 'ack', processed: false, reason: 'unsupported_message_type' };
    }

    const eventId = stringValue(header?.event_id);
    const tenantId = stringValue(header?.tenant_key);
    const sender = asRecord(event?.sender);
    const senderId = asRecord(sender?.sender_id);
    const openId = stringValue(senderId?.open_id);
    const userId = openId
      ?? stringValue(senderId?.union_id)
      ?? stringValue(senderId?.user_id);
    const messageId = stringValue(message?.message_id);
    if (!eventId || !tenantId || !userId || !messageId || !text) {
      return { type: 'ack', processed: false, reason: 'invalid_event_payload' };
    }

    if (this.options.commandService
      && this.options.eventReceipts
      && parseFeishuCommand(text)) {
      if (!this.options.messenger || !openId) {
        return {
          type: 'ack',
          processed: false,
          reason: 'command_notifications_unavailable',
        };
      }
      return this.#handleCommand({ tenantId, userId }, messageId, openId, text);
    }

    const result = await this.assetService.ingest(
      { tenantId, userId },
      {
        title: `飞书消息：${singleLine(text).slice(0, 80)}`,
        content: text,
        // Use message_id rather than event_id: Feishu may redeliver one
        // message with a newly assigned event_id.
        idempotencyKey: `feishu-message:${messageId}`,
        visibility: 'owner',
        source: { type: 'feishu_message', externalId: messageId },
      },
    );

    // Do not create a scheduled reminder when Feishu did not provide an
    // open_id. FeishuClient's send endpoint is explicitly pinned to
    // receive_id_type=open_id, so a union_id/user_id fallback must never reach
    // either the synchronous notifier or the background reminder worker.
    const notificationTargetUnavailable = Boolean(this.options.messenger && !openId);
    const reminder = notificationTargetUnavailable
      ? null
      : await this.reminderService.observeMessage(
        { tenantId, userId },
        {
          text: result.asset.redactedContent,
          sourceAssetId: result.asset.id,
          sourceEventId: messageId,
        },
      );
    const notificationSent = reminder && openId && result.deduplicatedBy !== 'idempotency'
      ? await this.#notify(openId, reminder)
      : false;
    if (result.created) {
      return {
        type: 'ack',
        processed: true,
        reminder,
        ...(notificationSent ? { notificationSent: true } : {}),
        ...(notificationTargetUnavailable ? { reason: 'notification_target_unavailable' as const } : {}),
      };
    }
    return {
      type: 'ack',
      processed: false,
      reminder,
      ...(notificationSent ? { notificationSent: true } : {}),
      reason: result.deduplicatedBy === 'idempotency'
        ? 'duplicate_event'
        : 'duplicate_content',
    };
  }

  async #handleCommand(
    context: { tenantId: string; userId: string },
    messageId: string,
    openId: string,
    text: string,
  ): Promise<FeishuEventResult> {
    const commandService = this.options.commandService;
    const receipts = this.options.eventReceipts;
    const messenger = this.options.messenger;
    if (!commandService || !receipts || !messenger) {
      return {
        type: 'ack',
        processed: false,
        reason: 'command_notifications_unavailable',
      };
    }
    const receivedAt = (this.options.now?.() ?? new Date()).toISOString();
    const receipt = {
      tenantId: context.tenantId,
      connector: 'feishu',
      // The provider's event_id identifies one delivery, while message_id
      // identifies the logical message. Deduplicate commands by the latter so
      // a retry with a new event_id cannot execute twice.
      eventId: messageId,
      receivedAt,
    };
    const claim = await receipts.claimConnectorEventReceipt(receipt);
    if (!claim.claimed) {
      return { type: 'ack', processed: false, reason: 'duplicate_event' };
    }
    try {
      const response = await commandService.execute(context, text);
      if (!response) throw new Error('Feishu command could not be executed');
      await messenger.sendText(openId, response);
      return { type: 'ack', processed: true, notificationSent: true };
    } catch {
      await receipts.releaseConnectorEventReceipt(receipt);
      return { type: 'ack', processed: false, reason: 'command_delivery_failed' };
    }
  }

  async #notify(userId: string, reminder: Reminder): Promise<boolean> {
    if (!this.options.messenger) return false;
    try {
      await this.options.messenger.sendText(
        userId,
        reminderMessage(reminder, this.options.timeZone),
      );
      return true;
    } catch {
      return false;
    }
  }

  #verify(receivedToken: string | null): void {
    if (!receivedToken || !safeEqual(receivedToken, this.options.verificationToken ?? '')) {
      throw new FeishuVerificationError();
    }
  }
}

function reminderMessage(reminder: Reminder, timeZone = 'Asia/Shanghai'): string {
  const startsAt = new Date(reminder.startsAt);
  const formatted = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(startsAt);
  if (reminder.precision === 'exact' && reminder.status === 'scheduled') {
    return `知澜提醒：已识别到会议。\n时间：${formatted}\n我会在会议前提醒你。`;
  }
  return `知澜提醒：发现一条可能的会议安排。\n候选时间：${formatted}\n请确认后再按此时间提醒。`;
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseInboundMessageText(
  messageType: string | null,
  content: string | null,
): string | null | undefined {
  if (messageType === 'text') return parseTextContent(content);
  if (messageType === 'post') return parsePostContent(content);
  return undefined;
}

function parseTextContent(content: string | null): string | null {
  if (!content) return null;
  try {
    const parsed = asRecord(JSON.parse(content));
    return stringValue(parsed?.text);
  } catch {
    return null;
  }
}

/**
 * Feishu sends numbered lists and other rich-text composer output as `post`
 * messages. Keep the connector's text-only memory boundary, but extract the
 * visible text from safe inline nodes so ordinary formatting does not cause a
 * message to be silently skipped. Media and unsupported inline nodes remain
 * excluded rather than being interpreted as text or downloaded.
 */
function parsePostContent(content: string | null): string | null {
  if (!content) return null;
  try {
    const parsed = asRecord(JSON.parse(content));
    const document = richTextDocument(parsed);
    if (!document) return null;
    const title = optionalText(document.title);
    const rows = Array.isArray(document.content) ? document.content : null;
    if (!rows) return title;
    const lines = rows
      .map((row) => Array.isArray(row)
        ? row.map(richTextInlineText).join('').trim()
        : '')
      .filter(Boolean);
    return [title, ...lines].filter(Boolean).join('\n').trim() || null;
  } catch {
    return null;
  }
}

function richTextDocument(payload: UnknownRecord | null): UnknownRecord | null {
  if (!payload) return null;
  if (Array.isArray(payload.content)) return payload;
  for (const candidate of Object.values(payload)) {
    const record = asRecord(candidate);
    if (Array.isArray(record?.content)) return record;
  }
  return null;
}

function richTextInlineText(value: unknown): string {
  const inline = asRecord(value);
  if (!inline) return '';
  const tag = stringValue(inline.tag);
  if (tag === 'text' || tag === 'a' || tag === 'code_block') return optionalText(inline.text) ?? '';
  if (tag === 'at') {
    const name = optionalText(inline.user_name) ?? optionalText(inline.text);
    return name ? `@${name}` : '';
  }
  return '';
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function parseQueuedEvent(value: unknown): FeishuQueuedEvent | null {
  const record = asRecord(value);
  if (!record || record.kind !== 'text') return null;
  const eventId = stringValue(record.eventId);
  const tenantId = stringValue(record.tenantId);
  const userId = stringValue(record.userId);
  const messageId = stringValue(record.messageId);
  const text = stringValue(record.text);
  const receivedAt = stringValue(record.receivedAt);
  if (!eventId || !tenantId || !userId || !messageId || !text || !receivedAt) return null;
  const openId = record.openId === null ? null : stringValue(record.openId);
  if (record.openId !== null && !openId) return null;
  if (!Number.isFinite(Date.parse(receivedAt))) return null;
  return { kind: 'text', eventId, tenantId, userId, openId, messageId, text, receivedAt };
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}
