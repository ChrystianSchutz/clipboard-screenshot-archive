export interface KeyedJob<Input> {
  /** Identity of the work, e.g. the image's sha256: one image is processed once, however often it is copied. */
  readonly key: string;
  /** Produces the input only when the job runs, so queued jobs hold no pixels. */
  readonly load: () => Promise<Input>;
}

export interface KeyedQueueDeps<Input, Output> {
  readonly run: (input: Input) => Promise<Output>;
  readonly onResult: (key: string, output: Output) => void;
  readonly onFailure: (key: string, error: Error) => void;
  /** `onResult` or `onFailure` threw (reported to the error log in production). */
  readonly onCallbackError?: (key: string, error: Error) => void;
}

/**
 * Runs jobs one at a time, in arrival order (text recognition and image analysis each have one).
 *
 * One at a time on purpose: this is background work on a desktop someone is using, so it may take
 * one core, not all of them. Enqueueing a key that is already queued or running is a no-op, which
 * makes "re-queue everything still pending" at startup safe to call.
 *
 * `clear()` drops every waiting job and disowns the running one: its result or failure is thrown
 * away when it arrives (it belongs to a request that was cancelled, e.g. the feature was switched
 * off), and its key may be queued again at once.
 */
export class KeyedQueue<Input, Output> {
  private readonly waiting: KeyedJob<Input>[] = [];
  private readonly known = new Set<string>();
  /** The job being run, while its result is still wanted. */
  private current: { readonly key: string } | null = null;
  private running: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly deps: KeyedQueueDeps<Input, Output>) {}

  enqueue(job: KeyedJob<Input>): boolean {
    if (this.disposed || this.known.has(job.key) || this.current?.key === job.key) return false;
    this.known.add(job.key);
    this.waiting.push(job);
    this.running ??= this.drain();
    return true;
  }

  /** Drops the waiting jobs and the result of the running one. Returns the dropped keys. */
  clear(): string[] {
    const dropped = [...this.waiting.map((job) => job.key)];
    if (this.current) dropped.unshift(this.current.key);
    this.waiting.length = 0;
    this.known.clear();
    this.current = null;
    return dropped;
  }

  /**
   * Drops the waiting jobs whose key matches and disowns the running one if it matches (its result
   * is thrown away like after `clear()`). Other jobs keep their place. Returns the dropped keys.
   */
  withdraw(match: (key: string) => boolean): string[] {
    const dropped: string[] = [];
    if (this.current && match(this.current.key)) {
      dropped.push(this.current.key);
      this.current = null;
    }
    for (let index = this.waiting.length - 1; index >= 0; index--) {
      const job = this.waiting[index];
      if (!job || !match(job.key)) continue;
      this.waiting.splice(index, 1);
      this.known.delete(job.key);
      dropped.push(job.key);
    }
    return dropped;
  }

  /** Shutdown: drops everything like `clear()` and refuses every later job. */
  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  /** Jobs not finished yet (queued or running). */
  get size(): number {
    return this.known.size + (this.current ? 1 : 0);
  }

  has(key: string): boolean {
    return this.known.has(key) || this.current?.key === key;
  }

  /** Resolves when the queue is empty (tests, and a clean shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async drain(): Promise<void> {
    for (let job = this.waiting.shift(); job; job = this.waiting.shift()) {
      this.known.delete(job.key);
      const current = { key: job.key };
      this.current = current;
      let outcome: { ok: true; output: Output } | { ok: false; error: Error };
      try {
        const input = await job.load();
        // Cleared (or disposed) while its input loaded: never start the work, so no worker is
        // spawned for a request nobody wants any more.
        if (this.current !== current) continue;
        outcome = { ok: true, output: await this.deps.run(input) };
      } catch (error) {
        outcome = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
      }
      // Cleared while it ran: nobody wants this answer any more.
      if (this.current !== current) continue;
      this.current = null;
      // A throwing callback is the caller's bug; it must not stop the queue or report a success
      // as a failure, so it is reported on its own.
      try {
        if (outcome.ok) this.deps.onResult(job.key, outcome.output);
        else this.deps.onFailure(job.key, outcome.error);
      } catch (error) {
        this.deps.onCallbackError?.(
          job.key,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    this.running = null;
  }
}
