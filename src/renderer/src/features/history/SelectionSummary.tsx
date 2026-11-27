import { useMemo } from 'react';
import type { ClipSummary } from '@shared/types';
import { firstLine, pluralize } from '@shared/text';
import { formatRelative, formatTimestamp } from '@shared/time';
import { selectionLabels, type SelectionNoun } from '../../components/context-menu';
import { Icon } from '../../components/Icon';
import { Kbd, KindBadge } from '../../components/primitives';
import { selectionFacts, selectionMenuContext } from './selection-actions';

/** Selected items listed by name in the pane; the rest are counted. */
const LISTED_ITEMS = 6;

export interface SelectionSummaryProps {
  /** The selected clips (two or more), in display order. */
  readonly clips: readonly ClipSummary[];
  readonly noun: SelectionNoun;
  readonly now: number;
  /** The first Delete was pressed: the pane asks to confirm. */
  readonly confirmingDelete: boolean;
  readonly onCopy: () => void;
  /** "Copy text" (the gallery: joined text read from the screenshots); leave out elsewhere. */
  readonly onCopyText?: (() => void) | undefined;
  readonly onTogglePin: () => void;
  /** "Compare" (History); leave out where comparing is not offered. */
  readonly onCompare?: (() => void) | undefined;
  /** Asks to confirm, or deletes once confirming. */
  readonly onDelete: () => void;
  readonly onCancelDelete: () => void;
}

/**
 * The detail pane for a multi-selection: how many items, of which kinds, from where, and the
 * actions that apply to all of them. Deleting more than one item asks to confirm inline: no
 * native dialog, and a second Del press confirms too.
 */
export function SelectionSummary({
  clips,
  noun,
  now,
  confirmingDelete,
  onCopy,
  onCopyText,
  onTogglePin,
  onCompare,
  onDelete,
  onCancelDelete,
}: SelectionSummaryProps) {
  const facts = useMemo(() => selectionFacts(clips), [clips]);
  const labels = selectionLabels(
    selectionMenuContext(clips, {
      noun,
      copyText: onCopyText !== undefined,
      compare: onCompare !== undefined,
    }),
  );
  const shownApps = facts.apps.slice(0, 3);
  const moreApps = facts.apps.length - shownApps.length;
  const listed = clips.slice(0, LISTED_ITEMS);
  const newest = facts.newest === null ? '' : formatRelative(facts.newest, now);
  const oldest = facts.oldest === null ? '' : formatRelative(facts.oldest, now);

  return (
    <section className="preview selection-summary" aria-label="Selected clips">
      <header className="preview__header">
        <h2 className="selection-summary__title">{labels.title}</h2>
      </header>

      <div className="selection-summary__body">
        <ul className="selection-summary__kinds" aria-label="Kinds">
          {facts.kinds.map(({ kind, count }) => (
            <li key={kind}>
              <KindBadge kind={kind} />
              <span className="selection-summary__count">{count}</span>
            </li>
          ))}
        </ul>

        <ul className="selection-summary__items" aria-label={`Selected ${noun}s`}>
          {listed.map((clip) => (
            <li key={clip.id}>
              {facts.kinds.length > 1 && <KindBadge kind={clip.kind} />}
              <span className="selection-summary__item-title">
                {firstLine(clip.preview) || '(whitespace)'}
              </span>
            </li>
          ))}
          {clips.length > listed.length && (
            <li className="selection-summary__more">
              and {pluralize(clips.length - listed.length, `more ${noun}`)}
            </li>
          )}
        </ul>

        {confirmingDelete && (
          <div className="selection-summary__confirm" role="alert">
            <p className="selection-summary__question">
              <strong>{labels.confirmDelete}</strong> This cannot be undone.
            </p>
            <div className="selection-summary__confirm-actions">
              <button type="button" className="button button--danger-solid" onClick={onDelete}>
                <Icon name="trash" size={14} /> Delete
              </button>
              <button type="button" className="button" onClick={onCancelDelete}>
                Cancel
              </button>
              <span className="selection-summary__hint">
                <Kbd>Del</Kbd> again to confirm, <Kbd>Esc</Kbd> to cancel
              </span>
            </div>
          </div>
        )}
      </div>

      <dl className="preview__meta">
        <dt>Pinned</dt>
        <dd>
          {facts.pinnedCount === 0
            ? 'None'
            : `${String(facts.pinnedCount)} of ${String(facts.count)}`}
        </dd>
        <dt>Sources</dt>
        <dd>
          {shownApps.length === 0 ? 'Unknown app' : shownApps.join(', ')}
          {moreApps > 0 && (
            <span className="preview__exe"> · {pluralize(moreApps, 'more app')}</span>
          )}
        </dd>
        {facts.oldest !== null && facts.newest !== null && (
          <>
            <dt>Copied</dt>
            <dd title={`${formatTimestamp(facts.oldest)} – ${formatTimestamp(facts.newest)}`}>
              {newest}
              {oldest !== newest && <> to {oldest}</>}
            </dd>
          </>
        )}
      </dl>

      <footer className="preview__actions">
        <button
          type="button"
          className="button button--primary"
          aria-disabled={labels.copyDisabled || undefined}
          title={labels.copyNote ?? `${labels.copy} (Enter)`}
          onClick={() => {
            if (!labels.copyDisabled) onCopy();
          }}
        >
          <Icon name="copy" size={14} /> {labels.copy}
        </button>
        {onCopyText && (
          <button type="button" className="button" onClick={onCopyText}>
            <Icon name="copy" size={14} /> Copy text
          </button>
        )}
        <button
          type="button"
          className="button"
          aria-pressed={facts.pinnedCount === facts.count}
          onClick={onTogglePin}
        >
          <Icon name="pin" size={14} />{' '}
          {facts.pinnedCount === facts.count ? 'Unpin all' : 'Pin all'}
        </button>
        {onCompare && (
          <button
            type="button"
            className="button"
            aria-disabled={labels.compareNote !== null || undefined}
            title={labels.compareNote ?? 'Compare the older clip (A) with the newer one (B)'}
            onClick={() => {
              if (labels.compareNote === null) onCompare();
            }}
          >
            <Icon name="compare" size={14} /> Compare
          </button>
        )}
        <span className="clip-row__spacer" />
        <button
          type="button"
          className="button button--danger"
          aria-label={labels.delete}
          title={`${labels.delete} (Del)`}
          onClick={onDelete}
        >
          <Icon name="trash" size={14} /> Delete
        </button>
      </footer>
    </section>
  );
}

/**
 * "3 selected" in the status bar while several items are selected. The live region is always
 * rendered (empty otherwise), so screen readers announce every change of the count.
 */
export function SelectionCount({ count }: { readonly count: number }) {
  return (
    <span className="statusbar__selection" role="status">
      {count > 1 && (
        <>
          <span className="statusbar__sep" aria-hidden>
            ·
          </span>
          {count} selected
        </>
      )}
    </span>
  );
}
