export type SecretFindingType =
  | 'api_key'
  | 'bearer_token'
  | 'basic_auth'
  | 'cloud_access_key'
  | 'github_token'
  | 'jwt'
  | 'password'
  | 'database_password'
  | 'private_key'
  | 'service_token';

export interface SecretFinding {
  type: SecretFindingType;
  start: number;
  end: number;
  maskedPreview: string;
}

export interface RedactionResult {
  redactedText: string;
  findings: SecretFinding[];
}

interface Candidate {
  type: SecretFindingType;
  start: number;
  end: number;
  priority: number;
}

const API_KEY_PATTERN = /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{35}|(?:sk|rk)_live_[A-Za-z0-9]{16,})\b/g;
const CLOUD_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{16}\b/g;
const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g;
const SERVICE_TOKEN_PATTERN = /\b(?:npm_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}\b/g;
const BEARER_PATTERN = /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/gi;
const BASIC_AUTH_PATTERN = /\bBasic\s+([A-Za-z0-9+/=]{12,})/gi;
const PASSWORD_ASSIGNMENT_PATTERN =
  /(?:^|[^\p{L}\p{N}_])(?:"?(?:(?:[a-z][a-z0-9]*[_-])*(?:password|passwd|pwd|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|app[_-]?secret|secret|token)|密码|密钥|令牌)"?)\s*[:=]\s*["']?([^\s,;"']{4,})["']?/gimu;
const DATABASE_URL_PATTERN =
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|mssql):\/\/[^:\s/@]+:([^@\s/]+)@/gi;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]{1,100000}?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g;

function collectWholeMatches(
  input: string,
  pattern: RegExp,
  type: SecretFindingType,
  priority: number,
): Candidate[] {
  return Array.from(input.matchAll(pattern), (match) => ({
    type,
    start: match.index,
    end: match.index + match[0].length,
    priority,
  }));
}

function collectCapturedMatches(
  input: string,
  pattern: RegExp,
  type: SecretFindingType,
  priority: number,
): Candidate[] {
  const candidates: Candidate[] = [];

  for (const match of input.matchAll(pattern)) {
    const captured = match[1];
    if (!captured) continue;

    const offsetInMatch = match[0].lastIndexOf(captured);
    if (offsetInMatch < 0) continue;

    const start = match.index + offsetInMatch;
    candidates.push({
      type,
      start,
      end: start + captured.length,
      priority,
    });
  }

  return candidates;
}

function maskedPreview(type: SecretFindingType): string {
  return `[REDACTED:${type}]`;
}

export function redactSecrets(input: string): RedactionResult {
  const candidates = [
    ...collectWholeMatches(input, PRIVATE_KEY_PATTERN, 'private_key', 0),
    ...collectCapturedMatches(input, DATABASE_URL_PATTERN, 'database_password', 0),
    ...collectWholeMatches(input, API_KEY_PATTERN, 'api_key', 1),
    ...collectWholeMatches(input, CLOUD_ACCESS_KEY_PATTERN, 'cloud_access_key', 1),
    ...collectWholeMatches(input, GITHUB_TOKEN_PATTERN, 'github_token', 1),
    ...collectWholeMatches(input, SERVICE_TOKEN_PATTERN, 'service_token', 1),
    ...collectWholeMatches(input, JWT_PATTERN, 'jwt', 1),
    ...collectCapturedMatches(input, BEARER_PATTERN, 'bearer_token', 2),
    ...collectCapturedMatches(input, BASIC_AUTH_PATTERN, 'basic_auth', 2),
    ...collectCapturedMatches(input, PASSWORD_ASSIGNMENT_PATTERN, 'password', 3),
  ].sort((left, right) => left.start - right.start || left.priority - right.priority);

  const findings: SecretFinding[] = [];
  const output: string[] = [];
  let cursor = 0;

  for (const candidate of candidates) {
    if (candidate.start < cursor || candidate.end <= candidate.start) continue;

    const preview = maskedPreview(candidate.type);
    output.push(input.slice(cursor, candidate.start), preview);
    findings.push({
      type: candidate.type,
      start: candidate.start,
      end: candidate.end,
      maskedPreview: preview,
    });
    cursor = candidate.end;
  }

  if (findings.length === 0) {
    return { redactedText: input, findings: [] };
  }

  output.push(input.slice(cursor));
  return { redactedText: output.join(''), findings };
}
