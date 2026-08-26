import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { AccessContext, Reminder, ReminderStatus } from '../domain.js';
import type { ReminderRepository } from '../repositories/reminder-repository.js';
import { redactSecrets } from '../security/secret-redactor.js';
import { sanitizeContent, sanitizeTitle } from '../security/metadata-sanitizer.js';
import {
  DEFAULT_MEETING_TIME_ZONE,
  extractMeetingReminder,
  type MeetingReminderCandidate,
} from './meeting-time-extractor.js';

const accessContextSchema = z.object({
  tenantId: z.string().trim().min(1).max(200),
  userId: z.string().trim().min(1).max(200),
});

const listSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).max(100_000).default(0),
  status: z.union([
    z.enum(['scheduled', 'needs_confirmation', 'completed', 'cancelled']),
    z.array(z.enum(['scheduled', 'needs_confirmation', 'completed', 'cancelled'])).min(1),
  ]).optional(),
  dueBefore: z.iso.datetime().optional(),
});

const scheduleSchema = z.object({
  title: z.string().trim().min(1).max(300),
  startsAt: z.iso.datetime(),
  remindAt: z.iso.datetime().optional(),
});

const ALLOWED_STATUS_TRANSITIONS: Record<ReminderStatus, ReminderStatus[]> = {
  needs_confirmation: ['scheduled', 'completed', 'cancelled'],
  scheduled: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export interface ReminderObservation {
  text: string;
  sourceAssetId?: string;
  sourceEventId?: string;
}

export interface ScheduleReminderCommand {
  title: string;
  startsAt: string;
  remindAt?: string;
}

export class InvalidReminderTransitionError extends Error {
  readonly code = 'invalid_reminder_transition';

  constructor(from: ReminderStatus, to: ReminderStatus) {
    super(`Reminder cannot transition from ${from} to ${to}`);
    this.name = 'InvalidReminderTransitionError';
  }
}

export interface ReminderServiceOptions {
  idFactory?: () => string;
  now?: () => Date;
  timeZone?: string;
}

export class ReminderService {
  readonly #idFactory: () => string;
  readonly #now: () => Date;
  readonly #timeZone: string;

  constructor(
    private readonly repository: ReminderRepository,
    options: ReminderServiceOptions = {},
  ) {
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#timeZone = options.timeZone?.trim() || DEFAULT_MEETING_TIME_ZONE;
  }

  async observeMessage(
    contextInput: AccessContext,
    observation: ReminderObservation,
  ): Promise<Reminder | null> {
    const context = accessContextSchema.parse(contextInput);
    const text = z.string().trim().min(1).max(1_000_000).parse(observation.text);
    const safeText = sanitizeContent(text).value;
    if (observation.sourceEventId) {
      const existing = await this.repository.findReminderBySourceEvent(
        context,
        observation.sourceEventId,
      );
      if (existing) return existing;
    }
    const candidate = extractMeetingReminder(safeText, this.#now(), {
      timeZone: this.#timeZone,
    });
    if (!candidate) return null;
    return this.#persistCandidate(context, {
      ...candidate,
      title: sanitizeTitle(candidate.title).value,
      matchedText: sanitizeContent(candidate.matchedText).value,
    }, observation);
  }

  async list(
    contextInput: AccessContext,
    input: {
      limit?: number;
      offset?: number;
      status?: ReminderStatus | ReminderStatus[];
      dueBefore?: string;
    } = {},
  ): Promise<Reminder[]> {
    const context = accessContextSchema.parse(contextInput);
    const options = listSchema.parse(input);
    return this.repository.listReminders(context, {
      limit: options.limit,
      offset: options.offset,
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.dueBefore !== undefined ? { dueBefore: options.dueBefore } : {}),
    });
  }

  async schedule(
    contextInput: AccessContext,
    input: ScheduleReminderCommand,
  ): Promise<Reminder> {
    const context = accessContextSchema.parse(contextInput);
    const command = scheduleSchema.parse(input);
    const now = this.#now();
    const startsAt = new Date(command.startsAt);
    if (startsAt.getTime() <= now.getTime()) {
      throw new z.ZodError([{
        code: 'custom',
        path: ['startsAt'],
        message: 'startsAt must be in the future',
      }]);
    }
    const requestedRemindAt = command.remindAt
      ? new Date(command.remindAt)
      : new Date(Math.max(now.getTime(), startsAt.getTime() - 30 * 60_000));
    if (requestedRemindAt.getTime() < now.getTime()) {
      throw new z.ZodError([{
        code: 'custom',
        path: ['remindAt'],
        message: 'remindAt must not be in the past',
      }]);
    }
    if (requestedRemindAt.getTime() > startsAt.getTime()) {
      throw new z.ZodError([{
        code: 'custom',
        path: ['remindAt'],
        message: 'remindAt must not be after startsAt',
      }]);
    }
    const safeTitle = redactSecrets(command.title).redactedText;
    return this.repository.createReminder({
      id: this.#idFactory(),
      context,
      title: safeTitle,
      startsAt: startsAt.toISOString(),
      remindAt: requestedRemindAt.toISOString(),
      status: 'scheduled',
      precision: 'exact',
      createdAt: now.toISOString(),
    });
  }

  async listDue(contextInput: AccessContext, at = this.#now()): Promise<Reminder[]> {
    const context = accessContextSchema.parse(contextInput);
    return this.repository.listReminders(context, {
      status: 'scheduled',
      dueBefore: at.toISOString(),
      limit: 200,
    });
  }

  async deleteReminder(contextInput: AccessContext, idInput: string): Promise<boolean> {
    const context = accessContextSchema.parse(contextInput);
    const id = z.string().trim().min(1).max(200).parse(idInput);
    return this.repository.deleteReminder(context, id);
  }

  async updateStatus(
    contextInput: AccessContext,
    idInput: string,
    status: ReminderStatus,
  ): Promise<Reminder | null> {
    const context = accessContextSchema.parse(contextInput);
    const id = z.string().trim().min(1).max(200).parse(idInput);
    const nextStatus = z.enum(['scheduled', 'needs_confirmation', 'completed', 'cancelled']).parse(status);
    const current = await this.repository.findReminder(context, id);
    if (!current || current.status === nextStatus) return current;
    if (!ALLOWED_STATUS_TRANSITIONS[current.status].includes(nextStatus)) {
      throw new InvalidReminderTransitionError(current.status, nextStatus);
    }
    // Compare-and-set in the repository closes the read/modify/write race
    // between concurrent terminal transitions. If another worker won first,
    // re-read the row and report the real transition that is now invalid.
    const updated = await this.repository.updateReminderStatus(
      context,
      id,
      nextStatus,
      current.status,
    );
    if (updated) return updated;
    const latest = await this.repository.findReminder(context, id);
    if (!latest || latest.status === nextStatus) return latest;
    throw new InvalidReminderTransitionError(latest.status, nextStatus);
  }

  #persistCandidate(
    context: AccessContext,
    candidate: MeetingReminderCandidate,
    observation: ReminderObservation,
  ): Promise<Reminder> {
    return this.repository.createReminder({
      id: this.#idFactory(),
      context,
      title: candidate.title,
      startsAt: candidate.startsAt.toISOString(),
      remindAt: candidate.remindAt.toISOString(),
      status: candidate.needsConfirmation ? 'needs_confirmation' : 'scheduled',
      precision: candidate.precision,
      ...(observation.sourceAssetId ? { sourceAssetId: observation.sourceAssetId } : {}),
      ...(observation.sourceEventId ? { sourceEventId: observation.sourceEventId } : {}),
      createdAt: this.#now().toISOString(),
    });
  }
}
