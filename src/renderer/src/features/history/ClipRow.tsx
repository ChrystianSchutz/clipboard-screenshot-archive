import { memo, type MouseEvent } from 'react';
import type { ClipSummary } from '@shared/types';
import { firstLine, domainOf } from '@shared/text';
import { formatRelative, formatTimestamp } from '@shared/time';
import { CategoryChips } from '../../components/CategoryChips';
import { Highlight } from '../../components/Highlight';
import { Icon } from '../../components/Icon';
import { KindBadge } from '../../components/primitives';
import { isMacPlatform, pointerIntent, type PointerIntent } from '../../lib/selection';
import { ClipThumbnail } from '../ocr/ClipThumbnail';
import type { HighlightQuery } from './highlight';

const IS_MAC = isMacPlatform();

/**
 * The selection intent of a mouse press on a row or tile: plain, Ctrl/Cmd, Shift or both. `null`
 * for presses that leave the selection alone (other buttons, and a macOS Ctrl+click, which is a
 * right-click): the context menu handler decides those.
 */
export function pressIntent(event: MouseEvent): PointerIntent | null {
  return event.button === 0 ? pointerIntent(event, IS_MAC) : null;
}

interface ClipRowProps {
  readonly clip: ClipSummary;
  readonly selected: boolean;
  /** Has keyboard focus within the list (the focus ring); usually also selected. */
  readonly focused: boolean;
  readonly marked: boolean;
  readonly now: number;
  readonly query: HighlightQuery;
  readonly onSelect: (id: number, intent: PointerIntent) => void;
  readonly onActivate: (id: number) => void;
  /** Right-click: opens the clip menu. */
  readonly onContextMenu: (clip: ClipSummary, event: MouseEvent) => void;
}

export const ClipRow = memo(function ClipRow({
  clip,
  selected,
  focused,
  marked,
  now,
  query,
  onSelect,
  onActivate,
  onContextMenu,
}: ClipRowProps) {
  const domain = clip.source.url ? domainOf(clip.source.url) : null;
  // `titleMatches` (regex search) are computed in main on exactly this string.
  const title = firstLine(clip.preview) || '(whitespace)';

  return (
    <li
      id={`clip-${clip.id}`}
      role="option"
      aria-selected={selected}
      className={`clip-row ${selected ? 'clip-row--selected' : ''} ${focused ? 'clip-row--focused' : ''} ${marked ? 'clip-row--marked' : ''}`}
      onMouseDown={(event) => {
        const intent = pressIntent(event);
        if (intent !== null) onSelect(clip.id, intent);
      }}
      onDoubleClick={() => onActivate(clip.id)}
      onContextMenu={(event) => onContextMenu(clip, event)}
    >
      <div
        className={
          clip.kind === 'image' ? 'clip-row__title clip-row__title--image' : 'clip-row__title'
        }
      >
        {clip.kind === 'image' && <ClipThumbnail clipId={clip.id} />}
        <Highlight text={title} query={query} ranges={clip.titleMatches} />
      </div>
      <div className="clip-row__meta">
        <KindBadge kind={clip.kind} />
        <CategoryChips categories={clip.categories} />
        {clip.pinned && (
          <span className="clip-row__pin" title="Pinned">
            <Icon name="pin" size={12} label="Pinned" />
          </span>
        )}
        {marked && <span className="badge clip-row__marked">A</span>}
        <span className="clip-row__source">{clip.source.app ?? 'Unknown app'}</span>
        {domain && <span className="clip-row__domain">{domain}</span>}
        <span className="clip-row__spacer" />
        {clip.copyCount > 1 && <span className="clip-row__count">×{clip.copyCount}</span>}
        <time
          dateTime={new Date(clip.lastCopiedAt).toISOString()}
          title={formatTimestamp(clip.lastCopiedAt)}
        >
          {formatRelative(clip.lastCopiedAt, now)}
        </time>
      </div>
    </li>
  );
});
