import { describe, expect, it } from 'vitest';

import { redactSecrets } from '../src/security/secret-redactor.js';

describe('redactSecrets', () => {
  it('redacts an OpenAI-compatible API key without retaining the original', () => {
    const secret = ['sk', 'example1234567890ABCDEFGHJKLMNPQ'].join('-');
    const result = redactSecrets(`LLM_API_KEY=${secret}`);

    expect(result.redactedText).not.toContain(secret);
    expect(result.redactedText).toContain('[REDACTED:api_key]');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.type).toBe('api_key');
    expect(JSON.stringify(result.findings)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret.slice(-4));
  });

  it('redacts bearer tokens while preserving the authorization scheme', () => {
    const token = 'example.bearer.token.with.sufficient.length';
    const result = redactSecrets(`Authorization: Bearer ${token}`);

    expect(result.redactedText).toBe('Authorization: Bearer [REDACTED:bearer_token]');
    expect(result.redactedText).not.toContain(token);
  });

  it('redacts password assignments and connection-string passwords', () => {
    const result = redactSecrets([
      'password=example-password-value',
      'postgresql://service:database-password@db.internal:5432/app',
    ].join('\n'));

    expect(result.redactedText).toContain('password=[REDACTED:password]');
    expect(result.redactedText).toContain('postgresql://service:[REDACTED:database_password]');
    expect(result.redactedText).toContain('@db.internal:5432/app');
    expect(result.findings.map((finding) => finding.type)).toEqual([
      'password',
      'database_password',
    ]);
  });

  it('returns ordinary text unchanged', () => {
    const input = '项目数据库配置由平台组维护，详情见部署手册。';

    expect(redactSecrets(input)).toEqual({
      redactedText: input,
      findings: [],
    });
  });

  it('is idempotent for its own redaction markers', () => {
    const input = 'password=[REDACTED:password] Bearer [REDACTED:bearer_token]';
    expect(redactSecrets(input)).toEqual({ redactedText: input, findings: [] });
  });

  it('redacts multiple non-overlapping findings deterministically', () => {
    const apiKey = ['sk', 'anotherExample1234567890ABCDEF'].join('-');
    const input = `api_key=${apiKey}; pwd=another-password`;

    const first = redactSecrets(input);
    const second = redactSecrets(input);

    expect(first).toEqual(second);
    expect(first.findings).toHaveLength(2);
    expect(first.findings.every((finding) => finding.end > finding.start)).toBe(true);
  });

  it.each([
    ['cloud_access_key', 'AKIAIOSFODNN7EXAMPLE'],
    ['github_token', `ghp_${'a'.repeat(36)}`],
    ['service_token', `npm_${'b'.repeat(36)}`],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signatureValue12345'],
  ])('redacts high-value %s credentials without retaining any suffix', (type, secret) => {
    const result = redactSecrets(`credential=${secret}`);

    expect(result.findings.some((finding) => finding.type === type)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret.slice(-4));
  });

  it('redacts private key blocks and prefixed environment assignments', () => {
    const privateKey = [
      '-----BEGIN PRIVATE KEY-----',
      'c3VwZXItc2VjcmV0LXByaXZhdGUta2V5LW1hdGVyaWFs',
      '-----END PRIVATE KEY-----',
    ].join('\n');
    const appSecret = 'feishu-application-secret-value';
    const result = redactSecrets(`${privateKey}\nFEISHU_APP_SECRET=${appSecret}`);

    expect(result.findings.map((finding) => finding.type)).toEqual([
      'private_key',
      'password',
    ]);
    expect(result.redactedText).toContain('[REDACTED:private_key]');
    expect(JSON.stringify(result)).not.toContain('bWF0ZXJpYWw');
    expect(JSON.stringify(result)).not.toContain(appSecret.slice(-4));
  });

  it('redacts common cloud and OAuth assignment names', () => {
    const input = [
      'AWS_SECRET_ACCESS_KEY=aws-secret-value',
      'AccountKey=account-secret-value',
      'refreshToken=refresh-secret-value',
      'AWS_SESSION_TOKEN=session-secret-value',
    ].join('\n');

    const result = redactSecrets(input);

    expect(result.redactedText).not.toContain('aws-secret-value');
    expect(result.redactedText).not.toContain('account-secret-value');
    expect(result.redactedText).not.toContain('refresh-secret-value');
    expect(result.redactedText).not.toContain('session-secret-value');
    expect(result.findings).toHaveLength(4);
    expect(result.findings.every((finding) => finding.type === 'password')).toBe(true);
  });
});
