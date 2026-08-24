import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  FeishuSignatureError,
  verifyFeishuSignature,
} from '../src/feishu/feishu-signature.js';

describe('verifyFeishuSignature', () => {
  const encryptKey = 'test-encrypt-key';
  const now = () => 1_800_000_000_000;
  const timestamp = '1800000000';
  const nonce = 'nonce-1';
  const payload = { encrypt: 'ciphertext' };

  it('accepts the signature used by the official Feishu Node SDK boundary', () => {
    expect(() => verifyFeishuSignature(payload, {
      timestamp,
      nonce,
      signature: sign(payload),
    }, { encryptKey, now })).not.toThrow();
  });

  it('rejects missing, stale, malformed, and tampered signatures', () => {
    expect(() => verifyFeishuSignature(payload, {}, { encryptKey, now }))
      .toThrow(FeishuSignatureError);
    expect(() => verifyFeishuSignature(payload, {
      timestamp: '1799999000',
      nonce,
      signature: sign(payload, '1799999000'),
    }, { encryptKey, now })).toThrow('timestamp');
    expect(() => verifyFeishuSignature(payload, {
      timestamp,
      nonce,
      signature: 'not-a-signature',
    }, { encryptKey, now })).toThrow(FeishuSignatureError);
    expect(() => verifyFeishuSignature({ encrypt: 'changed' }, {
      timestamp,
      nonce,
      signature: sign(payload),
    }, { encryptKey, now })).toThrow(FeishuSignatureError);
  });

  function sign(value: unknown, at = timestamp): string {
    return createHash('sha256')
      .update(at + nonce + encryptKey + JSON.stringify(value))
      .digest('hex');
  }
});
