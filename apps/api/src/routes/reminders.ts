import {
  ReminderService,
  type ReminderStatus,
} from '@infomemory/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireAccessContext } from '../plugins/access-context.js';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  status: z.string().trim().min(1).optional(),
  dueBefore: z.iso.datetime().optional(),
});

const statusSchema = z.object({
  status: z.enum(['scheduled', 'needs_confirmation', 'completed', 'cancelled']),
});

const createSchema = z.object({
  title: z.string().trim().min(1).max(300),
  startsAt: z.iso.datetime(),
  remindAt: z.iso.datetime().optional(),
});

const statuses: ReminderStatus[] = ['scheduled', 'needs_confirmation', 'completed', 'cancelled'];

export function registerReminderRoutes(
  app: FastifyInstance,
  reminderService: ReminderService,
): void {
  app.post('/reminders', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const reminder = await reminderService.schedule(
      requireAccessContext(request),
      {
        title: body.title,
        startsAt: body.startsAt,
        ...(body.remindAt !== undefined ? { remindAt: body.remindAt } : {}),
      },
    );
    return reply.code(201).send({ reminder });
  });

  app.get('/reminders/due', async (request) => {
    const query = z.object({ at: z.iso.datetime().optional() }).parse(request.query);
    return {
      reminders: await reminderService.listDue(
        requireAccessContext(request),
        query.at ? new Date(query.at) : undefined,
      ),
    };
  });

  app.get('/reminders', async (request) => {
    const query = querySchema.parse(request.query);
    const status = query.status ? parseStatuses(query.status) : undefined;
    const { status: _rawStatus, dueBefore, ...rest } = query;
    return {
      reminders: await reminderService.list(
        requireAccessContext(request),
        {
          ...rest,
          ...(status ? { status } : {}),
          ...(dueBefore ? { dueBefore } : {}),
        },
      ),
    };
  });

  app.delete('/reminders/:id', async (request, reply) => {
    const params = z.object({ id: z.string().trim().min(1).max(200) }).parse(request.params);
    const deleted = await reminderService.deleteReminder(
      requireAccessContext(request),
      params.id,
    );
    if (!deleted) {
      return reply.code(404).send({
        error: 'reminder_not_found',
        message: 'Reminder was not found in the current access context',
        requestId: request.id,
      });
    }
    return { deleted: true, id: params.id };
  });

  app.post('/reminders/:id/status', async (request, reply) => {
    const params = z.object({ id: z.string().trim().min(1).max(200) }).parse(request.params);
    const body = statusSchema.parse(request.body);
    const reminder = await reminderService.updateStatus(
      requireAccessContext(request),
      params.id,
      body.status,
    );
    if (!reminder) {
      return reply.code(404).send({
        error: 'reminder_not_found',
        message: 'Reminder was not found in the current access context',
        requestId: request.id,
      });
    }
    return { reminder };
  });
}

function parseStatuses(value: string): ReminderStatus[] {
  const values = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (values.length === 0 || values.some((item) => !statuses.includes(item as ReminderStatus))) {
    throw new z.ZodError([{
      code: 'custom',
      path: ['status'],
      message: 'status contains an unsupported value',
    }]);
  }
  return values as ReminderStatus[];
}
