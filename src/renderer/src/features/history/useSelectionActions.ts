import { useCallback, useState } from 'react';
import { ocrText } from '@shared/ocr';
import { joinedLength, joinTexts, pluralize } from '@shared/text';
import { MAX_BATCH_IDS, MAX_COPY_TEXT_CHARS, type ClipSummary } from '@shared/types';
import { api } from '../../api';
import { selectionLabels, type SelectionNoun } from '../../components/context-menu';
import { focusAfterRemoval, type Selection } from '../../lib/selection';
import {
  batches,
  compareOrder,
  copiedMessage,
  copiedTextMessage,
  selectionMenuContext,
  textClips,
} from './selection-actions';

export interface SelectionActionsOptions {
  readonly noun: SelectionNoun;
  /** The current selection (from `useListSelection`): a pending delete belongs to it. */
  readonly selection: Selection;
  /** The selected clips in display order. */
  readonly clips: readonly ClipSummary[];
  /** Every visible id in display order, to pick the item focus moves to after a delete. */
  readonly ids: readonly number[];
  readonly onNotify: (message: string) => void;
  /** After a delete: focus (and select) this item, or nothing when the list is now empty. */
  readonly onRemoved: (next: number | null) => void;
}

/** How many screenshots' details "Copy text" reads at once. */
export const COPY_TEXT_CONCURRENCY = 6;

/**
 * The clips an action applies to. The keys and the summary pane leave it out (the current
 * selection); the context menu passes the clips it showed, so it acts on exactly those.
 */
type Targets = readonly ClipSummary[];

export interface SelectionActions {
  /** The selection is waiting for its delete to be confirmed. */
  readonly confirmingDelete: boolean;
  /** Copy (Enter): the joined text of the selected text clips. Images are skipped. */
  readonly copy: (targets?: Targets) => Promise<void>;
  /** Copy text: the joined recognised text of the selected screenshots. */
  readonly copyText: (targets?: Targets) => Promise<void>;
  /** Ctrl+P: pins all when any is unpinned, otherwise unpins all. */
  readonly togglePin: (targets?: Targets) => Promise<void>;
  /** Ctrl+D: compares exactly two text clips, the older as A. */
  readonly compare: (targets?: Targets) => Promise<void>;
  /** Del: the first press asks to confirm, the second (or the Delete button) deletes. */
  readonly requestDelete: () => Promise<void>;
  readonly cancelDelete: () => void;
}

/**
 * The actions on a multi-selection, shared by History and the Screenshots gallery. Each one is a
 * single IPC call per batch of up to `MAX_BATCH_IDS` ids (one transaction and one list reload in
 * main), and none of them touches the clips' order (Copy does not move them to the top).
 *
 * Copy is decided before any text is read: the stored lengths of the selected clips say whether
 * the joined text fits `MAX_COPY_TEXT_CHARS`, and main then joins and writes it in one call
 * (`history:copy-many`). A selection of more than `MAX_BATCH_IDS` text clips is not copied: it
 * cannot be one call, and split calls could not write one text.
 */
export function useSelectionActions({
  noun,
  selection,
  clips,
  ids,
  onNotify,
  onRemoved,
}: SelectionActionsOptions): SelectionActions {
  // The selection whose delete waits for a confirmation. Stored by identity: any change to the
  // selection (a click, an arrow key, a filter) is a new object and cancels the request.
  const [confirming, setConfirming] = useState<Selection | null>(null);
  const confirmingDelete = confirming !== null && confirming === selection && clips.length > 1;

  const copy = useCallback(
    async (targets: Targets = clips) => {
      const texts = textClips(targets);
      const skippedImages = targets.length - texts.length;
      if (texts.length === 0) {
        const note = selectionLabels(
          selectionMenuContext(targets, { noun, copyText: false, compare: false }),
        ).copyNote;
        onNotify(note ?? 'Nothing to copy');
        return;
      }
      if (joinedLength(texts.map((clip) => clip.charCount)) > MAX_COPY_TEXT_CHARS) {
        onNotify(`Too much text to copy at once. Select fewer ${noun}s.`);
        return;
      }
      if (texts.length > MAX_BATCH_IDS) {
        onNotify(`Copy takes up to ${String(MAX_BATCH_IDS)} clips at once. Select fewer.`);
        return;
      }
      try {
        // Joined and written in main without recording it as a new clip.
        const result = await api.history.copyMany(texts.map((clip) => clip.id));
        if (result.status === 'too-large') {
          onNotify(`Too much text to copy at once. Select fewer ${noun}s.`);
          return;
        }
        if (result.status === 'nothing') {
          onNotify('Nothing to copy: the selected clips are gone');
          return;
        }
        onNotify(copiedMessage(result.copied, skippedImages + result.skippedImages));
        await api.window.hide();
      } catch {
        onNotify(`Could not copy the selected ${noun}s`);
      }
    },
    [clips, noun, onNotify],
  );

  const copyText = useCallback(
    async (targets: Targets = clips) => {
      try {
        // A few lookups at a time, in order, stopping as soon as the text cannot fit.
        const texts: string[] = [];
        for (const group of batches(targets, COPY_TEXT_CONCURRENCY)) {
          const details = await Promise.all(group.map((clip) => api.screenshots.details(clip.id)));
          for (const detail of details) {
            const result = detail?.text.state === 'done' ? detail.text.result : null;
            const text = result ? ocrText(result).trim() : '';
            if (text !== '') texts.push(text);
          }
          if (joinedLength(texts.map((text) => text.length)) > MAX_COPY_TEXT_CHARS) {
            onNotify('Too much text to copy at once. Select fewer screenshots.');
            return;
          }
        }
        if (texts.length === 0) {
          onNotify('No text was found in the selected screenshots');
          return;
        }
        await api.screenshots.copyText(joinTexts(texts));
        onNotify(copiedTextMessage(texts.length, targets.length - texts.length));
      } catch {
        onNotify('Could not copy the text');
      }
    },
    [clips, onNotify],
  );

  const togglePin = useCallback(
    async (targets: Targets = clips) => {
      const pin = targets.some((clip) => !clip.pinned);
      try {
        for (const batch of batches(
          targets.map((clip) => clip.id),
          MAX_BATCH_IDS,
        )) {
          await api.history.setPinnedMany(batch, pin);
        }
        onNotify(`${pin ? 'Pinned' : 'Unpinned'} ${pluralize(targets.length, noun)}`);
      } catch {
        onNotify(`Could not ${pin ? 'pin' : 'unpin'} the selected ${noun}s`);
      }
    },
    [clips, noun, onNotify],
  );

  const compare = useCallback(
    async (targets: Targets = clips) => {
      const order = compareOrder(targets);
      if (!order) {
        onNotify('Select exactly two text clips to compare');
        return;
      }
      await api.compare.openClips(order[0], order[1]);
    },
    [clips, onNotify],
  );

  const remove = useCallback(async () => {
    const removed = clips.map((clip) => clip.id);
    setConfirming(null);
    // Focus moves first, so the list never shows a selection that is about to disappear.
    onRemoved(focusAfterRemoval(ids, new Set(removed)));
    let deleted = 0;
    try {
      for (const batch of batches(removed, MAX_BATCH_IDS)) {
        deleted += await api.history.removeMany(batch);
      }
      onNotify(`Deleted ${pluralize(deleted, noun)}`);
    } catch {
      onNotify(
        deleted > 0
          ? `Deleted ${pluralize(deleted, noun)}, then the rest failed`
          : `Could not delete the selected ${noun}s`,
      );
    }
  }, [clips, ids, noun, onNotify, onRemoved]);

  const requestDelete = useCallback(async () => {
    if (clips.length < 2) return;
    if (confirmingDelete) await remove();
    else setConfirming(selection);
  }, [clips.length, confirmingDelete, remove, selection]);

  const cancelDelete = useCallback(() => setConfirming(null), []);

  return { confirmingDelete, copy, copyText, togglePin, compare, requestDelete, cancelDelete };
}
