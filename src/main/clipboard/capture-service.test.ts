import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clip, Settings } from '@shared/types';
import {
  deferred,
  FakeCaptureRepository,
  FakeClipboard,
  FakeSourceProbe,
  settingsWith,
} from '../test-support/fakes';
import {
  CaptureService,
  PRIVACY_RETRY_DELAYS_MS,
  SELF_WRITE_TTL_MS,
  type CaptureDeps,
  type CaptureImages,
} from './capture-service';
import { CaptureGate } from './capture-gate';
import type { ClipboardIO, ProbeResult, SourceProbe } from './ports';
import { MAX_CLIP_CHARS } from './privacy';

const NOW = 1_764_000_000_000;

/** Lets every queued promise callback run (a macrotask boundary drains the microtask queue). */
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * One mutable system clipboard, like Windows: a copy replaces text, owner and privacy marker
 * together and bumps the sequence number. A read returns whatever is on the clipboard when it
 * completes, never a value assigned to it in advance.
 */
class SystemClipboard {
  private text = '';
  /** The app's write marker (only its own writes carry one; any other copy replaces it). */
  private marker: string | null = null;
  private owner: ProbeResult = { exe: null, url: null, hasPrivateFormat: false };
  private sequence = 0;
  private readsDone: Promise<void> = Promise.resolve();
  /**
   * Another app holds the clipboard open: the privacy markers cannot be read. Opening or closing
   * the clipboard does not change its version.
   */
  locked = false;
  /** Text reads that completed. */
  reads = 0;
  /** Makes the next writes fail (as `clipboard.writeText` does when the clipboard is busy). */
  failWrites = false;

  copy(text: string, owner: Partial<ProbeResult> = {}, marker: string | null = null): void {
    this.text = text;
    this.marker = marker;
    this.owner = { exe: null, url: null, hasPrivateFormat: false, ...owner };
    this.sequence++;
  }

  /** Makes reads slow: they complete only when the returned function is called. */
  holdReads(): () => void {
    const gate = deferred<undefined>();
    this.readsDone = gate.promise;
    return () => {
      gate.resolve(undefined);
    };
  }

  readonly io: ClipboardIO = {
    readText: async () => {
      await this.readsDone;
      this.reads++;
      return this.text;
    },
    writeText: (text, marker) => {
      if (this.failWrites) return Promise.reject(new Error('OpenClipboard failed'));
      this.copy(text, {}, marker ?? null);
      return Promise.resolve();
    },
    readWriteMarker: () => Promise.resolve(this.marker),
  };

  readonly probe: SourceProbe = {
    capabilities: { sourceDetection: true, appExclusion: true, privateFormatDetection: true },
    // What Win32SourceProbe reports when a marker cannot be read: fail closed, retry allowed.
    probe: () =>
      this.locked
        ? { exe: null, url: null, hasPrivateFormat: true, privacyUnreadable: true }
        : this.owner,
    sequenceNumber: () => this.sequence,
  };
}

describe('CaptureService', () => {
  let io: FakeClipboard;
  let probe: FakeSourceProbe;
  let repository: FakeCaptureRepository;
  let settings: Settings;
  let onRecorded: ReturnType<typeof vi.fn<(clip: Clip, created: boolean) => void>>;

  function createService(overrides: Partial<CaptureDeps> = {}): CaptureService {
    return new CaptureService({
      io,
      probe,
      repository,
      settings: () => settings,
      now: () => NOW,
      onRecorded,
      ...overrides,
    });
  }

  beforeEach(() => {
    io = new FakeClipboard();
    probe = new FakeSourceProbe();
    repository = new FakeCaptureRepository();
    settings = settingsWith({ excludedApps: ['KeePassXC.exe'], maxClips: 500 });
    onRecorded = vi.fn<(clip: Clip, created: boolean) => void>();
  });

  describe('recording', () => {
    it('stores new clipboard text with its kind, source and capture time', async () => {
      io.text = '{"status":"ok"}';
      probe.result = { exe: 'Code.exe', url: null, hasPrivateFormat: false };

      const outcome = await createService().handleChange();

      expect(outcome).toMatchObject({ status: 'recorded', created: true });
      expect(repository.records).toEqual([
        {
          content: '{"status":"ok"}',
          kind: 'json',
          categories: [],
          source: { app: 'VS Code', exe: 'Code.exe', url: null },
          copiedAt: NOW,
        },
      ]);
    });

    it('tags the clip with its automatic categories at capture time', async () => {
      io.text = 'SELECT id FROM users WHERE email = $1';

      await createService().handleChange();

      expect(repository.records[0]?.categories).toEqual(['sql']);
    });

    it('keeps the page URL from the probe', async () => {
      io.text = 'quoted paragraph';
      probe.result = { exe: 'chrome.exe', url: 'https://example.com/a', hasPrivateFormat: false };

      await createService().handleChange();

      expect(repository.records[0]?.source).toEqual({
        app: 'Chrome',
        exe: 'chrome.exe',
        url: 'https://example.com/a',
      });
    });

    it('leaves the app unknown when the owner could not be resolved', async () => {
      io.text = 'from somewhere';

      await createService().handleChange();

      expect(repository.records[0]?.source).toEqual({ app: null, exe: null, url: null });
    });

    it('notifies onRecorded with the stored clip and whether it is new', async () => {
      io.text = 'hello';
      const service = createService();

      const first = await service.handleChange();
      const second = await service.handleChange();

      expect(onRecorded.mock.calls.map(([clip, created]) => [clip.copyCount, created])).toEqual([
        [1, true],
        [2, false],
      ]);
      expect(first).toMatchObject({ status: 'recorded', created: true });
      expect(second).toMatchObject({ status: 'recorded', created: false });
    });

    it('works without an onRecorded callback', async () => {
      io.text = 'hello';
      const service = new CaptureService({ io, probe, repository, settings: () => settings });

      await expect(service.handleChange()).resolves.toMatchObject({ status: 'recorded' });
    });

    it('defaults to the system clock when no clock is injected', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(42);
      io.text = 'hello';
      const service = new CaptureService({ io, probe, repository, settings: () => settings });

      await service.handleChange();

      expect(repository.records[0]?.copiedAt).toBe(42);
    });

    it('reads the settings on every change, so pausing takes effect immediately', async () => {
      io.text = 'hello';
      const service = createService();
      await service.handleChange();

      settings = settingsWith({ captureEnabled: false });

      await expect(service.handleChange()).resolves.toEqual({
        status: 'skipped',
        reason: 'paused',
      });
    });
  });

  describe('pruning', () => {
    it('prunes to maxClips after a new clip is created', async () => {
      io.text = 'new text';

      await createService().handleChange();

      expect(repository.prune).toHaveBeenCalledExactlyOnceWith(500);
    });

    it('does not prune when an existing clip is only bumped', async () => {
      io.text = 'same text';
      const service = createService();
      await service.handleChange();
      repository.prune.mockClear();

      await service.handleChange();

      expect(repository.prune).not.toHaveBeenCalled();
    });

    it('does not prune when nothing was recorded', async () => {
      io.text = '   ';

      await createService().handleChange();

      expect(repository.prune).not.toHaveBeenCalled();
    });
  });

  describe('skipping', () => {
    it('skips everything while capture is paused, without reading the clipboard', async () => {
      settings = settingsWith({ captureEnabled: false });
      io.text = 'secret';

      const outcome = await createService().handleChange();

      expect(outcome).toEqual({ status: 'skipped', reason: 'paused' });
      expect(io.readText).not.toHaveBeenCalled();
      expect(repository.record).not.toHaveBeenCalled();
    });

    it('never reads text marked private by a password manager', async () => {
      io.text = 'hunter2';
      probe.result = { exe: null, url: null, hasPrivateFormat: true };

      const outcome = await createService().handleChange();

      expect(outcome).toEqual({ status: 'skipped', reason: 'private-format' });
      expect(io.readText).not.toHaveBeenCalled();
      expect(repository.record).not.toHaveBeenCalled();
      expect(onRecorded).not.toHaveBeenCalled();
    });

    it('skips excluded apps, comparing executable names case-insensitively', async () => {
      io.text = 'password';
      probe.result = { exe: 'keepassxc.EXE', url: null, hasPrivateFormat: false };

      const outcome = await createService().handleChange();

      expect(outcome).toEqual({ status: 'skipped', reason: 'excluded-app' });
      expect(repository.record).not.toHaveBeenCalled();
    });

    it('skips empty and whitespace-only text', async () => {
      io.text = ' \r\n\t';

      await expect(createService().handleChange()).resolves.toEqual({
        status: 'skipped',
        reason: 'empty',
      });
    });

    it('skips text above the size limit', async () => {
      io.text = 'x'.repeat(MAX_CLIP_CHARS + 1);

      await expect(createService().handleChange()).resolves.toEqual({
        status: 'skipped',
        reason: 'too-large',
      });
    });

    it('records text of exactly the size limit', async () => {
      io.text = 'x'.repeat(MAX_CLIP_CHARS);

      await expect(createService().handleChange()).resolves.toMatchObject({ status: 'recorded' });
    });
  });

  describe('self-write suppression (write marker)', () => {
    it('writes the text together with a fresh random marker token', async () => {
      const service = createService();
      await service.writeWithoutRecording('restored');
      await service.writeWithoutRecording('again');

      const tokens = io.writeText.mock.calls.map(([, marker]) => marker);
      expect(io.writeText.mock.calls.map(([text]) => text)).toEqual(['restored', 'again']);
      expect(tokens).toEqual([
        expect.stringMatching(/^[0-9a-f]{32}$/),
        expect.stringMatching(/^[0-9a-f]{32}$/),
      ]);
      expect(tokens[0]).not.toBe(tokens[1]);
    });

    it('does not record the change caused by its own write', async () => {
      const service = createService();
      await service.writeWithoutRecording('restored');

      const outcome = await service.handleChange();

      expect(outcome).toEqual({ status: 'skipped', reason: 'self-write' });
      expect(repository.record).not.toHaveBeenCalled();
    });

    it('suppresses every notification of its own write (Windows can send several)', async () => {
      const service = createService();
      await service.writeWithoutRecording('restored');

      await expect(service.handleChange()).resolves.toMatchObject({ reason: 'self-write' });
      await expect(service.handleChange()).resolves.toMatchObject({ reason: 'self-write' });
    });

    it('records an identical copy made by another app after the restore', async () => {
      const service = createService();
      await service.writeWithoutRecording('restored');
      await service.handleChange();

      io.text = 'restored'; // another app copies the same text: no marker
      const outcome = await service.handleChange();

      expect(outcome).toMatchObject({ status: 'recorded' });
      expect(repository.records.map((record) => record.content)).toEqual(['restored']);
    });

    it('records a different text that replaced the restore before its change was handled', async () => {
      const service = createService();
      await service.writeWithoutRecording('restored');

      io.text = 'copied elsewhere';
      await expect(service.handleChange()).resolves.toMatchObject({ status: 'recorded' });
    });

    it('never matches a marker token it did not write', async () => {
      const service = createService();
      await service.writeWithoutRecording('restored');
      io.marker = 'f'.repeat(32);

      await expect(service.handleChange()).resolves.toMatchObject({ status: 'recorded' });
    });

    it('records a change whose marker cannot be read (no heuristic fallback)', async () => {
      const service = createService();
      await service.writeWithoutRecording('restored');
      io.readWriteMarker.mockResolvedValue(null);

      // Only a harmless bump of the restored clip: nothing private, nothing lost.
      await expect(service.handleChange()).resolves.toMatchObject({ status: 'recorded' });
    });

    it('forgets a token once its time is up', async () => {
      let now = NOW;
      const service = createService({ now: () => now });
      await service.writeWithoutRecording('restored');
      now += SELF_WRITE_TTL_MS + 1;

      await expect(service.handleChange()).resolves.toMatchObject({ status: 'recorded' });
    });

    it('keeps nothing from a failed write', async () => {
      const service = createService();
      io.writeText.mockRejectedValueOnce(new Error('OpenClipboard failed'));
      await expect(service.writeWithoutRecording('restored')).rejects.toThrow('OpenClipboard');

      io.text = 'restored';
      await expect(service.handleChange()).resolves.toMatchObject({ status: 'recorded' });
    });

    it('still skips a private copy that arrives after a restore', async () => {
      const service = createService();
      await service.writeWithoutRecording('restored');
      io.text = 'hunter2';
      probe.result = { exe: null, url: null, hasPrivateFormat: true };

      await expect(service.handleChange()).resolves.toEqual({
        status: 'skipped',
        reason: 'private-format',
      });
    });
  });

  describe('composed text (joined clips, text read from a screenshot)', () => {
    const JOINED = 'first\nsecond';

    it('is skipped by its marker like any own write', async () => {
      const service = createService();
      await service.writeComposedText(JOINED);

      await expect(service.handleChange()).resolves.toEqual({
        status: 'skipped',
        reason: 'self-write',
      });
      expect(repository.record).not.toHaveBeenCalled();
    });

    it('is recorded once when its change arrives after the token expired, like a restore', async () => {
      let now = NOW;
      const service = createService({ now: () => now });
      await service.writeComposedText(JOINED);
      now += SELF_WRITE_TTL_MS + 1;

      await expect(service.handleChange()).resolves.toMatchObject({ status: 'recorded' });
      expect(repository.records.map((record) => record.content)).toEqual([JOINED]);
    });

    it('is recorded once, as an ordinary clip, when its marker cannot be read (known limit)', async () => {
      const clipboard = new SystemClipboard();
      const service = createService({ io: clipboard.io, probe: clipboard.probe });
      await service.writeComposedText(JOINED);
      vi.spyOn(clipboard.io, 'readWriteMarker').mockResolvedValue(null);

      // It is what the user just copied; no content guess that could swallow a real copy.
      await expect(service.handleChange()).resolves.toMatchObject({
        status: 'recorded',
        created: true,
      });
      expect(repository.records.map((record) => record.content)).toEqual([JOINED]);
    });

    it('leaves nothing behind from a failed write', async () => {
      const service = createService();
      io.writeText.mockRejectedValueOnce(new Error('OpenClipboard failed'));
      await expect(service.writeComposedText(JOINED)).rejects.toThrow('OpenClipboard');

      io.text = JOINED;
      await expect(service.handleChange()).resolves.toMatchObject({ status: 'recorded' });
    });

    describe('an identical copy from another app is always recorded', () => {
      let clipboard: SystemClipboard;
      let now: number;
      let service: CaptureService;

      beforeEach(() => {
        clipboard = new SystemClipboard();
        now = NOW;
        service = createService({ io: clipboard.io, probe: clipboard.probe, now: () => now });
      });

      it('right after the composed write, before its own report', async () => {
        await service.writeComposedText(JOINED);
        clipboard.copy(JOINED, { exe: 'notepad.exe' });

        await expect(service.handleChange()).resolves.toMatchObject({ status: 'recorded' });
      });

      it('after the composed write was skipped', async () => {
        await service.writeComposedText(JOINED);
        await expect(service.handleChange()).resolves.toMatchObject({ reason: 'self-write' });

        clipboard.copy(JOINED, { exe: 'notepad.exe' });
        await expect(service.handleChange()).resolves.toMatchObject({ status: 'recorded' });
        expect(repository.records.map((record) => record.content)).toEqual([JOINED]);
      });

      it('a day later, and after a restore in between', async () => {
        await service.writeComposedText(JOINED);
        await expect(service.handleChange()).resolves.toMatchObject({ reason: 'self-write' });
        await service.writeWithoutRecording('restored');
        await expect(service.handleChange()).resolves.toMatchObject({ reason: 'self-write' });
        now += 24 * 60 * 60 * 1_000;

        clipboard.copy(JOINED, { exe: 'notepad.exe' });
        await expect(service.handleChange()).resolves.toMatchObject({ status: 'recorded' });
      });

      it('without clipboard versions too (the portable fallback)', async () => {
        const portable = createService();
        await portable.writeComposedText(JOINED);
        await expect(portable.handleChange()).resolves.toMatchObject({ reason: 'self-write' });

        io.text = JOINED; // copied in another app: no marker
        await expect(portable.handleChange()).resolves.toMatchObject({ status: 'recorded' });
      });
    });

    it('treats restores the same way (a missed marker is a harmless bump)', async () => {
      const service = createService();
      await service.writeWithoutRecording('restored');
      io.readWriteMarker.mockResolvedValue(null);

      await expect(service.handleChange()).resolves.toMatchObject({ status: 'recorded' });
    });
  });

  describe('privacy markers that cannot be read (another app holds the clipboard open)', () => {
    let clipboard: SystemClipboard;
    let sleeps: number[];
    /** Runs at each retry pause; a test uses it to clear the lock, copy again, etc. */
    let duringPause: () => void;

    const service = (): CaptureService =>
      createService({
        io: clipboard.io,
        probe: clipboard.probe,
        sleep: (ms) => {
          sleeps.push(ms);
          duringPause();
          return Promise.resolve();
        },
      });

    beforeEach(() => {
      clipboard = new SystemClipboard();
      sleeps = [];
      duringPause = () => undefined;
    });

    it('regression: a private copy is not recorded when the lock clears without a version change', async () => {
      clipboard.copy('hunter2', { exe: 'KeePassXC.exe', hasPrivateFormat: true });
      clipboard.locked = true;
      duringPause = () => {
        clipboard.locked = false; // same sequence number: only the lock went away
      };

      const outcome = await service().handleChange();

      expect(outcome).toEqual({ status: 'skipped', reason: 'private-format' });
      expect(clipboard.reads).toBe(0);
      expect(repository.record).not.toHaveBeenCalled();
    });

    it('records an ordinary copy once the markers become readable, with the re-probed owner', async () => {
      clipboard.copy('ordinary text', { exe: 'Code.exe' });
      clipboard.locked = true;
      let pauses = 0;
      duringPause = () => {
        if (++pauses === 2) clipboard.locked = false;
      };

      const outcome = await service().handleChange();

      expect(outcome).toMatchObject({ status: 'recorded' });
      expect(repository.records.map((r) => [r.content, r.source.exe])).toEqual([
        ['ordinary text', 'Code.exe'],
      ]);
    });

    it('drops the change, unread, when privacy stays unknown after a bounded wait', async () => {
      clipboard.copy('maybe a password', { exe: 'Unknown.exe' });
      clipboard.locked = true;

      const outcome = await service().handleChange();

      expect(outcome).toEqual({ status: 'skipped', reason: 'privacy-unknown' });
      expect(sleeps).toEqual([...PRIVACY_RETRY_DELAYS_MS]);
      expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(500);
      expect(clipboard.reads).toBe(0);
      expect(repository.record).not.toHaveBeenCalled();
    });

    it('drops the change as superseded when the clipboard changes during the wait', async () => {
      clipboard.copy('hunter2', { hasPrivateFormat: true });
      clipboard.locked = true;
      duringPause = () => {
        clipboard.locked = false;
        clipboard.copy('next copy'); // has its own notification
      };

      const outcome = await service().handleChange();

      expect(outcome).toEqual({ status: 'skipped', reason: 'superseded' });
      expect(clipboard.reads).toBe(0);
    });

    it('drops the change at once where there is no clipboard version to bind a retry to', async () => {
      probe.result = { exe: null, url: null, hasPrivateFormat: true, privacyUnreadable: true };
      io.text = 'maybe a password';
      const sleep = vi.fn(() => Promise.resolve());

      const outcome = await createService({ sleep }).handleChange();

      expect(outcome).toEqual({ status: 'skipped', reason: 'privacy-unknown' });
      expect(sleep).not.toHaveBeenCalled();
      expect(io.readText).not.toHaveBeenCalled();
    });

    it('fails closed even for code that only looks at hasPrivateFormat', async () => {
      clipboard.copy('', {});
      clipboard.locked = true;
      const captureClipboard = vi.fn();

      const outcome = await createService({
        io: clipboard.io,
        probe: clipboard.probe,
        sleep: () => Promise.resolve(),
        images: { captureClipboard },
      }).handleChange();

      expect(outcome).toEqual({ status: 'skipped', reason: 'privacy-unknown' });
      expect(captureClipboard).not.toHaveBeenCalled();
    });
  });

  describe('self-write suppression bound to the clipboard change', () => {
    let clipboard: SystemClipboard;
    let service: CaptureService;

    beforeEach(() => {
      clipboard = new SystemClipboard();
      service = createService({ io: clipboard.io, probe: clipboard.probe });
    });

    it('ignores the change its own write made', async () => {
      await service.writeWithoutRecording('restored');

      await expect(service.handleChange()).resolves.toEqual({
        status: 'skipped',
        reason: 'self-write',
      });
    });

    it('runs other writes (image restores) in the same chain, one at a time and in call order', async () => {
      const order: string[] = [];
      let releaseImage!: () => void;
      const markers: string[] = [];
      const image = service.writeMarked(async (marker) => {
        order.push('image:start');
        markers.push(marker);
        await new Promise<void>((resolve) => {
          releaseImage = resolve;
        });
        order.push('image:end');
        return 'written';
      });
      const text = service.writeWithoutRecording('restored').then(() => order.push('text'));

      await vi.waitFor(() => expect(order).toEqual(['image:start']));
      releaseImage();
      await expect(image).resolves.toBe('written');
      await text;
      expect(order).toEqual(['image:start', 'image:end', 'text']);
      expect(markers).toEqual([expect.stringMatching(/^[0-9a-f]{32}$/)]);
    });

    it('does not let a failed marked write block the chain', async () => {
      await expect(
        service.writeMarked(() => Promise.reject(new Error('clipboard locked'))),
      ).rejects.toThrow('clipboard locked');

      await service.writeWithoutRecording('restored');
      await expect(service.handleChange()).resolves.toEqual({
        status: 'skipped',
        reason: 'self-write',
      });
    });

    it('records an external copy of identical text made after a restore', async () => {
      await service.writeWithoutRecording('restored');
      await service.handleChange(); // the restore's own change

      clipboard.copy('restored', { exe: 'chrome.exe' });
      const outcome = await service.handleChange();

      expect(outcome).toMatchObject({ status: 'recorded' });
      expect(repository.records.map((r) => r.source.exe)).toEqual(['chrome.exe']);
    });

    it('records an identical external copy even when the restore change was never reported', async () => {
      await service.writeWithoutRecording('restored');
      // The listener merged the restore's notification into this one (debounce).
      clipboard.copy('restored', { exe: 'chrome.exe' });

      await expect(service.handleChange()).resolves.toMatchObject({ status: 'recorded' });
    });

    it('leaves nothing behind when the write fails, so the next real copy is recorded', async () => {
      clipboard.failWrites = true;
      await expect(service.writeWithoutRecording('restored')).rejects.toThrow(
        'OpenClipboard failed',
      );

      clipboard.copy('restored', { exe: 'chrome.exe' });
      await expect(service.handleChange()).resolves.toMatchObject({ status: 'recorded' });
    });

    it('a failed write does not block later writes', async () => {
      const writer = createService({
        io: {
          readText: () => clipboard.io.readText(),
          readWriteMarker: () => clipboard.io.readWriteMarker(),
          writeText: (text, marker) =>
            text === 'first'
              ? Promise.reject(new Error('OpenClipboard failed'))
              : clipboard.io.writeText(text, marker),
        },
        probe: clipboard.probe,
      });
      const failed = writer.writeWithoutRecording('first');
      const later = writer.writeWithoutRecording('second');

      await expect(failed).rejects.toThrow('OpenClipboard failed');
      await expect(later).resolves.toBeUndefined();
      await expect(clipboard.io.readText()).resolves.toBe('second');
    });

    it('overlapping restores: ignores the change of the last one, then records a re-copy of the first', async () => {
      const first = service.writeWithoutRecording('A');
      const second = service.writeWithoutRecording('B');
      await Promise.all([first, second]);

      // One notification for both writes (debounced): it is the second write's change.
      await expect(service.handleChange()).resolves.toMatchObject({ reason: 'self-write' });
      clipboard.copy('A', { exe: 'Code.exe' });
      await expect(service.handleChange()).resolves.toMatchObject({ status: 'recorded' });
    });

    it('serializes app writes: the second starts only after the first has finished', async () => {
      const calls: string[] = [];
      const firstWrite = deferred<undefined>();
      const io: ClipboardIO = {
        readText: () => Promise.resolve(''),
        readWriteMarker: () => Promise.resolve(null),
        writeText: vi.fn((text: string) => {
          calls.push(`start ${text}`);
          return text === 'A'
            ? firstWrite.promise.then(() => {
                calls.push('end A');
              })
            : Promise.resolve();
        }),
      };
      const writer = createService({ io });

      const a = writer.writeWithoutRecording('A');
      const b = writer.writeWithoutRecording('B');
      await flushMicrotasks();
      expect(calls).toEqual(['start A']);

      firstWrite.resolve(undefined);
      await Promise.all([a, b]);
      expect(calls).toEqual(['start A', 'end A', 'start B']);
    });
  });

  describe('self-write suppression without a clipboard version (polling)', () => {
    let now: number;

    beforeEach(() => {
      now = NOW;
    });

    const service = (): CaptureService => createService({ now: () => now });

    it('keeps a token live for a bounded time after its write', async () => {
      const capture = service();
      await capture.writeWithoutRecording('restored');

      now += SELF_WRITE_TTL_MS - 1;
      await expect(capture.handleChange()).resolves.toMatchObject({ reason: 'self-write' });
      now += 2;
      await expect(capture.handleChange()).resolves.toMatchObject({ status: 'recorded' });
    });

    it('overlapping restores: the poll sees only the last one, and then nothing is suppressed', async () => {
      const capture = service();
      await Promise.all([capture.writeWithoutRecording('A'), capture.writeWithoutRecording('B')]);

      const own = await capture.handleChange(); // a poll sees only what is on the clipboard now: B
      io.text = 'A';
      const externalA = await capture.handleChange();
      io.text = 'B';
      const externalB = await capture.handleChange();

      expect(own).toEqual({ status: 'skipped', reason: 'self-write' });
      expect(externalA).toMatchObject({ status: 'recorded' });
      expect(externalB).toMatchObject({ status: 'recorded' });
    });

    it('restores whose changes are seen one by one are each ignored', async () => {
      const capture = service();
      await capture.writeWithoutRecording('A');
      const a = await capture.handleChange();
      await capture.writeWithoutRecording('B');
      const b = await capture.handleChange();
      io.text = 'A';
      const external = await capture.handleChange();

      expect([a, b]).toEqual([
        { status: 'skipped', reason: 'self-write' },
        { status: 'skipped', reason: 'self-write' },
      ]);
      expect(external).toMatchObject({ status: 'recorded' });
    });

    it('recognises a change reported while its write was still running', async () => {
      const write = deferred<undefined>();
      io.writeText.mockImplementationOnce((text, marker) => {
        io.text = text; // on the clipboard already; the call returns later
        io.marker = marker ?? null;
        return write.promise;
      });
      const capture = service();
      const restoring = capture.writeWithoutRecording('restored');
      await flushMicrotasks();

      const outcome = capture.handleChange();
      await flushMicrotasks();
      write.resolve(undefined);
      await restoring;

      await expect(outcome).resolves.toEqual({ status: 'skipped', reason: 'self-write' });
    });

    it('a capture that started before a restore never matches it', async () => {
      const markerRead = deferred<string | null>();
      io.readWriteMarker.mockReturnValueOnce(markerRead.promise);
      io.text = 'same text'; // another app's copy
      const capture = service();

      const external = capture.handleChange(); // reported before the restore below
      await flushMicrotasks();
      await capture.writeWithoutRecording('same text');
      markerRead.resolve(io.marker); // the read lands on the restore's clipboard state

      // The reported copy was replaced by the restore: dropped, never mistaken for the restore.
      await expect(external).resolves.toEqual({ status: 'skipped', reason: 'superseded' });
      // The restore's own change is still recognised.
      await expect(capture.handleChange()).resolves.toMatchObject({ reason: 'self-write' });
      expect(repository.record).not.toHaveBeenCalled();
    });

    it('drops a change whose marker moved while the text was read', async () => {
      const read = deferred<string>();
      io.readText.mockReturnValueOnce(read.promise);
      io.text = 'external';
      const capture = service();

      const external = capture.handleChange();
      await flushMicrotasks();
      await capture.writeWithoutRecording('restored');
      read.resolve('external');

      await expect(external).resolves.toEqual({ status: 'skipped', reason: 'superseded' });
    });
  });

  describe('pause during an in-flight capture (capture generation)', () => {
    let gate: CaptureGate;

    beforeEach(() => {
      gate = new CaptureGate();
    });

    const pause = (): void => {
      settings = settingsWith({ captureEnabled: false });
      gate.invalidate();
    };
    const resume = (): void => {
      settings = settingsWith({ captureEnabled: true });
      gate.invalidate();
    };

    it('records nothing when capture is paused during the privacy retry', async () => {
      const clipboard = new SystemClipboard();
      clipboard.copy('ordinary text', { exe: 'Code.exe' });
      clipboard.locked = true;
      const service = createService({
        io: clipboard.io,
        probe: clipboard.probe,
        gate,
        sleep: () => {
          pause();
          clipboard.locked = false;
          return Promise.resolve();
        },
      });

      await expect(service.handleChange()).resolves.toEqual({
        status: 'skipped',
        reason: 'paused',
      });
      expect(repository.record).not.toHaveBeenCalled();
    });

    it('records nothing when capture is paused and resumed while the text is read', async () => {
      const read = deferred<string>();
      io.readText.mockReturnValueOnce(read.promise);
      io.text = 'copied before the pause';
      const service = createService({ gate });

      const outcome = service.handleChange();
      await flushMicrotasks();
      pause();
      resume(); // capture is on again, but this change belongs to the old generation
      read.resolve('copied before the pause');

      await expect(outcome).resolves.toEqual({ status: 'skipped', reason: 'paused' });
      expect(repository.record).not.toHaveBeenCalled();
    });

    it('records a change reported after resuming', async () => {
      const service = createService({ gate });
      pause();
      resume();
      io.text = 'new copy';

      await expect(service.handleChange()).resolves.toMatchObject({ status: 'recorded' });
    });

    it('hands screenshot capture a record check that fails after a pause', async () => {
      io.text = '';
      const checks: boolean[] = [];
      const captureClipboard = vi.fn<CaptureImages['captureClipboard']>(({ canRecord }) => {
        checks.push(canRecord());
        pause(); // while the image is being decoded and saved
        checks.push(canRecord());
        return Promise.resolve({ status: 'skipped', reason: 'paused' });
      });
      const service = createService({ gate, images: { captureClipboard } });

      await expect(service.handleChange()).resolves.toEqual({
        status: 'skipped',
        reason: 'paused',
      });
      expect(checks).toEqual([true, false]);
    });
  });

  describe('acknowledgments (onHandled)', () => {
    it('reports each handled change with its clipboard version and outcome', async () => {
      const onHandled = vi.fn<NonNullable<CaptureDeps['onHandled']>>();
      probe.sequence = 7;
      io.text = 'hello';
      const service = createService({ onHandled });

      await service.handleChange();
      probe.sequence = 8;
      probe.result = { exe: null, url: null, hasPrivateFormat: true };
      await service.handleChange();
      await flushMicrotasks();

      expect(onHandled.mock.calls).toEqual([
        [7, expect.objectContaining({ status: 'recorded' })],
        [8, { status: 'skipped', reason: 'private-format' }],
      ]);
    });

    it('reports a change whose processing failed as an error', async () => {
      const onHandled = vi.fn<NonNullable<CaptureDeps['onHandled']>>();
      io.text = 'hello';
      repository.record.mockImplementationOnce(() => {
        throw new Error('disk full');
      });
      const service = createService({ onHandled });

      await expect(service.handleChange()).rejects.toThrow('disk full');
      await flushMicrotasks();
      expect(onHandled).toHaveBeenCalledExactlyOnceWith(null, 'error');
    });
  });

  describe('ordering and probing', () => {
    it('probes the clipboard owner synchronously when the change is reported', () => {
      const service = createService();

      void service.handleChange();

      expect(probe.probe).toHaveBeenCalledTimes(1);
      expect(io.readText).not.toHaveBeenCalled();
    });

    it('attributes each change to the owner at notification time, not processing time', async () => {
      const reads = [deferred<string>(), deferred<string>()];
      io.readText.mockReturnValueOnce(reads[0]!.promise).mockReturnValueOnce(reads[1]!.promise);
      const service = createService();

      probe.result = { exe: 'Code.exe', url: null, hasPrivateFormat: false };
      const first = service.handleChange();
      probe.result = { exe: 'slack.exe', url: null, hasPrivateFormat: false };
      const second = service.handleChange();
      probe.result = { exe: 'explorer.exe', url: null, hasPrivateFormat: false };
      reads[0]!.resolve('from code');
      reads[1]!.resolve('from slack');
      await Promise.all([first, second]);

      expect(repository.records.map((record) => [record.content, record.source.app])).toEqual([
        ['from code', 'VS Code'],
        ['from slack', 'Slack'],
      ]);
    });

    it('processes changes strictly one at a time, in arrival order', async () => {
      const reads = [deferred<string>(), deferred<string>(), deferred<string>()];
      for (const read of reads) io.readText.mockReturnValueOnce(read.promise);
      const service = createService();

      const outcomes = [service.handleChange(), service.handleChange(), service.handleChange()];
      await flushMicrotasks();
      // Only the first read may be in flight while it is pending.
      expect(io.readText).toHaveBeenCalledTimes(1);

      reads[2]!.resolve('third');
      reads[1]!.resolve('second');
      reads[0]!.resolve('first');
      await Promise.all(outcomes);

      expect(io.readText).toHaveBeenCalledTimes(3);
      expect(repository.records.map((record) => record.content)).toEqual([
        'first',
        'second',
        'third',
      ]);
    });

    it('keeps processing later changes after one of them fails', async () => {
      io.readText.mockRejectedValueOnce(new Error('clipboard busy'));
      io.text = 'next copy';
      const service = createService();

      const failed = service.handleChange();
      const next = service.handleChange();

      await expect(failed).rejects.toThrow('clipboard busy');
      await expect(next).resolves.toMatchObject({ status: 'recorded' });
    });

    it('propagates a repository failure to the caller of that change only', async () => {
      io.text = 'boom';
      repository.record.mockImplementationOnce(() => {
        throw new Error('disk full');
      });
      const service = createService();

      await expect(service.handleChange()).rejects.toThrow('disk full');
      await expect(service.handleChange()).resolves.toMatchObject({ status: 'recorded' });
    });
  });

  describe('clipboard version binding (private-copy race)', () => {
    let clipboard: SystemClipboard;
    let service: CaptureService;

    beforeEach(() => {
      clipboard = new SystemClipboard();
      service = createService({ io: clipboard.io, probe: clipboard.probe });
    });

    it('records text together with the owner of the same clipboard version', async () => {
      clipboard.copy('ordinary text', { exe: 'Code.exe' });

      await expect(service.handleChange()).resolves.toMatchObject({ status: 'recorded' });
      expect(repository.records.map((r) => [r.content, r.source.exe])).toEqual([
        ['ordinary text', 'Code.exe'],
      ]);
    });

    it('never stores a password copied while older changes wait in the queue', async () => {
      const release = clipboard.holdReads();
      clipboard.copy('first', { exe: 'Code.exe' });
      const first = service.handleChange();
      clipboard.copy('ordinary text', { exe: 'Code.exe' });
      const queued = service.handleChange();
      clipboard.copy('hunter2', { exe: 'KeePassXC.exe', hasPrivateFormat: true });
      const password = service.handleChange();

      release();

      await expect(first).resolves.toEqual({ status: 'skipped', reason: 'superseded' });
      await expect(queued).resolves.toEqual({ status: 'skipped', reason: 'superseded' });
      await expect(password).resolves.toEqual({ status: 'skipped', reason: 'private-format' });
      expect(repository.records).toEqual([]);
    });

    it('drops text whose clipboard changed while it was being read', async () => {
      const release = clipboard.holdReads();
      clipboard.copy('ordinary text', { exe: 'Code.exe' });
      const ordinary = service.handleChange();
      await flushMicrotasks(); // the read for "ordinary text" is now in flight

      clipboard.copy('hunter2', { hasPrivateFormat: true });
      release();

      await expect(ordinary).resolves.toEqual({ status: 'skipped', reason: 'superseded' });
      expect(repository.records).toEqual([]);
    });

    it('records the newer copy through its own notification after dropping the older one', async () => {
      const release = clipboard.holdReads();
      clipboard.copy('older', { exe: 'Code.exe' });
      const older = service.handleChange();
      clipboard.copy('newer', { exe: 'slack.exe' });
      const newer = service.handleChange();
      release();
      await Promise.all([older, newer]);

      expect(repository.records.map((r) => [r.content, r.source.exe])).toEqual([
        ['newer', 'slack.exe'],
      ]);
    });

    it('gives a comparison snapshot the text and source of one version, re-reading if needed', async () => {
      const release = clipboard.holdReads();
      clipboard.copy('left side', { exe: 'Code.exe' });
      const snapshot = service.snapshot();
      await flushMicrotasks();

      clipboard.copy('right side', { exe: 'slack.exe' });
      release();

      await expect(snapshot).resolves.toEqual({
        content: 'right side',
        source: { app: 'Slack', exe: 'slack.exe', url: null },
      });
    });

    it('gives up on a snapshot when the clipboard never holds still', async () => {
      const probe = { ...clipboard.probe, sequenceNumber: vi.fn(() => Math.random()) };

      await expect(createService({ io: clipboard.io, probe }).snapshot()).rejects.toThrow(
        'The clipboard kept changing while it was being read',
      );
    });
  });

  describe('snapshot', () => {
    it('returns the current clipboard text with its mapped source', async () => {
      io.text = 'left side';
      probe.result = { exe: 'msedge.exe', url: 'https://example.com', hasPrivateFormat: false };

      const snapshot = await createService().snapshot();

      expect(snapshot).toEqual({
        content: 'left side',
        source: { app: 'Edge', exe: 'msedge.exe', url: 'https://example.com' },
      });
    });

    it('does not record anything', async () => {
      io.text = 'left side';

      await createService().snapshot();

      expect(repository.record).not.toHaveBeenCalled();
      expect(onRecorded).not.toHaveBeenCalled();
    });
  });

  describe('screenshots (a change without text)', () => {
    const imageClip: Clip = {
      id: 77,
      content: 'Image 800×600',
      kind: 'image',
      charCount: 0,
      lineCount: 0,
      firstCopiedAt: NOW,
      lastCopiedAt: NOW,
      copyCount: 1,
      pinned: false,
      source: { app: 'Snipping Tool', exe: 'SnippingTool.exe', url: null },
      categories: [],
    };
    let images: {
      captureClipboard: ReturnType<
        typeof vi.fn<NonNullable<CaptureDeps['images']>['captureClipboard']>
      >;
    };

    beforeEach(() => {
      images = {
        captureClipboard: vi.fn(() =>
          Promise.resolve({ status: 'recorded' as const, clip: imageClip, created: true }),
        ),
      };
      io.text = '';
      probe.result = { exe: 'SnippingTool.exe', url: null, hasPrivateFormat: false };
      probe.sequence = 5;
    });

    it('hands the change to screenshot capture with its source and time, then prunes and reports it', async () => {
      const outcome = await createService({ images }).handleChange();

      expect(outcome).toEqual({ status: 'recorded', clip: imageClip, created: true });
      expect(images.captureClipboard).toHaveBeenCalledExactlyOnceWith({
        source: { app: 'SnippingTool', exe: 'SnippingTool.exe', url: null },
        copiedAt: NOW,
        isCurrent: expect.any(Function) as () => boolean,
        canRecord: expect.any(Function) as () => boolean,
      });
      expect(repository.prune).toHaveBeenCalledExactlyOnceWith(500);
      expect(onRecorded).toHaveBeenCalledExactlyOnceWith(imageClip, true);
      expect(repository.record).not.toHaveBeenCalled();
    });

    it('binds the image to the probed clipboard version', async () => {
      await createService({ images }).handleChange();
      const isCurrent = images.captureClipboard.mock.calls[0]?.[0].isCurrent;

      expect(await isCurrent?.()).toBe(true);
      probe.sequence = 6;
      expect(await isCurrent?.()).toBe(false);
    });

    it('without a clipboard version, binds the image to the write marker seen with the text', async () => {
      probe.sequence = null;
      await createService({ images }).handleChange();
      const isCurrent = images.captureClipboard.mock.calls[0]?.[0].isCurrent;

      expect(await isCurrent?.()).toBe(true);
      // A restore replaced the image while the capture waited for the image queue.
      io.marker = 'b'.repeat(32);
      expect(await isCurrent?.()).toBe(false);
    });

    it('does not prune for an image copied again', async () => {
      images.captureClipboard.mockResolvedValueOnce({
        status: 'recorded',
        clip: { ...imageClip, copyCount: 2 },
        created: false,
      });

      await createService({ images }).handleChange();

      expect(repository.prune).not.toHaveBeenCalled();
      expect(onRecorded).toHaveBeenCalledWith(expect.objectContaining({ copyCount: 2 }), false);
    });

    it('reports a change with neither text nor image as empty, and other image skips by name', async () => {
      images.captureClipboard.mockResolvedValueOnce({ status: 'skipped', reason: 'no-image' });
      images.captureClipboard.mockResolvedValueOnce({ status: 'skipped', reason: 'too-small' });
      const service = createService({ images });

      await expect(service.handleChange()).resolves.toEqual({ status: 'skipped', reason: 'empty' });
      await expect(service.handleChange()).resolves.toEqual({
        status: 'skipped',
        reason: 'image-too-small',
      });
      expect(onRecorded).not.toHaveBeenCalled();
    });

    it('never asks for the image of a private or excluded copy', async () => {
      const service = createService({ images });
      probe.result = { exe: 'Bitwarden.exe', url: null, hasPrivateFormat: true };
      await expect(service.handleChange()).resolves.toEqual({
        status: 'skipped',
        reason: 'private-format',
      });
      probe.result = { exe: 'KeePassXC.exe', url: null, hasPrivateFormat: false };
      await expect(service.handleChange()).resolves.toEqual({
        status: 'skipped',
        reason: 'excluded-app',
      });

      expect(images.captureClipboard).not.toHaveBeenCalled();
    });

    it('skips the change of its own image restore by its marker, before reading the image', async () => {
      const service = createService({ images });
      await service.writeMarked((marker) => {
        io.text = '';
        io.marker = marker; // an image restore: no text, the marker in the same write
        return Promise.resolve();
      });

      await expect(service.handleChange()).resolves.toEqual({
        status: 'skipped',
        reason: 'self-write',
      });
      expect(images.captureClipboard).not.toHaveBeenCalled();
    });

    it('does not capture images while capture is paused', async () => {
      settings = settingsWith({ captureEnabled: false });

      await createService({ images }).handleChange();

      expect(images.captureClipboard).not.toHaveBeenCalled();
    });

    it('still skips empty text as empty without screenshot capture', async () => {
      await expect(createService().handleChange()).resolves.toEqual({
        status: 'skipped',
        reason: 'empty',
      });
    });
  });
});
