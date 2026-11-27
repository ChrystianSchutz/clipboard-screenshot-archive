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
import { useNow } from '../../hooks/useNow';
import { ClipContextMenu, isContextMenuKey, useClipContextMenu } from '../history/ClipContextMenu';
import { ClipPreview } from '../history/ClipPreview';
import { applySearchOperators } from '../history/search-operators';
import { reconcileSelection, selectionAfterRemoval } from '../history/selection';
import { DEFAULT_FILTERS, useHistory } from '../history/useHistory';
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
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const now = useNow();
  const clipMenu = useClipContextMenu();

  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLUListElement>(null);
  const sentinelRef = useRef<HTMLLIElement>(null);

  const ids = useMemo(() => clips.map((clip) => clip.id), [clips]);
  const currentId = reconcileSelection(ids, selectedId);
  const selected = clips.find((clip) => clip.id === currentId) ?? null;
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

  /** Selects a tile and moves keyboard focus onto it. */
  const focusTile = useCallback((id: number | null) => {
    setSelectedId(id);
    if (id !== null) document.getElementById(tileId(id))?.focus();
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
    async (id: number, keepFocus: boolean) => {
      const next = selectionAfterRemoval(ids, id);
      if (keepFocus) focusTile(next);
      else setSelectedId(next);
      await api.history.remove([id]);
      onNotify('Deleted');
    },
    [ids, focusTile, onNotify],
  );

  const { openAtPointer } = clipMenu;
  /** Right-click on a tile: select it and open its menu. */
  const openTileMenu = useCallback(
    (clip: ClipSummary, event: MouseEvent) => {
      setSelectedId(clip.id);
      openAtPointer(clip, event);
    },
    [openAtPointer],
  );

  const columns = (): number => {
    const grid = gridRef.current;
    if (!grid) return 1;
    return getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
  };

  /**
   * Keys on a focused tile: arrows move, Enter copies, Delete deletes, Ctrl+P pins, the ContextMenu
   * key or Shift+F10 opens the menu.
   */
  const onGridKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const onTile = event.target instanceof HTMLElement && event.target.dataset.tile !== undefined;
    if (!onTile) return;
    const mod = event.ctrlKey || event.metaKey;
    if (isContextMenuKey(event) && selected) {
      event.preventDefault();
      clipMenu.openAtElement(selected, document.getElementById(tileId(selected.id)));
    } else if (isGridKey(event.key) && !mod) {
      event.preventDefault();
      focusTile(moveInGrid(ids, currentId, event.key, columns()));
    } else if (event.key === 'Enter' && selected) {
      event.preventDefault();
      void copy(selected.id);
    } else if (event.key === 'Delete' && selected && !event.repeat) {
      event.preventDefault();
      void remove(selected.id, true);
    } else if (mod && event.key.toLowerCase() === 'p' && selected) {
      event.preventDefault();
      void togglePin(selected.id, selected.pinned);
    }
  };

  /** Keys in the search box: Down enters the grid, Enter copies; Delete stays with the text. */
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' && ids.length > 0) {
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
    if (text !== '') {
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
              onKeyDown={onGridKeyDown}
            >
              {clips.map((clip) => (
                <ShotTile
                  key={clip.id}
                  clip={clip}
                  selected={clip.id === currentId}
                  now={now}
                  onSelect={setSelectedId}
                  onActivate={(id) => void copy(id)}
                  onContextMenu={openTileMenu}
                />
              ))}
              <li ref={sentinelRef} className="shots__sentinel" aria-hidden role="presentation" />
            </ul>
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
        handlers={{ copy, togglePin, remove: (id) => remove(id, true) }}
        onNotify={onNotify}
      />

      <footer className="statusbar">
        <span>
          {pluralize(clips.length, 'screenshot')}
          {hasMore ? '+' : ''}
        </span>
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
  readonly now: number;
  readonly onSelect: (id: number) => void;
  readonly onActivate: (id: number) => void;
  readonly onContextMenu: (clip: ClipSummary, event: MouseEvent) => void;
}

const ShotTile = memo(function ShotTile({
  clip,
  selected,
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
      tabIndex={selected ? 0 : -1}
      data-tile=""
      className={`shot-tile ${selected ? 'shot-tile--selected' : ''}`}
      onMouseDown={() => onSelect(clip.id)}
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
