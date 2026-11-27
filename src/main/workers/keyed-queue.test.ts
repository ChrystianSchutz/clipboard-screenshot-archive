import { describe, expect, it, vi } from 'vitest';
import { deferred } from '../test-support/fakes';
import { KeyedQueue, type KeyedJob } from './keyed-queue';

/** Lets every queued promise callback run. */
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * A queue that doubles numbers and records what happened, in order. `load` and `run` can be
 * replaced per test to hold or fail a job.
 */
function setup() {
  const log: string[] = [];
  const results = new Map<string, number>();
  const failures = new Map<string, Error>();
  const run = vi.fn<(input: number) => Promise<number>>((input) => {
    log.push(`run ${input}`);
    return Promise.resolve(input * 2);
  });
  const queue = new KeyedQueue<number, number>({
    run,
    onResult: (key, output) => {
      log.push(`result ${key}`);
      results.set(key, output);
    },
    onFailure: (key, error) => {
      log.push(`failure ${key}`);
      failures.set(key, error);
    },
  });
  /** A job whose input is `input`, loaded only when the job starts. */
  const job = (key: string, input: number): KeyedJob<number> => ({
    key,
    load: () => {
      log.push(`load ${key}`);
      return Promise.resolve(input);
    },
  });
  return { queue, run, log, results, failures, job };
}

describe('KeyedQueue', () => {
  it('runs jobs one at a time, in arrival order', async () => {
    const { queue, job, log, results } = setup();

    queue.enqueue(job('a', 1));
    queue.enqueue(job('b', 2));
    queue.enqueue(job('c', 3));
    await queue.idle();

    expect(log).toEqual([
      'load a',
      'run 1',
      'result a',
      'load b',
      'run 2',
      'result b',
      'load c',
      'run 3',
      'result c',
    ]);
    expect([...results]).toEqual([
      ['a', 2],
      ['b', 4],
      ['c', 6],
    ]);
  });

  it('never starts a second job while one is running', async () => {
    const { queue, job, run } = setup();
    const slow = deferred<number>();
    run.mockReturnValueOnce(slow.promise);

    queue.enqueue(job('a', 1));
    queue.enqueue(job('b', 2));
    await flushMicrotasks();
    expect(run).toHaveBeenCalledTimes(1);

    slow.resolve(10);
    await queue.idle();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('loads a job input only when the job starts, not when it is queued', async () => {
    const { queue, run, job, log } = setup();
    const slow = deferred<number>();
    run.mockReturnValueOnce(slow.promise);

    queue.enqueue(job('a', 1));
    queue.enqueue(job('b', 2));
    await flushMicrotasks();
    expect(log).toEqual(['load a']);

    slow.resolve(10);
    await queue.idle();
    expect(log).toEqual(['load a', 'result a', 'load b', 'run 2', 'result b']);
  });

  it('ignores a key that is already queued', async () => {
    const { queue, job, run } = setup();
    const slow = deferred<number>();
    run.mockReturnValueOnce(slow.promise);
    queue.enqueue(job('a', 1));
    queue.enqueue(job('b', 2));

    expect(queue.enqueue(job('b', 2))).toBe(false);

    slow.resolve(10);
    await queue.idle();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('ignores a key that is running right now', async () => {
    const { queue, job, run } = setup();
    const slow = deferred<number>();
    run.mockReturnValueOnce(slow.promise);
    expect(queue.enqueue(job('a', 1))).toBe(true);
    await flushMicrotasks();

    expect(queue.enqueue(job('a', 1))).toBe(false);

    slow.resolve(10);
    await queue.idle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('accepts a key again once its job has finished', async () => {
    const { queue, job, run } = setup();
    queue.enqueue(job('a', 1));
    await queue.idle();

    expect(queue.enqueue(job('a', 1))).toBe(true);
    await queue.idle();

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('reports a failed load and carries on with the next job', async () => {
    const { queue, job, run, failures, results } = setup();
    queue.enqueue({ key: 'gone', load: () => Promise.reject(new Error('Image file was deleted')) });
    queue.enqueue(job('b', 2));
    await queue.idle();

    expect(failures.get('gone')?.message).toBe('Image file was deleted');
    expect(run).toHaveBeenCalledOnce();
    expect(results.get('b')).toBe(4);
  });

  it('reports a failed run and carries on with the next job', async () => {
    const { queue, job, run, failures, results } = setup();
    run.mockRejectedValueOnce(new Error('Worker crashed'));
    queue.enqueue(job('a', 1));
    queue.enqueue(job('b', 2));
    await queue.idle();

    expect(failures.get('a')?.message).toBe('Worker crashed');
    expect(results.has('a')).toBe(false);
    expect(results.get('b')).toBe(4);
  });

  it('wraps a thrown value that is not an Error', async () => {
    const { queue, job, run, failures } = setup();
    run.mockRejectedValueOnce('out of memory');
    queue.enqueue(job('a', 1));
    await queue.idle();

    const failure = failures.get('a');
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toBe('out of memory');
  });

  it('lets a failed key be queued again', async () => {
    const { queue, job, run, results } = setup();
    run.mockRejectedValueOnce(new Error('transient'));
    queue.enqueue(job('a', 1));
    await queue.idle();

    expect(queue.enqueue(job('a', 1))).toBe(true);
    await queue.idle();
    expect(results.get('a')).toBe(2);
  });

  it('counts queued and running jobs in size and has()', async () => {
    const { queue, job, run } = setup();
    const slow = deferred<number>();
    run.mockReturnValueOnce(slow.promise);
    expect(queue.size).toBe(0);

    queue.enqueue(job('a', 1));
    queue.enqueue(job('b', 2));
    await flushMicrotasks();
    expect(queue.size).toBe(2);
    expect(queue.has('a')).toBe(true);
    expect(queue.has('b')).toBe(true);
    expect(queue.has('c')).toBe(false);

    slow.resolve(10);
    await queue.idle();
    expect(queue.size).toBe(0);
    expect(queue.has('a')).toBe(false);
  });

  it('idle() resolves at once on an empty queue', async () => {
    const { queue } = setup();
    await expect(queue.idle()).resolves.toBeUndefined();
  });

  it('idle() waits for jobs queued while it was waiting', async () => {
    const { queue, job, run, results } = setup();
    const slow = deferred<number>();
    run.mockReturnValueOnce(slow.promise);
    queue.enqueue(job('a', 1));
    const idle = queue.idle();

    queue.enqueue(job('b', 2));
    slow.resolve(10);
    await idle;

    expect(results.get('b')).toBe(4);
    expect(queue.size).toBe(0);
  });

  it('starts again after it has drained', async () => {
    const { queue, job, results } = setup();
    queue.enqueue(job('a', 1));
    await queue.idle();

    queue.enqueue(job('b', 2));
    await queue.idle();

    expect(results.get('b')).toBe(4);
  });
});

describe('KeyedQueue with a throwing callback', () => {
  it('keeps running after onFailure throws, and reports the callback error separately', async () => {
    const results: number[] = [];
    const callbackErrors: string[] = [];
    const queue = new KeyedQueue<number, number>({
      run: (n) => (n < 0 ? Promise.reject(new Error('bad input')) : Promise.resolve(n * 2)),
      onResult: (_key, output) => results.push(output),
      onFailure: () => {
        throw new Error('listener broke');
      },
      onCallbackError: (key, error) => callbackErrors.push(`${key}: ${error.message}`),
    });

    queue.enqueue({ key: 'a', load: () => Promise.resolve(-1) });
    queue.enqueue({ key: 'b', load: () => Promise.resolve(2) });
    await queue.idle();

    expect(results).toEqual([4]);
    expect(callbackErrors).toEqual(['a: listener broke']);
    expect(queue.size).toBe(0);
    expect(queue.enqueue({ key: 'a', load: () => Promise.resolve(5) })).toBe(true);
    await queue.idle();
    expect(results).toEqual([4, 10]);
  });

  it('does not report a successful job as failed when onResult throws', async () => {
    const onFailure = vi.fn();
    const onCallbackError = vi.fn();
    const queue = new KeyedQueue<number, number>({
      run: (n) => Promise.resolve(n),
      onResult: () => {
        throw new Error('render failed');
      },
      onFailure,
      onCallbackError,
    });

    queue.enqueue({ key: 'a', load: () => Promise.resolve(1) });
    await queue.idle();

    expect(onFailure).not.toHaveBeenCalled();
    expect(onCallbackError).toHaveBeenCalledExactlyOnceWith('a', new Error('render failed'));
  });
});

describe('KeyedQueue.clear', () => {
  it('returns no keys and changes nothing on an empty queue', async () => {
    const { queue, job, results } = setup();

    expect(queue.clear()).toEqual([]);

    queue.enqueue(job('a', 1));
    await queue.idle();
    expect(results.get('a')).toBe(2);
  });

  it('drops the waiting jobs without loading or running them, and returns their keys', async () => {
    const { queue, job, run, log, results, failures } = setup();
    const slow = deferred<number>();
    run.mockReturnValueOnce(slow.promise);
    queue.enqueue(job('a', 1));
    queue.enqueue(job('b', 2));
    queue.enqueue(job('c', 3));
    await flushMicrotasks();

    // The running job comes first, then the waiting ones in arrival order.
    expect(queue.clear()).toEqual(['a', 'b', 'c']);
    expect(queue.size).toBe(0);
    expect(queue.has('a')).toBe(false);
    expect(queue.has('b')).toBe(false);

    slow.resolve(10);
    await queue.idle();

    expect(log).toEqual(['load a']);
    expect(run).toHaveBeenCalledOnce();
    expect(results.size).toBe(0);
    expect(failures.size).toBe(0);
  });

  it('never runs a job that was cleared while its input was loading', async () => {
    const { queue, job, run, log, results, failures } = setup();
    queue.enqueue(job('a', 1));
    queue.enqueue(job('b', 2));

    expect(queue.clear()).toEqual(['a', 'b']);
    await queue.idle();

    // The load had already started, but the work (a worker process) never does; 'b' never loads.
    expect(log).toEqual(['load a']);
    expect(run).not.toHaveBeenCalled();
    expect(results.size).toBe(0);
    expect(failures.size).toBe(0);
  });

  it('runs a job queued again after a clear, but not the obsolete one still loading', async () => {
    const { queue, run, results } = setup();
    const loading = deferred<number>();
    queue.enqueue({ key: 'a', load: () => loading.promise });
    await flushMicrotasks();

    queue.clear();
    queue.enqueue({ key: 'a', load: () => Promise.resolve(5) });
    loading.resolve(1);
    await queue.idle();

    expect(run.mock.calls).toEqual([[5]]);
    expect([...results]).toEqual([['a', 10]]);
  });

  it('throws away the result of the job that was running', async () => {
    const onResult = vi.fn();
    const onFailure = vi.fn();
    const slow = deferred<number>();
    const queue = new KeyedQueue<number, number>({
      run: () => slow.promise,
      onResult,
      onFailure,
    });
    queue.enqueue({ key: 'a', load: () => Promise.resolve(1) });
    await flushMicrotasks();

    expect(queue.clear()).toEqual(['a']);
    slow.resolve(2);
    await queue.idle();

    expect(onResult).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('throws away the failure of the job that was running', async () => {
    const onResult = vi.fn();
    const onFailure = vi.fn();
    const slow = deferred<number>();
    const queue = new KeyedQueue<number, number>({
      run: () => slow.promise,
      onResult,
      onFailure,
    });
    queue.enqueue({ key: 'a', load: () => Promise.resolve(1) });
    await flushMicrotasks();

    queue.clear();
    slow.reject(new Error('Worker crashed'));
    await queue.idle();

    expect(onResult).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('lets the cleared running key be queued again at once, and runs it normally', async () => {
    const { queue, job, run, log, results } = setup();
    const slow = deferred<number>();
    run.mockReturnValueOnce(slow.promise);
    queue.enqueue(job('a', 1));
    await flushMicrotasks();
    queue.clear();

    expect(queue.enqueue(job('a', 5))).toBe(true);
    expect(queue.has('a')).toBe(true);
    expect(queue.size).toBe(1);

    // The disowned run finishes late; its answer (999) must not be reported for the new job.
    slow.resolve(999);
    await queue.idle();

    expect(results.get('a')).toBe(10);
    expect(log).toEqual(['load a', 'load a', 'run 5', 'result a']);
    expect(queue.size).toBe(0);
  });

  it('lets a cleared waiting key be queued again after the queue drained', async () => {
    const { queue, job, run, results } = setup();
    const slow = deferred<number>();
    run.mockReturnValueOnce(slow.promise);
    queue.enqueue(job('a', 1));
    queue.enqueue(job('b', 2));
    await flushMicrotasks();
    queue.clear();
    slow.resolve(10);
    await queue.idle();

    expect(queue.enqueue(job('b', 3))).toBe(true);
    await queue.idle();

    expect(results.get('b')).toBe(6);
    expect(results.has('a')).toBe(false);
  });

  it('counts a running job in size and has() exactly once', async () => {
    const { queue, job, run } = setup();
    const slow = deferred<number>();
    run.mockReturnValueOnce(slow.promise);

    queue.enqueue(job('a', 1));
    await flushMicrotasks();
    expect(queue.size).toBe(1);
    expect(queue.has('a')).toBe(true);

    queue.enqueue(job('b', 2));
    expect(queue.size).toBe(2);

    slow.resolve(10);
    await queue.idle();
    expect(queue.size).toBe(0);
  });
});

describe('KeyedQueue.dispose', () => {
  it('drops everything, never runs a job still loading, and refuses later jobs', async () => {
    const { queue, job, run, results } = setup();
    const loading = deferred<number>();
    queue.enqueue({ key: 'a', load: () => loading.promise });
    queue.enqueue(job('b', 2));
    await flushMicrotasks();

    queue.dispose();
    expect(queue.enqueue(job('c', 3))).toBe(false);
    loading.resolve(1);
    await queue.idle();

    expect(run).not.toHaveBeenCalled();
    expect(results.size).toBe(0);
    expect(queue.size).toBe(0);
  });

  it('withdraws only the matching jobs, the running one included, and keeps the others in order', async () => {
    const started: string[] = [];
    const results: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred<string>>>();
    const queue = new KeyedQueue<string, string>({
      run: (input) => {
        started.push(input);
        const gate = deferred<string>();
        gates.set(input, gate);
        return gate.promise;
      },
      onResult: (key) => results.push(key),
      onFailure: () => undefined,
    });
    for (const key of ['a', 'b', 'c', 'd'])
      queue.enqueue({ key, load: () => Promise.resolve(key) });
    await vi.waitFor(() => expect(started).toEqual(['a']));

    expect(queue.withdraw((key) => key === 'a' || key === 'c').sort()).toEqual(['a', 'c']);
    gates.get('a')?.resolve('a');
    await vi.waitFor(() => expect(started).toEqual(['a', 'b']));
    gates.get('b')?.resolve('b');
    await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'd']));
    gates.get('d')?.resolve('d');
    await queue.idle();

    expect(results).toEqual(['b', 'd']); // the withdrawn running job's result was dropped
    expect(queue.has('c')).toBe(false);
  });
});
