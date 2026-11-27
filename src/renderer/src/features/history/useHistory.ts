import { useCallback, useEffect, useState } from 'react';
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
const MAX_REQUEST = 1_000;
/** Shown while the regex is invalid. One shared array, so its identity is stable across renders. */
const NO_CLIPS: readonly ClipSummary[] = [];

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

/** Where a row sits in the list order (newest copy first, the higher id first on a tie). */
export function cursorOf(clip: ClipSummary): HistoryCursor {
  return { lastCopiedAt: clip.lastCopiedAt, id: clip.id };
}

/** Whether `clip` comes after `cursor` in the list order (is older). */
function isAfter(clip: ClipSummary, cursor: HistoryCursor): boolean {
  return (
    clip.lastCopiedAt < cursor.lastCopiedAt ||
    (clip.lastCopiedAt === cursor.lastCopiedAt && clip.id < cursor.id)
  );
}

/**
 * Loads at least `count` rows (or every row there is) for `query`, page by page, and with
 * `through` also every row down to that position in the list.
 *
 * The main process may return fewer rows than asked (a page has a size budget), so one large
 * request is not enough to restore what the user had scrolled through; this follows the cursor
 * until the count is reached. A refresh passes the position of the last row it showed as
 * `through`: new copies arriving at the top then lengthen the list instead of pushing loaded rows
 * (and the selection on them) out at the bottom. `isStale` stops early when a newer request has
 * started.
 */
export async function fetchRows(
  query: (q: HistoryQuery) => Promise<HistoryPage>,
  base: HistoryQuery,
  count: number,
  isStale: () => boolean,
  through: HistoryCursor | null = null,
): Promise<HistoryPage> {
  let rows: ClipSummary[] = [];
  let cursor: HistoryCursor | null = null;
  const reachedEnd = (): boolean => {
    const last = rows.at(-1);
    return through === null || (last !== undefined && isAfter(last, through));
  };
  do {
    const missing = count - rows.length;
    // Past the count, only `through` is still to be reached: fetch ordinary pages for it.
    const limit = Math.min(missing > 0 ? missing : PAGE_SIZE, MAX_REQUEST);
    const page: HistoryPage = await query({
      ...base,
      limit,
      ...(cursor ? { before: cursor } : {}),
    });
    rows.push(...page.clips);
    cursor = page.nextCursor;
    // An empty page with a cursor would loop forever; treat it as the end.
    if (page.clips.length === 0) cursor = null;
  } while (cursor !== null && (rows.length < count || !reachedEnd()) && !isStale());

  // Keep the count, and every row up to `through`, but not the rest of the last page.
  if (through !== null && rows.length > count) {
    const upTo = rows.findIndex((row) => isAfter(row, through));
    const keep = Math.max(count, upTo === -1 ? rows.length : upTo);
    const last = rows[keep - 1];
    if (keep < rows.length && last) {
      rows = rows.slice(0, keep);
      cursor = cursorOf(last);
    }
  }
  return { clips: rows, nextCursor: cursor };
}

export interface HistoryState {
  readonly clips: readonly ClipSummary[];
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly loadMore: () => void;
}

/** What the hook shows; the loader replaces parts of it in one update per response. */
interface Shown {
  readonly clips: readonly ClipSummary[];
  readonly cursor: HistoryCursor | null;
  readonly error: string | null;
  /** The query the shown list answers; while it differs from the current one, a load is pending. */
  readonly loadedKey: string | null;
  readonly loadingMore: boolean;
}

const NOTHING_SHOWN: Shown = {
  clips: NO_CLIPS,
  cursor: null,
  error: null,
  loadedKey: null,
  loadingMore: false,
};

/**
 * How many refresh answers in a row are thrown away because the history changed while they were
 * fetched, before one is shown anyway (see `HistoryLoader`).
 */
export const MAX_DISCARDED_REFRESHES = 2;
/** First wait before a failed refresh is tried again; it doubles up to `MAX_RETRY_DELAY_MS`. */
export const RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8_000;

type Job = 'first' | 'refresh' | 'more';

/**
 * Runs the list's requests one at a time: the first page of a query, refreshes after history
 * changes, and "load more" pages. All bookkeeping is plain fields read synchronously, never React
 * state that could be one render behind, so no request can overtake or discard another.
 *
 * - A change that arrives while a request runs only marks a refresh as needed; it runs when that
 *   request is done. A "load more" asked for meanwhile runs first, so changes never starve paging.
 * - Only settled lists are shown: when the history changed while a refresh was fetching, a row
 *   could be missing only because it moved (a re-copy jumps above the refresh's cursor), so that
 *   answer is thrown away and the refresh runs again. Under constant changes the answer is shown
 *   anyway after `MAX_DISCARDED_REFRESHES` in a row, so the list cannot go stale forever; a
 *   selected row that moved during that fetch may then drop from the selection, which is accepted.
 * - A failed refresh keeps its error and stays needed: it is tried again at the next change, or
 *   after a growing pause (`RETRY_DELAY_MS`), never in a tight loop. A "load more" page that
 *   succeeds meanwhile only appends its rows; it clears neither the error nor the pending refresh.
 * - A new query (`setQuery`, also to "nothing" for an invalid regex) abandons the old one at once:
 *   no further page of it is fetched and its answers are dropped.
 */
export class HistoryLoader {
  private generation = 0;
  private filters: HistoryFilters | null = null;
  private key = '';
  private busy = false;
  /** The history changed since the last refresh began fetching: a refresh is needed. */
  private dirty = false;
  private wantMore = false;
  private discarded = 0;
  private refreshError: string | null = null;
  private retryDelay = RETRY_DELAY_MS;
  private retryAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private rows: readonly ClipSummary[] = NO_CLIPS;
  private cursor: HistoryCursor | null = null;
  private readonly show: (patch: Partial<Shown>) => void;
  private readonly now: () => number;

  constructor(show: (patch: Partial<Shown>) => void, now: () => number = Date.now) {
    this.show = show;
    this.now = now;
  }

  /** Starts over for these filters, or stops (`null`: an invalid regex, or unmounting). */
  setQuery(filters: HistoryFilters | null, key: string): void {
    this.generation++;
    this.filters = filters;
    this.key = key;
    this.busy = false;
    this.dirty = false;
    this.wantMore = false;
    this.discarded = 0;
    this.refreshError = null;
    this.retryDelay = RETRY_DELAY_MS;
    this.retryAt = 0;
    this.cancelRetry();
    this.rows = NO_CLIPS;
    this.cursor = null;
    if (filters !== null) this.run('first');
  }

  /** The history changed: refresh once the running request, if any, is done. */
  changed(): void {
    this.dirty = true;
    this.retryAt = 0; // a new change is worth trying at once, even after a failure
    this.next();
  }

  /** The user reached the end of the list: fetch the next page once the running request is done. */
  more(): void {
    this.wantMore = true;
    this.next();
  }

  private next(): void {
    if (this.busy || this.filters === null) return;
    if (this.wantMore && this.cursor !== null) {
      this.run('more');
      return;
    }
    this.wantMore = false;
    if (!this.dirty) return;
    const wait = this.retryAt - this.now();
    if (wait <= 0) this.run('refresh');
    else if (this.retryTimer === null) {
      const generation = this.generation;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (generation === this.generation) this.next();
      }, wait);
    }
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private run(job: Job): void {
    const { filters, key, cursor } = this;
    if (filters === null) return;
    const generation = this.generation;
    const isStale = (): boolean => generation !== this.generation;
    const query = (request: HistoryQuery): Promise<HistoryPage> => api.history.query(request);
    const base = toQuery(filters);
    this.busy = true;
    let request: Promise<HistoryPage>;
    if (job === 'more' && cursor !== null) {
      this.wantMore = false;
      this.show({ loadingMore: true });
      request = query({ ...base, before: cursor });
    } else if (job === 'refresh') {
      // The fetch starts now: a change from here on makes its answer unsettled.
      this.dirty = false;
      this.cancelRetry();
      const last = this.rows.at(-1);
      // Every row already shown, down to the last one, so rows (and selections on them) survive
      // new copies above. No cap: a cap would drop rows the user scrolled to.
      request = fetchRows(
        query,
        base,
        Math.max(this.rows.length, PAGE_SIZE),
        isStale,
        last ? cursorOf(last) : null,
      );
    } else {
      this.dirty = false;
      request = query(base);
    }
    request
      .then(
        (page) => {
          if (isStale()) return;
          if (job === 'more') {
            this.appendPage(page);
            return;
          }
          if (job === 'refresh' && this.dirty && this.discarded < MAX_DISCARDED_REFRESHES) {
            this.discarded++; // unsettled: `dirty` is still set, so the refresh runs again
            return;
          }
          this.discarded = 0;
          this.refreshError = null;
          this.retryDelay = RETRY_DELAY_MS;
          this.rows = page.clips;
          this.cursor = page.nextCursor;
          this.show({
            clips: page.clips,
            cursor: page.nextCursor,
            error: null,
            loadedKey: key,
            loadingMore: false,
          });
        },
        (cause: unknown) => {
          if (isStale()) return;
          const message = ipcErrorMessage(cause);
          if (job === 'refresh') {
            // Still needed: tried again at the next change, or after a growing pause.
            this.refreshError = message;
            this.dirty = true;
            this.retryAt = this.now() + this.retryDelay;
            this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_DELAY_MS);
          }
          this.show({ error: message, loadedKey: key, loadingMore: false });
        },
      )
      .finally(() => {
        if (isStale()) return;
        this.busy = false;
        this.next();
      });
  }

  /** A "load more" page: only adds rows; a failed or pending refresh stays as it was. */
  private appendPage(page: HistoryPage): void {
    this.rows = appendNew(this.rows, page.clips);
    this.cursor = page.nextCursor;
    this.show({
      clips: this.rows,
      cursor: page.nextCursor,
      error: this.refreshError,
      loadingMore: false,
    });
  }
}

/** `rows` plus the rows of `page` not in it yet (a re-copy can move a row across pages). */
function appendNew(
  rows: readonly ClipSummary[],
  page: readonly ClipSummary[],
): readonly ClipSummary[] {
  const known = new Set(rows.map((row) => row.id));
  return [...rows, ...page.filter((row) => !known.has(row.id))];
}

/**
 * Loads the history for the given filters, pages through it on demand and refreshes when the main
 * process reports a change (see `HistoryLoader`). Responses for an old query are dropped, so fast
 * typing can never show results for it.
 */
export function useHistory(requested: HistoryFilters): HistoryState {
  // The filters by value: an equal object built anew (the view rebuilds it when the list of source
  // apps changes) is the same query, and must not reload the list (and drop rows) as if it were a
  // new one. Adjusted while rendering when the query really changed (React's documented pattern).
  const requestedKey = JSON.stringify(toQuery(requested));
  const [kept, setKept] = useState({ filters: requested, key: requestedKey });
  if (kept.key !== requestedKey) setKept({ filters: requested, key: requestedKey });
  const filters = kept.key === requestedKey ? kept.filters : requested;

  const [shown, setShown] = useState<Shown>(NOTHING_SHOWN);
  const [loader] = useState(
    () => new HistoryLoader((patch) => setShown((current) => ({ ...current, ...patch }))),
  );
  const invalid = regexError(filters);

  useEffect(() => {
    // An invalid regex stops the loader: nothing more of the old query, and nothing invalid, is sent.
    loader.setQuery(invalid === null ? filters : null, requestedKey);
    return () => loader.setQuery(null, '');
  }, [loader, filters, invalid, requestedKey]);

  useEffect(() => api.history.onChanged(() => loader.changed()), [loader]);

  const { cursor } = shown;
  // A new callback with every page, so a view that watches the end of the list asks again.
  const loadMore = useCallback(() => {
    if (cursor !== null) loader.more();
  }, [loader, cursor]);

  return {
    clips: invalid === null ? shown.clips : NO_CLIPS,
    hasMore: cursor !== null,
    loading: invalid === null && (shown.loadedKey !== requestedKey || shown.loadingMore),
    error: invalid ?? shown.error,
    loadMore,
  };
}
