import type { FeishuInstallationRepository } from '@infomemory/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  FeishuOAuthError,
  FeishuOAuthService,
} from '../feishu/feishu-oauth-service.js';
import {
  requireAccessContext,
  requirePermission,
} from '../plugins/access-context.js';

const startQuerySchema = z.object({
  returnTo: z.string().trim().min(1).max(500).optional(),
});

const callbackQuerySchema = z.object({
  code: z.string().trim().min(1).max(4_000).optional(),
  state: z.string().trim().min(1).max(512).optional(),
  error: z.string().trim().min(1).max(200).optional(),
});

/** Routes that run after the normal product authentication hook. */
export function registerFeishuOAuthSecuredRoutes(
  app: FastifyInstance,
  service: FeishuOAuthService,
): void {
  app.get('/connectors/feishu/oauth/start', async (request) => {
    const query = startQuerySchema.parse(request.query);
    const context = requireAccessContext(request);
    requirePermission(request, 'feishu:install', 'tenant_admin', 'knowledge_manager');
    return service.start({
      tenantId: context.tenantId,
      userId: context.userId,
      ...(query.returnTo ? { returnTo: query.returnTo } : {}),
    });
  });

  app.get('/connectors/feishu/installation', async (request, reply) => {
    requirePermission(request, 'feishu:install', 'tenant_admin', 'knowledge_manager');
    const installation = await service.getInstallation(requireAccessContext(request).tenantId);
    if (!installation) {
      return reply.code(404).send({
        error: 'feishu_installation_not_found',
        message: 'No Feishu installation exists for the current tenant',
        requestId: request.id,
      });
    }
    return { installation };
  });

  app.delete('/connectors/feishu/installation', async (request, reply) => {
    requirePermission(request, 'feishu:install', 'tenant_admin', 'knowledge_manager');
    const tenantId = requireAccessContext(request).tenantId;
    const revoked = await service.revokeInstallation(tenantId);
    if (!revoked) {
      return reply.code(404).send({
        error: 'feishu_installation_not_found',
        message: 'No active Feishu installation exists for the current tenant',
        requestId: request.id,
      });
    }
    return { revoked: true, tenantId };
  });

  app.post('/connectors/feishu/installation/refresh', async (request) => {
    requirePermission(request, 'feishu:install', 'tenant_admin', 'knowledge_manager');
    const tenantId = requireAccessContext(request).tenantId;
    return { installation: await service.refresh(tenantId) };
  });
}

/** Public callback route; CSRF protection is provided by the one-time state. */
export function registerFeishuOAuthCallbackRoute(
  app: FastifyInstance,
  service: FeishuOAuthService,
): void {
  app.get('/oauth/callback', async (request, reply) => {
    const query = callbackQuerySchema.parse(request.query);
    if (query.error) {
      if (!query.state) {
        throw new FeishuOAuthError(
          'feishu_oauth_callback_invalid',
          'The Feishu OAuth callback is missing required parameters',
        );
      }
      // Consume the state even when the provider denies access. This keeps
      // CSRF protection one-shot and allows browser flows to return to the
      // already validated local workbench path without reflecting provider
      // error text in a URL or response body.
      const denied = await service.callbackError(query.state);
      if (denied.returnTo) {
        const target = new URL(denied.returnTo, 'http://localhost');
        target.searchParams.set('feishu', 'error');
        return reply
          .code(303)
          .header('location', `${target.pathname}${target.search}`)
          .send();
      }
      throw new FeishuOAuthError(
        'feishu_oauth_provider_failed',
        'The Feishu authorization was denied',
      );
    }
    if (!query.code || !query.state) {
      throw new FeishuOAuthError(
        'feishu_oauth_callback_invalid',
        'The Feishu OAuth callback is missing required parameters',
      );
    }
    const result = await service.callback(query.code, query.state);
    // Browser-initiated installs can return to the first-party workbench. The
    // service only accepts local paths, so this cannot become an open redirect.
    if (result.returnTo) {
      const target = new URL(result.returnTo, 'http://localhost');
      target.searchParams.set('feishu', 'connected');
      return reply
        .code(303)
        .header('location', `${target.pathname}${target.search}`)
        .send();
    }
    return result;
  });
}

// Kept as a small compile-time assertion/documentation aid: the concrete
// SQLite repository is also the implementation used by buildApp.
export type FeishuOAuthRepository = FeishuInstallationRepository;
