/** Pure helpers for the right-click menu: the clip menu's items, placement and keyboard moves. */
import type { ClipKind } from '@shared/types';

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  /** The shortcut that does the same thing, shown on the right (e.g. "Ctrl+P"). */
  readonly hint?: string;
  /** Destructive: drawn in the danger colour. */
  readonly danger?: boolean;
}

export type MenuEntry = MenuItem | { readonly separator: true };

export function isSeparator(entry: MenuEntry): entry is { readonly separator: true } {
  return 'separator' in entry;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Gap kept between the menu and the window edge. */
export const MENU_EDGE_MARGIN = 4;

/**
 * Where to put a menu of `menu` size opened at `point` so it stays inside `viewport`: at the
 * point when it fits, otherwise pushed back from the right and bottom edges. A menu larger than
 * the window sticks to the top-left margin.
 */
export function clampMenuPosition(
  point: Point,
  menu: Size,
  viewport: Size,
  margin = MENU_EDGE_MARGIN,
): Point {
  const clamp = (value: number, size: number, limit: number): number =>
    Math.max(margin, Math.min(value, limit - size - margin));
  return {
    x: clamp(point.x, menu.width, viewport.width),
    y: clamp(point.y, menu.height, viewport.height),
  };
}

export type MenuNavKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

export function isMenuNavKey(key: string): key is MenuNavKey {
  return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End';
}

/**
 * The item index a key moves to among `count` items: down/up wrap around, Home/End jump to the
 * ends. With nothing focused yet (`current` -1), down goes to the first item and up to the last.
 */
export function nextMenuIndex(count: number, current: number, key: MenuNavKey): number {
  if (count <= 0) return -1;
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp':
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
  }
}

export type ClipMenuAction = 'copy' | 'copy-text' | 'pin' | 'compare' | 'delete';

/**
 * The state of the A/B compare (Ctrl+D) for the clip the menu is for, or `null` where comparing
 * is not offered (image clips, the Screenshots tab).
 * - `mark`: nothing marked yet; the action marks this clip as A.
 * - `compare`: another clip is marked as A; the action compares it with this one.
 * - `unmark`: this clip is A; the action clears the mark.
 */
export type CompareState = 'mark' | 'compare' | 'unmark' | null;

export interface ClipMenuContext {
  readonly kind: ClipKind;
  readonly pinned: boolean;
  /** Whether the image clip has recognised text to copy. */
  readonly hasOcrText: boolean;
  readonly compare: CompareState;
}

const COMPARE_LABELS: Record<Exclude<CompareState, null>, string> = {
  mark: 'Compare',
  compare: 'Compare with A',
  unmark: 'Unmark A',
};

/** The clip menu, top to bottom; each id maps to the same handler as the matching button or key. */
export function clipMenuItems(context: ClipMenuContext): MenuEntry[] {
  const isImage = context.kind === 'image';
  const entries: MenuEntry[] = [{ id: 'copy', label: 'Copy', hint: 'Enter' }];
  if (isImage && context.hasOcrText) entries.push({ id: 'copy-text', label: 'Copy text' });
  entries.push({ id: 'pin', label: context.pinned ? 'Unpin' : 'Pin', hint: 'Ctrl+P' });
  if (!isImage && context.compare !== null) {
    entries.push({ id: 'compare', label: COMPARE_LABELS[context.compare], hint: 'Ctrl+D' });
  }
  entries.push({ separator: true }, { id: 'delete', label: 'Delete', hint: 'Del', danger: true });
  return entries;
}

/** The compare state of `clipId` given the clip currently marked as A. */
export function compareStateFor(clipId: number, markedId: number | null): CompareState {
  if (markedId === null) return 'mark';
  return markedId === clipId ? 'unmark' : 'compare';
}
