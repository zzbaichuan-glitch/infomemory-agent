import { createHash, timingSafeEqual } from 'node:crypto';

export interface FeishuSignatureHeaders {
  timestamp?: string;
  nonce?: string;
  signature?: string;
}

export interface VerifyFeishuSignatureOptions {
  encryptKey: string;
  now?: () => number;
  toleranceSeconds?: number;
}

export type FeishuSignedPayload = unknown | string | Buffer;

export class FeishuSignatureError extends Error {
  constructor(message = 'Feishu callback signature verification failed') {
    super(message);
    this.name = 'FeishuSignatureError';
  }
}

/**
 * Mirrors the current official Feishu Node SDK webhook verification boundary:
 * sha256(timestamp + nonce + encryptKey + JSON.stringify(payload)).
 */
export function verifyFeishuSignature(
  payload: FeishuSignedPayload,
  headers: FeishuSignatureHeaders,
  options: VerifyFeishuSignatureOptions,
): void {
  const timestamp = required(headers.timestamp);
  const nonce = required(headers.nonce);
  const signature = required(headers.signature).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(signature)) throw new FeishuSignatureError();

  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds <= 0) {
    throw new FeishuSignatureError();
  }
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1_000);
  const tolerance = Math.max(1, options.toleranceSeconds ?? 300);
  if (Math.abs(nowSeconds - timestampSeconds) > tolerance) {
    throw new FeishuSignatureError('Feishu callback timestamp is outside the accepted window');
  }

  const serialized = serializeSignedPayload(payload);
  if (!serialized) throw new FeishuSignatureError();
  const expected = createHash('sha256')
    .update(timestamp + nonce + options.encryptKey + serialized)
    .digest();
  const received = Buffer.from(signature, 'hex');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new FeishuSignatureError();
  }
}

function serializeSignedPayload(payload: FeishuSignedPayload): string | null {
  if (typeof payload === 'string') return payload;
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  const serialized = JSON.stringify(payload);
  return serialized ?? null;
}

function required(value: string | undefined): string {
  if (typeof value !== 'string' || !value.trim()) throw new FeishuSignatureError();
  return value.trim();
}
