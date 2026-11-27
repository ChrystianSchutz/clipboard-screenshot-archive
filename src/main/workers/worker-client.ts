import { WorkerTaskError, type WorkerRequest, type WorkerResponse } from './worker-protocol';

/** A running worker process, as main sees it (an Electron `UtilityProcess` in production). */
export interface WorkerProcess<Payload> {
  postMessage(message: WorkerRequest<Payload>): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
  kill(): void;
}

export interface WorkerClientOptions<Payload, Result> {
  /** Short name for error messages, e.g. "Text recognition". */
  readonly name: string;
  /** Starts a new worker. Called lazily, and again after a crash or an idle shutdown. */
  readonly spawn: () => WorkerProcess<Payload>;
  /** Validates a worker message (see `responseParser`). */
  readonly parse: (message: unknown) => WorkerResponse<Result> | null;
  /** A single task taking longer than this is treated as a hung worker: it is killed. */
  readonly timeoutMs: number;
  /** The worker is ended after this long without work, which returns its WASM memory to the OS. */
  readonly idleMs: number;
  readonly onError?: (error: Error) => void;
}

/**
 * The worker timed out or its process died while a task ran. Retrying on a fresh worker may
 * succeed (an out-of-memory abort, a stalled engine), unlike an error the engine reported itself.
 */
export class WorkerUnavailableError extends Error {
  override readonly name = 'WorkerUnavailableError';
}

/** Whether a failed task is worth one more try on a fresh worker. */
export function isTransientWorkerError(error: unknown): boolean {
  return error instanceof WorkerUnavailableError;
}

interface Pending<Result> {
  readonly resolve: (result: Result) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * Sends tasks to a worker utility process and matches the answers to them.
 *
 * - Starts the worker on the first task, not at app start: most sessions copy no screenshot.
 * - Rejects every pending task if the worker dies, and starts a fresh one for the next task.
 * - Kills a worker that does not answer within `timeoutMs` (one pathological image cannot block
 *   the queue forever), and stops an idle worker to free its WASM heap and models.
 */
export class WorkerClient<Payload, Result> {
  private worker: WorkerProcess<Payload> | null = null;
  private readonly pending = new Map<number, Pending<Result>>();
  private nextId = 1;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: WorkerClientOptions<Payload, Result>) {}

  run(payload: Payload): Promise<Result> {
    this.cancelIdle();
    const id = this.nextId++;
    return new Promise<Result>((resolve, reject) => {
      // Inside the executor: a failing spawn or post rejects this task instead of throwing.
      const worker = this.ensureWorker();
      const timer = setTimeout(() => {
        const error = new WorkerUnavailableError(
          `${this.options.name} timed out after ${this.options.timeoutMs} ms`,
        );
        this.options.onError?.(error);
        this.stop(error);
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ type: 'run', id, payload });
      } catch (error) {
        this.settle(id, () => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }

  dispose(): Promise<void> {
    this.cancelIdle();
    this.stop(new Error(`${this.options.name} was stopped`));
    return Promise.resolve();
  }

  /** True while a worker process is running (for tests and diagnostics). */
  get running(): boolean {
    return this.worker !== null;
  }

  private ensureWorker(): WorkerProcess<Payload> {
    if (this.worker) return this.worker;
    const worker = this.options.spawn();
    worker.onMessage((raw) => {
      if (this.worker === worker) this.handle(raw);
    });
    worker.onExit((code) => {
      if (this.worker !== worker) return; // an old worker we already replaced
      this.worker = null;
      this.rejectAll(
        new WorkerUnavailableError(`${this.options.name} process exited with code ${code}`),
      );
    });
    this.worker = worker;
    return worker;
  }

  private handle(raw: unknown): void {
    const message = this.options.parse(raw);
    if (!message) {
      const error = new Error(`${this.options.name} process sent an invalid message`);
      this.options.onError?.(error);
      // If the broken answer still names its task, fail that task now instead of at the timeout.
      const id = messageId(raw);
      if (id !== null) this.settle(id, (pending) => pending.reject(error));
      return;
    }
    if (message.type === 'ready') return;
    if (message.type === 'result')
      this.settle(message.id, (pending) => pending.resolve(message.result));
    else
      this.settle(message.id, (pending) =>
        pending.reject(
          message.code
            ? new WorkerTaskError(message.message, message.code)
            : new Error(message.message),
        ),
      );
  }

  /** Removes a pending task (if it is still pending) and hands it to `finish`. */
  private settle(id: number, finish: (pending: Pending<Result>) => void): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    finish(pending);
    if (this.pending.size === 0) this.scheduleIdle();
  }

  private stop(error: Error): void {
    const worker = this.worker;
    this.worker = null;
    this.rejectAll(error);
    if (worker) {
      worker.postMessage({ type: 'dispose' });
      worker.kill();
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private scheduleIdle(): void {
    this.cancelIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size === 0) this.stop(new Error(`${this.options.name} stopped while idle`));
    }, this.options.idleMs);
    this.idleTimer.unref();
  }

  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

/** The task id of a message that failed validation, when it has a usable one. */
function messageId(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { id } = raw as { id?: unknown };
  return typeof id === 'number' && Number.isInteger(id) ? id : null;
}
