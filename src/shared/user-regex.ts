/**
 * Compiles a regular expression typed by the user in the search box.
 *
 * We cap the length and refuse the classic exponential shape (a quantified group whose body ends
 * with a quantifier, e.g. `(a+)+` or `(\w*)*`). A cheap early error, not a proof of safety: other
 * patterns can still backtrack for seconds, which is why user regexes only ever run in the
 * search worker, under a time budget (src/main/search/regex-search.ts).
 */

export const MAX_PATTERN_LENGTH = 200;

export type RegexResult =
  { readonly ok: true; readonly regex: RegExp } | { readonly ok: false; readonly error: string };

const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}]\)\s*[+*{]/;

export function compileUserRegex(pattern: string): RegexResult {
  if (pattern.length === 0) return { ok: false, error: 'Empty pattern' };
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { ok: false, error: `Pattern is longer than ${MAX_PATTERN_LENGTH} characters` };
  }
  if (NESTED_QUANTIFIER.test(pattern)) {
    return { ok: false, error: 'Nested quantifiers like (a+)+ are not allowed' };
  }
  try {
    return { ok: true, regex: new RegExp(pattern, 'i') };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message.replace(/^Invalid regular expression: /, '') };
  }
}

/** Highlighting stops here: a regex matching every character of a long text has nothing to show. */
export const MAX_MATCHES = 500;

/** Where `regex` matches `text` (non-empty matches only, at most `MAX_MATCHES`). */
export function findMatches(text: string, regex: RegExp): [start: number, end: number][] {
  const global = new RegExp(
    regex.source,
    regex.flags.includes('g') ? regex.flags : `${regex.flags}g`,
  );
  const ranges: [number, number][] = [];
  for (const match of text.matchAll(global)) {
    if (match[0] === '') continue; // zero-width matches have nothing to highlight
    ranges.push([match.index, match.index + match[0].length]);
    if (ranges.length >= MAX_MATCHES) break;
  }
  return ranges;
}
