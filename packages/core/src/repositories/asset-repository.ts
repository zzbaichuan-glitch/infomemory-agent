import type {
  AccessContext,
  AssetVisibility,
  InformationAsset,
  SourceReference,
} from '../domain.js';

export type DeduplicatedBy = 'idempotency' | 'content_hash';

export class IdempotencyConflictError extends Error {
  readonly code = 'idempotency_conflict';

  constructor() {
    super('The idempotency key was already used for a different request');
    this.name = 'IdempotencyConflictError';
  }
}

export class InvalidAssetCursorError extends Error {
  readonly code = 'invalid_asset_cursor';

  constructor() {
    super('The asset cursor is invalid');
    this.name = 'InvalidAssetCursorError';
  }
}

export interface PersistAssetInput {
  id: string;
  context: AccessContext;
  visibility: AssetVisibility;
  title: string;
  redactedContent: string;
  contentHash: string;
  source: SourceReference;
  secretFindingCount: number;
  operation: 'asset.ingest';
  idempotencyKey: string;
  requestFingerprint: string;
  createdAt: string;
}

export interface AssetIngestResult {
  asset: InformationAsset;
  created: boolean;
  deduplicatedBy?: DeduplicatedBy;
}

export interface AssetListOptions {
  limit?: number;
  offset?: number;
  cursor?: string;
  visibility?: AssetVisibility;
  sourceType?: SourceReference['type'];
  createdAfter?: string;
  createdBefore?: string;
}

export interface AssetListPage {
  assets: InformationAsset[];
  nextCursor?: string;
}

export interface AssetSearchOptions {
  limit?: number;
}

export interface AssetSearchHit {
  asset: InformationAsset;
  score: number;
}

export interface AssetRepository {
  ingest(input: PersistAssetInput): Promise<AssetIngestResult>;
  findById(context: AccessContext, id: string): Promise<InformationAsset | null>;
  list(context: AccessContext, options?: AssetListOptions): Promise<InformationAsset[]>;
  listPage(context: AccessContext, options?: AssetListOptions): Promise<AssetListPage>;
  search(
    context: AccessContext,
    query: string,
    options?: AssetSearchOptions,
  ): Promise<AssetSearchHit[]>;
  deleteOwned(context: AccessContext, id: string): Promise<boolean>;
}
