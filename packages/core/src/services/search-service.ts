import { z } from 'zod';

import type { AccessContext, SourceReference } from '../domain.js';
import type { AssetRepository } from '../repositories/asset-repository.js';
import { redactSecrets } from '../security/secret-redactor.js';
import { normalizeSearchText, searchTerms } from '../search/search-text.js';

const searchSchema = z.object({
  query: z.string().trim().min(1).max(1_000),
  limit: z.number().int().min(1).max(20).default(8),
});

export type SearchCommand = z.input<typeof searchSchema>;

export interface SearchEvidence {
  citationId: string;
  assetId: string;
  title: string;
  snippet: string;
  score: number;
  sources: SourceReference[];
  createdAt: string;
}

export interface SearchResult {
  mode: 'keyword';
  query: string;
  evidence: SearchEvidence[];
}

export class SearchService {
  constructor(private readonly repository: AssetRepository) {}

  async search(context: AccessContext, input: SearchCommand): Promise<SearchResult> {
    const command = searchSchema.parse(input);
    const safeQuery = redactSecrets(command.query).redactedText;
    const normalizedQuery = normalizeSearchText(safeQuery);
    const terms = searchTerms(normalizedQuery);
    const ranked = await this.repository.search(context, normalizedQuery, {
      limit: command.limit,
    });

    return {
      mode: 'keyword',
      query: safeQuery,
      evidence: ranked.map(({ asset, score }) => ({
        citationId: `asset:${asset.id}`,
        assetId: asset.id,
        title: asset.title,
        snippet: createSnippet(asset.redactedContent, normalizedQuery, terms),
        score,
        sources: asset.sources,
        createdAt: asset.createdAt,
      })),
    };
  }
}

function createSnippet(content: string, query: string, terms: string[]): string {
  const normalizedContent = normalizeSearchText(content);
  let matchIndex = normalizedContent.indexOf(query);
  if (matchIndex < 0) {
    matchIndex = terms
      .map((term) => normalizedContent.indexOf(term))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0] ?? 0;
  }

  const radius = 70;
  const start = Math.max(0, matchIndex - radius);
  const end = Math.min(content.length, matchIndex + query.length + radius);
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
}
