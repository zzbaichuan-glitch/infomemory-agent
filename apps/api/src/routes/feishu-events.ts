import type { FastifyInstance } from 'fastify';

import type { ConnectorQueueRepository } from '@infomemory/core';

import { FeishuEventService } from '../feishu/feishu-event-service.js';
import type { FeishuEventResult } from '../feishu/feishu-event-service.js';
import type { FeishuSignatureHeaders } from '../feishu/feishu-signature.js';

export interface FeishuEventRouteOptions {
  processingMode?: 'sync' | 'async';
  queue?: ConnectorQueueRepository;
}

export function registerFeishuEventRoute(
  app: FastifyInstance,
  eventService: FeishuEventService,
  options: FeishuEventRouteOptions = {},
): void {
  app.post('/events', async (request) => {
    const signatureHeaders: FeishuSignatureHeaders = {};
    const timestamp = singleHeader(request.headers['x-lark-request-timestamp']);
    const nonce = singleHeader(request.headers['x-lark-request-nonce']);
    const signature = singleHeader(request.headers['x-lark-signature']);
    if (timestamp) signatureHeaders.timestamp = timestamp;
    if (nonce) signatureHeaders.nonce = nonce;
    if (signature) signatureHeaders.signature = signature;
    const rawBody = request.rawBody;
    const processingMode = options.processingMode ?? 'sync';
    if (processingMode === 'async') {
      if (!options.queue) throw new Error('Feishu async processing queue is not configured');
      const prepared = eventService.prepare(
        request.body,
        signatureHeaders,
        rawBody ? { rawBody } : {},
      );
      if (prepared.kind !== 'event') return formatFeishuResult(prepared.result);
      const queued = await options.queue.enqueueConnectorInbox({
        tenantId: prepared.event.tenantId,
        connector: 'feishu',
        // Feishu may retry one logical message with a different delivery
        // event_id.  Use the provider's stable message_id as the durable
        // inbox identity; the original event_id remains in the redacted
        // payload for diagnostics and is not used as a side-effect key.
        eventId: prepared.event.messageId,
        payload: prepared.event,
        receivedAt: prepared.event.receivedAt,
      });
      if (queued.conflict) {
        // The queue payload intentionally retains receipt metadata for
        // diagnostics, so a legitimate retry can have a different
        // `receivedAt` (and delivery `eventId`) while sharing the same
        // stable message_id key.  The key is provider-assigned and therefore
        // the authoritative idempotency boundary for Feishu messages; never
        // enqueue a second side effect for a conflicting retry payload.
        return {
          code: 0, queued: false, processed: false, inboxId: queued.id,
          reason: 'duplicate_event',
        };
      }
      if (!queued.created) {
        return {
          code: 0, queued: false, processed: false, inboxId: queued.id,
          reason: 'duplicate_event',
        };
      }
      return { code: 0, queued: true, processed: false, inboxId: queued.id };
    }
    const result = await eventService.handle(
      request.body,
      signatureHeaders,
      rawBody ? { rawBody } : {},
    );
    return formatFeishuResult(result);
  });
}

function formatFeishuResult(result: FeishuEventResult): Record<string, unknown> {
  if (result.type === 'challenge') return { challenge: result.challenge };
  return {
    code: 0,
    processed: result.processed,
    ...(result.reminder ? { reminder: result.reminder } : {}),
    ...(result.notificationSent ? { notificationSent: true } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

function singleHeader(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
