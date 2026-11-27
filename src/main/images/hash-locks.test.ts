import { describe, expect, it } from 'vitest';
import { deferred } from '../test-support/fakes';
import { HashLocks } from './hash-locks';

/** Lets every queued promise callback run. */
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('HashLocks', () => {
  it('runs tasks for the same hash strictly one after another, in call order', async () => {
    const locks = new HashLocks();
    const log: string[] = [];
    const gates = [deferred<undefined>(), deferred<undefined>(), deferred<undefined>()];
    const runs = gates.map((gate, index) =>
      locks.run(HASH_A, async () => {
        log.push(`start ${index}`);
        await gate.promise;
        log.push(`end ${index}`);
        return index;
      }),
    );

    await flushMicrotasks();
    expect(log).toEqual(['start 0']);

    // Releasing a later task first must not let it overtake the one holding the lock.
    gates[2]!.resolve(undefined);
    gates[1]!.resolve(undefined);
    await flushMicrotasks();
    expect(log).toEqual(['start 0']);

    gates[0]!.resolve(undefined);
    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2]);
    expect(log).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('runs tasks for different hashes concurrently', async () => {
    const locks = new HashLocks();
    const log: string[] = [];
    const gateA = deferred<undefined>();
    const gateB = deferred<undefined>();

    const a = locks.run(HASH_A, async () => {
      log.push('start a');
      await gateA.promise;
      log.push('end a');
    });
    const b = locks.run(HASH_B, async () => {
      log.push('start b');
      await gateB.promise;
      log.push('end b');
    });

    await flushMicrotasks();
    expect(log).toEqual(['start a', 'start b']);

    gateB.resolve(undefined);
    await b;
    expect(log).toEqual(['start a', 'start b', 'end b']);

    gateA.resolve(undefined);
    await a;
  });

  it('accepts a synchronous task and returns its value', async () => {
    const locks = new HashLocks();
    await expect(locks.run(HASH_A, () => 42)).resolves.toBe(42);
    expect(locks.isLocked(HASH_A)).toBe(false);
  });

  it('releases the lock when a task rejects, so the next task still runs', async () => {
    const locks = new HashLocks();
    const gate = deferred<undefined>();
    const failing = locks.run(HASH_A, async () => {
      await gate.promise;
      throw new Error('disk full');
    });
    const next = locks.run(HASH_A, () => 'next ran');
    const failure = expect(failing).rejects.toThrow('disk full');

    gate.resolve(undefined);

    await failure;
    await expect(next).resolves.toBe('next ran');
    expect(locks.isLocked(HASH_A)).toBe(false);
  });

  it('releases the lock when a task throws synchronously', async () => {
    const locks = new HashLocks();
    const failing = locks.run(HASH_A, () => {
      throw new Error('boom');
    });
    const next = locks.run(HASH_A, () => 'ok');

    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
    expect(locks.isLocked(HASH_A)).toBe(false);
  });

  it('reports a hash as locked while a task holds or waits for it, and cleans up after', async () => {
    const locks = new HashLocks();
    const first = deferred<undefined>();
    const second = deferred<undefined>();
    expect(locks.isLocked(HASH_A)).toBe(false);

    const holding = locks.run(HASH_A, () => first.promise);
    const waiting = locks.run(HASH_A, () => second.promise);
    await flushMicrotasks();
    expect(locks.isLocked(HASH_A)).toBe(true);
    expect(locks.isLocked(HASH_B)).toBe(false);

    // The first holder finishes; the waiting task now holds the lock, so it stays locked.
    first.resolve(undefined);
    await holding;
    expect(locks.isLocked(HASH_A)).toBe(true);

    second.resolve(undefined);
    await waiting;
    expect(locks.isLocked(HASH_A)).toBe(false);
  });

  it('can lock a hash again after it was released', async () => {
    const locks = new HashLocks();
    await locks.run(HASH_A, () => undefined);

    const log: string[] = [];
    await Promise.all([
      locks.run(HASH_A, async () => {
        log.push('first');
        await flushMicrotasks();
        log.push('first done');
      }),
      locks.run(HASH_A, () => {
        log.push('second');
      }),
    ]);

    expect(log).toEqual(['first', 'first done', 'second']);
    expect(locks.isLocked(HASH_A)).toBe(false);
  });
});
