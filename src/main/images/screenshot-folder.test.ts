import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '../test-support/fakes';
import {
  isScreenshotCandidate,
  parseScreenshotLocation,
  resolveScreenshotFolder,
  ScreenshotFolderWatcher,
  type FileFacts,
} from './screenshot-folder';

const HOME = '/Users/me';
const DIR = '/Users/me/Screenshots';
const NOW = 1_764_000_000_000;
const SETTLE_MS = 400;

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('parseScreenshotLocation', () => {
  it('returns an absolute folder, trimmed of the newline `defaults` prints', () => {
    expect(parseScreenshotLocation('/Volumes/Shots\n', HOME)).toBe('/Volumes/Shots');
    expect(parseScreenshotLocation('  /Volumes/My Shots  ', HOME)).toBe('/Volumes/My Shots');
  });

  it('expands the home folder shorthand', () => {
    expect(parseScreenshotLocation('~', HOME)).toBe(HOME);
    expect(parseScreenshotLocation('~/Pictures/Screenshots', HOME)).toBe(
      '/Users/me/Pictures/Screenshots',
    );
  });

  it('rejects missing, empty and relative values', () => {
    expect(parseScreenshotLocation(null, HOME)).toBeNull();
    expect(parseScreenshotLocation('', HOME)).toBeNull();
    expect(parseScreenshotLocation('  \n', HOME)).toBeNull();
    expect(parseScreenshotLocation('Pictures', HOME)).toBeNull();
    expect(parseScreenshotLocation('~other/Pictures', HOME)).toBeNull();
  });
});

describe('resolveScreenshotFolder', () => {
  it('uses the configured folder', async () => {
    expect(await resolveScreenshotFolder(() => Promise.resolve('~/Shots\n'), HOME)).toBe(
      '/Users/me/Shots',
    );
  });

  it('falls back to the Desktop when the key was never set', async () => {
    expect(
      await resolveScreenshotFolder(() => Promise.reject(new Error('exit code 1')), HOME),
    ).toBe('/Users/me/Desktop');
    expect(await resolveScreenshotFolder(() => Promise.resolve(null), HOME)).toBe(
      '/Users/me/Desktop',
    );
  });

  it('falls back to the Desktop when the configured folder is relative', async () => {
    expect(await resolveScreenshotFolder(() => Promise.resolve('Shots'), HOME)).toBe(
      '/Users/me/Desktop',
    );
  });
});

describe('isScreenshotCandidate', () => {
  it('accepts PNG and JPEG files whatever the case of the extension', () => {
    expect(isScreenshotCandidate('Screenshot 2026-11-27 at 10.00.00.png')).toBe(true);
    expect(isScreenshotCandidate('shot.PNG')).toBe(true);
    expect(isScreenshotCandidate('shot.jpg')).toBe(true);
    expect(isScreenshotCandidate('shot.JPEG')).toBe(true);
  });

  it('skips the hidden temp file macOS writes before renaming it', () => {
    expect(isScreenshotCandidate('.Screenshot 2026-11-27 at 10.00.00.png')).toBe(false);
  });

  it('skips other file types', () => {
    expect(isScreenshotCandidate('shot.heic')).toBe(false);
    expect(isScreenshotCandidate('shot.tiff')).toBe(false);
    expect(isScreenshotCandidate('shot.png.pdf')).toBe(false);
    expect(isScreenshotCandidate('png')).toBe(false);
  });
});

/**
 * A folder whose files change only when the test says so. `whileSettling` runs during the
 * watcher's settle pause, which is where a file that is still being written grows.
 */
class FakeFolder {
  readonly files = new Map<string, FileFacts>();
  whileSettling: (() => void) | null = null;
  private listener: ((fileName: string) => void) | null = null;

  readonly stopWatching = vi.fn(() => {
    this.listener = null;
  });

  readonly watch = vi.fn((_dir: string, onName: (fileName: string) => void) => {
    this.listener = onName;
    return this.stopWatching;
  });

  readonly stat = vi.fn((path: string): Promise<FileFacts | null> =>
    Promise.resolve(this.files.get(path) ?? null),
  );

  readonly sleep = vi.fn<(ms: number) => Promise<void>>(() => {
    this.whileSettling?.();
    return Promise.resolve();
  });

  /** A file-system event for `fileName`, as `fs.watch` would deliver it. */
  emit(fileName: string): void {
    this.listener?.(fileName);
  }

  write(fileName: string, size: number, mtimeMs = NOW): void {
    this.files.set(`${DIR}/${fileName}`, { size, mtimeMs });
  }
}

describe('ScreenshotFolderWatcher', () => {
  let folder: FakeFolder;
  let onScreenshot: ReturnType<typeof vi.fn<(path: string, ticket: number) => void>>;
  let ticket: number;
  let watcher: ScreenshotFolderWatcher;

  beforeEach(() => {
    folder = new FakeFolder();
    onScreenshot = vi.fn();
    ticket = 0;
    watcher = new ScreenshotFolderWatcher(DIR, {
      ticket: () => ticket,
      watch: folder.watch,
      stat: folder.stat,
      sleep: folder.sleep,
      now: () => NOW,
      onScreenshot,
      settleMs: SETTLE_MS,
    });
    watcher.start();
  });

  it('watches the folder once, however often it is started', () => {
    watcher.start();
    expect(folder.watch).toHaveBeenCalledTimes(1);
    expect(folder.watch).toHaveBeenCalledWith(DIR, expect.any(Function));
  });

  it('reports a new screenshot once its size has settled', async () => {
    folder.write('shot.png', 2048);

    folder.emit('shot.png');
    await flushMicrotasks();

    expect(folder.sleep).toHaveBeenCalledWith(SETTLE_MS);
    expect(onScreenshot).toHaveBeenCalledExactlyOnceWith(`${DIR}/shot.png`, 0);
  });

  it('ignores files modified before the watcher started (allowing 1 s of mtime slack)', async () => {
    folder.write('old.png', 2048, NOW - 1_001);
    folder.write('borderline.png', 2048, NOW - 1_000);

    await watcher.consider('old.png');
    await watcher.consider('borderline.png');

    expect(onScreenshot).toHaveBeenCalledExactlyOnceWith(`${DIR}/borderline.png`, 0);
  });

  it('does not report a file that is still being written', async () => {
    folder.write('shot.png', 1024);
    folder.whileSettling = () => folder.write('shot.png', 4096);

    await watcher.consider('shot.png');

    expect(onScreenshot).not.toHaveBeenCalled();
  });

  it('reports it on a later event once the size stops changing', async () => {
    folder.write('shot.png', 1024);
    folder.whileSettling = () => folder.write('shot.png', 4096);
    await watcher.consider('shot.png');

    folder.whileSettling = null;
    await watcher.consider('shot.png');

    expect(onScreenshot).toHaveBeenCalledExactlyOnceWith(`${DIR}/shot.png`, 0);
  });

  it('does not report empty files or files that vanished', async () => {
    folder.write('empty.png', 0);
    folder.write('gone.png', 2048);
    folder.whileSettling = () => folder.files.delete(`${DIR}/gone.png`);

    await watcher.consider('empty.png');
    await watcher.consider('gone.png');
    await watcher.consider('never-existed.png');

    expect(onScreenshot).not.toHaveBeenCalled();
  });

  it('ignores hidden temp files and other file types without touching the disk', async () => {
    folder.write('.Screenshot.png', 2048);
    folder.write('notes.txt', 2048);

    await watcher.consider('.Screenshot.png');
    await watcher.consider('notes.txt');

    expect(folder.stat).not.toHaveBeenCalled();
    expect(onScreenshot).not.toHaveBeenCalled();
  });

  it('checks a burst of events for one file once and reports it once', async () => {
    folder.write('shot.png', 2048);

    folder.emit('shot.png');
    folder.emit('shot.png');
    folder.emit('shot.png');
    await flushMicrotasks();
    folder.emit('shot.png');
    await flushMicrotasks();

    expect(folder.sleep).toHaveBeenCalledTimes(1);
    expect(onScreenshot).toHaveBeenCalledTimes(1);
  });

  it('reports nothing after stop, also for a file that was being checked', async () => {
    const settling = deferred<undefined>();
    folder.sleep.mockReturnValueOnce(settling.promise);
    folder.write('shot.png', 2048);
    const checking = watcher.consider('shot.png');

    watcher.stop();
    settling.resolve(undefined);
    await checking;
    folder.write('later.png', 2048);
    folder.emit('later.png');
    await flushMicrotasks();

    expect(folder.stopWatching).toHaveBeenCalledTimes(1);
    expect(onScreenshot).not.toHaveBeenCalled();
  });

  it('carries the capture ticket taken at first sight through the settle time', async () => {
    const settling = deferred<undefined>();
    folder.sleep.mockReturnValueOnce(settling.promise);
    folder.write('shot.png', 2048);
    ticket = 7; // e.g. capture paused when the screenshot appeared
    const checking = watcher.consider('shot.png');

    ticket = 8; // resumed before the file settled
    settling.resolve(undefined);
    await checking;

    expect(onScreenshot).toHaveBeenCalledExactlyOnceWith(`${DIR}/shot.png`, 7);
  });

  it('keeps the first ticket when a file is still being written and a later event reports it', async () => {
    folder.write('shot.png', 1024);
    folder.whileSettling = () => folder.write('shot.png', 4096);
    ticket = 3;
    await watcher.consider('shot.png');

    ticket = 4;
    folder.whileSettling = null;
    await watcher.consider('shot.png');

    expect(onScreenshot).toHaveBeenCalledExactlyOnceWith(`${DIR}/shot.png`, 3);
  });

  describe('after a burst of more than 1,024 unsettled candidates', () => {
    /** Every settle sees each file grow: all of them stay "still being written". */
    const keepGrowing = (): void => {
      folder.whileSettling = () => {
        for (const [path, facts] of folder.files) {
          folder.files.set(path, { ...facts, size: facts.size + 1 });
        }
      };
    };
    const burst = async (): Promise<void> => {
      for (let i = 0; i < 1_024; i++) {
        folder.write(`burst-${String(i)}.png`, 1024);
        await watcher.consider(`burst-${String(i)}.png`);
      }
    };

    it('drops a file whose first-seen ticket was evicted, never giving it a fresh one', async () => {
      keepGrowing();
      folder.write('shot.png', 1024);
      ticket = 5; // paused when the screenshot appeared
      await watcher.consider('shot.png');
      await burst(); // evicts the ticket of shot.png (the oldest)

      ticket = 6; // resumed
      folder.whileSettling = null;
      await watcher.consider('shot.png');

      expect(onScreenshot).not.toHaveBeenCalled();
    });

    it('drops a file still settling when its ticket is evicted', async () => {
      const settling = deferred<undefined>();
      folder.sleep.mockReturnValueOnce(settling.promise);
      folder.write('shot.png', 2048);
      ticket = 5;
      const checking = watcher.consider('shot.png');
      keepGrowing();
      await burst();

      ticket = 6;
      settling.resolve(undefined);
      await checking;

      expect(onScreenshot).not.toHaveBeenCalled();
    });
  });

  it('takes a fresh ticket after a restart (the old run reported nothing)', async () => {
    const settling = deferred<undefined>();
    folder.sleep.mockReturnValueOnce(settling.promise);
    folder.write('shot.png', 2048);
    ticket = 1;
    const checking = watcher.consider('shot.png');
    watcher.stop();
    settling.resolve(undefined);
    await checking;

    ticket = 2;
    watcher.start();
    await watcher.consider('shot.png');

    expect(onScreenshot).toHaveBeenCalledExactlyOnceWith(`${DIR}/shot.png`, 2);
  });
});
