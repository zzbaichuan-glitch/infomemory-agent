import { createDecipheriv, createHash } from 'node:crypto';

export class FeishuPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeishuPayloadError';
  }
}

export function decodeFeishuPayload(payload: unknown, encryptKey?: string): unknown {
  if (!isRecord(payload) || typeof payload.encrypt !== 'string') {
    if (encryptKey?.trim()) {
      throw new FeishuPayloadError('Feishu encrypted payload is required');
    }
    return payload;
  }
  if (!encryptKey?.trim()) throw new FeishuPayloadError('Feishu encrypted payload cannot be decrypted');
  try {
    const key = createHash('sha256').update(encryptKey.trim(), 'utf8').digest();
    const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.encrypt, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext) as unknown;
  } catch {
    throw new FeishuPayloadError('Feishu encrypted payload is invalid');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
