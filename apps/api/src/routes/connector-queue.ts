import type { ConnectorQueueRepository } from '@infomemory/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireAccessContext, requirePermission } from '../plugins/access-context.js';

const querySchema = z.object({
  connector: z.string().trim().min(1).max(100).optional(),
});

const idSchema = z.object({ id: z.string().trim().min(1).max(200) });

/** Protected operational view of connector queue health; payloads are never returned. */
export function registerConnectorQueueRoutes(
  app: FastifyInstance,
  repository: ConnectorQueueRepository,
): void {
  app.get('/admin/connectors/queue', async (request) => {
    requirePermission(request, 'connector:queue:read', 'tenant_admin', 'knowledge_manager');
    const query = querySchema.parse(request.query);
    const context = requireAccessContext(request);
    return repository.getConnectorQueueStats(query.connector, context.tenantId);
  });

  app.post('/admin/connectors/queue/inbox/:id/retry', async (request, reply) => {
    requirePermission(request, 'connector:queue:manage', 'tenant_admin');
    const { id } = idSchema.parse(request.params);
    const retried = await repository.retryConnectorInbox(id, undefined, requireAccessContext(request).tenantId);
    if (!retried) return reply.code(404).send({
      error: 'queue_item_not_found',
      message: 'The queue item was not found in the current tenant or cannot be retried',
      requestId: request.id,
    });
    return { retried: true, id };
  });

  app.post('/admin/connectors/queue/outbox/:id/retry', async (request, reply) => {
    requirePermission(request, 'connector:queue:manage', 'tenant_admin');
    const { id } = idSchema.parse(request.params);
    const retried = await repository.retryConnectorOutbox(id, undefined, requireAccessContext(request).tenantId);
    if (!retried) return reply.code(404).send({
      error: 'queue_item_not_found',
      message: 'The queue item was not found in the current tenant or cannot be retried',
      requestId: request.id,
    });
    return { retried: true, id };
  });

  app.post('/admin/connectors/queue/inbox/:id/cancel', async (request, reply) => {
    requirePermission(request, 'connector:queue:manage', 'tenant_admin');
    const { id } = idSchema.parse(request.params);
    const cancelled = await repository.cancelConnectorInbox(id, undefined, requireAccessContext(request).tenantId);
    if (!cancelled) return reply.code(404).send({
      error: 'queue_item_not_found',
      message: 'The queue item was not found in the current tenant or cannot be cancelled',
      requestId: request.id,
    });
    return { cancelled: true, id };
  });

  app.post('/admin/connectors/queue/outbox/:id/cancel', async (request, reply) => {
    requirePermission(request, 'connector:queue:manage', 'tenant_admin');
    const { id } = idSchema.parse(request.params);
    const cancelled = await repository.cancelConnectorOutbox(id, undefined, requireAccessContext(request).tenantId);
    if (!cancelled) return reply.code(404).send({
      error: 'queue_item_not_found',
      message: 'The queue item was not found in the current tenant or cannot be cancelled',
      requestId: request.id,
    });
    return { cancelled: true, id };
  });
}
