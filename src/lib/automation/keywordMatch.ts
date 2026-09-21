/**
 * Keyword matching rules (identical to the proven original):
 *  - null / empty keywords  → any text triggers (wildcard)
 *  - ["*ANY*"]              → explicit wildcard
 *  - otherwise              → case-insensitive whole-word match
 */

export function keywordMatches(text: string, keywords: string[] | null): boolean {
  if (!keywords || keywords.length === 0 || keywords.includes('*ANY*')) {
    return true;
  }

  const normalizedText = text.toLowerCase();

  return keywords.some((keyword) => {
    const normalizedKeyword = keyword.toLowerCase().trim();
    if (!normalizedKeyword) return false;
    // JS `\b` is ASCII-only, so it never matches Hebrew/Arabic/etc. Use
    // Unicode-aware boundaries instead: not preceded/followed by a letter, digit or underscore.
    const wordBoundaryRegex = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegex(normalizedKeyword)}(?![\\p{L}\\p{N}_])`,
      'u'
    );
    return wordBoundaryRegex.test(normalizedText);
  });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
