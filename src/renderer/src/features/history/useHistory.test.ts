/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClipboardArchiveApi } from '@shared/ipc-contract';
import type { ClipSummary, HistoryPage, HistoryQuery } from '@shared/types';
import { DEFAULT_FILTERS, fetchRows, useHistory, type HistoryFilters } from './useHistory';

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

  function install(query: ReturnType<typeof server>): void {
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
});
