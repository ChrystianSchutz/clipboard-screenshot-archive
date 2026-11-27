/**
 * Selection is tracked by clip id, not by index, so it survives reloads and new clips arriving
 * at the top of the list.
 */

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

/** After deleting `removed`, select its neighbour below (or above, at the end of the list). */
export function selectionAfterRemoval(ids: readonly number[], removed: number): number | null {
  const index = ids.indexOf(removed);
  if (index === -1) return ids[0] ?? null;
  return ids[index + 1] ?? ids[index - 1] ?? null;
}

/** Keeps the selection if it still exists, otherwise selects the first row. */
export function reconcileSelection(ids: readonly number[], current: number | null): number | null {
  if (current !== null && ids.includes(current)) return current;
  return ids[0] ?? null;
}
