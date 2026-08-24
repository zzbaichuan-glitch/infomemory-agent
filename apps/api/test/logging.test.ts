import { describe, expect, it } from 'vitest';

import { createLoggerOptions } from '../src/logging.js';

describe('safe logger configuration', () => {
  it('redacts authorization, cookies, callback tokens, and application secrets', () => {
    const options = createLoggerOptions('production');

    expect(options.level).toBe('info');
    expect(options.redact.censor).toBe('[REDACTED]');
    expect(options.redact.paths).toEqual(expect.arrayContaining([
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.token',
      'req.body.header.token',
      'apiKey',
      'appSecret',
      'encryptKey',
    ]));
  });
});
