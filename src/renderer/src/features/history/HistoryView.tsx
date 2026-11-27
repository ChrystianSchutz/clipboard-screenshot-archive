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
import { useNow } from '../../hooks/useNow';
import { ClipContextMenu, isContextMenuKey, useClipContextMenu } from './ClipContextMenu';
import { ClipPreview } from './ClipPreview';
import { ClipRow } from './ClipRow';
import { FilterBar } from './FilterBar';
import { applySearchOperators } from './search-operators';
import { moveSelection, reconcileSelection, selectionAfterRemoval } from './selection';
import { DEFAULT_FILTERS, useHistory, type HistoryFilters } from './useHistory';
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
  const { clips, hasMore, loading, error, loadMore } = useHistory(effective.filters);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [markedId, setMarkedId] = useState<number | null>(null);
  const now = useNow();
  const clipMenu = useClipContextMenu();

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const ids = useMemo(() => clips.map((clip) => clip.id), [clips]);
  const currentId = reconcileSelection(ids, selectedId);
  const selected = clips.find((clip) => clip.id === currentId) ?? null;
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
      setSelectedId(selectionAfterRemoval(ids, id));
      if (markedId === id) setMarkedId(null);
      await api.history.remove([id]);
      onNotify('Deleted');
    },
    [ids, markedId, onNotify],
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
  /** Right-click on a row: select it and open its menu. */
  const openRowMenu = useCallback(
    (clip: ClipSummary, event: MouseEvent) => {
      setSelectedId(clip.id);
      openAtPointer(clip, event);
    },
    [openAtPointer],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const mod = event.ctrlKey || event.metaKey;
    // The action bound to this key, or `null` to let the key do its default.
    const shortcut = (): (() => unknown) | null => {
      switch (true) {
        case event.key === 'ArrowDown':
          return () => setSelectedId(moveSelection(ids, currentId, 1));
        case event.key === 'ArrowUp':
          return () => setSelectedId(moveSelection(ids, currentId, -1));
        case event.key === 'PageDown':
          return () => setSelectedId(moveSelection(ids, currentId, PAGE_JUMP));
        case event.key === 'PageUp':
          return () => setSelectedId(moveSelection(ids, currentId, -PAGE_JUMP));
        case isContextMenuKey(event) && selected !== null:
          return () =>
            clipMenu.openAtElement(selected, document.getElementById(`clip-${selected.id}`));
        case event.key === 'Enter' && selected !== null:
          return () => copy(selected.id);
        case mod && event.key.toLowerCase() === 'p' && selected !== null:
          return () => togglePin(selected.id, selected.pinned);
        case mod && event.key.toLowerCase() === 'd' && selected !== null:
          return () => compare(selected.id);
        case mod && event.key.toLowerCase() === 'r':
          return () => updateFilters({ regex: !filters.regex });
        case event.key === 'Delete' &&
          selected !== null &&
          !event.repeat &&
          !editsText(event.target):
          return () => remove(selected.id);
        case event.key === 'Escape':
          return () => {
            if (markedId !== null) setMarkedId(null);
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
              aria-activedescendant={currentId !== null ? `clip-${currentId}` : undefined}
              tabIndex={-1}
            >
              {clips.map((clip) => (
                <ClipRow
                  key={clip.id}
                  clip={clip}
                  selected={clip.id === currentId}
                  marked={clip.id === markedId}
                  now={now}
                  query={highlightQuery}
                  onSelect={setSelectedId}
                  onActivate={(id) => void copy(id)}
                  onContextMenu={openRowMenu}
                />
              ))}
              <div ref={sentinelRef} className="history__sentinel" aria-hidden />
            </ul>
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
        handlers={{ copy, togglePin, compare, remove }}
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
        <span className="clip-row__spacer" />
        <span className="statusbar__hint">
          <Kbd>↑↓</Kbd> select <Kbd>Enter</Kbd> copy <Kbd>Ctrl P</Kbd> pin <Kbd>Ctrl D</Kbd> compare{' '}
          <Kbd>Del</Kbd> delete <Kbd>Esc</Kbd> close
        </span>
      </footer>
    </div>
  );
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
