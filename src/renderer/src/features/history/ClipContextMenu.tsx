import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { ocrText } from '@shared/ocr';
import { pluralize } from '@shared/text';
import type { ClipSummary } from '@shared/types';
import { api } from '../../api';
import { ContextMenu } from '../../components/ContextMenu';
import {
  clipMenuItems,
  compareStateFor,
  selectionMenuItems,
  type ClipMenuAction,
  type Point,
  type SelectionNoun,
} from '../../components/context-menu';
import { selectionMenuContext } from './selection-actions';

/** An open clip menu: which clip and where. */
export interface ClipMenuState {
  /** The clip the menu was opened on. */
  readonly clip: ClipSummary;
  /**
   * What the actions apply to: the multi-selection (in display order) when the menu was opened
   * inside one, otherwise just `clip`.
   */
  readonly targets: readonly ClipSummary[];
  readonly position: Point;
  /** The image clip's recognised text ('' for text clips, images without text, selections). */
  readonly ocrText: string;
}

export interface ClipMenuControls {
  readonly menu: ClipMenuState | null;
  /**
   * Opens the menu at the mouse pointer (a `contextmenu` event on a row or tile). `targets` is
   * the multi-selection the clip belongs to; leave it out for a menu on one clip.
   */
  readonly openAtPointer: (
    clip: ClipSummary,
    event: MouseEvent,
    targets?: readonly ClipSummary[],
  ) => void;
  /** Opens the menu at an element (the ContextMenu key or Shift+F10 on a row or tile). */
  readonly openAtElement: (
    clip: ClipSummary,
    element: HTMLElement | null,
    targets?: readonly ClipSummary[],
  ) => void;
  readonly close: (restoreFocus: boolean) => void;
}

/** Whether a key press asks for the context menu: the ContextMenu key or Shift+F10. */
export function isContextMenuKey(event: {
  readonly key: string;
  readonly shiftKey: boolean;
}): boolean {
  return event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
}

/**
 * State of the clip context menu shared by History and Screenshots. For an image clip it first
 * looks up the recognised text, so "Copy text" is there (or not) from the first frame.
 */
export function useClipContextMenu(): ClipMenuControls {
  const [menu, setMenu] = useState<ClipMenuState | null>(null);
  // Only the latest request opens; a slow text lookup never reopens a menu the user moved past.
  const request = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);

  const open = useCallback(
    (clip: ClipSummary, position: Point, targets: readonly ClipSummary[] = [clip]) => {
      const id = ++request.current;
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      returnFocus.current = focused;
      // A selection's "Copy text" reads the texts when it runs, so it never waits for them here.
      const text = targets.length > 1 ? Promise.resolve('') : loadOcrText(clip);
      void text.then((ocrText) => {
        if (id === request.current) setMenu({ clip, targets, position, ocrText });
      });
    },
    [],
  );

  const openAtPointer = useCallback(
    (clip: ClipSummary, event: MouseEvent, targets?: readonly ClipSummary[]) => {
      event.preventDefault();
      open(clip, { x: event.clientX, y: event.clientY }, targets);
    },
    [open],
  );

  const openAtElement = useCallback(
    (clip: ClipSummary, element: HTMLElement | null, targets?: readonly ClipSummary[]) => {
      const box = element?.getBoundingClientRect();
      open(
        clip,
        box ? { x: box.left + 16, y: box.top + box.height / 2 } : { x: 16, y: 16 },
        targets,
      );
    },
    [open],
  );

  const close = useCallback((restoreFocus: boolean) => {
    request.current++;
    const target = returnFocus.current;
    returnFocus.current = null;
    setMenu(null);
    if (restoreFocus && target?.isConnected) target.focus({ preventScroll: true });
  }, []);

  return { menu, openAtPointer, openAtElement, close };
}

async function loadOcrText(clip: ClipSummary): Promise<string> {
  if (clip.kind !== 'image') return '';
  try {
    const details = await api.screenshots.details(clip.id);
    const result = details?.text.state === 'done' ? details.text.result : null;
    return result ? ocrText(result).trim() : '';
  } catch {
    return '';
  }
}

/** The clips a selection menu shows, passed to the action picked. */
type MenuTargets = readonly ClipSummary[];

/**
 * What the menu does on a multi-selection: the same handlers the summary pane's buttons and the
 * keys use, given the clips the menu showed. The menu closes as soon as the view's selection
 * stops being exactly those clips, so an action never runs on a set other than the one shown.
 */
export interface SelectionMenuHandlers {
  readonly noun: SelectionNoun;
  readonly copy: (targets: MenuTargets) => unknown;
  /** The joined text read from the selected screenshots; leave out where it is not offered. */
  readonly copyText?: ((targets: MenuTargets) => unknown) | undefined;
  readonly togglePin: (targets: MenuTargets) => unknown;
  /** Compares two selected text clips; leave out where comparing is not offered. */
  readonly compare?: ((targets: MenuTargets) => unknown) | undefined;
  /** Asks to delete the selection (the summary pane then confirms it). */
  readonly remove: () => unknown;
}

/** The handlers the menu items call: the same ones the preview buttons and the keys use. */
export interface ClipMenuHandlers {
  readonly copy: (id: number) => unknown;
  readonly togglePin: (id: number, pinned: boolean) => unknown;
  /** The A/B compare (Ctrl+D); leave out where comparing is not offered. */
  readonly compare?: ((id: number) => unknown) | undefined;
  readonly remove: (id: number) => unknown;
  /** Actions on a multi-selection; the menu opens on one clip only without them. */
  readonly selection?: SelectionMenuHandlers | undefined;
}

interface ClipContextMenuProps {
  readonly controls: ClipMenuControls;
  readonly handlers: ClipMenuHandlers;
  /** The clip marked as A for comparing, if any. */
  readonly markedId?: number | null;
  /** The view's selected ids in display order; a selection menu closes when they change. */
  readonly selectedIds: readonly number[];
  readonly onNotify: (message: string) => void;
}

/**
 * Whether an open selection menu no longer matches the view's selection (a click elsewhere, a
 * clip deleted or filtered out by a refresh). Its label and its actions would then disagree with
 * what is selected, so it closes instead.
 */
export function isStaleSelectionMenu(
  menu: ClipMenuState | null,
  selectedIds: readonly number[],
): boolean {
  if (!menu || menu.targets.length < 2) return false;
  return (
    menu.targets.length !== selectedIds.length ||
    menu.targets.some((clip, index) => clip.id !== selectedIds[index])
  );
}

export function ClipContextMenu({
  controls,
  handlers,
  markedId = null,
  selectedIds,
  onNotify,
}: ClipContextMenuProps) {
  const { menu, close } = controls;
  const stale = isStaleSelectionMenu(menu, selectedIds);
  useEffect(() => {
    // Focus goes back where it was, so the keys keep working on the list.
    if (stale) close(true);
  }, [stale, close]);
  if (!menu || stale) return null;
  const { clip } = menu;
  const many = handlers.selection;

  if (many && menu.targets.length > 1) {
    const { targets } = menu;
    const context = selectionMenuContext(targets, {
      noun: many.noun,
      copyText: many.copyText !== undefined,
      compare: many.compare !== undefined,
    });
    const runOnSelection = (action: ClipMenuAction): unknown => {
      switch (action) {
        case 'copy':
          return many.copy(targets);
        case 'copy-text':
          return many.copyText?.(targets);
        case 'pin':
          return many.togglePin(targets);
        case 'compare':
          return many.compare?.(targets);
        case 'delete':
          return many.remove();
      }
    };
    return (
      <ContextMenu
        entries={selectionMenuItems(context)}
        position={menu.position}
        label={`Actions for ${pluralize(context.count, context.noun)}`}
        onClose={close}
        onSelect={(id) => {
          close(true);
          void runOnSelection(id as ClipMenuAction);
        }}
      />
    );
  }

  const entries = clipMenuItems({
    kind: clip.kind,
    pinned: clip.pinned,
    hasOcrText: menu.ocrText !== '',
    compare: handlers.compare ? compareStateFor(clip.id, markedId) : null,
  });

  const run = (action: ClipMenuAction): void => {
    switch (action) {
      case 'copy':
        void handlers.copy(clip.id);
        return;
      case 'copy-text':
        // What "Copy all text" in the screenshot preview does.
        api.screenshots.copyText(menu.ocrText).then(
          () => onNotify('Copied all text'),
          () => onNotify('Could not copy the text'),
        );
        return;
      case 'pin':
        void handlers.togglePin(clip.id, clip.pinned);
        return;
      case 'compare':
        void handlers.compare?.(clip.id);
        return;
      case 'delete':
        void handlers.remove(clip.id);
        return;
    }
  };

  return (
    <ContextMenu
      entries={entries}
      position={menu.position}
      label="Clip actions"
      onClose={close}
      onSelect={(id) => {
        // Focus goes back to the row first, so an action that moves it (Delete) has the last word.
        close(true);
        run(id as ClipMenuAction);
      }}
    />
  );
}
