import { useMemo, useState } from 'react';
import type { Category } from '@shared/categories';
import { PREVIEW_PANE_CHARS, type ClipSummary } from '@shared/types';
import { parseJson } from '@shared/json-diff';
import { compactNumber, pluralize } from '@shared/text';
import { formatRelative, formatTimestamp } from '@shared/time';
import { CategoryChips } from '../../components/CategoryChips';
import { Highlight } from '../../components/Highlight';
import { Icon } from '../../components/Icon';
import { Kbd, KindBadge } from '../../components/primitives';
import { ScreenshotPreview } from '../ocr/ScreenshotPreview';
import type { HighlightQuery } from './highlight';
import { useClipContent, useRegexRanges } from './useClipDetail';

interface ClipPreviewProps {
  /** The selected row; its full text is fetched on demand. */
  readonly clip: ClipSummary;
  readonly now: number;
  readonly query: HighlightQuery;
  readonly marked: boolean;
  readonly onCopy: () => void;
  readonly onTogglePin: () => void;
  readonly onCompare: () => void;
  readonly onDelete: () => void;
  /** Called when a category chip is clicked. */
  readonly onFilterCategory?: (category: Category) => void;
  /** Opens Settings (the screenshot analysis panel links to its options). */
  readonly onOpenSettings?: (() => void) | undefined;
}

export function ClipPreview({
  clip,
  now,
  query,
  marked,
  onCopy,
  onTogglePin,
  onCompare,
  onDelete,
  onFilterCategory,
  onOpenSettings,
}: ClipPreviewProps) {
  const isImage = clip.kind === 'image';
  const [formatted, setFormatted] = useState(true);
  // The row's preview shows at once; the full text replaces it when it arrives.
  const content = useClipContent(clip.id) ?? clip.preview;

  const body = useMemo(() => {
    if (clip.kind === 'json' && formatted) {
      const parsed = parseJson(content);
      if (parsed.ok) return JSON.stringify(parsed.value, null, 2);
    }
    return content;
  }, [clip.kind, content, formatted]);

  // Rendering a multi-megabyte <pre> with highlights is slow; the full text is one Enter away.
  const truncated = body.length > PREVIEW_PANE_CHARS;
  const visible = truncated ? body.slice(0, PREVIEW_PANE_CHARS) : body;
  const regexRanges = useRegexRanges(visible, query);

  return (
    <section className="preview" aria-label="Selected clip">
      <header className="preview__header">
        <KindBadge kind={clip.kind} />
        <CategoryChips categories={clip.categories} onSelect={onFilterCategory} />
        <span className="preview__stats">
          {isImage
            ? clip.preview
            : `${compactNumber(clip.charCount)} chars · ${pluralize(clip.lineCount, 'line')}`}
        </span>
        <span className="clip-row__spacer" />
        {clip.kind === 'json' && (
          <button
            type="button"
            className="button button--ghost"
            aria-pressed={formatted}
            onClick={() => setFormatted((value) => !value)}
          >
            Formatted
          </button>
        )}
      </header>

      {isImage ? (
        <div className="preview__image">
          <ScreenshotPreview clipId={clip.id} onOpenSettings={onOpenSettings} />
        </div>
      ) : (
        <pre className="preview__body mono" tabIndex={0}>
          <Highlight text={visible} query={query} ranges={regexRanges} />
          {truncated && (
            <span className="preview__more">
              … {compactNumber(body.length - PREVIEW_PANE_CHARS)} more chars
            </span>
          )}
        </pre>
      )}

      <dl className="preview__meta">
        <dt>Source</dt>
        <dd>
          {clip.source.app ?? 'Unknown app'}
          {clip.source.exe && clip.source.exe !== clip.source.app && (
            <span className="preview__exe"> · {clip.source.exe}</span>
          )}
        </dd>
        {clip.source.url && (
          <>
            <dt>Page</dt>
            <dd>
              <a href={clip.source.url} target="_blank" rel="noreferrer" title={clip.source.url}>
                <Icon name="link" size={12} /> {clip.source.url}
              </a>
            </dd>
          </>
        )}
        <dt>Copied</dt>
        <dd title={formatTimestamp(clip.lastCopiedAt)}>
          {formatRelative(clip.lastCopiedAt, now)}
          {clip.copyCount > 1 && (
            <>
              {' '}
              · {pluralize(clip.copyCount, 'time')}, first {formatRelative(clip.firstCopiedAt, now)}
            </>
          )}
        </dd>
      </dl>

      <footer className="preview__actions">
        <button type="button" className="button button--primary" onClick={onCopy}>
          <Icon name="copy" size={14} /> Copy <Kbd>Enter</Kbd>
        </button>
        <button type="button" className="button" aria-pressed={clip.pinned} onClick={onTogglePin}>
          <Icon name="pin" size={14} /> {clip.pinned ? 'Unpin' : 'Pin'}
        </button>
        {!isImage && (
          <button type="button" className="button" aria-pressed={marked} onClick={onCompare}>
            <Icon name="compare" size={14} /> {marked ? 'Marked as A' : 'Compare'}
          </button>
        )}
        <span className="clip-row__spacer" />
        <button
          type="button"
          className="button button--danger button--icon"
          title="Delete (Del)"
          aria-label="Delete"
          onClick={onDelete}
        >
          <Icon name="trash" size={14} />
        </button>
      </footer>
    </section>
  );
}
