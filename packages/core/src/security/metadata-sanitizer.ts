import type { SourceReference } from '../domain.js';
import { redactSecrets } from './secret-redactor.js';

const SENSITIVE_URL_PARAMETER =
  /(?:^|[_-])(?:access[_-]?token|auth|authorization|code|credential|key|password|passwd|pwd|secret|sig|signature|token)(?:$|[_-])/i;

export interface SanitizedSourceReference {
  source: SourceReference;
  findingCount: number;
}

/**
 * Applies the same normalization used at ingest time to source metadata.
 * Invalid legacy URLs are dropped instead of being returned or indexed.
 */
export function sanitizeSourceReference(source: SourceReference): SanitizedSourceReference {
  const externalId = source.externalId
    ? redactSecrets(source.externalId.normalize('NFKC'))
    : undefined;
  const url = source.url ? sanitizeSourceUrl(source.url) : undefined;

  return {
    source: {
      type: source.type,
      ...(externalId ? { externalId: externalId.redactedText } : {}),
      ...(url?.value ? { url: url.value } : {}),
    },
    findingCount: (externalId?.findings.length ?? 0) + (url?.findingCount ?? 0),
  };
}

export function sanitizeTitle(value: string): { value: string; findingCount: number } {
  const result = redactSecrets(value.normalize('NFKC'));
  return { value: result.redactedText, findingCount: result.findings.length };
}

export function sanitizeContent(value: string): { value: string; findingCount: number } {
  const result = redactSecrets(value);
  return { value: result.redactedText, findingCount: result.findings.length };
}

function sanitizeSourceUrl(input: string): { value?: string; findingCount: number } {
  try {
    const url = new URL(input);
    let findingCount = 0;
    if (url.username) {
      url.username = '';
      findingCount += 1;
    }
    if (url.password) {
      url.password = '';
      findingCount += 1;
    }

    url.pathname = url.pathname
      .split('/')
      .map((segment) => {
        if (!segment) return segment;
        const decoded = safeDecode(segment);
        const redaction = redactSecrets(decoded);
        if (redaction.findings.length === 0) return segment;
        findingCount += redaction.findings.length;
        return 'REDACTED';
      })
      .join('/');

    for (const [name, value] of Array.from(url.searchParams.entries())) {
      const redaction = redactSecrets(value);
      if (SENSITIVE_URL_PARAMETER.test(name) || redaction.findings.length > 0) {
        findingCount += Math.max(1, redaction.findings.length);
        url.searchParams.set(name, 'REDACTED');
      }
    }

    if (url.hash) {
      const redaction = redactSecrets(safeDecode(url.hash.slice(1)));
      if (
        redaction.findings.length > 0
        || /(?:access[_-]?token|code|credential|password|secret|token)=/i.test(url.hash)
      ) {
        findingCount += Math.max(1, redaction.findings.length);
        url.hash = 'REDACTED';
      }
    }

    return { value: url.toString(), findingCount };
  } catch {
    // Legacy databases can contain malformed source URLs. Do not retain them.
    return { findingCount: 1 };
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
