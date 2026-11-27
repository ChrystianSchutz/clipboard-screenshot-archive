import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import type { ClipSummary } from '@shared/types';
import type { Category } from '@shared/categories';
import { removeOperator, type OperatorKey } from '@shared/search-query';
import { pluralize } from '@shared/text';
import { api } from '../../api';
import { EmptyState, Kbd } from '../../components/primitives';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useListSelection } from '../../hooks/useListSelection';
import { useNow } from '../../hooks/useNow';
import {
  applyPointer,
  collapseToFocus,
  focusAfterRemoval,
  moveSelection,
  selectAll,
  selectOnly,
  selectRange,
  type PointerIntent,
} from '../../lib/selection';
import { ClipContextMenu, isContextMenuKey, useClipContextMenu } from './ClipContextMenu';
import { ClipPreview } from './ClipPreview';
import { ClipRow } from './ClipRow';
import { FilterBar } from './FilterBar';
import { applySearchOperators } from './search-operators';
import { SelectionCount, SelectionSummary } from './SelectionSummary';
import { DEFAULT_FILTERS, useHistory, type HistoryFilters } from './useHistory';
import { useSelectionActions } from './useSelectionActions';
import './history.css';

const PAGE_JUMP = 8;

interface HistoryViewProps {
  readonly shortcutLabel: string;
  readonly captureEnabled: boolean;
  /** Incremented by the parent whenever the window is shown, to re-focus the search box. */
  readonly focusToken: number;
  readonly onNotify: (message: string) => void;
  /** Opens Settings (linked from the screenshot analysis panel). */
  readonly onOpenSettings?: (() => void) | undefined;
}

export function HistoryView({
  shortcutLabel,
  captureEnabled,
  focusToken,
  onNotify,
  onOpenSettings,
}: HistoryViewProps) {
  const [filters, setFilters] = useState<HistoryFilters>(DEFAULT_FILTERS);
  const debouncedText = useDebouncedValue(filters.text, 120);
  const [apps, setApps] = useState<readonly string[]>([]);
  // Operators typed in the search box (#sql, app:chrome, is:pinned) merged into the filters:
  // `live` drives the controls as you type, `effective` (debounced) is what gets queried.
  const live = useMemo(() => applySearchOperators(filters, apps), [filters, apps]);
  const effective = useMemo(
    () => applySearchOperators({ ...filters, text: debouncedText }, apps),
    [filters, debouncedText, apps],
  );
  const { clips, missing, hasMore, loading, error, loadMore } = useHistory(effective.filters);
  const [markedId, setMarkedId] = useState<number | null>(null);
  const now = useNow();
  const clipMenu = useClipContextMenu();

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const ids = useMemo(() => clips.map((clip) => clip.id), [clips]);
  // Rows missing only until the refresh on its way shows them again stay selectable, so a
  // selection (and a pending delete) survives a re-copy of one of its rows during a refresh.
  const selectableIds = useMemo(
    () => (missing.length === 0 ? ids : [...ids, ...missing.map((clip) => clip.id)]),
    [ids, missing],
  );
  const { selection, selectedIds, update: updateSelection } = useListSelection(selectableIds);
  /** The row with the focus ring, where arrow keys move from. */
  const currentId = selection.focus;
  const selectedClips = useMemo(() => {
    const byId = new Map([...missing, ...clips].map((clip) => [clip.id, clip]));
    return selectedIds.flatMap((id) => byId.get(id) ?? []);
  }, [clips, missing, selectedIds]);
  const multi = selectedClips.length > 1;
  /** The one selected clip (preview, single-clip actions); `null` for none or several. */
  const selected = selectedClips.length === 1 ? (selectedClips[0] ?? null) : null;
  const highlightQuery = useMemo(
    () => ({ text: effective.filters.text, regex: effective.filters.regex }),
    [effective.filters.text, effective.filters.regex],
  );

  useEffect(() => {
    const refreshApps = (): void => {
      // Keep the old array when nothing changed, so the operator merge (and the query) stay put.
      api.history.apps().then(
        (next) => setApps((current) => (sameList(current, next) ? current : next)),
        () => undefined,
      );
    };
    refreshApps();
    return api.history.onChanged(refreshApps);
  }, []);

  useEffect(() => {
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [focusToken]);

  useEffect(() => {
    if (currentId === null) return;
    document.getElementById(`clip-${currentId}`)?.scrollIntoView({ block: 'nearest' });
  }, [currentId]);

  // Infinite scroll: load the next page when the sentinel below the last row becomes visible.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root: listRef.current, rootMargin: '200px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  const updateFilters = useCallback((patch: Partial<HistoryFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  }, []);

  const removeSearchOperator = useCallback((key: OperatorKey) => {
    setFilters((current) => ({ ...current, text: removeOperator(current.text, key) }));
    searchRef.current?.focus();
  }, []);

  /** Clicking a category chip in the preview: filter by it (replacing a typed #category). */
  const filterByCategory = useCallback((category: Category) => {
    setFilters((current) => ({
      ...current,
      text: current.regex ? current.text : removeOperator(current.text, 'category'),
      category,
    }));
  }, []);

  const copy = useCallback(
    async (id: number) => {
      await api.history.restore(id);
      onNotify('Copied to clipboard');
      await api.window.hide();
    },
    [onNotify],
  );

  const togglePin = useCallback(async (id: number, pinned: boolean) => {
    await api.history.setPinned(id, !pinned);
  }, []);

  const remove = useCallback(
    async (id: number) => {
      const next = focusAfterRemoval(ids, new Set([id]));
      updateSelection(() => selectOnly(next));
      // The last clip: the preview (and its Delete button) goes away with the list.
      if (next === null) searchRef.current?.focus({ preventScroll: true });
      if (markedId === id) setMarkedId(null);
      await api.history.remove(id);
      onNotify('Deleted');
    },
    [ids, markedId, onNotify, updateSelection],
  );

  /**
   * After the summary pane's buttons go away (a delete, a cancelled delete), focus goes to the list
   * unless it is in the search box, so the arrow keys keep working instead of landing on the page.
   * When nothing is left to show (`remaining` false), the list goes away too: focus goes to the
   * search box, which stays, so Esc and typing still reach the view.
   */
  const keepKeyboardInView = useCallback((remaining = true) => {
    if (!remaining) searchRef.current?.focus({ preventScroll: true });
    else if (document.activeElement !== searchRef.current)
      listRef.current?.focus({ preventScroll: true });
  }, []);

  const afterBatchRemoval = useCallback(
    (next: number | null) => {
      if (markedId !== null && selection.selected.has(markedId)) setMarkedId(null);
      updateSelection(() => selectOnly(next));
      keepKeyboardInView(next !== null);
    },
    [markedId, selection, updateSelection, keepKeyboardInView],
  );
  const many = useSelectionActions({
    noun: 'clip',
    selection,
    clips: selectedClips,
    ids,
    onNotify,
    onRemoved: afterBatchRemoval,
  });

  const selectRow = useCallback(
    (id: number, intent: PointerIntent) => {
      updateSelection((current, visible) => applyPointer(current, visible, id, intent));
    },
    [updateSelection],
  );

  /** First press marks A; pressing on another clip opens the compare window for A vs B. */
  const compare = useCallback(
    async (id: number) => {
      if (markedId === null || markedId === id) {
        setMarkedId(markedId === id ? null : id);
        if (markedId !== id) onNotify('Marked as A. Pick another clip and compare again.');
        return;
      }
      await api.compare.openClips(markedId, id);
      setMarkedId(null);
    },
    [markedId, onNotify],
  );

  const { openAtPointer } = clipMenu;
  /**
   * Right-click on a row: inside a multi-selection it keeps the selection (and focuses the row),
   * so the menu acts on all of it; anywhere else it selects just that row.
   */
  const openRowMenu = useCallback(
    (clip: ClipSummary, event: MouseEvent) => {
      if (multi && selection.selected.has(clip.id)) {
        updateSelection((current) =>
          current.focus === clip.id ? current : { ...current, focus: clip.id },
        );
        openAtPointer(clip, event, selectedClips);
      } else {
        updateSelection(() => selectOnly(clip.id));
        openAtPointer(clip, event);
      }
    },
    [multi, selection, selectedClips, openAtPointer, updateSelection],
  );

  /** Arrow keys and PageUp/PageDown: move the focus; with Shift, extend the selection to it. */
  const moveBy = (delta: number, extend: boolean) => (): void => {
    updateSelection((current, visible) => {
      const next = moveSelection(visible, current.focus, delta);
      if (next === null) return current;
      return extend ? selectRange(current, visible, next) : selectOnly(next);
    });
  };

  const cancelDelete = (): void => {
    many.cancelDelete();
    keepKeyboardInView();
  };

  /** Ctrl+A selects every row from the list, or from the search box while it is empty. */
  function selectsAllRows(target: EventTarget): boolean {
    if (target === searchRef.current) return filters.text === '';
    return inside(listRef.current, target);
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const focused = clips.find((clip) => clip.id === currentId) ?? null;
    const deleteKey = event.key === 'Delete' && !event.repeat && !editsText(event.target);
    // Enter and Space on a focused button press that button (Cancel, Delete, Copy, a filter);
    // they never also run the list's shortcut for the selected clips.
    if ((event.key === 'Enter' || event.key === ' ') && activatesOnKey(event.target)) return;
    // The action bound to this key, or `null` to let the key do its default.
    const shortcut = (): (() => unknown) | null => {
      switch (true) {
        case event.key === 'ArrowDown' && !mod:
          return moveBy(1, event.shiftKey);
        case event.key === 'ArrowUp' && !mod:
          return moveBy(-1, event.shiftKey);
        case event.key === 'PageDown' && !mod:
          return moveBy(PAGE_JUMP, event.shiftKey);
        case event.key === 'PageUp' && !mod:
          return moveBy(-PAGE_JUMP, event.shiftKey);
        // Every row, from the list or the empty search box (where there is no text to select).
        case mod && key === 'a' && !event.shiftKey && selectsAllRows(event.target):
          return () => updateSelection(selectAll);
        case isContextMenuKey(event) && focused !== null:
          return () => {
            const element = document.getElementById(`clip-${String(focused.id)}`);
            if (multi && selection.selected.has(focused.id)) {
              clipMenu.openAtElement(focused, element, selectedClips);
            } else {
              updateSelection(() => selectOnly(focused.id));
              clipMenu.openAtElement(focused, element);
            }
          };
        case event.key === 'Enter' && multi:
          return many.copy;
        case event.key === 'Enter' && selected !== null:
          return () => copy(selected.id);
        case mod && key === 'p' && multi:
          return many.togglePin;
        case mod && key === 'p' && selected !== null:
          return () => togglePin(selected.id, selected.pinned);
        case mod && key === 'd' && multi:
          return many.compare;
        case mod && key === 'd' && selected !== null:
          return () => compare(selected.id);
        case mod && key === 'r':
          return () => updateFilters({ regex: !filters.regex });
        case deleteKey && multi:
          return many.requestDelete;
        case deleteKey && selected !== null:
          return () => remove(selected.id);
        case event.key === 'Escape':
          // One step back per press: the pending delete, the multi-selection, the A mark, the
          // search text, and only then the window.
          return () => {
            if (many.confirmingDelete) cancelDelete();
            else if (multi) updateSelection(collapseToFocus);
            else if (markedId !== null) setMarkedId(null);
            else if (filters.text !== '') updateFilters({ text: '' });
            else void api.window.hide();
          };
        default:
          return null;
      }
    };

    const action = shortcut();
    if (!action) return;
    event.preventDefault();
    void action();
  };

  const shown = live.filters;
  const filtered =
    shown.text !== '' ||
    shown.app !== null ||
    shown.kind !== null ||
    shown.category !== null ||
    shown.range !== 'all' ||
    shown.pinnedOnly;

  return (
    <div className="history" onKeyDown={onKeyDown}>
      <FilterBar
        ref={searchRef}
        filters={filters}
        operators={live.operators}
        apps={apps}
        error={error}
        onChange={updateFilters}
        onRemoveOperator={removeSearchOperator}
      />

      <div className="history__body">
        {clips.length === 0 && !loading ? (
          filtered ? (
            <EmptyState title="No clips match">
              <p>Try fewer words, a wider time range, or turn off the regex mode.</p>
              <button type="button" className="button" onClick={() => setFilters(DEFAULT_FILTERS)}>
                Clear filters
              </button>
            </EmptyState>
          ) : (
            <EmptyState title="Your clipboard trail starts here">
              <p>
                Copy anything, in any app. It shows up here with the app and page it came from. Open
                this window anytime with <Kbd>{shortcutLabel}</Kbd>.
              </p>
            </EmptyState>
          )
        ) : (
          <>
            <ul
              ref={listRef}
              className="history__list"
              role="listbox"
              aria-label="Clipboard history"
              aria-multiselectable="true"
              aria-activedescendant={currentId !== null ? `clip-${String(currentId)}` : undefined}
              tabIndex={0}
            >
              {clips.map((clip) => (
                <ClipRow
                  key={clip.id}
                  clip={clip}
                  selected={selection.selected.has(clip.id)}
                  focused={clip.id === currentId}
                  marked={clip.id === markedId}
                  now={now}
                  query={highlightQuery}
                  onSelect={selectRow}
                  onActivate={(id) => void copy(id)}
                  onContextMenu={openRowMenu}
                />
              ))}
              <div ref={sentinelRef} className="history__sentinel" aria-hidden />
            </ul>
            {multi && (
              <SelectionSummary
                clips={selectedClips}
                noun="clip"
                now={now}
                confirmingDelete={many.confirmingDelete}
                onCopy={() => void many.copy()}
                onTogglePin={() => void many.togglePin()}
                onCompare={() => void many.compare()}
                onDelete={() => void many.requestDelete()}
                onCancelDelete={cancelDelete}
              />
            )}
            {selected && (
              <ClipPreview
                clip={selected}
                now={now}
                query={highlightQuery}
                marked={selected.id === markedId}
                onCopy={() => void copy(selected.id)}
                onTogglePin={() => void togglePin(selected.id, selected.pinned)}
                onCompare={() => void compare(selected.id)}
                onDelete={() => void remove(selected.id)}
                onFilterCategory={filterByCategory}
                onOpenSettings={onOpenSettings}
              />
            )}
          </>
        )}
      </div>

      <ClipContextMenu
        controls={clipMenu}
        markedId={markedId}
        selectedIds={selectedIds}
        handlers={{
          copy,
          togglePin,
          compare,
          remove,
          selection: {
            noun: 'clip',
            copy: many.copy,
            togglePin: many.togglePin,
            compare: many.compare,
            remove: many.requestDelete,
          },
        }}
        onNotify={onNotify}
      />

      <footer className="statusbar">
        <span className={`statusbar__dot ${captureEnabled ? '' : 'statusbar__dot--paused'}`} />
        <span>{captureEnabled ? 'Recording' : 'Paused'}</span>
        <span className="statusbar__sep">·</span>
        <span>
          {pluralize(clips.length, 'clip')}
          {hasMore ? '+' : ''}
        </span>
        <SelectionCount count={selectedClips.length} />
        <span className="clip-row__spacer" />
        <span className="statusbar__hint">
          <Kbd>↑↓</Kbd> select <Kbd>Enter</Kbd> copy <Kbd>Ctrl P</Kbd> pin <Kbd>Ctrl D</Kbd> compare{' '}
          <Kbd>Del</Kbd> delete <Kbd>Esc</Kbd> close
        </span>
      </footer>
    </div>
  );
}

/** Whether `target` is `container` or inside it. */
function inside(container: HTMLElement | null, target: EventTarget): boolean {
  return container !== null && target instanceof Node && container.contains(target);
}

/**
 * Whether Enter or Space on `target` belongs to it: a button, link, checkbox or select, which the
 * key presses or opens. The search box and the list are not: there the keys act on the clips.
 */
function activatesOnKey(target: EventTarget): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement)
    return target.type === 'checkbox' || target.type === 'radio';
  return target.closest('button, a[href], select, [role="button"], [role="menuitem"]') !== null;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Whether Delete in `target` edits text: a text field with something in it. Then Delete belongs to
 * the field (it removes characters, or the selection) and never deletes a clip. In an empty search
 * box, or on a row, Delete deletes the selected clip. "Empty" is simpler to predict than "caret at
 * the end": the user sees it, and a held key (auto-repeat, ignored above) never runs on from
 * clearing the text into deleting clips.
 */
function editsText(target: EventTarget): boolean {
  return (
    (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
    target.value !== ''
  );
}
