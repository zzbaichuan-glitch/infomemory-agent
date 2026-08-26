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
import { sanitizeSourceReference } from '../security/metadata-sanitizer.js';

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
    // Keep the request digest private and content-sensitive. Hashing only the
    // redacted payload would make two different secret values look identical
    // under one idempotency key. The raw values are never persisted.
    const requestFingerprint = `v2:${createHash('sha256')
      .update(JSON.stringify({
        title: command.title.normalize('NFKC'),
        content: command.content,
        visibility: command.visibility,
        source: command.source
          ? {
            type: command.source.type,
            externalId: command.source.externalId,
            url: command.source.url,
          }
          : undefined,
      }), 'utf8')
      .digest('hex')}`;

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
      ? source.externalId
      : undefined;
    // Keep source normalization in one place so legacy migration and new writes
    // cannot diverge on URL credentials or sensitive identifiers.
    return sanitizeSourceReference({
      type: source.type,
      ...(externalId ? { externalId } : {}),
      ...(source.url ? { url: source.url } : {}),
    });
  }
}
