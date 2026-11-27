/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClipboardArchiveApi } from '@shared/ipc-contract';
import type { ClipSummary, HistoryCursor, HistoryPage, HistoryQuery } from '@shared/types';
import { useListSelection } from '../../hooks/useListSelection';
import { selectAll } from '../../lib/selection';
import {
  cursorOf,
  DEFAULT_FILTERS,
  fetchRows,
  MAX_DISCARDED_REFRESHES,
  useHistory,
  type HistoryFilters,
} from './useHistory';
import { useSelectionActions } from './useSelectionActions';

/** Rows 1..total, newest first; only `id` and `lastCopiedAt` matter to paging. */
function rows(total: number): ClipSummary[] {
  return Array.from(
    { length: total },
    (_, index) => ({ id: total - index, lastCopiedAt: total - index }) as unknown as ClipSummary,
  );
}

/**
 * A history of `total` rows served like the main process does: at most `budget` rows per page,
 * however many were asked for (the page's preview-size budget), with a keyset cursor.
 */
function server(total: number, budget: number) {
  const all = rows(total);
  return vi.fn((query: HistoryQuery): Promise<HistoryPage> => {
    const start = query.before ? all.findIndex((row) => row.id < query.before!.id) : 0;
    const from = start === -1 ? all.length : start;
    const page = all.slice(from, from + Math.min(query.limit ?? 60, budget));
    const last = page.at(-1);
    const more = from + page.length < all.length;
    return Promise.resolve({
      clips: page,
      nextCursor: more && last ? { lastCopiedAt: last.lastCopiedAt, id: last.id } : null,
    });
  });
}

/**
 * A history that grows at the top as new copies arrive, served like `server` and ordered like the
 * repository (newest copy first, the higher id first on a tie). `recopy` moves a row to the top,
 * as copying its text again does. `onQuery` runs before each request is answered, `fail` makes
 * it reject; with `async` set, answers arrive in later tasks, so React renders each published list
 * on its own.
 */
function growingServer(total: number, budget: number, nextPage?: number) {
  let all = rows(total);
  let clock = total;
  let lastId = total;
  const hooks: {
    onQuery?: (request: HistoryQuery) => void;
    /** Rejects this request instead of answering it. */
    fail?: (request: HistoryQuery) => boolean;
    async?: boolean;
  } = {};
  const isAfter = (row: ClipSummary, cursor: HistoryCursor): boolean =>
    row.lastCopiedAt < cursor.lastCopiedAt ||
    (row.lastCopiedAt === cursor.lastCopiedAt && row.id < cursor.id);
  const query = vi.fn((request: HistoryQuery): Promise<HistoryPage> => {
    hooks.onQuery?.(request);
    if (hooks.fail?.(request)) return Promise.reject(new Error('The history is busy'));
    const before = request.before;
    const start = before ? all.findIndex((row) => isAfter(row, before)) : 0;
    const from = start === -1 ? all.length : start;
    // `nextPage`: the size of a "load more" page, so a test reaches a deep scroll in a few steps.
    const size = request.before && nextPage ? nextPage : (request.limit ?? 60);
    const page = all.slice(from, from + Math.min(size, budget));
    const last = page.at(-1);
    const more = from + page.length < all.length;
    const answer = { clips: page, nextCursor: more && last ? cursorOf(last) : null };
    if (!hooks.async) return Promise.resolve(answer);
    return new Promise((resolve) => setTimeout(() => resolve(answer), 0));
  });
  const copy = (count: number): void => {
    const added = Array.from({ length: count }, () => {
      const row = { id: ++lastId, lastCopiedAt: ++clock } as unknown as ClipSummary;
      return row;
    }).reverse();
    all = [...added, ...all];
  };
  const recopy = (id: number): void => {
    const row = all.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`no row ${String(id)}`);
    all = [{ ...row, lastCopiedAt: ++clock }, ...all.filter((candidate) => candidate !== row)];
  };
  return { query, copy, recopy, hooks };
}

describe('fetchRows', () => {
  it('follows the cursor until the requested count is reached', async () => {
    const query = server(200, 25);
    const page = await fetchRows(query, { limit: 60 }, 70, () => false);
    // 25 + 25, then only the 20 still missing.
    expect(page.clips).toHaveLength(70);
    expect(page.nextCursor).not.toBeNull();
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('stops at the end of the history', async () => {
    const page = await fetchRows(server(30, 25), { limit: 60 }, 500, () => false);
    expect(page.clips).toHaveLength(30);
    expect(page.nextCursor).toBeNull();
  });

  it('stops as soon as a newer request has started', async () => {
    const query = server(200, 25);
    await fetchRows(query, { limit: 60 }, 200, () => true);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('with a last row to reach, also loads the rows that arrived above it', async () => {
    const history = growingServer(100, 25);
    const before = await fetchRows(history.query, { limit: 60 }, 60, () => false);
    const lastShown = before.clips.at(-1)!;
    history.copy(3);

    const page = await fetchRows(
      history.query,
      { limit: 60 },
      60,
      () => false,
      cursorOf(lastShown),
    );
    expect(page.clips).toHaveLength(63);
    expect(page.clips.at(-1)).toBe(lastShown);
    // The cursor continues right after the last kept row, not after the last row fetched.
    expect(page.nextCursor).toEqual(cursorOf(lastShown));
  });

  it('keeps the count when rows above the last one were deleted', async () => {
    const history = growingServer(100, 500);
    const page = await fetchRows(history.query, { limit: 60 }, 60, () => false, {
      lastCopiedAt: 70,
      id: 70,
    });
    expect(page.clips).toHaveLength(60);
    expect(page.nextCursor).toEqual({ lastCopiedAt: 41, id: 41 });
  });

  it('treats an empty page with a cursor as the end instead of looping', async () => {
    const query = vi.fn(() =>
      Promise.resolve({ clips: [], nextCursor: { lastCopiedAt: 1, id: 1 } } as HistoryPage),
    );
    const page = await fetchRows(query, { limit: 60 }, 100, () => false);
    expect(page).toEqual({ clips: [], nextCursor: null });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('useHistory refresh', () => {
  let changed: (() => void) | null;
  let removeMany: ReturnType<typeof vi.fn<(ids: readonly number[]) => Promise<number>>>;

  beforeEach(() => {
    changed = null;
    removeMany = vi.fn((ids: readonly number[]) => Promise.resolve(ids.length));
  });

  afterEach(() => {
    delete (window as { clipboardArchive?: ClipboardArchiveApi }).clipboardArchive;
  });

  function install(query: (request: HistoryQuery) => Promise<HistoryPage>): void {
    (window as { clipboardArchive?: unknown }).clipboardArchive = {
      history: {
        query,
        removeMany,
        onChanged: (listener: () => void) => {
          changed = listener;
          return () => {
            changed = null;
          };
        },
      },
    };
  }

  it('keeps every page the user scrolled through when the history changes', async () => {
    install(server(300, 25));
    const filters: HistoryFilters = DEFAULT_FILTERS;
    const { result } = renderHook(() => useHistory(filters));
    await waitFor(() => expect(result.current.clips).toHaveLength(25));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.clips).toHaveLength(50));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.clips).toHaveLength(75));

    act(() => changed?.());
    await waitFor(() => expect(result.current.loading).toBe(false));
    // Before the fix the refresh asked for 75 rows once and got one 25-row page back.
    await waitFor(() => expect(result.current.clips).toHaveLength(75));
    expect(result.current.hasMore).toBe(true);
  });

  it('keeps the rows shown, and the selection on them, when a new copy arrives', async () => {
    const history = growingServer(200, 500);
    install(history.query);
    const { result } = renderHook(() => {
      const state = useHistory(DEFAULT_FILTERS);
      const ids = state.clips.map((clip) => clip.id);
      const list = useListSelection(ids);
      const selected = state.clips.filter((clip) => list.selection.selected.has(clip.id));
      const actions = useSelectionActions({
        noun: 'clip',
        selection: list.selection,
        clips: selected,
        ids,
        onNotify: vi.fn(),
        onRemoved: vi.fn(),
      });
      return { state, list, actions };
    });
    await waitFor(() => expect(result.current.state.clips).toHaveLength(60));
    act(() => result.current.list.update(selectAll));
    await act(() => result.current.actions.requestDelete());
    expect(result.current.actions.confirmingDelete).toBe(true);
    const selectedBefore = result.current.list.selectedIds;

    history.copy(1);
    act(() => changed?.());
    await waitFor(() => expect(result.current.state.clips).toHaveLength(61));

    // Before the fix the refresh reloaded 60 rows: the oldest selected row fell off the list.
    expect(result.current.list.selectedIds).toEqual(selectedBefore);
    expect(result.current.list.selectedIds).toHaveLength(60);
    expect(result.current.actions.confirmingDelete).toBe(true);
  });

  it('regression: equal filters built anew (a new source app) do not reload the list', async () => {
    const history = growingServer(200, 500);
    install(history.query);
    const { result, rerender } = renderHook(
      ({ filters }: { filters: HistoryFilters }) => useHistory(filters),
      { initialProps: { filters: DEFAULT_FILTERS } },
    );
    await waitFor(() => expect(result.current.clips).toHaveLength(60));

    // A copy from a new app: the history reports a change, and the view rebuilds its filters.
    history.copy(1);
    act(() => changed?.());
    rerender({ filters: { ...DEFAULT_FILTERS } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.clips).toHaveLength(61));
    // Before the fix the rebuilt object started a fresh 60-row load that replaced the refresh.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.clips).toHaveLength(61);
  });

  it('a real filter change still starts again from the first page', async () => {
    const history = growingServer(200, 500);
    install(history.query);
    const { result, rerender } = renderHook(
      ({ filters }: { filters: HistoryFilters }) => useHistory(filters),
      { initialProps: { filters: DEFAULT_FILTERS } },
    );
    await waitFor(() => expect(result.current.clips).toHaveLength(60));
    history.query.mockClear();

    rerender({ filters: { ...DEFAULT_FILTERS, pinnedOnly: true } });
    await waitFor(() => expect(history.query).toHaveBeenCalledOnce());
    expect(history.query.mock.calls[0]?.[0]).toMatchObject({ pinnedOnly: true, limit: 60 });
  });

  it('regression: a refresh deep in a large history keeps every loaded row', async () => {
    const history = growingServer(6_000, 2_000, 1_245);
    install(history.query);
    const { result } = renderHook(() => useHistory(DEFAULT_FILTERS));
    await waitFor(() => expect(result.current.clips).toHaveLength(60));
    // Scroll through 5,040 rows, past what a refresh used to reload (5,000).
    for (const loaded of [1_305, 2_550, 3_795, 5_040]) {
      act(() => result.current.loadMore());
      await waitFor(() => expect(result.current.clips).toHaveLength(loaded));
    }
    const lastShown = result.current.clips.at(-1);

    history.copy(1);
    act(() => changed?.());
    await waitFor(() => expect(result.current.clips).toHaveLength(5_041));
    expect(result.current.clips.at(-1)).toBe(lastShown);
    expect(result.current.hasMore).toBe(true);
  });

  /** Renders the hook and scrolls it through 5,040 rows of a 6,000-row history. */
  async function deepList(history: ReturnType<typeof growingServer>) {
    install(history.query);
    const hook = renderHook(({ filters }: { filters: HistoryFilters }) => useHistory(filters), {
      initialProps: { filters: DEFAULT_FILTERS },
    });
    await waitFor(() => expect(hook.result.current.clips).toHaveLength(60));
    for (const loaded of [1_305, 2_550, 3_795, 5_040]) {
      act(() => hook.result.current.loadMore());
      await waitFor(() => expect(hook.result.current.clips).toHaveLength(loaded));
    }
    history.query.mockClear();
    return hook;
  }

  /** Reloads from the top of the list (each refresh round starts with one). */
  const fullReloads = (query: ReturnType<typeof growingServer>['query']): number =>
    query.mock.calls.filter(([request]) => !request.before).length;

  it('regression: rapid changes deep in the list run one refresh and one rerun, not six', async () => {
    const history = growingServer(6_000, 2_000, 1_245);
    const { result } = await deepList(history);

    // Six copies, each reported while the refresh of the previous one is still paging.
    for (let copy = 0; copy < 6; copy++) {
      history.copy(1);
      act(() => changed?.());
      await Promise.resolve();
    }

    await waitFor(() => expect(result.current.clips[0]?.id).toBe(6_006));
    await waitFor(() => expect(result.current.clips).toHaveLength(5_046));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fullReloads(history.query)).toBe(2);
    // In pages of up to 1,000 rows: 6 requests per round of 5,046 rows.
    expect(history.query.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it('shows the newest row as soon as the first refresh of a burst lands', async () => {
    const history = growingServer(6_000, 2_000, 1_245);
    const { result } = await deepList(history);
    history.copy(6);
    let landed = 0;
    history.query.mockImplementation(
      ((query) => (request: HistoryQuery) => {
        if (!request.before) landed++;
        return query(request);
      })(history.query.getMockImplementation()!),
    );

    for (let event = 0; event < 6; event++) act(() => changed?.());
    await waitFor(() => expect(result.current.clips[0]?.id).toBe(6_006));
    expect(landed).toBeLessThanOrEqual(2);
    await waitFor(() => expect(result.current.loading).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(landed).toBe(2);
    expect(result.current.clips).toHaveLength(5_046);
  });

  /** History, selection and actions wired like the views wire them: rendered rows only. */
  function renderView(onRender: (state: ReturnType<typeof useHistory>) => void = () => undefined) {
    return renderHook(() => {
      const state = useHistory(DEFAULT_FILTERS);
      onRender(state);
      const ids = state.clips.map((clip) => clip.id);
      const list = useListSelection(ids);
      const byId = new Map(state.clips.map((clip) => [clip.id, clip]));
      const selected = list.selectedIds.flatMap((id) => byId.get(id) ?? []);
      const actions = useSelectionActions({
        noun: 'clip',
        selection: list.selection,
        clips: selected,
        ids,
        onNotify: vi.fn(),
        onRemoved: vi.fn(),
      });
      return { state, list, actions, selected };
    });
  }

  /** 90 rows of a 300-row history in pages of 30, rows 21-70 selected, the delete confirmation open. */
  async function fiftySelected(onRender?: (state: ReturnType<typeof useHistory>) => void) {
    const history = growingServer(300, 30);
    install(history.query);
    const view = renderView(onRender);
    const { result } = view;
    await waitFor(() => expect(result.current.state.clips).toHaveLength(30));
    for (const loaded of [60, 90]) {
      act(() => result.current.state.loadMore());
      await waitFor(() => expect(result.current.state.clips).toHaveLength(loaded));
    }
    const picked = result.current.state.clips.slice(20, 70).map((clip) => clip.id);
    act(() =>
      result.current.list.update(() => ({
        selected: new Set(picked),
        anchor: picked[0] ?? null,
        focus: picked[0] ?? null,
      })),
    );
    await act(() => result.current.actions.requestDelete());
    expect(result.current.actions.confirmingDelete).toBe(true);
    return { history, picked, ...view };
  }

  it('regression: re-copying a selected clip during a refresh keeps all 50 selected', async () => {
    let target = 0;
    let watching = false;
    let renderedWithout = false;
    const { history, picked, result } = await fiftySelected((state) => {
      const ids = state.clips.map((clip) => clip.id);
      if (watching && ids.length > 0 && !ids.includes(target)) renderedWithout = true;
    });

    // A new copy starts a refresh. After it has read its first page, a selected clip from the
    // second page is copied again: it moves above the refresh's cursor.
    target = picked[25]!;
    history.hooks.async = true;
    let requests = 0;
    history.hooks.onQuery = () => {
      if (++requests !== 2) return;
      history.recopy(target);
      changed?.();
    };
    history.copy(1);
    watching = true;
    act(() => changed?.());

    await waitFor(() => expect(result.current.state.clips[0]?.id).toBe(target));
    // The first refresh's answer lacked the clip: it was thrown away, never shown.
    expect(renderedWithout).toBe(false);
    expect(result.current.list.selectedIds).toHaveLength(50);
    expect(result.current.list.selectedIds).toContain(target);
    expect(result.current.selected).toHaveLength(50);
    expect(result.current.actions.confirmingDelete).toBe(true);
  });

  it('regression: "load more" right after a change does not discard the refresh', async () => {
    const history = growingServer(300, 500);
    install(history.query);
    const { result } = renderHook(() => useHistory(DEFAULT_FILTERS));
    await waitFor(() => expect(result.current.clips).toHaveLength(60));

    history.copy(1);
    // Both before React commits anything: the callback is the one from before the change.
    const { loadMore } = result.current;
    act(() => {
      changed?.();
      loadMore();
    });

    await waitFor(() => expect(result.current.clips).toHaveLength(121));
    expect(result.current.clips[0]?.id).toBe(301);
  });

  it('regression: a change in every refresh round does not starve "load more"', async () => {
    const history = growingServer(300, 500);
    install(history.query);
    const { result } = renderHook(() => useHistory(DEFAULT_FILTERS));
    await waitFor(() => expect(result.current.clips).toHaveLength(60));

    // Every refresh round sees one more change, six rounds in all. "Load more" asks for the rows
    // after the last one shown (refreshes keep that row last, so it does not move meanwhile).
    const lastShown = result.current.clips.at(-1)!.id;
    let rounds = 0;
    let roundsBeforeMore: number | null = null;
    history.hooks.onQuery = (request) => {
      if (request.before?.id === lastShown) {
        roundsBeforeMore ??= rounds;
      } else if (!request.before && rounds < 6) {
        rounds++;
        history.copy(1);
        changed?.();
      }
    };
    act(() => changed?.());
    act(() => result.current.loadMore());

    await waitFor(() => expect(rounds).toBe(6));
    await waitFor(() => expect(result.current.clips[0]?.id).toBe(306));
    // The page was fetched between rounds, not after the changes stopped.
    expect(roundsBeforeMore).not.toBeNull();
    expect(roundsBeforeMore).toBeLessThan(6);
    expect(result.current.clips).toHaveLength(126);
  });

  it('regression: an invalid regex stops the old refresh and sends nothing invalid', async () => {
    const history = growingServer(6_000, 2_000, 1_245);
    const { result, rerender } = await deepList(history);

    act(() => changed?.()); // the refresh asks for its first 1,000-row page
    expect(history.query).toHaveBeenCalledOnce();
    rerender({ filters: { ...DEFAULT_FILTERS, text: '[', regex: true } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Before the fix the old query went on paging after the filter changed.
    expect(history.query).toHaveBeenCalledOnce();
    expect(result.current.error).not.toBeNull();

    act(() => changed?.());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(history.query).toHaveBeenCalledOnce();
    expect(history.query.mock.calls.some(([request]) => request.regex)).toBe(false);
  });

  it('regression: a failed refresh survives a successful "load more" and is tried again', async () => {
    const { history, picked, result } = await fiftySelected();
    const target = picked[25]!;
    let failures = 0;
    history.hooks.fail = (request) => !request.before && failures++ === 0;
    history.recopy(target);
    act(() => changed?.());
    await waitFor(() => expect(result.current.state.error).not.toBeNull());

    // A page appended meanwhile fetched only older rows: the refresh is still owed.
    act(() => result.current.state.loadMore());
    await waitFor(() => expect(result.current.state.clips).toHaveLength(120));
    expect(result.current.state.error).not.toBeNull();
    expect(result.current.list.selectedIds).toContain(target);

    // The retry (after a short pause, no change needed) brings the re-copied clip to the top.
    await waitFor(() => expect(result.current.state.clips[0]?.id).toBe(target), {
      timeout: 3_000,
    });
    expect(result.current.state.error).toBeNull();
    expect(failures).toBe(2); // one failure, one retry
    expect(result.current.list.selectedIds).toHaveLength(50);
    expect(result.current.actions.confirmingDelete).toBe(true);
  });

  it('under constant changes, shows a refresh after a bounded number of thrown-away rounds', async () => {
    const history = growingServer(300, 500);
    install(history.query);
    const tops: number[] = [];
    const { result } = renderHook(() => {
      const state = useHistory(DEFAULT_FILTERS);
      const top = state.clips[0]?.id;
      if (top !== undefined && top !== tops.at(-1)) tops.push(top);
      return state;
    });
    await waitFor(() => expect(result.current.clips).toHaveLength(60));

    // Every refresh round sees a new copy (ten rounds of churn). Answers arrive in separate
    // tasks, so each shown list renders on its own.
    history.hooks.async = true;
    let rounds = 0;
    history.hooks.onQuery = (request) => {
      if (request.before || rounds >= 10) return;
      rounds++;
      history.copy(1);
      changed?.();
    };
    act(() => changed?.());
    await waitFor(() => expect(result.current.clips[0]?.id).toBe(310));

    // Two answers thrown away, the third shown although it was unsettled too.
    expect(MAX_DISCARDED_REFRESHES).toBe(2);
    expect(tops[1]).toBe(303);
  });

  it('Ctrl+A and a bulk delete only ever cover rendered rows', async () => {
    const { history, picked, result } = await fiftySelected();
    const target = picked[25]!;
    history.hooks.async = true;
    let requests = 0;
    history.hooks.onQuery = () => {
      requests++;
      if (requests === 2 || requests === 5) {
        history.recopy(requests === 2 ? target : picked[40]!);
        changed?.();
      }
    };
    history.copy(1);
    act(() => changed?.());

    // Select everything at every step of the refresh rounds and compare with what is rendered.
    for (let step = 0; step < 12; step++) {
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
      act(() => result.current.list.update(selectAll));
      const rendered = new Set(result.current.state.clips.map((clip) => clip.id));
      expect(result.current.list.selectedIds.every((id) => rendered.has(id))).toBe(true);
    }
    await waitFor(() => expect(result.current.state.clips[0]?.id).toBe(picked[40]));
    act(() => result.current.list.update(selectAll));
    await act(() => result.current.actions.requestDelete());
    await act(() => result.current.actions.requestDelete());

    const rendered = new Set(result.current.state.clips.map((clip) => clip.id));
    const deleted = removeMany.mock.calls.flatMap(([ids]) => ids);
    expect(deleted.length).toBeGreaterThan(0);
    expect(deleted.every((id) => rendered.has(id))).toBe(true);
  });
});
