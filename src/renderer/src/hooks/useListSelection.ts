import { useCallback, useMemo, useState } from 'react';
import {
  EMPTY_SELECTION,
  reconcileSelection,
  selectOnly,
  selectedInOrder,
  type Selection,
} from '../lib/selection';

export interface ListSelection {
  /** The selection, always fitted to the visible ids. */
  readonly selection: Selection;
  /** The selected ids in display order. */
  readonly selectedIds: readonly number[];
  /**
   * Replaces the selection with what `next` makes of the current one and the visible ids. Stable
   * for the life of the component, so rows can be memoised on it.
   */
  readonly update: (next: (current: Selection, ids: readonly number[]) => Selection) => void;
}

interface State {
  /** What the user picked; ignored while `chosen` is false. */
  readonly selection: Selection;
  /**
   * False until the user picks something, and again once everything they picked is gone. Until
   * then the first item is selected, and that follows new items arriving at the top.
   */
  readonly chosen: boolean;
  /** The ids `selection` was last fitted to. */
  readonly ids: readonly number[];
}

function sameIds(a: readonly number[], b: readonly number[]): boolean {
  return a === b || (a.length === b.length && a.every((id, index) => id === b[index]));
}

/** The selection as shown: the user's pick fitted to the ids, or else the first item. */
function shownSelection(state: State, ids: readonly number[]): Selection {
  if (state.chosen) return reconcileSelection(state.selection, ids);
  const first = ids[0];
  return first === undefined ? EMPTY_SELECTION : selectOnly(first);
}

/** Fits the stored pick to new ids, dropping what is no longer visible. */
function fitToIds(state: State, ids: readonly number[]): State {
  const visible = new Set(ids);
  const chosen = state.chosen && [...state.selection.selected].some((id) => visible.has(id));
  return {
    ids,
    chosen,
    selection: chosen ? reconcileSelection(state.selection, ids) : EMPTY_SELECTION,
  };
}

/**
 * Multi-selection state for a list or grid whose items can change under it (search, filters,
 * reloads, deletions). Whenever the visible ids change, items that are no longer visible are
 * dropped from the stored selection for good (see `reconcileSelection`), so clearing a filter
 * never brings back a selection the user could not see. Ids are compared by value, so a caller
 * that rebuilds an equal array on every render costs a comparison, not a render loop.
 */
export function useListSelection(ids: readonly number[]): ListSelection {
  const [state, setState] = useState<State>({ selection: EMPTY_SELECTION, chosen: false, ids });
  // Adjusting state while rendering when an input changed (React's documented pattern): the
  // render is redone at once with the fitted selection, before anything is painted.
  if (!sameIds(state.ids, ids)) {
    setState((current) => fitToIds(current, ids));
  }

  const selection = useMemo(() => shownSelection(state, state.ids), [state]);
  const selectedIds = useMemo(() => selectedInOrder(selection, state.ids), [selection, state.ids]);
  const update = useCallback((next: (current: Selection, ids: readonly number[]) => Selection) => {
    setState((current) => {
      const shown = shownSelection(current, current.ids);
      const selection = next(shown, current.ids);
      return selection === shown ? current : { ...current, selection, chosen: true };
    });
  }, []);

  return { selection, selectedIds, update };
}
