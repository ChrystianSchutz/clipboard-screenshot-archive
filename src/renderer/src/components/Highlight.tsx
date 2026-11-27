import { useMemo } from 'react';
import type { MatchRange } from '@shared/types';
import {
  matchRanges,
  mergeRanges,
  splitByRanges,
  type HighlightQuery,
} from '../features/history/highlight';

interface HighlightProps {
  readonly text: string;
  readonly query: HighlightQuery;
  /** Regex mode: matches computed in main (the renderer never runs a user regex). */
  readonly ranges?: readonly MatchRange[] | null | undefined;
}

/** Renders `text` with every search match wrapped in <mark>. */
export function Highlight({ text, query, ranges }: HighlightProps) {
  const pieces = useMemo(() => {
    const found = query.regex ? mergeRanges(ranges ?? []) : matchRanges(text, query);
    return splitByRanges(text, found);
  }, [text, query, ranges]);
  return (
    <>
      {pieces.map((piece, index) =>
        piece.match ? <mark key={index}>{piece.text}</mark> : piece.text,
      )}
    </>
  );
}
