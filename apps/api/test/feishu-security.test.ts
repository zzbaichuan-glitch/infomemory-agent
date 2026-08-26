import { createCipheriv, createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';

describe('Feishu webhook transport security', () => {
  const encryptKey = 'test-encrypt-key';
  const nonce = 'transport-nonce';
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    app = await buildApp({
      databasePath: ':memory:',
      logger: false,
      feishuVerificationToken: 'expected-token',
      feishuEncryptKey: encryptKey,
    });
  });

  afterEach(async () => app.close());

  it('accepts a fresh, signed, encrypted challenge', async () => {
    const payload = {
      encrypt: encrypt({
        type: 'url_verification',
        token: 'expected-token',
        challenge: 'secure-challenge',
      }),
    };
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/connectors/feishu/events',
      headers: signatureHeaders(payload, timestamp),
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ challenge: 'secure-challenge' });
  });

  it('accepts an encrypted URL challenge without callback signature headers', async () => {
    const payload = {
      encrypt: encrypt({
        type: 'url_verification',
        token: 'expected-token',
        challenge: 'unsigned-challenge',
      }),
    };
    const response = await app.inject({
      method: 'POST',
      url: '/v1/connectors/feishu/events',
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ challenge: 'unsigned-challenge' });
  });

  it('rejects a correctly signed plaintext downgrade when encryption is configured', async () => {
    const payload = {
      type: 'url_verification',
      token: 'expected-token',
      challenge: 'must-not-pass',
    };
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/connectors/feishu/events',
      headers: signatureHeaders(payload, timestamp),
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'feishu_payload_invalid',
      requestId: expect.any(String),
    });
  });

  function signatureHeaders(payload: unknown, timestamp: string): Record<string, string> {
    const signature = createHash('sha256')
      .update(timestamp + nonce + encryptKey + JSON.stringify(payload))
      .digest('hex');
    return {
      'x-lark-request-timestamp': timestamp,
      'x-lark-request-nonce': nonce,
      'x-lark-signature': signature,
    };
  }

  function encrypt(value: unknown): string {
    const key = createHash('sha256').update(encryptKey).digest();
    const iv = Buffer.alloc(16, 11);
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([
      iv,
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]).toString('base64');
  }
});
