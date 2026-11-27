import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  isTransientWorkerError,
  WorkerClient,
  WorkerUnavailableError,
  type WorkerProcess,
} from './worker-client';
import {
  isWeightsIntegrityError,
  responseParser,
  WorkerTaskError,
  type WorkerRequest,
} from './worker-protocol';

const TIMEOUT_MS = 10_000;
const IDLE_MS = 3_000;

/**
 * A worker process held in memory. Tests play the worker's part with `send` (a message to main)
 * and `exit` (the process ends). `events` records what main did to it, in order.
 */
class FakeWorker implements WorkerProcess<string> {
  readonly events: string[] = [];
  readonly posted: WorkerRequest<string>[] = [];
  private messageListener: ((message: unknown) => void) | null = null;
  private exitListener: ((code: number) => void) | null = null;

  postMessage(message: WorkerRequest<string>): void {
    this.posted.push(message);
    this.events.push(message.type);
  }

  onMessage(listener: (message: unknown) => void): void {
    this.messageListener = listener;
  }

  onExit(listener: (code: number) => void): void {
    this.exitListener = listener;
  }

  kill(): void {
    this.events.push('kill');
  }

  get killed(): boolean {
    return this.events.includes('kill');
  }

  /** Ids of the tasks main sent, in order. */
  get runIds(): number[] {
    return this.posted.flatMap((message) => (message.type === 'run' ? [message.id] : []));
  }

  send(message: unknown): void {
    this.messageListener?.(message);
  }

  exit(code: number): void {
    this.exitListener?.(code);
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const errors: Error[] = [];
  const client = new WorkerClient<string, string>({
    name: 'Upper-casing',
    spawn: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    parse: responseParser(z.string()),
    timeoutMs: TIMEOUT_MS,
    idleMs: IDLE_MS,
    onError: (error) => errors.push(error),
  });
  return { client, workers, errors };
}

/** Starts watching `promise` at once (no unhandled rejection) and resolves with its error. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`Rejected with a non-Error: ${String(error)}`, { cause: error });
  }
  throw new Error('Expected the promise to reject');
}

/** Whether `promise` has settled once the queued promise callbacks have run. */
async function stateOf(promise: Promise<unknown>): Promise<'pending' | 'resolved' | 'rejected'> {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  void promise.then(
    () => (state = 'resolved'),
    () => (state = 'rejected'),
  );
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  return state;
}

describe('WorkerClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts no worker until the first task', () => {
    const { client, workers } = setup();
    expect(workers).toHaveLength(0);
    expect(client.running).toBe(false);

    void client.run('a');

    expect(workers).toHaveLength(1);
    expect(client.running).toBe(true);
  });

  it('sends every task to the same worker with a fresh id', () => {
    const { client, workers } = setup();

    void client.run('a');
    void client.run('b');

    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted).toEqual([
      { type: 'run', id: 1, payload: 'a' },
      { type: 'run', id: 2, payload: 'b' },
    ]);
  });

  it('matches results to tasks by id, also when they arrive out of order', async () => {
    const { client, workers } = setup();
    const first = client.run('a');
    const second = client.run('b');
    const worker = workers[0]!;

    worker.send({ type: 'result', id: 2, result: 'B' });
    worker.send({ type: 'result', id: 1, result: 'A' });

    await expect(first).resolves.toBe('A');
    await expect(second).resolves.toBe('B');
  });

  it('rejects only the task the worker reported an error for', async () => {
    const { client, workers } = setup();
    const failing = rejectionOf(client.run('a'));
    const other = client.run('b');

    workers[0]!.send({ type: 'error', id: 1, message: 'Unsupported image' });

    expect((await failing).message).toBe('Unsupported image');
    expect(await stateOf(other)).toBe('pending');
  });

  it('rebuilds a typed failure from its code, and keeps uncoded errors plain', async () => {
    const { client, workers } = setup();
    const damaged = rejectionOf(client.run('a'));
    const plain = rejectionOf(client.run('b'));

    workers[0]!.send({ type: 'error', id: 1, message: 'weights bad', code: 'weights-integrity' });
    workers[0]!.send({ type: 'error', id: 2, message: 'Unsupported image' });

    const error = await damaged;
    expect(error).toBeInstanceOf(WorkerTaskError);
    expect(error.message).toBe('weights bad');
    expect(isWeightsIntegrityError(error)).toBe(true);
    expect(isWeightsIntegrityError(await plain)).toBe(false);
  });

  it('treats an error with an unknown code as an invalid message', async () => {
    const { client, workers, errors } = setup();
    const task = rejectionOf(client.run('a'));

    workers[0]!.send({ type: 'error', id: 1, message: 'x', code: 'format-disk' });

    expect((await task).message).toBe('Upper-casing process sent an invalid message');
    expect(errors).toHaveLength(1);
  });

  it('ignores ready messages and answers for unknown ids', async () => {
    const { client, workers, errors } = setup();
    const task = client.run('a');

    workers[0]!.send({ type: 'ready', worker: 'upper@1' });
    workers[0]!.send({ type: 'result', id: 99, result: 'stray' });

    expect(await stateOf(task)).toBe('pending');
    expect(errors).toEqual([]);
  });

  it('reports an invalid answer and fails its task at once, without waiting for the timeout', async () => {
    const { client, workers, errors } = setup();
    const task = rejectionOf(client.run('a'));
    const other = client.run('b');

    workers[0]!.send({ type: 'result', id: 1, result: 42 });

    expect(errors.map((error) => error.message)).toEqual([
      'Upper-casing process sent an invalid message',
    ]);
    expect((await task).message).toBe('Upper-casing process sent an invalid message');
    // Other tasks and the worker are unaffected.
    expect(await stateOf(other)).toBe('pending');
    expect(workers[0]!.killed).toBe(false);
    workers[0]!.send({ type: 'result', id: 2, result: 'B' });
    await expect(other).resolves.toBe('B');
  });

  it('keeps tasks waiting when an invalid message names no task', async () => {
    const { client, workers, errors } = setup();
    const task = client.run('a');

    workers[0]!.send({ type: 'surprise' });

    expect(errors).toHaveLength(1);
    expect(await stateOf(task)).toBe('pending');
    workers[0]!.send({ type: 'result', id: 1, result: 'A' });
    await expect(task).resolves.toBe('A');
  });

  describe('timeouts', () => {
    it('kills a worker that does not answer in time and rejects its tasks', async () => {
      const { client, workers, errors } = setup();
      const task = rejectionOf(client.run('a'));

      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

      const error = await task;
      expect(error.message).toBe('Upper-casing timed out after 10000 ms');
      expect(errors).toEqual([error]);
      expect(workers[0]!.events).toEqual(['run', 'dispose', 'kill']);
      expect(client.running).toBe(false);
    });

    it('does not fire for a task answered in time', async () => {
      const { client, workers, errors } = setup();
      const task = client.run('a');

      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      workers[0]!.send({ type: 'result', id: 1, result: 'A' });
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

      await expect(task).resolves.toBe('A');
      expect(errors).toEqual([]);
    });

    it('starts a fresh worker for the next task', async () => {
      const { client, workers } = setup();
      const timedOut = rejectionOf(client.run('a'));
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      await timedOut;

      const next = client.run('b');

      expect(workers).toHaveLength(2);
      expect(workers[1]!.runIds).toEqual([2]);
      workers[1]!.send({ type: 'result', id: 2, result: 'B' });
      await expect(next).resolves.toBe('B');
    });

    it('ignores late messages and the exit of the worker it replaced', async () => {
      const { client, workers } = setup();
      const timedOut = rejectionOf(client.run('a'));
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      await timedOut;
      const next = client.run('b');
      const [old, fresh] = [workers[0]!, workers[1]!];

      old.send({ type: 'result', id: 2, result: 'from the old worker' });
      old.exit(1);

      expect(await stateOf(next)).toBe('pending');
      expect(client.running).toBe(true);
      fresh.send({ type: 'result', id: 2, result: 'B' });
      await expect(next).resolves.toBe('B');
    });
  });

  describe('worker exit', () => {
    it('rejects every pending task when the worker dies', async () => {
      const { client, workers } = setup();
      const first = rejectionOf(client.run('a'));
      const second = rejectionOf(client.run('b'));

      workers[0]!.exit(3);

      expect((await first).message).toBe('Upper-casing process exited with code 3');
      expect((await second).message).toBe('Upper-casing process exited with code 3');
      expect(client.running).toBe(false);
    });

    it('starts a new worker for the next task', async () => {
      const { client, workers } = setup();
      const crashed = rejectionOf(client.run('a'));
      workers[0]!.exit(1);
      await crashed;

      const next = client.run('b');

      expect(workers).toHaveLength(2);
      workers[1]!.send({ type: 'result', id: 2, result: 'B' });
      await expect(next).resolves.toBe('B');
    });

    it('does not time out tasks that were already rejected by the exit', async () => {
      const { client, workers, errors } = setup();
      const crashed = rejectionOf(client.run('a'));
      workers[0]!.exit(1);
      await crashed;

      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

      expect(errors).toEqual([]);
    });
  });

  describe('idle shutdown', () => {
    it('stops the worker once it has had no work for idleMs', async () => {
      const { client, workers } = setup();
      const task = client.run('a');
      workers[0]!.send({ type: 'result', id: 1, result: 'A' });
      await task;

      await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
      expect(client.running).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      expect(client.running).toBe(false);
      expect(workers[0]!.events).toEqual(['run', 'dispose', 'kill']);
    });

    it('also counts an error answer as the end of the work', async () => {
      const { client, workers } = setup();
      const task = rejectionOf(client.run('a'));
      workers[0]!.send({ type: 'error', id: 1, message: 'nope' });
      await task;

      await vi.advanceTimersByTimeAsync(IDLE_MS);

      expect(client.running).toBe(false);
    });

    it('does not stop a worker that still has tasks pending', async () => {
      const { client, workers } = setup();
      const done = client.run('a');
      const stillRunning = client.run('b');
      workers[0]!.send({ type: 'result', id: 1, result: 'A' });
      await done;

      await vi.advanceTimersByTimeAsync(IDLE_MS * 2);

      expect(client.running).toBe(true);
      expect(await stateOf(stillRunning)).toBe('pending');
    });

    it('is cancelled by a new task', async () => {
      const { client, workers } = setup();
      const first = client.run('a');
      workers[0]!.send({ type: 'result', id: 1, result: 'A' });
      await first;
      await vi.advanceTimersByTimeAsync(IDLE_MS - 1);

      const second = client.run('b');
      await vi.advanceTimersByTimeAsync(IDLE_MS);

      expect(workers).toHaveLength(1);
      expect(client.running).toBe(true);
      expect(await stateOf(second)).toBe('pending');
    });

    it('starts a new worker after an idle shutdown', async () => {
      const { client, workers } = setup();
      const first = client.run('a');
      workers[0]!.send({ type: 'result', id: 1, result: 'A' });
      await first;
      await vi.advanceTimersByTimeAsync(IDLE_MS);

      void client.run('b');

      expect(workers).toHaveLength(2);
      expect(client.running).toBe(true);
    });
  });

  describe('dispose', () => {
    it('rejects pending tasks, then asks the worker to clean up before killing it', async () => {
      const { client, workers } = setup();
      const task = rejectionOf(client.run('a'));

      await client.dispose();

      expect((await task).message).toBe('Upper-casing was stopped');
      expect(workers[0]!.events).toEqual(['run', 'dispose', 'kill']);
      expect(client.running).toBe(false);
    });

    it('does nothing when no worker was started', async () => {
      const { client, workers } = setup();

      await client.dispose();

      expect(workers).toHaveLength(0);
    });

    it('cancels a scheduled idle shutdown', async () => {
      const { client, workers } = setup();
      const task = client.run('a');
      workers[0]!.send({ type: 'result', id: 1, result: 'A' });
      await task;

      await client.dispose();
      await vi.advanceTimersByTimeAsync(IDLE_MS);

      expect(workers[0]!.events).toEqual(['run', 'dispose', 'kill']);
    });
  });
});

describe('WorkerClient start failures', () => {
  it('rejects the task (instead of throwing) when the worker cannot be started', async () => {
    const client = new WorkerClient<string, string>({
      name: 'Upper-casing',
      spawn: () => {
        throw new Error('worker entry missing');
      },
      parse: responseParser(z.string()),
      timeoutMs: TIMEOUT_MS,
      idleMs: IDLE_MS,
    });

    const task = client.run('a');

    await expect(task).rejects.toThrow('worker entry missing');
    expect(client.running).toBe(false);
  });
});

describe('WorkerUnavailableError and isTransientWorkerError', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks a timeout as a transient WorkerUnavailableError', async () => {
    const { client } = setup();
    const task = rejectionOf(client.run('a'));

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    const error = await task;

    expect(error).toBeInstanceOf(WorkerUnavailableError);
    expect(error.name).toBe('WorkerUnavailableError');
    expect(isTransientWorkerError(error)).toBe(true);
  });

  it('marks a worker exit as a transient WorkerUnavailableError', async () => {
    const { client, workers } = setup();
    const task = rejectionOf(client.run('a'));

    workers[0]!.exit(134);
    const error = await task;

    expect(error).toBeInstanceOf(WorkerUnavailableError);
    expect(error.message).toBe('Upper-casing process exited with code 134');
    expect(isTransientWorkerError(error)).toBe(true);
  });

  it('does not retry an error the worker reported itself', async () => {
    const { client, workers } = setup();
    const task = rejectionOf(client.run('a'));

    workers[0]!.send({ type: 'error', id: 1, message: 'Unsupported image' });
    const error = await task;

    expect(error).not.toBeInstanceOf(WorkerUnavailableError);
    expect(isTransientWorkerError(error)).toBe(false);
  });

  it('does not retry an invalid answer or a stopped client', async () => {
    const { client, workers } = setup();
    const invalid = rejectionOf(client.run('a'));
    workers[0]!.send({ type: 'result', id: 1, result: 42 });
    expect(isTransientWorkerError(await invalid)).toBe(false);

    const stopped = rejectionOf(client.run('b'));
    await client.dispose();
    expect(isTransientWorkerError(await stopped)).toBe(false);
  });

  it('is false for ordinary errors and values that are not errors', () => {
    expect(isTransientWorkerError(new Error('process exited'))).toBe(false);
    expect(isTransientWorkerError({ name: 'WorkerUnavailableError', message: 'x' })).toBe(false);
    expect(isTransientWorkerError('WorkerUnavailableError')).toBe(false);
    expect(isTransientWorkerError(null)).toBe(false);
    expect(isTransientWorkerError(undefined)).toBe(false);
    expect(isTransientWorkerError(new WorkerUnavailableError('timed out'))).toBe(true);
  });
});
