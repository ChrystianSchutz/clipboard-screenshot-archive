import { useEffect, useState } from 'react';
import type { MatchRange } from '@shared/types';
import { api } from '../../api';
import type { HighlightQuery } from './highlight';

/**
 * The full text of a clip, fetched on demand for the preview pane: history rows only carry a
 * short preview. `null` until it arrives (or when the clip was deleted meanwhile). A clip's text
 * never changes (identical text is the same clip), so it is fetched once per selection.
 */
export function useClipContent(id: number): string | null {
  const [loaded, setLoaded] = useState<{ readonly id: number; readonly content: string } | null>(
    null,
  );

  useEffect(() => {
    let current = true;
    api.history.get(id).then(
      (clip) => {
        if (current && clip) setLoaded({ id, content: clip.content });
      },
      () => undefined, // deleted or unreachable: the pane keeps showing the preview
    );
    return () => {
      current = false;
    };
  }, [id]);

  return loaded?.id === id ? loaded.content : null;
}

/**
 * Regex matches in `text`, computed by main's search worker under its time budget: the renderer
 * never runs a user regex, so a catastrophic pattern cannot freeze the window. `null` in plain
 * mode, while waiting, or when the pattern is invalid or too slow (then nothing is highlighted).
 */
export function useRegexRanges(text: string, query: HighlightQuery): readonly MatchRange[] | null {
  const pattern = query.regex ? query.text.trim() : '';
  const [result, setResult] = useState<{
    readonly text: string;
    readonly pattern: string;
    readonly ranges: readonly MatchRange[];
  } | null>(null);

  useEffect(() => {
    if (pattern === '' || text === '') return;
    let current = true;
    api.history.regexRanges(pattern, text).then(
      (answer) => {
        if (current && answer.ok) setResult({ text, pattern, ranges: answer.ranges });
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [text, pattern]);

  return result?.text === text && result.pattern === pattern ? result.ranges : null;
}
