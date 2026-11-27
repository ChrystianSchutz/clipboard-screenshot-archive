import { useCallback, useRef, useState, type MouseEvent } from 'react';
import { ocrText } from '@shared/ocr';
import type { ClipSummary } from '@shared/types';
import { api } from '../../api';
import { ContextMenu } from '../../components/ContextMenu';
import {
  clipMenuItems,
  compareStateFor,
  type ClipMenuAction,
  type Point,
} from '../../components/context-menu';

/** An open clip menu: which clip and where. */
export interface ClipMenuState {
  readonly clip: ClipSummary;
  readonly position: Point;
  /** The image clip's recognised text ('' for text clips and images without text). */
  readonly ocrText: string;
}

export interface ClipMenuControls {
  readonly menu: ClipMenuState | null;
  /** Opens the menu at the mouse pointer (a `contextmenu` event on a row or tile). */
  readonly openAtPointer: (clip: ClipSummary, event: MouseEvent) => void;
  /** Opens the menu at an element (the ContextMenu key or Shift+F10 on a row or tile). */
  readonly openAtElement: (clip: ClipSummary, element: HTMLElement | null) => void;
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

  const open = useCallback((clip: ClipSummary, position: Point) => {
    const id = ++request.current;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    returnFocus.current = focused;
    void loadOcrText(clip).then((text) => {
      if (id === request.current) setMenu({ clip, position, ocrText: text });
    });
  }, []);

  const openAtPointer = useCallback(
    (clip: ClipSummary, event: MouseEvent) => {
      event.preventDefault();
      open(clip, { x: event.clientX, y: event.clientY });
    },
    [open],
  );

  const openAtElement = useCallback(
    (clip: ClipSummary, element: HTMLElement | null) => {
      const box = element?.getBoundingClientRect();
      open(clip, box ? { x: box.left + 16, y: box.top + box.height / 2 } : { x: 16, y: 16 });
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

/** The handlers the menu items call: the same ones the preview buttons and the keys use. */
export interface ClipMenuHandlers {
  readonly copy: (id: number) => unknown;
  readonly togglePin: (id: number, pinned: boolean) => unknown;
  /** The A/B compare (Ctrl+D); leave out where comparing is not offered. */
  readonly compare?: ((id: number) => unknown) | undefined;
  readonly remove: (id: number) => unknown;
}

interface ClipContextMenuProps {
  readonly controls: ClipMenuControls;
  readonly handlers: ClipMenuHandlers;
  /** The clip marked as A for comparing, if any. */
  readonly markedId?: number | null;
  readonly onNotify: (message: string) => void;
}

export function ClipContextMenu({
  controls,
  handlers,
  markedId = null,
  onNotify,
}: ClipContextMenuProps) {
  const { menu, close } = controls;
  if (!menu) return null;
  const { clip } = menu;

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
