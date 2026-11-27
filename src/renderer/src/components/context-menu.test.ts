import { describe, expect, it } from 'vitest';
import type { ClipKind } from '@shared/types';
import {
  clampMenuPosition,
  clipMenuItems,
  compareStateFor,
  isSeparator,
  nextMenuIndex,
  selectionLabels,
  selectionMenuItems,
  type ClipMenuContext,
  type MenuEntry,
  type MenuItem,
  type SelectionMenuContext,
} from './context-menu';

const TEXT_KINDS: readonly ClipKind[] = ['text', 'json', 'url', 'code'];

function context(overrides: Partial<ClipMenuContext> = {}): ClipMenuContext {
  return { kind: 'text', pinned: false, hasOcrText: false, compare: 'mark', ...overrides };
}

/** The menu as a compact list: item labels, `---` for a separator. */
function labels(entries: readonly MenuEntry[]): string[] {
  return entries.map((entry) => (isSeparator(entry) ? '---' : entry.label));
}

describe('clipMenuItems', () => {
  it.each(TEXT_KINDS)('offers copy, pin, compare and delete for a %s clip', (kind) => {
    expect(labels(clipMenuItems(context({ kind })))).toEqual([
      'Copy',
      'Pin',
      'Compare',
      '---',
      'Delete',
    ]);
  });

  it('offers copy text for an image with recognised text, and never compare', () => {
    expect(labels(clipMenuItems(context({ kind: 'image', hasOcrText: true })))).toEqual([
      'Copy',
      'Copy text',
      'Pin',
      '---',
      'Delete',
    ]);
  });

  it('leaves copy text out for an image without text, and for text clips', () => {
    expect(labels(clipMenuItems(context({ kind: 'image', hasOcrText: false })))).toEqual([
      'Copy',
      'Pin',
      '---',
      'Delete',
    ]);
    // A text clip never offers it, even if asked.
    expect(labels(clipMenuItems(context({ kind: 'text', hasOcrText: true })))).not.toContain(
      'Copy text',
    );
  });

  it('says Unpin for a pinned clip', () => {
    expect(labels(clipMenuItems(context({ pinned: true })))).toContain('Unpin');
    expect(labels(clipMenuItems(context({ pinned: true })))).not.toContain('Pin');
  });

  it('names the compare step after the A/B state, and drops it where comparing is off', () => {
    expect(labels(clipMenuItems(context({ compare: 'compare' })))).toContain('Compare with A');
    expect(labels(clipMenuItems(context({ compare: 'unmark' })))).toContain('Unmark A');
    expect(labels(clipMenuItems(context({ compare: null })))).toEqual([
      'Copy',
      'Pin',
      '---',
      'Delete',
    ]);
  });

  it('shows the matching shortcut on each item and draws only Delete as dangerous', () => {
    const items = clipMenuItems(context()).filter(
      (entry): entry is MenuItem => !isSeparator(entry),
    );
    expect(items.map((item) => [item.id, item.hint ?? null, item.danger ?? false])).toEqual([
      ['copy', 'Enter', false],
      ['pin', 'Ctrl+P', false],
      ['compare', 'Ctrl+D', false],
      ['delete', 'Del', true],
    ]);
  });
});

describe('compareStateFor', () => {
  it('marks when nothing is marked, unmarks the marked clip and compares any other clip', () => {
    expect(compareStateFor(7, null)).toBe('mark');
    expect(compareStateFor(7, 7)).toBe('unmark');
    expect(compareStateFor(7, 3)).toBe('compare');
  });
});

describe('clampMenuPosition', () => {
  const viewport = { width: 800, height: 600 };
  const menu = { width: 200, height: 150 };

  it('opens at the point when the menu fits', () => {
    expect(clampMenuPosition({ x: 100, y: 120 }, menu, viewport)).toEqual({ x: 100, y: 120 });
  });

  it('moves left and up to stay inside the right and bottom edges', () => {
    expect(clampMenuPosition({ x: 750, y: 580 }, menu, viewport)).toEqual({ x: 596, y: 446 });
  });

  it('keeps a margin from the top-left edges', () => {
    expect(clampMenuPosition({ x: -20, y: 1 }, menu, viewport)).toEqual({ x: 4, y: 4 });
  });

  it('pins a menu larger than the window to the top-left margin', () => {
    expect(clampMenuPosition({ x: 50, y: 50 }, { width: 900, height: 700 }, viewport)).toEqual({
      x: 4,
      y: 4,
    });
  });

  it('honours a custom margin', () => {
    expect(clampMenuPosition({ x: 790, y: 10 }, menu, viewport, 10)).toEqual({ x: 590, y: 10 });
  });
});

describe('nextMenuIndex', () => {
  it('moves down and up, wrapping at the ends', () => {
    expect(nextMenuIndex(4, 0, 'ArrowDown')).toBe(1);
    expect(nextMenuIndex(4, 3, 'ArrowDown')).toBe(0);
    expect(nextMenuIndex(4, 2, 'ArrowUp')).toBe(1);
    expect(nextMenuIndex(4, 0, 'ArrowUp')).toBe(3);
  });

  it('jumps to the ends with Home and End', () => {
    expect(nextMenuIndex(4, 2, 'Home')).toBe(0);
    expect(nextMenuIndex(4, 1, 'End')).toBe(3);
  });

  it('starts at the first item going down and the last going up when nothing is focused', () => {
    expect(nextMenuIndex(4, -1, 'ArrowDown')).toBe(0);
    expect(nextMenuIndex(4, -1, 'ArrowUp')).toBe(3);
  });

  it('has nowhere to go in an empty menu', () => {
    expect(nextMenuIndex(0, -1, 'ArrowDown')).toBe(-1);
  });
});

describe('selectionMenuItems (right-click inside a multi-selection)', () => {
  const context = (overrides: Partial<SelectionMenuContext> = {}): SelectionMenuContext => ({
    noun: 'clip',
    count: 3,
    textCount: 3,
    allPinned: false,
    copyText: false,
    compare: false,
    ...overrides,
  });
  const items = (overrides: Partial<SelectionMenuContext> = {}) =>
    selectionMenuItems(context(overrides)).filter(
      (entry): entry is MenuItem => !isSeparator(entry),
    );

  it('puts the counts in the labels and keeps the single-clip shortcuts', () => {
    expect(items().map((item) => [item.id, item.label, item.hint])).toEqual([
      ['copy', 'Copy 3 clips', 'Enter'],
      ['pin', 'Pin 3 clips', 'Ctrl+P'],
      ['delete', 'Delete 3 clips', 'Del'],
    ]);
    expect(items().find((item) => item.id === 'delete')?.danger).toBe(true);
    expect(selectionMenuItems(context()).filter(isSeparator)).toHaveLength(1);
  });

  it('counts only the text clips Copy joins, and says what it skips', () => {
    const copy = items({ count: 4, textCount: 3 })[0];
    expect(copy?.label).toBe('Copy 3 clips');
    expect(copy?.title).toBe('1 image will be skipped');
    expect(copy?.disabled).toBeUndefined();
  });

  it('unpins when every selected item is pinned', () => {
    expect(items({ allPinned: true }).find((item) => item.id === 'pin')?.label).toBe(
      'Unpin 3 clips',
    );
  });

  it('offers Compare only for exactly two text clips', () => {
    expect(items({ count: 2, textCount: 2, compare: true }).map((item) => item.id)).toEqual([
      'copy',
      'pin',
      'compare',
      'delete',
    ]);
    expect(items({ compare: false }).some((item) => item.id === 'compare')).toBe(false);
    expect(items({ compare: null }).some((item) => item.id === 'compare')).toBe(false);
  });

  it('disables Copy of several screenshots, explains why, and offers Copy text instead', () => {
    const shots = items({
      noun: 'screenshot',
      count: 2,
      textCount: 0,
      copyText: true,
      compare: null,
    });
    expect(shots.map((item) => [item.id, item.label])).toEqual([
      ['copy', 'Copy'],
      ['copy-text', 'Copy text of 2 screenshots'],
      ['pin', 'Pin 2 screenshots'],
      ['delete', 'Delete 2 screenshots'],
    ]);
    expect(shots[0]?.disabled).toBe(true);
    expect(shots[0]?.title).toBe('Several images cannot be copied at once. Use Copy text.');
    expect(shots[0]?.hint).toBeUndefined();
  });
});

describe('selectionLabels', () => {
  it('words the summary pane title, the confirmation and the compare note', () => {
    const labels = selectionLabels({
      noun: 'clip',
      count: 5,
      textCount: 5,
      allPinned: false,
      copyText: false,
      compare: false,
    });
    expect(labels.title).toBe('5 clips selected');
    expect(labels.confirmDelete).toBe('Delete 5 clips?');
    expect(labels.compareNote).toBe('Select exactly two text clips to compare');
    expect(labels.copyNote).toBeNull();
  });

  it('explains that images alone cannot be joined in History', () => {
    const labels = selectionLabels({
      noun: 'clip',
      count: 2,
      textCount: 0,
      allPinned: false,
      copyText: false,
      compare: false,
    });
    expect(labels.copyDisabled).toBe(true);
    expect(labels.copyNote).toBe('Images cannot be joined into text. Select text clips.');
  });
});
