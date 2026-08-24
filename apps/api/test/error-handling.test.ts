import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';

describe('API error contract', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    app = await buildApp({ bodyLimitBytes: 1_024 });
  });

  afterEach(async () => app.close());

  it('maps malformed JSON to a stable 400 response', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: {
        ...accessHeaders(),
        'content-type': 'application/json',
      },
      payload: '{',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_json',
      message: 'The request body must contain valid JSON',
      requestId: expect.any(String),
    });
  });

  it('maps oversized payloads to 413 without echoing content', async () => {
    const sensitive = 'sensitive-body-marker';
    const response = await app.inject({
      method: 'POST',
      url: '/v1/assets',
      headers: {
        ...accessHeaders(),
        'idempotency-key': 'oversized',
      },
      payload: {
        title: 'oversized',
        content: `${sensitive}${'x'.repeat(2_000)}`,
      },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: 'payload_too_large',
      requestId: expect.any(String),
    });
    expect(response.body).not.toContain(sensitive);
  });

  it('rejects non-JSON request bodies with 415', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: {
        ...accessHeaders(),
        'content-type': 'text/plain',
      },
      payload: '{}',
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({
      error: 'unsupported_media_type',
      requestId: expect.any(String),
    });
  });

  it('returns the same safe contract for an unknown route', async () => {
    const response = await app.inject({ method: 'GET', url: '/missing' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'route_not_found',
      message: 'The requested route was not found',
      requestId: expect.any(String),
    });
  });
});

function accessHeaders(): Record<string, string> {
  return {
    'x-tenant-id': 'tenant-a',
    'x-user-id': 'alice',
  };
}
