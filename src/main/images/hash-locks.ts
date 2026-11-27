/**
 * One mutex per image hash, shared by capture and the orphan sweep.
 *
 * A capture holds the lock of its hash from "is the file already on disk?" until its database row
 * is committed; the sweep holds it from its final "does any clip use this hash?" check until the
 * files are unlinked. So a sweep can never delete the pixels of an image that a capture is reusing
 * at that moment, and a capture never reuses a file the sweep is deleting.
 */
export class HashLocks {
  private readonly tails = new Map<string, Promise<void>>();

  /** Runs `task` once every earlier task for `hash` has finished; tasks for other hashes run freely. */
  async run<T>(hash: string, task: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(hash) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(hash, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      // The last holder cleans up, so the map holds only hashes with work in flight.
      if (this.tails.get(hash) === tail) this.tails.delete(hash);
    }
  }

  /** Whether any task holds or waits for `hash` (tests and diagnostics). */
  isLocked(hash: string): boolean {
    return this.tails.has(hash);
  }
}
