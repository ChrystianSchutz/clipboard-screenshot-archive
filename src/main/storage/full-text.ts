/**
 * How plain-text search words map onto the FTS5 trigram index (`clips_fts`, schema v2).
 *
 * The trigram tokenizer matches any substring of 3+ characters, case-insensitively, which is
 * exactly the old `ci_contains` behaviour, only indexed. Shorter words cannot use the index, so
 * they fall back to a `ci_contains` scan. Every word must match either way.
 */

/** Trigram FTS cannot match terms shorter than this (in Unicode code points). */
export const MIN_INDEXED_TERM_LENGTH = 3;

export interface SearchTerms {
  /** Words long enough for the FTS index. */
  readonly indexed: readonly string[];
  /** Words that must be matched with a scan, lower-cased for `ci_contains`. */
  readonly short: readonly string[];
}

/** Splits plain search text into whitespace-separated words, grouped by how they can be matched. */
export function splitSearchTerms(text: string): SearchTerms {
  const indexed: string[] = [];
  const short: string[] = [];
  for (const word of text.toLocaleLowerCase().split(/\s+/)) {
    if (word === '') continue;
    // Count code points, not UTF-16 units: the trigram tokenizer works on characters.
    if (Array.from(word).length >= MIN_INDEXED_TERM_LENGTH) indexed.push(word);
    else short.push(word);
  }
  return { indexed: unique(indexed), short: unique(short) };
}

/**
 * Builds an FTS5 MATCH expression requiring every term, each as a quoted phrase so operators
 * and punctuation in user input (`AND`, `*`, `"`, `:`) are matched literally.
 * Each phrase may match any column (content, source or extra text).
 */
export function ftsMatchExpression(terms: readonly string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' ');
}

function unique(words: readonly string[]): string[] {
  return [...new Set(words)];
}
