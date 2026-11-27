import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryPage } from '@shared/types';
import type { WorkerProcess } from '../workers/worker-client';
import type { WorkerRequest } from '../workers/worker-protocol';
import { RegexSearch, RegexTooSlowError } from './regex-search';
import type { RegexTask } from './regex-task';

const BUDGET = 250;
const EMPTY_PAGE: HistoryPage = { clips: [], nextCursor: null };

/** A worker that answers only when the test says so. */
class FakeWorker implements WorkerProcess<RegexTask> {
  readonly received: WorkerRequest<RegexTask>[] = [];
  killed = false;
  private listener: ((message: unknown) => void) | null = null;

  postMessage(message: WorkerRequest<RegexTask>): void {
    this.received.push(message);
  }
  onMessage(listener: (message: unknown) => void): void {
    this.listener = listener;
  }
  onExit(): void {
    // not needed: these tests never crash the worker
  }
  kill(): void {
    this.killed = true;
  }

  get tasks(): RegexTask[] {
    return this.received.flatMap((message) => (message.type === 'run' ? [message.payload] : []));
  }

  /** Answers the most recent task. */
  answer(result: unknown): void {
    const last = this.received.findLast((message) => message.type === 'run');
    if (last?.type !== 'run') throw new Error('no task to answer');
    this.listener?.({ type: 'result', id: last.id, result });
  }
}

describe('RegexSearch', () => {
  let workers: FakeWorker[];
  let search: RegexSearch;
  const flush = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    workers = [];
    search = new RegexSearch(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    }, BUDGET);
  });

  afterEach(async () => {
    await search.dispose();
    vi.useRealTimers();
  });

  it('runs a regex query in the worker', async () => {
    const result = search.query({ text: 'a+', regex: true });
    await flush();
    expect(workers[0]?.tasks).toEqual([{ op: 'query', query: { text: 'a+', regex: true } }]);

    workers[0]?.answer(EMPTY_PAGE);
    await expect(result).resolves.toEqual(EMPTY_PAGE);
  });

  it('terminates a worker that exceeds the budget and reports the regex as too slow', async () => {
    const result = search.query({ text: '(a|a)*b', regex: true });
    const rejected = expect(result).rejects.toBeInstanceOf(RegexTooSlowError);
    await vi.advanceTimersByTimeAsync(BUDGET);

    await rejected;
    expect(workers[0]?.killed).toBe(true);
  });

  it('starts a fresh worker for the next search after a timeout', async () => {
    const slow = search.query({ text: '(a|a)*b', regex: true }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(BUDGET);
    expect(await slow).toBeInstanceOf(RegexTooSlowError);

    const next = search.query({ text: 'b', regex: true });
    await flush();
    expect(workers).toHaveLength(2);
    workers[1]?.answer(EMPTY_PAGE);
    await expect(next).resolves.toEqual(EMPTY_PAGE);
  });

  it("runs one task at a time, so a slow search does not use up the next one's budget", async () => {
    const slow = search.query({ text: '(a|a)*b', regex: true }).catch((error: unknown) => error);
    const queued = search.ranges('b', 'abc');
    await flush();
    expect(workers[0]?.tasks).toHaveLength(1); // the second waits for the first

    await vi.advanceTimersByTimeAsync(BUDGET);
    expect(await slow).toBeInstanceOf(RegexTooSlowError);
    await flush();

    await vi.advanceTimersByTimeAsync(BUDGET - 1); // almost a full budget of its own
    workers[1]?.answer([[1, 2]]);
    await expect(queued).resolves.toEqual({ ok: true, ranges: [[1, 2]] });
  });

  it('reports a slow highlight as an error instead of throwing', async () => {
    const result = search.ranges('(a|a)*b', 'a'.repeat(50));
    await vi.advanceTimersByTimeAsync(BUDGET);

    const answer = await result;
    expect(answer.ok ? null : answer.error).toMatch(/too slow/);
  });

  it('passes a worker error on', async () => {
    const result = search.query({ text: '[', regex: true });
    await flush();
    const worker = workers[0];
    const task = worker?.received.at(-1);
    if (task?.type !== 'run') throw new Error('expected a task');
    (worker as unknown as { listener: (message: unknown) => void }).listener({
      type: 'error',
      id: task.id,
      message: 'Unterminated character class',
    });

    await expect(result).rejects.toThrow('Unterminated character class');
  });
});
