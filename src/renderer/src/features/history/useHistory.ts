import { useCallback, useEffect, useRef, useState } from 'react';
import type { Category } from '@shared/categories';
import type {
  ClipKind,
  ClipSummary,
  HistoryCursor,
  HistoryPage,
  HistoryQuery,
  TimeRange,
} from '@shared/types';
import { compileUserRegex } from '@shared/user-regex';
import { api, ipcErrorMessage } from '../../api';

export interface HistoryFilters {
  readonly text: string;
  readonly regex: boolean;
  readonly app: string | null;
  readonly kind: ClipKind | null;
  readonly category: Category | null;
  readonly range: TimeRange;
  readonly pinnedOnly: boolean;
}

export const DEFAULT_FILTERS: HistoryFilters = {
  text: '',
  regex: false,
  app: null,
  kind: null,
  category: null,
  range: 'all',
  pinnedOnly: false,
};

export const PAGE_SIZE = 60;
/** Largest page the main process serves (`MAX_PAGE_SIZE` in clip-repository.ts). */
const MAX_REQUEST = 500;
/** Upper bound on the rows a refresh reloads, however far the user has scrolled. */
const MAX_RELOAD = 5_000;

/** Maps UI filter state to the IPC query, omitting everything that is not set. */
export function toQuery(filters: HistoryFilters, limit = PAGE_SIZE): HistoryQuery {
  const text = filters.text.trim();
  return {
    limit,
    ...(text !== '' ? { text, regex: filters.regex } : {}),
    ...(filters.app !== null ? { app: filters.app } : {}),
    ...(filters.kind !== null ? { kind: filters.kind } : {}),
    ...(filters.category !== null ? { category: filters.category } : {}),
    ...(filters.range !== 'all' ? { range: filters.range } : {}),
    ...(filters.pinnedOnly ? { pinnedOnly: true } : {}),
  };
}

/** A regex error to show inline, or `null` when the filters can be sent as they are. */
export function regexError(filters: HistoryFilters): string | null {
  if (!filters.regex || filters.text.trim() === '') return null;
  const result = compileUserRegex(filters.text.trim());
  return result.ok ? null : result.error;
}

/**
 * Loads at least `count` rows (or every row there is) for `query`, page by page.
 *
 * The main process may return fewer rows than asked (a page has a size budget), so one large
 * request is not enough to restore what the user had scrolled through; this follows the cursor
 * until the count is reached. `isStale` stops early when a newer request has started.
 */
export async function fetchRows(
  query: (q: HistoryQuery) => Promise<HistoryPage>,
  base: HistoryQuery,
  count: number,
  isStale: () => boolean,
): Promise<HistoryPage> {
  const rows: ClipSummary[] = [];
  let cursor: HistoryCursor | null = null;
  do {
    const limit = Math.min(Math.max(count - rows.length, 1), MAX_REQUEST);
    const page: HistoryPage = await query({
      ...base,
      limit,
      ...(cursor ? { before: cursor } : {}),
    });
    rows.push(...page.clips);
    cursor = page.nextCursor;
    // An empty page with a cursor would loop forever; treat it as the end.
    if (page.clips.length === 0) cursor = null;
  } while (cursor !== null && rows.length < count && !isStale());
  return { clips: rows, nextCursor: cursor };
}

export interface HistoryState {
  readonly clips: readonly ClipSummary[];
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly loadMore: () => void;
}

/**
 * Loads the history for the given filters, pages through it on demand and reloads when the
 * main process reports a change. Responses that arrive after a newer request are dropped,
 * so fast typing can never show results for an old query.
 */
export function useHistory(filters: HistoryFilters): HistoryState {
  const [clips, setClips] = useState<readonly ClipSummary[]>([]);
  const [cursor, setCursor] = useState<HistoryCursor | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The query the shown page answers; while it differs from the current one, a load is pending. */
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestId = useRef(0);
  const loadedCount = useRef(0);

  const invalid = regexError(filters);
  const queryKey = JSON.stringify(toQuery(filters));
  const loading = invalid === null && (loadedKey !== queryKey || loadingMore);

  /** Loads the first `count` rows (one page, or several on a refresh) and replaces the list. */
  const load = useCallback(
    (count: number) => {
      const id = ++requestId.current;
      const isStale = (): boolean => id !== requestId.current;
      const settle = (): void => {
        if (isStale()) return;
        setLoadedKey(JSON.stringify(toQuery(filters)));
        setLoadingMore(false);
      };
      // State changes only in the callbacks, never synchronously in the effects that call this.
      const request =
        count <= PAGE_SIZE
          ? api.history.query(toQuery(filters, count))
          : fetchRows((query) => api.history.query(query), toQuery(filters), count, isStale);
      request.then(
        (page) => {
          if (isStale()) return;
          // All pages land in one update, so the list never collapses to a single page meanwhile.
          setClips(page.clips);
          setCursor(page.nextCursor);
          setError(null);
          loadedCount.current = page.clips.length;
          settle();
        },
        (cause: unknown) => {
          if (isStale()) return;
          setError(ipcErrorMessage(cause));
          settle();
        },
      );
    },
    [filters],
  );

  useEffect(() => {
    if (invalid !== null) return;
    load(PAGE_SIZE);
  }, [load, invalid]);

  // Keep as many rows as the user has already scrolled through when the history changes
  // (a new copy, a deletion, or a screenshot whose text or analysis just became searchable).
  useEffect(
    () =>
      api.history.onChanged(() => {
        load(Math.min(Math.max(loadedCount.current, PAGE_SIZE), MAX_RELOAD));
      }),
    [load],
  );

  const loadMore = useCallback(() => {
    if (!cursor || loading) return;
    const id = ++requestId.current;
    setLoadingMore(true);
    api.history
      .query({ ...toQuery(filters), before: cursor })
      .then((page) => {
        if (id !== requestId.current) return;
        setClips((current) => {
          const next = [...current, ...page.clips];
          loadedCount.current = next.length;
          return next;
        });
        setCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (id === requestId.current) setError(ipcErrorMessage(cause));
      })
      .finally(() => {
        if (id === requestId.current) setLoadingMore(false);
      });
  }, [cursor, filters, loading]);

  return {
    clips: invalid === null ? clips : [],
    hasMore: cursor !== null,
    loading,
    error: invalid ?? error,
    loadMore,
  };
}
