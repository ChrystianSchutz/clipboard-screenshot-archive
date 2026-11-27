import type { MatchRange } from '@shared/types';

export type Range = MatchRange;

export interface HighlightQuery {
  readonly text: string;
  readonly regex: boolean;
}

export interface Piece {
  readonly text: string;
  readonly match: boolean;
}

/** Stops pathological inputs (a one-letter word in a 20k-character preview) from bloating the DOM. */
const MAX_RANGES = 500;

/**
 * Where a plain search matches `text`: every word, case-insensitively. Overlapping ranges are
 * merged. Regex matches are never computed here: a user regex only runs in main's search worker,
 * under a time budget, and arrives as ranges (`ClipSummary.titleMatches`, `history:regex-ranges`).
 */
export function matchRanges(text: string, query: HighlightQuery): Range[] {
  const needle = query.text.trim();
  if (query.regex || needle === '' || text === '') return [];

  const ranges: [number, number][] = [];
  const haystack = text.toLocaleLowerCase();
  for (const word of needle.toLocaleLowerCase().split(/\s+/)) {
    let from = haystack.indexOf(word);
    while (from !== -1 && ranges.length < MAX_RANGES) {
      ranges.push([from, from + word.length]);
      from = haystack.indexOf(word, from + word.length);
    }
  }
  return mergeRanges(ranges);
}

export function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** Splits text into alternating plain/matched pieces for rendering with <mark>. */
export function splitByRanges(text: string, ranges: readonly Range[]): Piece[] {
  const pieces: Piece[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor || end > text.length) continue; // stale ranges for another text
    if (start > cursor) pieces.push({ text: text.slice(cursor, start), match: false });
    pieces.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), match: false });
  return pieces;
}
