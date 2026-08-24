import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { AccessContext, SourceReference } from '../domain.js';
import type {
  AssetIngestResult,
  AssetListOptions,
  AssetListPage,
  AssetRepository,
} from '../repositories/asset-repository.js';
import { redactSecrets } from '../security/secret-redactor.js';

const sourceSchema = z.object({
  type: z.enum(['manual', 'local_file', 'feishu_message', 'feishu_document']),
  externalId: z.string().trim().min(1).max(500).optional(),
  url: z.url().max(2_000).refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'https:' || protocol === 'http:';
  }, 'Source URL must use HTTP or HTTPS').optional(),
});

const ingestAssetSchema = z.object({
  title: z.string().trim().min(1).max(300),
  content: z.string().trim().min(1).max(1_000_000),
  idempotencyKey: z.string().trim().min(1).max(500),
  visibility: z.enum(['tenant', 'owner']).default('owner'),
  source: sourceSchema.optional(),
});

const accessContextSchema = z.object({
  tenantId: z.string().trim().min(1).max(200),
  userId: z.string().trim().min(1).max(200),
});

export type IngestAssetCommand = z.input<typeof ingestAssetSchema>;

const listAssetsSchema = z.object({
  limit: z.number().int().min(1).max(200).default(100),
  offset: z.number().int().min(0).max(100_000).optional(),
  cursor: z.string().trim().min(1).max(2_000).optional(),
  visibility: z.enum(['tenant', 'owner']).optional(),
  sourceType: z.enum(['manual', 'local_file', 'feishu_message', 'feishu_document']).optional(),
  createdAfter: z.iso.datetime().optional(),
  createdBefore: z.iso.datetime().optional(),
}).refine((value) => value.cursor === undefined || value.offset === undefined, {
  message: 'cursor and offset cannot be used together',
});

export type ListAssetsCommand = z.input<typeof listAssetsSchema>;

export interface AssetServiceOptions {
  idFactory?: () => string;
  now?: () => Date;
}

export class AssetService {
  readonly #idFactory: () => string;
  readonly #now: () => Date;

  constructor(
    private readonly repository: AssetRepository,
    options: AssetServiceOptions = {},
  ) {
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  async ingest(
    contextInput: AccessContext,
    commandInput: IngestAssetCommand,
  ): Promise<AssetIngestResult> {
    const context = accessContextSchema.parse(contextInput);
    const command = ingestAssetSchema.parse(commandInput);
    const safeTitle = redactSecrets(command.title.normalize('NFKC'));
    const safeContent = redactSecrets(command.content);
    const safeSource = this.#normalizeSource(command.source);
    const contentHash = createHash('sha256')
      .update(safeContent.redactedText, 'utf8')
      .digest('hex');
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({
        title: safeTitle.redactedText,
        content: safeContent.redactedText,
        visibility: command.visibility,
        source: safeSource.source,
      }), 'utf8')
      .digest('hex');

    return this.repository.ingest({
      id: this.#idFactory(),
      context,
      visibility: command.visibility,
      title: safeTitle.redactedText,
      redactedContent: safeContent.redactedText,
      contentHash,
      source: safeSource.source,
      secretFindingCount:
        safeTitle.findings.length + safeContent.findings.length + safeSource.findingCount,
      operation: 'asset.ingest',
      idempotencyKey: command.idempotencyKey,
      requestFingerprint,
      createdAt: this.#now().toISOString(),
    });
  }

  async getById(contextInput: AccessContext, idInput: string) {
    const context = accessContextSchema.parse(contextInput);
    const id = z.string().trim().min(1).max(200).parse(idInput);
    return this.repository.findById(context, id);
  }

  async listPage(
    contextInput: AccessContext,
    input: ListAssetsCommand = {},
  ): Promise<AssetListPage> {
    const context = accessContextSchema.parse(contextInput);
    const options = listAssetsSchema.parse(input);
    const repositoryOptions: AssetListOptions = {
      limit: options.limit,
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...(options.visibility !== undefined ? { visibility: options.visibility } : {}),
      ...(options.sourceType !== undefined ? { sourceType: options.sourceType } : {}),
      ...(options.createdAfter !== undefined ? { createdAfter: options.createdAfter } : {}),
      ...(options.createdBefore !== undefined ? { createdBefore: options.createdBefore } : {}),
    };
    return this.repository.listPage(context, repositoryOptions);
  }

  async deleteOwned(contextInput: AccessContext, idInput: string): Promise<boolean> {
    const context = accessContextSchema.parse(contextInput);
    const id = z.string().trim().min(1).max(200).parse(idInput);
    return this.repository.deleteOwned(context, id);
  }

  #normalizeSource(source: z.output<typeof sourceSchema> | undefined): {
    source: SourceReference;
    findingCount: number;
  } {
    if (!source) return { source: { type: 'manual' }, findingCount: 0 };
    const externalId = source.externalId
      ? redactSecrets(source.externalId.normalize('NFKC'))
      : undefined;
    const url = source.url ? sanitizeSourceUrl(source.url) : undefined;
    return {
      source: {
        type: source.type,
        ...(externalId ? { externalId: externalId.redactedText } : {}),
        ...(url ? { url: url.value } : {}),
      },
      findingCount: (externalId?.findings.length ?? 0) + (url?.findingCount ?? 0),
    };
  }
}

const SENSITIVE_URL_PARAMETER = /(?:^|[_-])(?:access[_-]?token|auth|authorization|code|credential|key|password|passwd|pwd|secret|sig|signature|token)(?:$|[_-])/i;

function sanitizeSourceUrl(input: string): { value: string; findingCount: number } {
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
    if (redaction.findings.length > 0 || /(?:access[_-]?token|code|credential|password|secret|token)=/i.test(url.hash)) {
      findingCount += Math.max(1, redaction.findings.length);
      url.hash = 'REDACTED';
    }
  }

  return { value: url.toString(), findingCount };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
