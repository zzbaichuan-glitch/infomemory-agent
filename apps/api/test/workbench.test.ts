import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';

describe('browser workbench', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    app = await buildApp({ databasePath: ':memory:', logger: false });
  });

  afterEach(async () => app.close());

  it('serves the first-party shell and static assets without authentication', async () => {
    const [root, page, script, styles] = await Promise.all([
      app.inject({ method: 'GET', url: '/' }),
      app.inject({ method: 'GET', url: '/app/' }),
      app.inject({ method: 'GET', url: '/app/app.js' }),
      app.inject({ method: 'GET', url: '/app/styles.css' }),
    ]);

    expect(root.statusCode).toBe(200);
    expect(page.statusCode).toBe(200);
    expect(root.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.headers['content-security-policy']).toContain("object-src 'none'");
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(page.headers['permissions-policy']).toContain('camera=()');
    expect(page.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(page.body).toContain('知澜工作台');
    expect(page.body).toContain('/v1/connectors/feishu/events');
    expect(page.body).toContain('id="identity-form" class="form-grid" method="post"');
    expect(page.body).not.toMatch(/<form[^>]*method=["']get["']/iu);
    expect(page.body).not.toContain('AUTH_SECRET');
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toContain('text/javascript');
    expect(script.body).toContain("'/v1/answers'");
    expect(script.body).toContain("'/v1/connectors/feishu/oauth/start");
    expect(script.body).toContain("'/v1/connectors/feishu/installation/refresh");
    expect(script.body).toContain('connectorCapabilities');
    expect(script.body).toContain('feishuOAuthInstallation');
    expect(script.body).toContain('state.feishuOAuthEnabled === false');
    expect(script.body).not.toContain('process.env');
    expect(script.body).not.toContain('innerHTML');
    expect(script.body).not.toContain('eval(');
    expect(script.body).not.toContain('token: state.token');
    expect(styles.statusCode).toBe(200);
    expect(styles.headers['content-type']).toContain('text/css');
    expect(styles.body).toContain('overflow-y: hidden');
    expect(styles.body).toContain('.evidence-card .meta { display: flex;');
  });

  it('advertises the workbench capability without exposing configuration secrets', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json().capabilities).toContain('first_party_web_workbench');
    expect(response.body).not.toContain('AUTH_SECRET');
    expect(response.body).not.toContain('FEISHU_APP_SECRET');
  });

  it('keeps the page usable with the real authenticated API contract', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/assets',
      headers: {
        'x-tenant-id': 'workbench-tenant',
        'x-user-id': 'alice',
        'idempotency-key': 'workbench-smoke-1',
      },
      payload: {
        title: '工作台 smoke',
        content: '这条内容用于验证工作台与 API 的连接。',
      },
    });
    expect(created.statusCode).toBe(201);

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/assets?limit=10',
      headers: {
        'x-tenant-id': 'workbench-tenant',
        'x-user-id': 'alice',
      },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().assets).toHaveLength(1);

    const search = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: {
        'x-tenant-id': 'workbench-tenant',
        'x-user-id': 'alice',
      },
      payload: { query: '工作台' },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().evidence).toHaveLength(1);
  });
});
