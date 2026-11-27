/**
 * The capture generation: one counter that pause, resume and shutdown move on.
 *
 * Every capture (a clipboard change, a file from the macOS screenshot folder) takes the generation
 * when it is first seen (a clipboard change when it is reported, a folder file when the watcher
 * first notices it, before it has finished writing) and checks it again at its final record
 * boundary, right before the database insert. Work that was in flight when the user paused (a
 * privacy retry, a file still settling, a file save, a slow image read) therefore never commits,
 * even if capture is switched back on before it finishes.
 *
 * Shutdown closes the gate for good: no generation is ever current again, so a poll or a settle
 * that resolves after `stop()` (when the database is already closed) can never commit.
 */
export class CaptureGate {
  private generation = 0;
  private closed = false;

  /** The current generation; a capture keeps the value it saw when it was first seen. */
  get current(): number {
    return this.generation;
  }

  /** Pause or resume: everything taken before this call is dropped unrecorded. */
  invalidate(): void {
    this.generation++;
  }

  /** Shutdown: everything taken before or after this call is dropped unrecorded, for good. */
  close(): void {
    this.closed = true;
    this.generation++;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Whether a capture taken at `generation` may still commit (nothing invalidated it since). */
  isCurrent(generation: number): boolean {
    return !this.closed && generation === this.generation;
  }
}
