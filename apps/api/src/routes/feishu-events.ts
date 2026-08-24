import type { FastifyInstance } from 'fastify';

import { FeishuEventService } from '../feishu/feishu-event-service.js';
import type { FeishuSignatureHeaders } from '../feishu/feishu-signature.js';

export function registerFeishuEventRoute(
  app: FastifyInstance,
  eventService: FeishuEventService,
): void {
  app.post('/events', async (request) => {
    const signatureHeaders: FeishuSignatureHeaders = {};
    const timestamp = singleHeader(request.headers['x-lark-request-timestamp']);
    const nonce = singleHeader(request.headers['x-lark-request-nonce']);
    const signature = singleHeader(request.headers['x-lark-signature']);
    if (timestamp) signatureHeaders.timestamp = timestamp;
    if (nonce) signatureHeaders.nonce = nonce;
    if (signature) signatureHeaders.signature = signature;
    const result = await eventService.handle(request.body, signatureHeaders);
    if (result.type === 'challenge') return { challenge: result.challenge };
    return {
      code: 0,
      processed: result.processed,
      ...(result.reminder ? { reminder: result.reminder } : {}),
      ...(result.notificationSent ? { notificationSent: true } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
    };
  });
}

function singleHeader(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
