import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import {
  ConnectorQueueConflictError,
  IdempotencyConflictError,
  InvalidAssetCursorError,
  InvalidReminderTransitionError,
} from '@infomemory/core';
import { ZodError } from 'zod';

import {
  FeishuConfigurationError,
  FeishuPayloadError,
  FeishuVerificationError,
} from '../feishu/feishu-event-service.js';
import { FeishuSignatureError } from '../feishu/feishu-signature.js';
import { FeishuOAuthError } from '../feishu/feishu-oauth-service.js';
import {
  AuthenticationError,
  AuthorizationError,
} from '../plugins/access-context.js';

export interface ApiErrorBody {
  error: string;
  message: string;
  requestId: string;
}

interface ErrorDescriptor {
  statusCode: number;
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler(async (request, reply) => sendError(
    request,
    reply,
    {
      statusCode: 404,
      code: 'route_not_found',
      message: 'The requested route was not found',
    },
  ));

  app.setErrorHandler(async (error, request, reply) => {
    const descriptor = describeError(error);
    if (descriptor.statusCode >= 500) {
      request.log.error({
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorCode: fastifyErrorCode(error),
        requestId: request.id,
        statusCode: descriptor.statusCode,
      }, 'request failed');
    }
    return sendError(request, reply, descriptor);
  });
}

function describeError(error: unknown): ErrorDescriptor {
  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      code: 'validation_error',
      message: 'Request validation failed',
    };
  }
  if (error instanceof AuthenticationError) {
    return {
      statusCode: 401,
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof AuthorizationError) {
    return {
      statusCode: 403,
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof FeishuVerificationError) {
    return {
      statusCode: 401,
      code: 'feishu_verification_failed',
      message: 'Feishu callback verification failed',
    };
  }
  if (error instanceof FeishuSignatureError) {
    return {
      statusCode: 401,
      code: 'feishu_signature_invalid',
      message: 'Feishu callback signature verification failed',
    };
  }
  if (error instanceof FeishuPayloadError) {
    return {
      statusCode: 400,
      code: 'feishu_payload_invalid',
      message: 'Feishu callback payload could not be decrypted',
    };
  }
  if (error instanceof FeishuConfigurationError) {
    return {
      statusCode: 503,
      code: 'feishu_not_configured',
      message: 'Feishu callback is not configured',
    };
  }
  if (error instanceof FeishuOAuthError) {
    const statusCode = error.code === 'feishu_oauth_not_configured' ? 503
      : error.code === 'feishu_oauth_state_invalid' || error.code === 'feishu_oauth_callback_invalid'
        ? 400
        : error.code === 'feishu_oauth_tenant_mismatch' ? 403
          : error.code === 'feishu_oauth_refresh_unavailable' ? 404
            : error.code === 'feishu_oauth_refresh_conflict' ? 409 : 502;
    return {
      statusCode,
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof IdempotencyConflictError) {
    return {
      statusCode: 409,
      code: 'idempotency_conflict',
      message: 'The idempotency key was already used for a different request',
    };
  }
  if (error instanceof ConnectorQueueConflictError) {
    return {
      statusCode: 409,
      code: 'connector_queue_conflict',
      message: 'The connector event key was already used for a different payload',
    };
  }
  if (error instanceof InvalidAssetCursorError) {
    return {
      statusCode: 400,
      code: 'invalid_asset_cursor',
      message: 'The asset cursor is invalid or no longer supported',
    };
  }
  if (error instanceof InvalidReminderTransitionError) {
    return {
      statusCode: 409,
      code: 'invalid_reminder_transition',
      message: 'The reminder cannot transition from its current status',
    };
  }

  const code = fastifyErrorCode(error);
  if (code === 'FST_ERR_CTP_INVALID_JSON_BODY' || code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
    return {
      statusCode: 400,
      code: 'invalid_json',
      message: 'The request body must contain valid JSON',
    };
  }
  if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return {
      statusCode: 413,
      code: 'payload_too_large',
      message: 'The request body exceeds the allowed size',
    };
  }
  if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || errorName(error) === 'UnsupportedMediaTypeError') {
    return {
      statusCode: 415,
      code: 'unsupported_media_type',
      message: 'The request content type must be application/json',
    };
  }
  if (errorName(error) === 'RateLimitError') {
    const retryAfterSeconds = numericProperty(error, 'retryAfterSeconds');
    return {
      statusCode: 429,
      code: 'rate_limit_exceeded',
      message: 'Too many requests; retry later',
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
  }

  const statusCode = fastifyStatusCode(error);
  if (statusCode >= 400 && statusCode < 500) {
    return genericClientError(statusCode);
  }
  return {
    statusCode: 500,
    code: 'internal_error',
    message: 'The request could not be completed',
  };
}

function genericClientError(statusCode: number): ErrorDescriptor {
  const known: Record<number, Omit<ErrorDescriptor, 'statusCode'>> = {
    400: { code: 'bad_request', message: 'The request is invalid' },
    401: { code: 'authentication_required', message: 'Authentication is required' },
    403: { code: 'forbidden', message: 'The request is not permitted' },
    404: { code: 'route_not_found', message: 'The requested route was not found' },
    405: { code: 'method_not_allowed', message: 'The request method is not allowed' },
    408: { code: 'request_timeout', message: 'The request timed out' },
    409: { code: 'conflict', message: 'The request conflicts with current state' },
    413: { code: 'payload_too_large', message: 'The request body exceeds the allowed size' },
    415: { code: 'unsupported_media_type', message: 'The request content type is not supported' },
    429: { code: 'rate_limit_exceeded', message: 'Too many requests; retry later' },
  };
  return { statusCode, ...(known[statusCode] ?? {
    code: 'request_rejected',
    message: 'The request was rejected',
  }) };
}

async function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  descriptor: ErrorDescriptor,
): Promise<void> {
  if (descriptor.retryAfterSeconds !== undefined) {
    reply.header('retry-after', String(Math.max(1, descriptor.retryAfterSeconds)));
  }
  await reply.code(descriptor.statusCode).send({
    error: descriptor.code,
    message: descriptor.message,
    requestId: request.id,
  } satisfies ApiErrorBody);
}

function fastifyErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as Partial<FastifyError>).code;
  return typeof code === 'string' ? code : undefined;
}

function fastifyStatusCode(error: unknown): number {
  if (!error || typeof error !== 'object') return 500;
  const statusCode = (error as Partial<FastifyError>).statusCode;
  return typeof statusCode === 'number' && Number.isInteger(statusCode)
    ? statusCode
    : 500;
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function numericProperty(error: unknown, name: string): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as Record<string, unknown>)[name];
  return typeof value === 'number' && Number.isFinite(value) ? Math.ceil(value) : undefined;
}
