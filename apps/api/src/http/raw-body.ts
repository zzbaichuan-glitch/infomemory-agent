import { Readable } from 'node:stream';

import type { FastifyInstance, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Exact UTF-8 bytes received for connector signature verification. */
    rawBody: Buffer | null;
  }
}

export interface RawBodyCaptureOptions {
  /** Only requests matching this prefix are copied. */
  pathPrefix?: string;
  /** Hard upper bound applied while buffering the body. */
  maxBytes?: number;
}

export class RawBodyLimitError extends Error {
  readonly code = 'FST_ERR_CTP_BODY_TOO_LARGE';
  readonly statusCode = 413;

  constructor() {
    super('The request body exceeds the allowed size');
    this.name = 'RawBodyLimitError';
  }
}

/**
 * Capture the exact request bytes before Fastify's JSON parser runs.
 *
 * Feishu signs the wire representation of the body. Re-serializing
 * `request.body` can change whitespace or object-key order and therefore
 * rejects valid production callbacks. The replacement stream lets Fastify
 * parse the body normally after we retain the original bytes.
 */
export function registerRawBodyCapture(
  app: FastifyInstance,
  options: RawBodyCaptureOptions = {},
): void {
  const pathPrefix = options.pathPrefix ?? '/v1/connectors/feishu/events';
  const maxBytes = options.maxBytes ?? 4 * 1_024 * 1_024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('raw body maxBytes must be a positive integer');
  }

  app.decorateRequest('rawBody', null);
  app.addHook('preParsing', async (request, _reply, payload) => {
    request.rawBody = null;
    if (!request.url.startsWith(pathPrefix) || !hasBody(request)) return payload;

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of payload) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        // Let Fastify's normal body-limit error contract handle the response;
        // do not retain a partial body in memory or expose its contents.
        request.rawBody = null;
        throw new RawBodyLimitError();
      }
      chunks.push(buffer);
    }
    const rawBody = Buffer.concat(chunks, total);
    request.rawBody = rawBody;
    const replacement = Readable.from([rawBody]);
    // Fastify uses this hint for its encoded-length accounting. It is not
    // user-controlled after the stream has been fully bounded above.
    Object.defineProperty(replacement, 'receivedEncodedLength', {
      configurable: true,
      value: total,
    });
    return replacement;
  });
}

function hasBody(request: FastifyRequest): boolean {
  return request.headers['content-length'] !== undefined
    || request.headers['transfer-encoding'] !== undefined;
}
