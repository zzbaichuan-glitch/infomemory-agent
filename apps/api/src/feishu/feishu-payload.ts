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
    // Feishu's encrypted webhook format is base64(IV || ciphertext). The
    // first AES block is a per-message IV and must not be passed to the
    // decipher as ciphertext. (Using key[0:16] as the IV is a common but
    // incompatible implementation found in older examples.)
    const encrypted = Buffer.from(payload.encrypt, 'base64');
    if (encrypted.length < 32 || (encrypted.length - 16) % 16 !== 0) {
      throw new Error('ciphertext has an invalid length');
    }
    const iv = encrypted.subarray(0, 16);
    const ciphertext = encrypted.subarray(16);
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
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
