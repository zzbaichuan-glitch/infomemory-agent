import type { FastifyInstance } from 'fastify';

const METHODS_WITH_BODIES = new Set(['POST', 'PUT', 'PATCH']);

export class UnsupportedMediaTypeError extends Error {
  constructor() {
    super('The request content type must be application/json');
    this.name = 'UnsupportedMediaTypeError';
  }
}

export function registerJsonMediaTypeGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    if (!METHODS_WITH_BODIES.has(request.method)) return;
    const hasBody = request.headers['content-length'] !== undefined
      || request.headers['transfer-encoding'] !== undefined;
    if (!hasBody) return;
    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string' || !isJsonMediaType(contentType)) {
      throw new UnsupportedMediaTypeError();
    }
  });
}

function isJsonMediaType(value: string): boolean {
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json' || Boolean(mediaType?.endsWith('+json'));
}
