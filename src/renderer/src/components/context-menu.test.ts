import { describe, expect, it } from 'vitest';
import type { ClipKind } from '@shared/types';
import {
  clampMenuPosition,
  clipMenuItems,
  compareStateFor,
  isSeparator,
  nextMenuIndex,
  type ClipMenuContext,
  type MenuEntry,
  type MenuItem,
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
