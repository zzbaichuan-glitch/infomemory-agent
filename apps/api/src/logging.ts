export interface SafeLoggerOptions {
  level: 'debug' | 'info';
  redact: {
    paths: string[];
    censor: string;
  };
}

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-lark-signature"]',
  'req.body.token',
  'req.body.header.token',
  'req.body.encrypt',
  'res.headers["set-cookie"]',
  'authorization',
  'apiKey',
  'appSecret',
  'encryptKey',
] as const;

export function createLoggerOptions(
  nodeEnv: 'development' | 'test' | 'production',
): SafeLoggerOptions {
  return {
    level: nodeEnv === 'production' ? 'info' : 'debug',
    redact: {
      paths: [...REDACTED_PATHS],
      censor: '[REDACTED]',
    },
  };
}
