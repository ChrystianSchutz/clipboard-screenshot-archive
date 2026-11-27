import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import type { ClipSummary } from '@shared/types';
import { pluralize } from '@shared/text';
import { formatRelative, formatTimestamp } from '@shared/time';
import { api } from '../../api';
import { Icon } from '../../components/Icon';
import { EmptyState, Kbd } from '../../components/primitives';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useListSelection } from '../../hooks/useListSelection';
import { useNow } from '../../hooks/useNow';
import {
  applyPointer,
  collapseToFocus,
  focusAfterRemoval,
  selectAll,
  selectOnly,
  selectRange,
  type PointerIntent,
} from '../../lib/selection';
import { ClipContextMenu, isContextMenuKey, useClipContextMenu } from '../history/ClipContextMenu';
import { ClipPreview } from '../history/ClipPreview';
import { pressIntent } from '../history/ClipRow';
import { applySearchOperators } from '../history/search-operators';
import { SelectionCount, SelectionSummary } from '../history/SelectionSummary';
import { DEFAULT_FILTERS, useHistory } from '../history/useHistory';
import { useSelectionActions } from '../history/useSelectionActions';
import { ClipThumbnail } from '../ocr/ClipThumbnail';
import { useScreenshotDetails } from '../ocr/ScreenshotPreview';
import {
  emptyHint,
  formatBytes,
  imageDimensions,
  isGridKey,
  moveInGrid,
  tileStatuses,
} from './gallery';
import '../history/history.css';
import './screenshots.css';

interface ScreenshotsViewProps {
  /** `app:info.platform`: picks the empty-state hint. */
  readonly platform: string;
  /** Incremented by the parent whenever the window is shown, to re-focus the search box. */
  readonly focusToken: number;
  readonly onNotify: (message: string) => void;
  readonly onOpenSettings: () => void;
}

const tileId = (id: number): string => `shot-${String(id)}`;

/** The Screenshots tab: every image clip as a thumbnail grid, newest first, with the image preview. */
export function ScreenshotsView({
  platform,
  focusToken,
  onNotify,
  onOpenSettings,
}: ScreenshotsViewProps) {
  const [text, setText] = useState('');
  const debouncedText = useDebouncedValue(text, 120);
  // Same query as History (operators such as is:pinned included), always limited to images.
  const filters = useMemo(
    () => ({
      ...applySearchOperators({ ...DEFAULT_FILTERS, text: debouncedText }, []).filters,
      kind: 'image' as const,
    }),
    [debouncedText],
  );
  const { clips, hasMore, loading, error, loadMore } = useHistory(filters);
  const now = useNow();
  const clipMenu = useClipContextMenu();

  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLUListElement>(null);
  const sentinelRef = useRef<HTMLLIElement>(null);

  const ids = useMemo(() => clips.map((clip) => clip.id), [clips]);
  const { selection, selectedIds, update: updateSelection } = useListSelection(ids);
  /** The tile with keyboard focus (the only one in the tab order), where arrow keys move from. */
  const currentId = selection.focus;
  const selectedClips = useMemo(() => {
    const byId = new Map(clips.map((clip) => [clip.id, clip]));
    return selectedIds.flatMap((id) => byId.get(id) ?? []);
  }, [clips, selectedIds]);
  const multi = selectedClips.length > 1;
  /** The one selected screenshot (preview, single actions); `null` for none or several. */
  const selected = selectedClips.length === 1 ? (selectedClips[0] ?? null) : null;
  const highlightQuery = useMemo(() => ({ text: filters.text, regex: false }), [filters.text]);

  useEffect(() => {
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [focusToken]);

  useEffect(() => {
    if (currentId === null) return;
    document.getElementById(tileId(currentId))?.scrollIntoView({ block: 'nearest' });
  }, [currentId]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root: gridRef.current, rootMargin: '200px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  /**
   * Selects just this tile and moves keyboard focus onto it. With no tile left (the last ones were
   * deleted), focus goes to the search box, which stays, so Esc and typing still reach the view.
   */
  const focusTile = useCallback(
    (id: number | null) => {
      updateSelection(() => selectOnly(id));
      if (id !== null) document.getElementById(tileId(id))?.focus();
      else searchRef.current?.focus({ preventScroll: true });
    },
    [updateSelection],
  );

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
    async (id: number, keepFocus: boolean) => {
      const next = focusAfterRemoval(ids, new Set([id]));
      // The last screenshot: its preview goes away too, so focus moves to the search box.
      if (keepFocus || next === null) focusTile(next);
      else updateSelection(() => selectOnly(next));
      await api.history.remove(id);
      onNotify('Deleted');
    },
    [ids, focusTile, onNotify, updateSelection],
  );

  const many = useSelectionActions({
    noun: 'screenshot',
    selection,
    clips: selectedClips,
    ids,
    onNotify,
    onRemoved: focusTile,
  });

  /**
   * Cancelling the pending delete removes its buttons; when one of them had the focus (or nothing
   * has it), focus goes back to the focused tile, so the arrow keys keep working.
   */
  const cancelDelete = (): void => {
    many.cancelDelete();
    const active = document.activeElement;
    if (active === searchRef.current) return;
    if (currentId !== null) document.getElementById(tileId(currentId))?.focus();
  };

  const selectTile = useCallback(
    (id: number, intent: PointerIntent) => {
      updateSelection((current, visible) => applyPointer(current, visible, id, intent));
    },
    [updateSelection],
  );

  const { openAtPointer } = clipMenu;
  /**
   * Right-click on a tile: inside a multi-selection it keeps the selection (and focuses the
   * tile), so the menu acts on all of it; anywhere else it selects just that tile.
   */
  const openTileMenu = useCallback(
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

  const columns = (): number => {
    const grid = gridRef.current;
    if (!grid) return 1;
    return getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
  };

  /**
   * Keys on a focused tile: arrows move (with Shift they extend the selection), Ctrl+A selects
   * every tile, Enter copies, Delete deletes, Ctrl+P pins, the ContextMenu key or Shift+F10 opens
   * the menu.
   */
  const onGridKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const onTile = event.target instanceof HTMLElement && event.target.dataset.tile !== undefined;
    if (!onTile) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;
    const focused = clips.find((clip) => clip.id === currentId) ?? null;
    let action: (() => unknown) | null = null;
    if (isContextMenuKey(event) && focused) {
      action = () => {
        const element = document.getElementById(tileId(focused.id));
        if (multi && selection.selected.has(focused.id)) {
          clipMenu.openAtElement(focused, element, selectedClips);
        } else {
          updateSelection(() => selectOnly(focused.id));
          clipMenu.openAtElement(focused, element);
        }
      };
    } else if (isGridKey(key) && !mod) {
      const next = moveInGrid(ids, currentId, key, columns());
      action = event.shiftKey
        ? () => {
            if (next === null) return;
            updateSelection((current, visible) => selectRange(current, visible, next));
            document.getElementById(tileId(next))?.focus();
          }
        : () => focusTile(next);
    } else if (mod && key.toLowerCase() === 'a' && !event.shiftKey) {
      action = () => updateSelection(selectAll);
    } else if (key === 'Enter') {
      if (multi) action = many.copy;
      else if (selected) action = () => copy(selected.id);
    } else if (key === 'Delete' && !event.repeat) {
      if (multi) action = many.requestDelete;
      else if (selected) action = () => remove(selected.id, true);
    } else if (mod && key.toLowerCase() === 'p') {
      if (multi) action = many.togglePin;
      else if (selected) action = () => togglePin(selected.id, selected.pinned);
    }
    if (!action) return;
    event.preventDefault();
    void action();
  };

  /**
   * Keys in the search box: Down enters the grid, Enter copies, Ctrl+A in the empty box selects
   * every screenshot; Delete stays with the text.
   */
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'a' && !event.shiftKey && text === '') {
      event.preventDefault();
      updateSelection(selectAll);
    } else if (event.key === 'ArrowDown' && ids.length > 0) {
      event.preventDefault();
      focusTile(currentId ?? ids[0] ?? null);
    } else if (event.key === 'Enter' && selected) {
      event.preventDefault();
      void copy(selected.id);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    // One step back per press: the pending delete, the multi-selection, the search, the window.
    if (many.confirmingDelete) cancelDelete();
    else if (multi) updateSelection(collapseToFocus);
    else if (text !== '') {
      setText('');
      searchRef.current?.focus();
    } else void api.window.hide();
  };

  const hint = emptyHint(platform);

  return (
    <div className="shots" onKeyDown={onKeyDown}>
      <div className="filters">
        <div className={`search ${error ? 'search--invalid' : ''}`}>
          <Icon name="search" />
          <input
            ref={searchRef}
            type="search"
            aria-label="Search screenshots"
            placeholder="Search the text in your screenshots…"
            spellCheck={false}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
        </div>
        {error && (
          <div className="search-error" role="status">
            {error}
          </div>
        )}
      </div>

      <div className="history__body shots__body">
        {clips.length === 0 && !loading ? (
          filters.text !== '' || filters.pinnedOnly ? (
            <EmptyState title="No screenshots match">
              <p>No screenshot has this text in it. Try fewer or different words.</p>
              <button type="button" className="button" onClick={() => setText('')}>
                Clear search
              </button>
            </EmptyState>
          ) : (
            <EmptyState title="No screenshots yet">
              <p>
                Press <Kbd>{hint.keys}</Kbd> {hint.after}
              </p>
              {hint.needsFolderImport && (
                <button type="button" className="button" onClick={onOpenSettings}>
                  <Icon name="settings" size={14} /> Open Settings
                </button>
              )}
            </EmptyState>
          )
        ) : (
          <>
            <ul
              ref={gridRef}
              className="shots__grid"
              role="listbox"
              aria-label="Screenshots"
              aria-multiselectable="true"
              onKeyDown={onGridKeyDown}
            >
              {clips.map((clip) => (
                <ShotTile
                  key={clip.id}
                  clip={clip}
                  selected={selection.selected.has(clip.id)}
                  focused={clip.id === currentId}
                  now={now}
                  onSelect={selectTile}
                  onActivate={(id) => void copy(id)}
                  onContextMenu={openTileMenu}
                />
              ))}
              <li ref={sentinelRef} className="shots__sentinel" aria-hidden role="presentation" />
            </ul>
            {multi && (
              <SelectionSummary
                clips={selectedClips}
                noun="screenshot"
                now={now}
                confirmingDelete={many.confirmingDelete}
                onCopy={() => void many.copy()}
                onCopyText={() => void many.copyText()}
                onTogglePin={() => void many.togglePin()}
                onDelete={() => void many.requestDelete()}
                onCancelDelete={cancelDelete}
              />
            )}
            {selected && (
              <ClipPreview
                clip={selected}
                now={now}
                query={highlightQuery}
                marked={false}
                onCopy={() => void copy(selected.id)}
                onTogglePin={() => void togglePin(selected.id, selected.pinned)}
                onCompare={() => undefined}
                onDelete={() => void remove(selected.id, false)}
                onOpenSettings={onOpenSettings}
              />
            )}
          </>
        )}
      </div>

      <ClipContextMenu
        controls={clipMenu}
        selectedIds={selectedIds}
        handlers={{
          copy,
          togglePin,
          remove: (id) => remove(id, true),
          selection: {
            noun: 'screenshot',
            copy: many.copy,
            copyText: many.copyText,
            togglePin: many.togglePin,
            remove: many.requestDelete,
          },
        }}
        onNotify={onNotify}
      />

      <footer className="statusbar">
        <span>
          {pluralize(clips.length, 'screenshot')}
          {hasMore ? '+' : ''}
        </span>
        <SelectionCount count={selectedClips.length} />
        <span className="clip-row__spacer" />
        <span className="statusbar__hint">
          <Kbd>←↑↓→</Kbd> select <Kbd>Enter</Kbd> copy <Kbd>Ctrl P</Kbd> pin <Kbd>Del</Kbd> delete{' '}
          <Kbd>Esc</Kbd> close
        </span>
      </footer>
    </div>
  );
}

interface ShotTileProps {
  readonly clip: ClipSummary;
  readonly selected: boolean;
  /** Has keyboard focus within the grid: the one tile in the tab order. */
  readonly focused: boolean;
  readonly now: number;
  readonly onSelect: (id: number, intent: PointerIntent) => void;
  readonly onActivate: (id: number) => void;
  readonly onContextMenu: (clip: ClipSummary, event: MouseEvent) => void;
}

const ShotTile = memo(function ShotTile({
  clip,
  selected,
  focused,
  now,
  onSelect,
  onActivate,
  onContextMenu,
}: ShotTileProps) {
  const { details } = useScreenshotDetails(clip.id);
  const ready = details.status === 'ready' ? details.value : null;
  const dimensions = imageDimensions(clip.preview);
  const size = ready ? formatBytes(ready.byteSize) : '';
  const statuses = ready ? tileStatuses(ready) : [];
  const app = clip.source.app ?? 'Unknown app';
  const when = formatRelative(clip.lastCopiedAt, now);

  return (
    <li
      id={tileId(clip.id)}
      role="option"
      aria-selected={selected}
      aria-label={`Screenshot ${dimensions} from ${app}, ${when}`}
      tabIndex={focused ? 0 : -1}
      data-tile=""
      className={`shot-tile ${selected ? 'shot-tile--selected' : ''} ${focused ? 'shot-tile--focused' : ''}`}
      onMouseDown={(event) => {
        const intent = pressIntent(event);
        if (intent !== null) onSelect(clip.id, intent);
      }}
      onDoubleClick={() => onActivate(clip.id)}
      onContextMenu={(event) => onContextMenu(clip, event)}
    >
      <div className="shot-tile__frame">
        <ClipThumbnail clipId={clip.id} />
        {clip.pinned && (
          <span className="shot-tile__pin" title="Pinned">
            <Icon name="pin" size={12} label="Pinned" />
          </span>
        )}
      </div>
      <div className="shot-tile__meta">
        <div className="shot-tile__line">
          <span className="shot-tile__size">
            {dimensions}
            {size && <span className="shot-tile__bytes"> · {size}</span>}
          </span>
          <time
            dateTime={new Date(clip.lastCopiedAt).toISOString()}
            title={formatTimestamp(clip.lastCopiedAt)}
          >
            {when}
          </time>
        </div>
        <div className="shot-tile__line">
          <span className="shot-tile__app" title={clip.source.exe ?? app}>
            {app}
          </span>
          {statuses.map((status) => (
            <span key={status.label} className={`shot-status shot-status--${status.tone}`}>
              {status.label}
            </span>
          ))}
        </div>
      </div>
    </li>
  );
});
