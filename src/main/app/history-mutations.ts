import type { ClipRepository } from '../storage/clip-repository';
import type { InvokeHandlers } from '../ipc/register';

export interface HistoryMutationDeps {
  readonly repository: Pick<ClipRepository, 'delete' | 'setPinnedMany'>;
  /** The screenshots side of a delete (see `Screenshots.forgetImages`). */
  readonly images: {
    /** The image hashes of these clips, read before they are deleted. */
    hashesOf(clipIds: readonly number[]): string[];
    /** Withdraws the queued work of the images no clip uses any more. */
    forget(hashes: readonly string[]): void;
  };
  /**
   * Schedules the orphan sweep that removes image files no clip uses any more. Debounced by
   * `Screenshots`, so a batch sweeps once.
   */
  readonly scheduleSweep: () => void;
  /** Tells every window that the history changed (`history:changed`). */
  readonly announce: () => void;
}

type MutationChannel =
  'history:delete' | 'history:delete-many' | 'history:set-pinned' | 'history:set-pinned-many';

/**
 * The IPC handlers that delete or pin clips, one or a whole multi-selection.
 *
 * Every call is one repository transaction and at most one `history:changed` broadcast, however
 * many clips it touches, so a batch of 500 reloads the list once instead of 500 times. For deleted
 * screenshots, the text recognition and analysis still queued (or running) are withdrawn, so the
 * workers neither read files about to be swept nor keep new screenshots waiting; their rows go
 * with the clip, and the sweep scheduled below removes their files.
 */
export function historyMutationHandlers(
  deps: HistoryMutationDeps,
): Pick<InvokeHandlers, MutationChannel> {
  const remove = (ids: readonly number[]): number => {
    const hashes = deps.images.hashesOf(ids);
    const removed = deps.repository.delete(ids);
    if (removed > 0) {
      if (hashes.length > 0) deps.images.forget(hashes);
      deps.scheduleSweep();
      deps.announce();
    }
    return removed;
  };
  const setPinned = (ids: readonly number[], pinned: boolean): number => {
    const matched = deps.repository.setPinnedMany(ids, pinned);
    if (matched > 0) deps.announce();
    return matched;
  };

  return {
    'history:delete': (id) => remove([id]),
    'history:delete-many': (ids) => remove(ids),
    'history:set-pinned': (id, pinned) => {
      setPinned([id], pinned);
    },
    'history:set-pinned-many': (ids, pinned) => setPinned(ids, pinned),
  };
}
