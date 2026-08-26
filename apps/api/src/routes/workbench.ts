import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance, FastifyReply } from 'fastify';

const WORKBENCH_HEADERS = {
  // The workbench is a same-origin client. Keeping a strict policy here
  // prevents accidental third-party script/style loading in deployments.
  'content-security-policy': "default-src 'self'; connect-src 'self'; script-src 'self'; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; manifest-src 'self'; worker-src 'none'",
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
} as const;

interface WorkbenchFiles {
  html: string;
  script: string;
  styles: string;
}

/**
 * Register the first-party browser workbench without adding a frontend build
 * dependency. Files are loaded from apps/api/public both in source (tsx) and
 * compiled (dist) layouts, and only a fixed allow-list is served.
 */
export async function registerWorkbenchRoutes(app: FastifyInstance): Promise<void> {
  const files = await loadWorkbenchFiles();
  const sendHtml = (_request: unknown, reply: FastifyReply) => send(reply, files.html, 'text/html; charset=utf-8');
  const sendScript = (_request: unknown, reply: FastifyReply) => send(reply, files.script, 'text/javascript; charset=utf-8');
  const sendStyles = (_request: unknown, reply: FastifyReply) => send(reply, files.styles, 'text/css; charset=utf-8');

  app.get('/', sendHtml);
  app.get('/app', sendHtml);
  app.get('/app/', sendHtml);
  app.get('/app/app.js', sendScript);
  app.get('/app/styles.css', sendStyles);
}

async function loadWorkbenchFiles(): Promise<WorkbenchFiles> {
  const publicDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../public');
  const [html, script, styles] = await Promise.all([
    readFile(resolve(publicDirectory, 'index.html'), 'utf8'),
    readFile(resolve(publicDirectory, 'app.js'), 'utf8'),
    readFile(resolve(publicDirectory, 'styles.css'), 'utf8'),
  ]);
  return { html, script, styles };
}

function send(reply: FastifyReply, body: string, contentType: string): FastifyReply {
  reply.type(contentType);
  for (const [name, value] of Object.entries(WORKBENCH_HEADERS)) reply.header(name, value);
  return reply.send(body);
}
