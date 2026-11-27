/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClipboardArchiveApi } from '@shared/ipc-contract';
import type { ClipSummary, HistoryPage, HistoryQuery } from '@shared/types';
import { useListSelection } from '../../hooks/useListSelection';
import { selectAll } from '../../lib/selection';
import {
  cursorOf,
  DEFAULT_FILTERS,
  fetchRows,
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

/** A history that grows at the top, as new copies arrive, served like `server`. */
function growingServer(total: number, budget: number) {
  let all = rows(total);
  const query = vi.fn((request: HistoryQuery): Promise<HistoryPage> => {
    const start = request.before ? all.findIndex((row) => row.id < request.before!.id) : 0;
    const from = start === -1 ? all.length : start;
    const page = all.slice(from, from + Math.min(request.limit ?? 60, budget));
    const last = page.at(-1);
    const more = from + page.length < all.length;
    return Promise.resolve({ clips: page, nextCursor: more && last ? cursorOf(last) : null });
  });
  const copy = (count: number): void => {
    const top = all[0]?.id ?? 0;
    const added = Array.from({ length: count }, (_, index) => {
      const id = top + count - index;
      return { id, lastCopiedAt: id } as unknown as ClipSummary;
    });
    all = [...added, ...all];
  };
  return { query, copy };
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

  beforeEach(() => {
    changed = null;
  });

  afterEach(() => {
    delete (window as { clipboardArchive?: ClipboardArchiveApi }).clipboardArchive;
  });

  function install(query: (request: HistoryQuery) => Promise<HistoryPage>): void {
    (window as { clipboardArchive?: unknown }).clipboardArchive = {
      history: {
        query,
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
});
