import { createCipheriv, createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decodeFeishuPayload, FeishuPayloadError } from '../src/feishu/feishu-payload.js';

describe('decodeFeishuPayload', () => {
  it('decrypts Feishu AES-256-CBC event payloads', () => {
    const keyText = 'test-encrypt-key';
    const key = createHash('sha256').update(keyText).digest();
    const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify({ type: 'url_verification', challenge: 'ok' }), 'utf8'),
      cipher.final(),
    ]).toString('base64');

    expect(decodeFeishuPayload({ encrypt: encrypted }, keyText)).toEqual({
      type: 'url_verification',
      challenge: 'ok',
    });
  });

  it('rejects encrypted payloads without a key', () => {
    expect(() => decodeFeishuPayload({ encrypt: 'invalid' }))
      .toThrow(FeishuPayloadError);
  });

  it('rejects plaintext downgrade when an encrypt key is configured', () => {
    expect(() => decodeFeishuPayload({
      type: 'url_verification',
      challenge: 'should-not-pass',
    }, 'configured-encrypt-key')).toThrow('encrypted payload is required');
  });
});
