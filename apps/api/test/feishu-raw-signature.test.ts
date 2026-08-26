import { createCipheriv, createHash } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';

describe('Feishu raw-body signature verification', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('verifies the exact wire body instead of re-serializing parsed JSON', async () => {
    const encryptKey = 'raw-body-test-encrypt-key';
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const nonce = 'raw-body-nonce';
    // Encrypt the event as Feishu does, then deliberately use non-canonical
    // whitespace and key order in the outer envelope. Fastify parses this
    // into the same object a normal handler receives, but JSON.stringify
    // would produce different signed bytes.
    const plaintext = '{"event":{"message":{"content":"{\\"text\\":\\"hello raw\\"}","message_type":"text","message_id":"raw-message"},"sender":{"sender_id":{"open_id":"raw-user"}}},"header":{"token":"verification","tenant_key":"raw-tenant","event_type":"im.message.receive_v1","event_id":"raw-event"}}';
    const encryptionKey = createHash('sha256').update(encryptKey, 'utf8').digest();
    const iv = Buffer.alloc(16, 13);
    const cipher = createCipheriv('aes-256-cbc', encryptionKey, iv);
    const encrypted = Buffer.concat([iv, cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
    const rawBody = `{\n  "encrypt": "${encrypted}"\n}`;
    const signature = createHash('sha256')
      .update(timestamp + nonce + encryptKey + rawBody, 'utf8')
      .digest('hex');

    app = await buildApp({
      databasePath: ':memory:',
      logger: false,
      feishuVerificationToken: 'verification',
      feishuEncryptKey: encryptKey,
      // Keep the test deterministic even if the wall clock ticks over a
      // second between signature creation and request injection.
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/connectors/feishu/events',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-lark-request-timestamp': timestamp,
        'x-lark-request-nonce': nonce,
        'x-lark-signature': signature,
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ code: 0, processed: true });
  });
});
