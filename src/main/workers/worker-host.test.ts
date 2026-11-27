import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { deferred } from '../test-support/fakes';
import {
  errorMessage,
  runWorkerHost,
  serializedBytes,
  type WorkerBody,
  type WorkerChannel,
} from './worker-host';
import type { WorkerResponse } from './worker-protocol';

/** Lets every queued promise callback run. */
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The worker's end of the message channel, held in memory instead of `process.parentPort`. */
class MemoryChannel implements WorkerChannel<number> {
  readonly posted: WorkerResponse<number>[] = [];
  private listener: ((message: unknown) => void) | null = null;

  onMessage(listener: (message: unknown) => void): void {
    this.listener = listener;
  }

  postMessage(message: WorkerResponse<number>): void {
    this.posted.push(message);
  }

  /** Main sends a message to the worker. */
  deliver(message: unknown): void {
    if (!this.listener) throw new Error('The worker host is not listening');
    this.listener(message);
  }
}

/** A worker body that counts characters, and fails on demand. */
function countingBody() {
  return {
    id: 'char-counter@1',
    payload: z.string().max(100),
    run: vi.fn<(payload: string) => Promise<number>>((payload) => Promise.resolve(payload.length)),
    dispose: vi.fn(() => Promise.resolve()),
  } satisfies WorkerBody<string, number>;
}

describe('runWorkerHost', () => {
  it('announces itself with the body id as soon as it starts', () => {
    const channel = new MemoryChannel();
    runWorkerHost(channel, countingBody());
    expect(channel.posted).toEqual([{ type: 'ready', worker: 'char-counter@1' }]);
  });

  it('answers each run with a result carrying the same id', async () => {
    const channel = new MemoryChannel();
    runWorkerHost(channel, countingBody());

    channel.deliver({ type: 'run', id: 1, payload: 'abc' });
    channel.deliver({ type: 'run', id: 2, payload: 'hello' });
    await flushMicrotasks();

    expect(channel.posted.slice(1)).toEqual([
      { type: 'result', id: 1, result: 3 },
      { type: 'result', id: 2, result: 5 },
    ]);
  });

  it('posts results in the order they finish, each with its own id', async () => {
    const channel = new MemoryChannel();
    const body = countingBody();
    const slow = deferred<number>();
    body.run.mockReturnValueOnce(slow.promise);
    runWorkerHost(channel, body);

    channel.deliver({ type: 'run', id: 1, payload: 'slow' });
    channel.deliver({ type: 'run', id: 2, payload: 'fast' });
    await flushMicrotasks();
    slow.resolve(99);
    await flushMicrotasks();

    expect(channel.posted.slice(1)).toEqual([
      { type: 'result', id: 2, result: 4 },
      { type: 'result', id: 1, result: 99 },
    ]);
  });

  it('answers a failing run with an error message instead of crashing', async () => {
    const channel = new MemoryChannel();
    const body = countingBody();
    body.run.mockRejectedValueOnce(new Error('Image could not be decoded'));
    runWorkerHost(channel, body);

    channel.deliver({ type: 'run', id: 4, payload: 'broken' });
    await flushMicrotasks();

    expect(channel.posted.at(-1)).toEqual({
      type: 'error',
      id: 4,
      message: 'Image could not be decoded',
    });
  });

  it('reports a generic message when the body rejects with something that is not an Error', async () => {
    const channel = new MemoryChannel();
    const body = countingBody();
    body.run.mockRejectedValueOnce({ code: 42 });
    runWorkerHost(channel, body);

    channel.deliver({ type: 'run', id: 5, payload: 'odd' });
    await flushMicrotasks();

    expect(channel.posted.at(-1)).toEqual({ type: 'error', id: 5, message: 'Worker task failed' });
  });

  it('keeps running tasks after one has failed', async () => {
    const channel = new MemoryChannel();
    const body = countingBody();
    body.run.mockRejectedValueOnce(new Error('first one fails'));
    runWorkerHost(channel, body);

    channel.deliver({ type: 'run', id: 1, payload: 'bad' });
    await flushMicrotasks();
    channel.deliver({ type: 'run', id: 2, payload: 'good' });
    await flushMicrotasks();

    expect(channel.posted.slice(1)).toEqual([
      { type: 'error', id: 1, message: 'first one fails' },
      { type: 'result', id: 2, result: 4 },
    ]);
  });

  it('frees the body on dispose without posting anything', () => {
    const channel = new MemoryChannel();
    const body = countingBody();
    runWorkerHost(channel, body);

    channel.deliver({ type: 'dispose' });

    expect(body.dispose).toHaveBeenCalledOnce();
    expect(body.run).not.toHaveBeenCalled();
    expect(channel.posted).toHaveLength(1);
  });
});

describe('runWorkerHost request validation', () => {
  it('answers a malformed request that names its task with an error, without running it', () => {
    const channel = new MemoryChannel();
    const body = countingBody();
    runWorkerHost(channel, body);

    channel.deliver({ type: 'run', id: 7 });
    channel.deliver({ type: 'execute', id: 8, payload: 'abc' });

    expect(body.run).not.toHaveBeenCalled();
    expect(channel.posted.slice(1)).toEqual([
      { type: 'error', id: 7, message: 'Invalid worker request' },
      { type: 'error', id: 8, message: 'Invalid worker request' },
    ]);
  });

  it('ignores a malformed request without a usable id', () => {
    const channel = new MemoryChannel();
    const body = countingBody();
    runWorkerHost(channel, body);

    channel.deliver('run everything');
    channel.deliver(null);
    channel.deliver({ type: 'run', id: -1, payload: 'abc' });
    channel.deliver({ type: 'run', id: 1.5, payload: 'abc' });

    expect(body.run).not.toHaveBeenCalled();
    expect(channel.posted).toHaveLength(1); // only "ready"
  });

  it('answers a payload that fails the body schema with an error and keeps serving', async () => {
    const channel = new MemoryChannel();
    const body = countingBody();
    runWorkerHost(channel, body);

    channel.deliver({ type: 'run', id: 1, payload: 42 });
    channel.deliver({ type: 'run', id: 2, payload: 'x'.repeat(101) });
    channel.deliver({ type: 'run', id: 3, payload: 'ok' });
    await flushMicrotasks();

    expect(body.run).toHaveBeenCalledExactlyOnceWith('ok');
    expect(channel.posted.slice(1)).toEqual([
      { type: 'error', id: 1, message: 'Invalid worker request' },
      { type: 'error', id: 2, message: 'Invalid worker request' },
      { type: 'result', id: 3, result: 2 },
    ]);
  });

  it('answers a body that throws synchronously with an error', () => {
    const channel = new MemoryChannel();
    const body = countingBody();
    body.run.mockImplementationOnce(() => {
      throw new Error('sync failure');
    });
    runWorkerHost(channel, body);

    channel.deliver({ type: 'run', id: 9, payload: 'abc' });

    expect(channel.posted.at(-1)).toEqual({ type: 'error', id: 9, message: 'sync failure' });
  });

  it('refuses to send a result larger than the output budget', async () => {
    const channel = new MemoryChannel();
    const body = { ...countingBody(), maxResultBytes: 3 };
    runWorkerHost(channel, body);

    channel.deliver({ type: 'run', id: 1, payload: 'x'.repeat(99) }); // result 99 → 2 bytes
    channel.deliver({ type: 'run', id: 2, payload: 'x'.repeat(100) }); // result 100 → 3 bytes
    body.run.mockResolvedValueOnce(1234);
    channel.deliver({ type: 'run', id: 3, payload: 'abc' }); // result 1234 → 4 bytes
    await flushMicrotasks();

    expect(channel.posted.slice(1)).toEqual([
      { type: 'result', id: 1, result: 99 },
      { type: 'result', id: 2, result: 100 },
      { type: 'error', id: 3, message: 'Worker result is too large' },
    ]);
  });
});

describe('serializedBytes', () => {
  it('counts UTF-8 bytes of the JSON form', () => {
    expect(serializedBytes({ a: 'ż' })).toBe('{"a":"ż"}'.length + 1);
    expect(serializedBytes(undefined)).toBe(0);
  });
});

describe('errorMessage', () => {
  it('uses the message of an Error', () => {
    expect(errorMessage(new TypeError('bad pixel format'))).toBe('bad pixel format');
  });

  it('passes a thrown string through', () => {
    expect(errorMessage('out of memory')).toBe('out of memory');
  });

  it('falls back to a generic message for anything else', () => {
    expect(errorMessage(undefined)).toBe('Worker task failed');
    expect(errorMessage(null)).toBe('Worker task failed');
    expect(errorMessage(404)).toBe('Worker task failed');
  });
});
