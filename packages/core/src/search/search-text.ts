const SEGMENT_PATTERN = /[a-z0-9_]+|[\p{Script=Han}]+/gu;

export function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN');
}

export function searchTerms(value: string): string[] {
  const normalized = normalizeSearchText(value);
  const terms = new Set<string>();
  for (const segment of normalized.match(SEGMENT_PATTERN) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(segment)) {
      // Keep a single Han character as a short-query fallback. Normal Chinese
      // text uses bigrams to avoid turning every multi-character query into a
      // broad OR expression.
      if (segment.length === 1) {
        terms.add(segment);
        continue;
      }
      for (let index = 0; index < segment.length - 1; index += 1) {
        terms.add(segment.slice(index, index + 2));
      }
      continue;
    }
    terms.add(segment);
  }
  return Array.from(terms);
}

export function isSingleHanTerm(value: string): boolean {
  return value.length === 1 && /^\p{Script=Han}$/u.test(value);
}

export function createFtsIndexText(value: string): string {
  return searchTerms(value).join(' ');
}

export function createFtsMatchExpression(value: string): string | null {
  const terms = searchTerms(value);
  return terms.length > 0
    ? terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ')
    : null;
}
