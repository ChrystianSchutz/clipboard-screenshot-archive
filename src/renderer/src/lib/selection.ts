/**
 * Multi-selection for a list or grid, following the desktop conventions of Windows Explorer and
 * VS Code. Pure and framework-free: every function takes the current selection and the visible
 * ids (in display order) and returns a new selection, or the same object when nothing changed.
 *
 * Items are tracked by id, not by index, so a selection survives reloads and new items arriving
 * at the top of the list. Ranges always follow the visible, filtered order.
 */

export interface Selection {
  /** The selected ids. Their order carries no meaning: display order comes from the list. */
  readonly selected: ReadonlySet<number>;
  /** Where Shift ranges start: the last item clicked or toggled without Shift. */
  readonly anchor: number | null;
  /**
   * The item with keyboard focus (the focus ring, `aria-activedescendant`): where arrow keys
   * move from. Usually selected; after Ctrl+click turned an item off it is not.
   */
  readonly focus: number | null;
}

export const EMPTY_SELECTION: Selection = { selected: new Set(), anchor: null, focus: null };

/** What a click does, from its modifier keys (see `pointerIntent`). */
export type PointerIntent = 'replace' | 'toggle' | 'range' | 'range-add';

/** One item selected, focused and anchored (a plain click, a plain arrow key). */
export function selectOnly(id: number | null): Selection {
  return id === null ? EMPTY_SELECTION : { selected: new Set([id]), anchor: id, focus: id };
}

/**
 * Ctrl+click (Cmd+click on macOS): adds the item or takes it out, and moves the anchor and focus
 * to it. The last selected item cannot be taken out: the detail pane always has something to
 * show, as before multi-selection.
 */
export function toggleItem(selection: Selection, id: number): Selection {
  const selected = new Set(selection.selected);
  if (!selected.delete(id)) selected.add(id);
  if (selected.size === 0) return selectOnly(id);
  return { selected, anchor: id, focus: id };
}

/**
 * Shift+click, Shift+arrow: selects the visible range from the anchor to `id` and focuses `id`;
 * the anchor stays. With `additive` (Ctrl+Shift+click) the range is added to the selection
 * instead of replacing it. Without a visible anchor the range starts at the focused item, and
 * without that at `id` itself. An `id` that is not visible changes nothing.
 */
export function selectRange(
  selection: Selection,
  ids: readonly number[],
  id: number,
  additive = false,
): Selection {
  const target = ids.indexOf(id);
  if (target === -1) return selection;
  const anchor = visibleOr(selection.anchor, ids) ?? visibleOr(selection.focus, ids) ?? id;
  const start = ids.indexOf(anchor);
  const range = ids.slice(Math.min(start, target), Math.max(start, target) + 1);
  const selected = new Set(additive ? [...selection.selected, ...range] : range);
  return { selected, anchor, focus: id };
}

/** Applies a click on `id` with the given intent. */
export function applyPointer(
  selection: Selection,
  ids: readonly number[],
  id: number,
  intent: PointerIntent,
): Selection {
  switch (intent) {
    case 'replace':
      return selectOnly(id);
    case 'toggle':
      return toggleItem(selection, id);
    case 'range':
      return selectRange(selection, ids, id);
    case 'range-add':
      return selectRange(selection, ids, id, true);
  }
}

/**
 * The intent of a primary-button click from its modifiers. The toggle key is Ctrl on Windows and
 * Linux, Cmd on macOS. `null` for a macOS Ctrl+click: that is a right-click there, and the
 * context menu handles it.
 */
export function pointerIntent(
  keys: { readonly ctrlKey: boolean; readonly metaKey: boolean; readonly shiftKey: boolean },
  isMac: boolean,
): PointerIntent | null {
  if (isMac && keys.ctrlKey) return null;
  const toggle = isMac ? keys.metaKey : keys.ctrlKey || keys.metaKey;
  if (keys.shiftKey) return toggle ? 'range-add' : 'range';
  return toggle ? 'toggle' : 'replace';
}

/** Ctrl+A: every visible item. Focus and anchor stay where they are when still visible. */
export function selectAll(selection: Selection, ids: readonly number[]): Selection {
  if (ids.length === 0) return selection;
  const focus = visibleOr(selection.focus, ids) ?? ids[0] ?? null;
  const anchor = visibleOr(selection.anchor, ids) ?? focus;
  return { selected: new Set(ids), anchor, focus };
}

/**
 * Esc on a multi-selection: back to the focused item alone (or, without a visible focus, the
 * first selected one). A selection of one or none is returned unchanged.
 */
export function collapseToFocus(selection: Selection, ids: readonly number[]): Selection {
  if (selection.selected.size <= 1) return selection;
  const focus = visibleOr(selection.focus, ids) ?? selectedInOrder(selection, ids)[0] ?? null;
  return focus === null ? selection : selectOnly(focus);
}

/**
 * Fits the selection to what is visible after the list changed (a search, a filter, a reload,
 * a deletion): ids that are no longer visible are dropped for good. When nothing selected is
 * left, the focused item (if still visible) or the first one is selected, so a non-empty list
 * always has a selection, as before multi-selection. Returns the same object when nothing changed.
 */
export function reconcileSelection(selection: Selection, ids: readonly number[]): Selection {
  if (ids.length === 0) return selection.selected.size === 0 ? selection : EMPTY_SELECTION;
  const visible = new Set(ids);
  const isVisible = (id: number | null): id is number => id !== null && visible.has(id);
  const kept = new Set([...selection.selected].filter(isVisible));
  if (kept.size === 0) {
    return selectOnly(isVisible(selection.focus) ? selection.focus : (ids[0] ?? null));
  }
  const focus = isVisible(selection.focus)
    ? selection.focus
    : (ids.find((id) => kept.has(id)) ?? null);
  const anchor = isVisible(selection.anchor) ? selection.anchor : focus;
  const unchanged =
    kept.size === selection.selected.size &&
    focus === selection.focus &&
    anchor === selection.anchor;
  return unchanged ? selection : { selected: kept, anchor, focus };
}

/** The selected ids in display order. */
export function selectedInOrder(selection: Selection, ids: readonly number[]): number[] {
  return ids.filter((id) => selection.selected.has(id));
}

export function isMultiSelection(selection: Selection): boolean {
  return selection.selected.size > 1;
}

/** The id `delta` rows away from `current`, clamped to the list. Falls back to the first row. */
export function moveSelection(
  ids: readonly number[],
  current: number | null,
  delta: number,
): number | null {
  if (ids.length === 0) return null;
  const index = current === null ? -1 : ids.indexOf(current);
  if (index === -1) return ids[0] ?? null;
  const next = Math.min(Math.max(index + delta, 0), ids.length - 1);
  return ids[next] ?? null;
}

/**
 * Where focus goes after deleting `removed`: the first remaining item below the first deleted
 * one (the item that moves up into its place), or, at the end of the list, the nearest one above.
 */
export function focusAfterRemoval(
  ids: readonly number[],
  removed: ReadonlySet<number>,
): number | null {
  const first = ids.findIndex((id) => removed.has(id));
  if (first === -1) return ids.find((id) => !removed.has(id)) ?? null;
  for (let index = first + 1; index < ids.length; index++) {
    const id = ids[index];
    if (id !== undefined && !removed.has(id)) return id;
  }
  for (let index = first - 1; index >= 0; index--) {
    const id = ids[index];
    if (id !== undefined && !removed.has(id)) return id;
  }
  return null;
}

function visibleOr(id: number | null, ids: readonly number[]): number | null {
  return id !== null && ids.includes(id) ? id : null;
}

/** Whether the renderer runs on macOS, where Cmd (not Ctrl) is the selection toggle key. */
export function isMacPlatform(userAgent: string = globalThis.navigator.userAgent): boolean {
  return /Macintosh|Mac OS X/.test(userAgent);
}
