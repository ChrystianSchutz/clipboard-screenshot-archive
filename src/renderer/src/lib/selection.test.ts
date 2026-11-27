import { describe, expect, it } from 'vitest';
import {
  EMPTY_SELECTION,
  applyPointer,
  collapseToFocus,
  focusAfterRemoval,
  isMacPlatform,
  isMultiSelection,
  moveSelection,
  pointerIntent,
  reconcileSelection,
  selectAll,
  selectOnly,
  selectRange,
  selectedInOrder,
  toggleItem,
  type Selection,
} from './selection';

/** Display order: newest first, as the history shows it. */
const IDS = [50, 40, 30, 20, 10];

function sel(selected: readonly number[], anchor: number | null, focus: number | null): Selection {
  return { selected: new Set(selected), anchor, focus };
}

/** A selection as plain data, selected ids sorted, for readable assertions. */
function plain(selection: Selection) {
  return {
    selected: [...selection.selected].sort((a, b) => b - a),
    anchor: selection.anchor,
    focus: selection.focus,
  };
}

describe('selectOnly', () => {
  it('selects, anchors and focuses one item', () => {
    expect(plain(selectOnly(30))).toEqual({ selected: [30], anchor: 30, focus: 30 });
  });

  it('is the empty selection for null', () => {
    expect(selectOnly(null)).toBe(EMPTY_SELECTION);
  });
});

describe('toggleItem (Ctrl+click)', () => {
  it('adds an item and moves the anchor and focus to it', () => {
    expect(plain(toggleItem(selectOnly(50), 30))).toEqual({
      selected: [50, 30],
      anchor: 30,
      focus: 30,
    });
  });

  it('takes a selected item out, keeping focus on it', () => {
    expect(plain(toggleItem(sel([50, 30], 50, 50), 30))).toEqual({
      selected: [50],
      anchor: 30,
      focus: 30,
    });
  });

  it('never takes out the last selected item', () => {
    expect(plain(toggleItem(selectOnly(30), 30))).toEqual({
      selected: [30],
      anchor: 30,
      focus: 30,
    });
  });

  it('does not change the selection it was given', () => {
    const before = sel([50], 50, 50);
    toggleItem(before, 40);
    expect(plain(before)).toEqual({ selected: [50], anchor: 50, focus: 50 });
  });
});

describe('selectRange (Shift+click, Shift+arrow)', () => {
  it('selects from the anchor down to the target, in either direction', () => {
    expect(plain(selectRange(selectOnly(40), IDS, 20))).toEqual({
      selected: [40, 30, 20],
      anchor: 40,
      focus: 20,
    });
    expect(plain(selectRange(selectOnly(20), IDS, 50))).toEqual({
      selected: [50, 40, 30, 20],
      anchor: 20,
      focus: 50,
    });
  });

  it('replaces the previous range: the anchor stays, so the range can shrink', () => {
    const wide = selectRange(selectOnly(50), IDS, 10);
    expect(plain(selectRange(wide, IDS, 40))).toEqual({
      selected: [50, 40],
      anchor: 50,
      focus: 40,
    });
  });

  it('replaces Ctrl-picked items too (plain Shift+click)', () => {
    const picked = toggleItem(toggleItem(selectOnly(50), 10), 30);
    expect(plain(selectRange(picked, IDS, 20))).toEqual({
      selected: [30, 20],
      anchor: 30,
      focus: 20,
    });
  });

  it('adds the range to the selection with Ctrl+Shift', () => {
    const picked = toggleItem(selectOnly(50), 30);
    expect(plain(selectRange(picked, IDS, 10, true))).toEqual({
      selected: [50, 30, 20, 10],
      anchor: 30,
      focus: 10,
    });
  });

  it('is a single item when the target is the anchor', () => {
    expect(plain(selectRange(selectOnly(30), IDS, 30))).toEqual({
      selected: [30],
      anchor: 30,
      focus: 30,
    });
  });

  it('starts at the focused item when the anchor is gone, and at the target without either', () => {
    expect(plain(selectRange(sel([40], 99, 40), IDS, 20))).toEqual({
      selected: [40, 30, 20],
      anchor: 40,
      focus: 20,
    });
    expect(plain(selectRange(EMPTY_SELECTION, IDS, 20))).toEqual({
      selected: [20],
      anchor: 20,
      focus: 20,
    });
  });

  it('follows the visible order: a filtered list ranges over what is shown only', () => {
    const filtered = [50, 30, 10]; // 40 and 20 are filtered out
    expect(plain(selectRange(selectOnly(50), filtered, 10))).toEqual({
      selected: [50, 30, 10],
      anchor: 50,
      focus: 10,
    });
  });

  it('changes nothing for a target that is not visible', () => {
    const before = selectOnly(50);
    expect(selectRange(before, IDS, 999)).toBe(before);
  });
});

describe('pointerIntent', () => {
  const keys = (ctrlKey: boolean, metaKey: boolean, shiftKey: boolean) => ({
    ctrlKey,
    metaKey,
    shiftKey,
  });

  it('maps the modifiers on Windows and Linux (Ctrl toggles)', () => {
    expect(pointerIntent(keys(false, false, false), false)).toBe('replace');
    expect(pointerIntent(keys(true, false, false), false)).toBe('toggle');
    expect(pointerIntent(keys(false, false, true), false)).toBe('range');
    expect(pointerIntent(keys(true, false, true), false)).toBe('range-add');
  });

  it('uses Cmd on macOS, where Ctrl+click is a right-click', () => {
    expect(pointerIntent(keys(false, true, false), true)).toBe('toggle');
    expect(pointerIntent(keys(false, true, true), true)).toBe('range-add');
    expect(pointerIntent(keys(false, false, true), true)).toBe('range');
    // Ctrl+click is a right-click on macOS: the context menu takes it, not the selection.
    expect(pointerIntent(keys(true, false, false), true)).toBeNull();
    expect(pointerIntent(keys(true, false, true), true)).toBeNull();
  });
});

describe('isMacPlatform', () => {
  it('recognises macOS user agents only', () => {
    expect(isMacPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_1) Electron/45.5.0')).toBe(
      true,
    );
    expect(isMacPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/45.5.0')).toBe(false);
    expect(isMacPlatform('Mozilla/5.0 (X11; Linux x86_64) Electron/45.5.0')).toBe(false);
  });
});

describe('applyPointer', () => {
  it('dispatches each intent', () => {
    const start = selectOnly(50);
    expect(plain(applyPointer(start, IDS, 30, 'replace')).selected).toEqual([30]);
    expect(plain(applyPointer(start, IDS, 30, 'toggle')).selected).toEqual([50, 30]);
    expect(plain(applyPointer(start, IDS, 30, 'range')).selected).toEqual([50, 40, 30]);
    const picked = toggleItem(start, 10);
    expect(plain(applyPointer(picked, IDS, 30, 'range-add')).selected).toEqual([50, 30, 20, 10]);
  });
});

describe('selectAll (Ctrl+A)', () => {
  it('selects every visible item and keeps focus and anchor', () => {
    expect(plain(selectAll(sel([30], 40, 30), IDS))).toEqual({
      selected: IDS,
      anchor: 40,
      focus: 30,
    });
  });

  it('focuses the first item when nothing was focused', () => {
    expect(plain(selectAll(EMPTY_SELECTION, IDS))).toEqual({
      selected: IDS,
      anchor: 50,
      focus: 50,
    });
  });

  it('changes nothing in an empty list', () => {
    const before = selectOnly(30);
    expect(selectAll(before, [])).toBe(before);
  });
});

describe('collapseToFocus (Esc)', () => {
  it('goes back to the focused item alone', () => {
    expect(plain(collapseToFocus(sel([50, 40, 30], 50, 40), IDS))).toEqual({
      selected: [40],
      anchor: 40,
      focus: 40,
    });
  });

  it('keeps the focused item even when Ctrl+click had turned it off', () => {
    expect(plain(collapseToFocus(sel([50, 10], 30, 30), IDS)).selected).toEqual([30]);
  });

  it('uses the first selected item when the focus is not visible', () => {
    expect(plain(collapseToFocus(sel([30, 10], 99, 99), IDS)).selected).toEqual([30]);
  });

  it('returns a single selection unchanged', () => {
    const one = selectOnly(30);
    expect(collapseToFocus(one, IDS)).toBe(one);
    expect(collapseToFocus(EMPTY_SELECTION, IDS)).toBe(EMPTY_SELECTION);
  });
});

describe('reconcileSelection (the list changed)', () => {
  it('returns the same object when everything is still visible', () => {
    const before = sel([50, 30], 50, 30);
    expect(reconcileSelection(before, IDS)).toBe(before);
    expect(reconcileSelection(before, [60, ...IDS])).toBe(before); // a new clip on top
  });

  it('drops items a filter hid, keeping focus and anchor when they stay', () => {
    expect(plain(reconcileSelection(sel([50, 40, 30], 50, 30), [50, 30, 10]))).toEqual({
      selected: [50, 30],
      anchor: 50,
      focus: 30,
    });
  });

  it('moves a hidden focus to the first remaining selected item and a hidden anchor to the focus', () => {
    expect(plain(reconcileSelection(sel([50, 40, 20], 50, 40), [40, 30, 20]))).toEqual({
      selected: [40, 20],
      anchor: 40,
      focus: 40,
    });
    expect(plain(reconcileSelection(sel([40, 20], 50, 20), [40, 30, 20]))).toEqual({
      selected: [40, 20],
      anchor: 20,
      focus: 20,
    });
  });

  it('drops hidden items for good: clearing the filter does not bring them back', () => {
    const filtered = reconcileSelection(sel([50, 40, 30], 50, 50), [50, 10]);
    expect(plain(reconcileSelection(filtered, IDS)).selected).toEqual([50]);
  });

  it('selects the focused item, or else the first one, when nothing selected is left', () => {
    expect(plain(reconcileSelection(sel([40], 40, 20), [30, 20, 10]))).toEqual({
      selected: [20],
      anchor: 20,
      focus: 20,
    });
    expect(plain(reconcileSelection(sel([40], 40, 40), [30, 20]))).toEqual({
      selected: [30],
      anchor: 30,
      focus: 30,
    });
  });

  it('selects the first item of a list that just loaded', () => {
    expect(plain(reconcileSelection(EMPTY_SELECTION, IDS)).selected).toEqual([50]);
  });

  it('is empty for an empty list', () => {
    expect(reconcileSelection(sel([50], 50, 50), [])).toBe(EMPTY_SELECTION);
    expect(reconcileSelection(EMPTY_SELECTION, [])).toBe(EMPTY_SELECTION);
  });

  it('tolerates duplicate ids in the list', () => {
    const before = sel([30], 30, 30);
    expect(reconcileSelection(before, [30, 30, 20])).toBe(before);
    expect(plain(selectRange(before, [30, 30, 20], 20)).selected).toEqual([30, 20]);
  });
});

describe('selectedInOrder', () => {
  it('lists the selected ids in display order, whatever order they were picked in', () => {
    const picked = toggleItem(toggleItem(selectOnly(10), 50), 30);
    expect(selectedInOrder(picked, IDS)).toEqual([50, 30, 10]);
  });

  it('leaves out ids that are not visible', () => {
    expect(selectedInOrder(sel([50, 99], 50, 50), IDS)).toEqual([50]);
  });
});

describe('isMultiSelection', () => {
  it('is true from two selected items on', () => {
    expect(isMultiSelection(EMPTY_SELECTION)).toBe(false);
    expect(isMultiSelection(selectOnly(1))).toBe(false);
    expect(isMultiSelection(sel([1, 2], 1, 2))).toBe(true);
  });
});

describe('moveSelection', () => {
  it('moves by delta and clamps to the ends', () => {
    expect(moveSelection(IDS, 40, 1)).toBe(30);
    expect(moveSelection(IDS, 40, -8)).toBe(50);
    expect(moveSelection(IDS, 20, 8)).toBe(10);
  });

  it('falls back to the first item, and to null in an empty list', () => {
    expect(moveSelection(IDS, null, 1)).toBe(50);
    expect(moveSelection(IDS, 999, 1)).toBe(50);
    expect(moveSelection([], 50, 1)).toBeNull();
  });
});

describe('focusAfterRemoval', () => {
  it('picks the item that moves up into the first deleted row', () => {
    expect(focusAfterRemoval(IDS, new Set([40]))).toBe(30);
    expect(focusAfterRemoval(IDS, new Set([40, 30]))).toBe(20);
    expect(focusAfterRemoval(IDS, new Set([40, 20]))).toBe(30);
  });

  it('picks the nearest item above when the deletion reaches the end', () => {
    expect(focusAfterRemoval(IDS, new Set([20, 10]))).toBe(30);
    expect(focusAfterRemoval(IDS, new Set([10]))).toBe(20);
  });

  it('is null when everything is deleted, or the list is empty', () => {
    expect(focusAfterRemoval(IDS, new Set(IDS))).toBeNull();
    expect(focusAfterRemoval([], new Set([1]))).toBeNull();
  });

  it('falls back to the first item when none of the deleted ids is visible', () => {
    expect(focusAfterRemoval(IDS, new Set([999]))).toBe(50);
  });
});
