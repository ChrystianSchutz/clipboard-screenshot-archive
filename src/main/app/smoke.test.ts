import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CaptureAcks,
  OS_CAPTURE_ACK_FILE,
  OS_CAPTURE_DONE_FILE,
  OS_CAPTURE_READY_FILE,
  runOsCaptureCheck,
} from './smoke';

type Name = 'normal' | 'secret' | 'public';

describe('runOsCaptureCheck (CI-only OS copy check, app half)', () => {
  let dir: string;
  let history: Set<string>;
  let acks: CaptureAcks;
  const hasClip = (text: string): boolean => history.has(text);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'smoke-capture-test-'));
    history = new Set();
    acks = new CaptureAcks(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const copies = {
    normal: { token: 'n-1', sequence: 11 },
    secret: { token: 's-1', sequence: 12 },
    public: { token: 'p-1', sequence: 13 },
  };

  /**
   * A sleep that plays the script and the app: once the app is ready, each copy is handled with
   * the given outcome (recorded copies land in the history), then the script reports its copies.
   */
  function script(
    outcomes: Partial<Record<Name, { status: string; reason?: string }>>,
    report: unknown = copies,
  ): (ms: number) => Promise<void> {
    let reported = false;
    return async () => {
      if (reported) return;
      await stat(join(dir, OS_CAPTURE_READY_FILE)); // throws if the app never announced itself
      for (const name of ['normal', 'secret', 'public'] as const) {
        const outcome = outcomes[name];
        if (!outcome) continue;
        if (outcome.status === 'recorded') history.add(copies[name].token);
        acks.record(copies[name].sequence, outcome);
      }
      await writeFile(join(dir, OS_CAPTURE_DONE_FILE), JSON.stringify(report));
      reported = true;
    };
  }

  const recorded = { status: 'recorded' };
  const privateSkip = { status: 'skipped', reason: 'private-format' };

  it('passes when normal and public copies are recorded and the private one is skipped as private', async () => {
    const sleep = script({ normal: recorded, secret: privateSkip, public: recorded });

    await expect(runOsCaptureCheck({ dir, hasClip, acks, sleep })).resolves.toEqual({
      normalRecorded: true,
      privateSkipped: true,
      publicRecorded: true,
      outcomes: { normal: 'recorded', secret: 'skipped:private-format', public: 'recorded' },
      error: null,
    });
  });

  it('fails when the private copy was never acknowledged (a lost notification)', async () => {
    const sleep = script({ normal: recorded, public: recorded });

    await expect(runOsCaptureCheck({ dir, hasClip, acks, sleep })).resolves.toMatchObject({
      privateSkipped: false,
      outcomes: { secret: null },
    });
  });

  it('fails when the private copy was skipped for another reason', async () => {
    const sleep = script({
      normal: recorded,
      secret: { status: 'skipped', reason: 'superseded' },
      public: recorded,
    });

    await expect(runOsCaptureCheck({ dir, hasClip, acks, sleep })).resolves.toMatchObject({
      privateSkipped: false,
      outcomes: { secret: 'skipped:superseded' },
    });
  });

  it('fails when the private copy was recorded', async () => {
    const sleep = script({ normal: recorded, secret: recorded, public: recorded });

    await expect(runOsCaptureCheck({ dir, hasClip, acks, sleep })).resolves.toMatchObject({
      normalRecorded: true,
      privateSkipped: false,
    });
  });

  it('fails the positive control when the public copy from the same writer is not recorded', async () => {
    const sleep = script({ normal: recorded, secret: privateSkip, public: privateSkip });

    await expect(runOsCaptureCheck({ dir, hasClip, acks, sleep })).resolves.toMatchObject({
      privateSkipped: true,
      publicRecorded: false,
    });
  });

  it('fails when the ordinary copy was not recorded', async () => {
    const sleep = script({ secret: privateSkip, public: recorded });

    await expect(runOsCaptureCheck({ dir, hasClip, acks, sleep })).resolves.toMatchObject({
      normalRecorded: false,
    });
  });

  it('fails, without hanging, when the script never reports', async () => {
    const sleep = vi.fn(() => Promise.resolve());

    await expect(
      runOsCaptureCheck({ dir, hasClip, acks, sleep, timeoutMs: 1_000 }),
    ).resolves.toEqual({
      normalRecorded: false,
      privateSkipped: false,
      publicRecorded: false,
      outcomes: { normal: null, secret: null, public: null },
      error: 'The script never reported its copies',
    });
    expect(sleep).toHaveBeenCalledTimes(10);
  });

  it.each([
    { normal: copies.normal, secret: copies.secret },
    { ...copies, normal: { token: '', sequence: 1 } },
    { ...copies, public: { token: 'p-1', sequence: 'x' } },
    { normal: 'n-1', secret: 's-1', public: 'p-1' },
  ])('fails on malformed copies %j', async (report) => {
    const sleep = script({}, report);

    await expect(runOsCaptureCheck({ dir, hasClip, acks, sleep })).resolves.toMatchObject({
      normalRecorded: false,
      privateSkipped: false,
      publicRecorded: false,
      error: 'The script reported malformed copies',
    });
  });
});

describe('CaptureAcks', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'smoke-acks-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends one JSON line per handled change, in order, and answers by sequence', async () => {
    const acks = new CaptureAcks(dir);
    acks.record(5, { status: 'skipped', reason: 'superseded' });
    acks.record(6, { status: 'recorded' });
    acks.record(null, 'error');

    await vi.waitFor(async () => {
      const lines = (await readFile(join(dir, OS_CAPTURE_ACK_FILE), 'utf8')).trim().split('\n');
      expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
        { sequence: 5, outcome: 'skipped:superseded' },
        { sequence: 6, outcome: 'recorded' },
        { sequence: null, outcome: 'error' },
      ]);
    });
    expect(acks.outcomeOf(5)).toBe('skipped:superseded');
    expect(acks.outcomeOf(6)).toBe('recorded');
    expect(acks.outcomeOf(7)).toBeNull();
  });
});
