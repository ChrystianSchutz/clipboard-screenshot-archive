import type { HistoryPage, HistoryQuery, MatchRange } from '@shared/types';
import { firstLine } from '@shared/text';
import { compileUserRegex, findMatches } from '@shared/user-regex';
import type { ClipRepository } from '../storage/clip-repository';

/** Work that runs a user regex, so it only ever runs in the search worker. */
export type RegexTask =
  | { readonly op: 'query'; readonly query: HistoryQuery }
  | { readonly op: 'ranges'; readonly pattern: string; readonly text: string };

export type RegexTaskResult = HistoryPage | readonly MatchRange[];

/** A history query that needs the regex engine (and so the worker). */
export function isRegexQuery(query: HistoryQuery): boolean {
  return query.regex === true && (query.text?.trim() ?? '') !== '';
}

/**
 * Runs one task against the worker's read-only repository. A regex history page also carries
 * where the pattern matches each row's title (what the list shows), so the renderer can
 * highlight without running the pattern itself.
 */
export function runRegexTask(repository: ClipRepository, task: RegexTask): RegexTaskResult {
  const compiled = compileUserRegex(
    task.op === 'query' ? (task.query.text?.trim() ?? '') : task.pattern,
  );
  if (!compiled.ok) throw new Error(compiled.error);

  if (task.op === 'ranges') return findMatches(task.text, compiled.regex);

  const page = repository.query(task.query);
  return {
    ...page,
    clips: page.clips.map((clip) => ({
      ...clip,
      titleMatches: findMatches(firstLine(clip.preview), compiled.regex),
    })),
  };
}
