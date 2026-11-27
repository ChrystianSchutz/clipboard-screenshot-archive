import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createErrlog, fingerprint, scrub, type ErrlogOptions, type ErrorEvent } from './errlog';

/** Every Error built here shares one top stack frame, as repeats of the same bug would. */
function failure(message: string): Error {
  return new Error(message);
}

describe('scrub', () => {
  it.each([
    ['double quotes', 'Cannot parse "my secret note" as JSON', 'Cannot parse [text] as JSON'],
    ['single quotes', "Unexpected token in 'hunter2'", 'Unexpected token in [text]'],
    ['backticks', 'Bad value `rm -rf /`', 'Bad value [text]'],
  ])('replaces text in %s', (_label, input, expected) => {
    expect(scrub(input)).toBe(expected);
  });

  it.each([
    [
      'a bearer token',
      'Authorization: Bearer abc.def-123 failed',
      'Authorization: [redacted] failed',
    ],
    [
      'a JWT',
      'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl expired',
      'token [redacted] expired',
    ],
    ['an API key', 'key sk-proj-abcdefghij1234 rejected', 'key [redacted] rejected'],
  ])('redacts %s', (_label, input, expected) => {
    expect(scrub(input)).toBe(expected);
  });

  it('keeps ordinary diagnostic text intact', () => {
    expect(scrub('ENOENT: no such file, open C:\\data\\clips.db')).toBe(
      'ENOENT: no such file, open C:\\data\\clips.db',
    );
  });

  it('does not treat quotes spanning lines as one quoted string', () => {
    expect(scrub('a "b\nc" d')).toBe('a "b\nc" d');
  });

  it('caps the result at 2000 characters', () => {
    expect(scrub('x'.repeat(5000))).toHaveLength(2000);
  });
});

describe('fingerprint', () => {
  const stack =
    'Error: x\n    at parse (C:\\app\\out\\main\\index.js:10:5)\n    at run (index.js:20:1)';

  it('is a 12-character hex string', () => {
    expect(fingerprint('main', 'boom', undefined)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is stable when only numbers in the message differ', () => {
    expect(fingerprint('main', 'Timeout after 300 ms (attempt 1)', stack)).toBe(
      fingerprint('main', 'Timeout after 5000 ms (attempt 12)', stack),
    );
  });

  it('differs for different messages', () => {
    expect(fingerprint('main', 'Timeout', stack)).not.toBe(fingerprint('main', 'Refused', stack));
  });

  it('differs for different kinds', () => {
    expect(fingerprint('main', 'boom', stack)).not.toBe(fingerprint('renderer', 'boom', stack));
  });

  it('uses only the top stack frame, so deeper frames do not split a group', () => {
    const otherCaller = stack.replace('at run (index.js:20:1)', 'at other (index.js:99:9)');

    expect(fingerprint('main', 'boom', stack)).toBe(fingerprint('main', 'boom', otherCaller));
  });

  it('differs when the top frame differs', () => {
    const otherTop = stack.replace('at parse', 'at render');

    expect(fingerprint('main', 'boom', stack)).not.toBe(fingerprint('main', 'boom', otherTop));
  });
});

describe('createErrlog', () => {
  let dir: string;
  let clock: number;

  const create = (overrides: Partial<ErrlogOptions> = {}): ReturnType<typeof createErrlog> =>
    createErrlog({
      dir,
      app: 'Clipboard & Screenshot Archive 0.1.0',
      now: () => clock,
      ...overrides,
    });

  const readEvents = (file: string): ErrorEvent[] =>
    existsSync(file)
      ? readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as ErrorEvent)
      : [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clipboard-archive-errlog-'));
    clock = Date.UTC(2026, 10, 27, 12, 0, 0);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes to errors.jsonl inside the given directory', () => {
    expect(create().file).toBe(join(dir, 'errors.jsonl'));
  });

  it('appends one JSON line with the event details', () => {
    const log = create();

    log.error(failure('Disk full'), 'storage:record');

    const [event] = readEvents(log.file);
    expect(event).toMatchObject({
      time: '2026-11-27T12:00:00.000Z',
      app: 'Clipboard & Screenshot Archive 0.1.0',
      kind: 'main',
      message: 'Disk full',
      where: 'storage:record',
      count: 1,
    });
    expect(event?.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(event?.stack).toContain('Disk full');
  });

  it('records the given error kind', () => {
    const log = create();

    log.error(failure('x'), 'renderer', 'renderer');

    expect(readEvents(log.file)[0]?.kind).toBe('renderer');
  });

  it('logs non-Error values as text without a stack', () => {
    const log = create();

    log.error(42, 'somewhere');

    expect(readEvents(log.file)[0]).toMatchObject({ message: '42' });
    expect(readEvents(log.file)[0]).not.toHaveProperty('stack');
  });

  it('scrubs quoted clipboard text from the message and the stack', () => {
    const log = create();

    log.error(failure('Cannot parse "my private clip"'), 'compare');

    const content = readFileSync(log.file, 'utf8');
    expect(content).not.toContain('my private clip');
    expect(readEvents(log.file)[0]?.message).toBe('Cannot parse [text]');
  });

  it('replaces an invalid "where" with a placeholder', () => {
    const log = create();

    log.error(failure('x'), 'clip content: {"password":"secret"}');

    expect(readEvents(log.file)[0]?.where).toBe('[where]');
  });

  it('keeps a valid "where" with path-like characters', () => {
    const log = create();

    log.error(failure('x'), 'ipc:history/query (#2)');

    expect(readEvents(log.file)[0]?.where).toBe('ipc:history/query (#2)');
  });

  it('prints a short line to the console', () => {
    create().error(failure('Disk full'), 'storage');

    expect(console.error).toHaveBeenCalledWith('[main] storage: Disk full');
  });

  it('creates the directory when it does not exist yet', () => {
    const nested = join(dir, 'logs', 'deep');
    const log = create({ dir: nested });

    log.error(failure('x'), 'here');

    expect(readEvents(log.file)).toHaveLength(1);
  });

  describe('deduplication', () => {
    it('counts repeats of the same error within the window instead of writing them', () => {
      const log = create({ dedupeMs: 60_000 });

      log.error(failure('Timeout after 300 ms'), 'sync');
      clock += 1_000;
      log.error(failure('Timeout after 5000 ms'), 'sync');
      clock += 1_000;
      log.error(failure('Timeout after 12 ms'), 'sync');

      expect(readEvents(log.file)).toHaveLength(1);
    });

    it('writes the error again after the window, with the suppressed repeats counted', () => {
      const log = create({ dedupeMs: 60_000 });
      log.error(failure('Timeout'), 'sync');
      clock += 10_000;
      log.error(failure('Timeout'), 'sync');
      clock += 10_000;
      log.error(failure('Timeout'), 'sync');

      clock += 60_000;
      log.error(failure('Timeout'), 'sync');

      expect(readEvents(log.file).map((event) => event.count)).toEqual([1, 3]);
    });

    it('starts a new window at the moment the error is written again', () => {
      const log = create({ dedupeMs: 60_000 });
      log.error(failure('Timeout'), 'sync');
      clock += 60_000;
      log.error(failure('Timeout'), 'sync');

      clock += 59_999;
      log.error(failure('Timeout'), 'sync');

      expect(readEvents(log.file)).toHaveLength(2);
    });

    it('writes different errors independently', () => {
      const log = create();

      log.error(failure('Timeout'), 'sync');
      log.error(failure('Refused'), 'sync');

      expect(readEvents(log.file).map((event) => event.message)).toEqual(['Timeout', 'Refused']);
    });
  });

  describe('rotation', () => {
    it('moves the file to .1 once it exceeds maxBytes and starts a new one', () => {
      const log = create({ maxBytes: 200 });
      log.error(failure('first error'), 'a');

      log.error(failure('second error'), 'b');

      expect(readEvents(`${log.file}.1`).map((event) => event.message)).toEqual(['first error']);
      expect(readEvents(log.file).map((event) => event.message)).toEqual(['second error']);
    });

    it('keeps appending while the file is within maxBytes', () => {
      const log = create({ maxBytes: 1_000_000 });

      log.error(failure('first error'), 'a');
      log.error(failure('second error'), 'b');

      expect(existsSync(`${log.file}.1`)).toBe(false);
      expect(readEvents(log.file)).toHaveLength(2);
    });

    it('replaces an older backup on the next rotation', () => {
      const log = create({ maxBytes: 200 });
      log.error(failure('first error'), 'a');
      log.error(failure('second error'), 'b');

      log.error(failure('third error'), 'c');

      expect(readEvents(`${log.file}.1`).map((event) => event.message)).toEqual(['second error']);
      expect(readEvents(log.file).map((event) => event.message)).toEqual(['third error']);
    });
  });

  it('never throws when the log cannot be written', () => {
    const blocker = join(dir, 'not-a-directory');
    writeFileSync(blocker, 'file in the way');
    const log = create({ dir: blocker });

    expect(() => log.error(failure('x'), 'here')).not.toThrow();
  });

  describe('installProcessHandlers', () => {
    type Listener = (value: unknown) => void;

    it('logs uncaught exceptions and unhandled rejections with their kinds', () => {
      const listeners = new Map<string, Listener>();
      vi.spyOn(process, 'on').mockImplementation(((event: string, listener: Listener) => {
        listeners.set(event, listener);
        return process;
      }) as typeof process.on);
      const log = create();

      log.installProcessHandlers();
      listeners.get('uncaughtException')?.(failure('crash'));
      listeners.get('unhandledRejection')?.('rejected with a string');

      expect(readEvents(log.file).map((event) => [event.kind, event.where, event.message])).toEqual(
        [
          ['uncaught', 'process', 'crash'],
          ['unhandled-rejection', 'process', 'rejected with a string'],
        ],
      );
    });
  });
});
