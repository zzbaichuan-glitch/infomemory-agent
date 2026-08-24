import {
  AssetService,
  type AssetRepository,
} from '@infomemory/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  requireAccessContext,
  requirePermission,
} from '../plugins/access-context.js';

const bodySchema = z.object({
  title: z.string().trim().min(1).max(300),
  content: z.string().trim().min(1).max(1_000_000),
  visibility: z.enum(['tenant', 'owner']).optional(),
  source: z.object({
    type: z.enum(['manual', 'local_file', 'feishu_message', 'feishu_document']),
    externalId: z.string().optional(),
    url: z.string().optional(),
  }).optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
  cursor: z.string().trim().min(1).max(2_000).optional(),
  visibility: z.enum(['tenant', 'owner']).optional(),
  sourceType: z.enum(['manual', 'local_file', 'feishu_message', 'feishu_document']).optional(),
  createdAfter: z.iso.datetime().optional(),
  createdBefore: z.iso.datetime().optional(),
});

const assetParamsSchema = z.object({
  id: z.string().trim().min(1).max(200),
});

export function registerAssetRoutes(
  app: FastifyInstance,
  assetService: AssetService,
  repository: AssetRepository,
): void {
  app.post('/assets', async (request, reply) => {
    const context = requireAccessContext(request);
    const body = bodySchema.parse(request.body);
    if (body.visibility === 'tenant') {
      requirePermission(request, 'asset:share_tenant', 'knowledge_manager');
    }
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
      return reply.code(400).send({
        error: 'idempotency_key_required',
        message: 'idempotency-key header is required',
        requestId: request.id,
      });
    }
    const result = await assetService.ingest(context, {
      ...body,
      idempotencyKey: idempotencyKey.trim(),
    });
    return reply.code(result.created ? 201 : 200).send(result);
  });

  app.get('/assets', async (request) => {
    const query = listQuerySchema.parse(request.query);
    return assetService.listPage(requireAccessContext(request), query);
  });

  app.get('/assets/:id', async (request, reply) => {
    const { id } = assetParamsSchema.parse(request.params);
    const asset = await assetService.getById(requireAccessContext(request), id);
    if (!asset) {
      return reply.code(404).send({
        error: 'asset_not_found',
        message: 'Asset was not found in the current access context',
        requestId: request.id,
      });
    }
    return { asset };
  });

  app.delete('/assets/:id', async (request, reply) => {
    const { id } = assetParamsSchema.parse(request.params);
    const deleted = await assetService.deleteOwned(requireAccessContext(request), id);
    if (!deleted) {
      return reply.code(404).send({
        error: 'asset_not_found',
        message: 'Asset was not found or is not owned by the current user',
        requestId: request.id,
      });
    }
    return { deleted: true, id };
  });
}
