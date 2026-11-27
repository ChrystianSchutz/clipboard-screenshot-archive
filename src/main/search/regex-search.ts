import type { Worker } from 'node:worker_threads';
import { z } from 'zod';
import type { HistoryPage, HistoryQuery, MatchRange, RegexRangesResult } from '@shared/types';
import { WorkerClient, type WorkerProcess } from '../workers/worker-client';
import { responseParser } from '../workers/worker-protocol';
import type { RegexTask } from './regex-task';

/**
 * How long one regex task may run. A no-match regex over 50k clips takes about 30 ms
 * (search-performance.test.ts), so a pattern that needs longer is backtracking, not searching.
 */
export const REGEX_BUDGET_MS = 250;

/** The worker is ended after this long without a regex search, to free its memory. */
const IDLE_MS = 60_000;

export class RegexTooSlowError extends Error {
  constructor(budgetMs: number) {
    super(
      `This regex is too slow: no result within ${String(budgetMs)} ms. Try a more specific pattern.`,
    );
    this.name = 'RegexTooSlowError';
  }
}

/**
 * Runs user regexes in a worker thread with its own read-only database connection.
 *
 * A pathological pattern (`(a|a)*b` on a long clip) can backtrack for minutes, and `RegExp`
 * cannot be interrupted. On the main thread that would freeze IPC, global shortcuts and clipboard
 * capture; in the worker it is simply terminated once a task exceeds the budget, and the next task
 * starts a fresh worker. Tasks run one at a time, so each budget covers only its own work and a
 * slow pattern never fails the searches queued behind it.
 */
export class RegexSearch {
  private readonly client: WorkerClient<RegexTask, unknown>;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    spawn: () => WorkerProcess<RegexTask>,
    private readonly budgetMs = REGEX_BUDGET_MS,
  ) {
    this.client = new WorkerClient({
      name: 'Regex search',
      spawn,
      // Our own worker running our own code: results are trusted, only the envelope is checked.
      parse: responseParser(z.unknown()),
      // A backstop only: `execute` enforces the real budget per task.
      timeoutMs: budgetMs * 4,
      idleMs: IDLE_MS,
    });
  }

  query(query: HistoryQuery): Promise<HistoryPage> {
    return this.enqueue({ op: 'query', query }) as Promise<HistoryPage>;
  }

  /** Where `pattern` matches `text`, for highlighting; a slow or invalid pattern yields an error. */
  async ranges(pattern: string, text: string): Promise<RegexRangesResult> {
    try {
      const ranges = (await this.enqueue({ op: 'ranges', pattern, text })) as readonly MatchRange[];
      return { ok: true, ranges };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  dispose(): Promise<void> {
    return this.client.dispose();
  }

  private enqueue(task: RegexTask): Promise<unknown> {
    const result = this.tail.then(() => this.execute(task));
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async execute(task: RegexTask): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined;
    const overBudget = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new RegexTooSlowError(this.budgetMs));
      }, this.budgetMs);
    });
    try {
      return await Promise.race([this.client.run(task), overBudget]);
    } catch (error) {
      // Kills the busy worker; the next task spawns a new one.
      if (error instanceof RegexTooSlowError) await this.client.dispose();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Adapts a `worker_threads` Worker to the generic worker client. */
export function threadWorkerProcess<Payload>(
  worker: Worker,
  onError: (error: Error) => void,
): WorkerProcess<Payload> {
  // An uncaught exception in the worker is followed by 'exit', which rejects the task; without a
  // listener the 'error' event itself would throw in main.
  worker.on('error', onError);
  return {
    postMessage: (message) => {
      worker.postMessage(message);
    },
    onMessage: (listener) => worker.on('message', listener),
    onExit: (listener) => worker.on('exit', listener),
    kill: () => void worker.terminate(),
  };
}
