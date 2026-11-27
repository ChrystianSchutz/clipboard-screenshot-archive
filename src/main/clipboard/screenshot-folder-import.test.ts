import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Clip } from '@shared/types';
import { ScreenshotFolderWatcher, type FileFacts } from '../images/screenshot-folder';
import type { ScreenshotCaptureResult } from '../images/screenshots';
import { deferred } from '../test-support/fakes';
import { CaptureGate } from './capture-gate';
import {
  isAffirmativeAttribute,
  isMacScreenCapture,
  isMacScreenshotName,
  macScreenCaptureCheck,
  ScreenshotFolderImport,
  type OpenedCandidate,
  type ReadDescriptorAttribute,
  type ScreenshotFolderImportDeps,
} from './screenshot-folder-import';
import { readDescriptorAttribute, type Fgetxattr } from './mac/xattr';

const STARTED = 1_764_000_000_000;
const SHOT = '/Users/me/Desktop/Screenshot 2026-11-27 at 10.15.30.png';

describe('isMacScreenshotName', () => {
  it.each([
    'Screenshot 2026-11-27 at 10.15.30.png',
    'Screenshot 2026-11-27 at 10.15.30 (2).png',
    'Screen Shot 2019-05-01 at 9.05.03 PM.png',
    'Bildschirmfoto 2026-11-27 um 10.15.30.png',
    'Capture d’écran 2026-11-27 à 10.15.30.png',
    'Zrzut ekranu 2026-11-27 o 10.15.30.png',
    'スクリーンショット 2026-11-27 10.15.30.png',
    'screenshot 2026-11-27 at 10.15.30.JPG',
    'Screenshot.png',
    'Screenshot 2.png',
    '/Users/me/Desktop/Screenshot 2026-11-27 at 10.15.30.jpeg',
  ])('accepts %s', (name) => {
    expect(isMacScreenshotName(name)).toBe(true);
  });

  it.each([
    'holiday.png',
    'IMG_2041.JPG',
    'Screenshot of the invoice.png',
    'My Screenshot 2026-11-27 at 10.15.30.png',
    'Screenshot 2026-11-27 at 10.15.30.gif',
    'Screenshot 2026-11-27 at 10.15.30.png.txt',
    '.Screenshot 2026-11-27 at 10.15.30.png',
    'Screenshot 2026-11-27.png',
  ])('rejects %s', (name) => {
    expect(isMacScreenshotName(name)).toBe(false);
  });

  it('accepts a decomposed (NFD) name as file-system events may deliver it', () => {
    expect(isMacScreenshotName('Capture d’écran 2026-11-27 à 10.15.30.png'.normalize('NFD'))).toBe(
      true,
    );
  });

  it('accepts the user’s own screenshot name only when it is configured', () => {
    const name = 'Grab 2026-11-27 at 10.15.30.png';

    expect(isMacScreenshotName(name)).toBe(false);
    expect(isMacScreenshotName(name, 'Grab')).toBe(true);
  });

  it('treats a configured name with regex characters literally', () => {
    expect(isMacScreenshotName('Shot (work) 2026-11-27 at 10.15.30.png', 'Shot (work)')).toBe(true);
    expect(isMacScreenshotName('Shot work 2026-11-27 at 10.15.30.png', 'Shot (work)')).toBe(false);
  });
});

/** An opened candidate whose descriptor stays at its path (its bytes are never read here). */
/** An opened candidate whose methods are mocks (plain properties, so they can be asserted on). */
type FakeOpened = Omit<OpenedCandidate, 'stillAtPath' | 'readBytes' | 'close'> & {
  stillAtPath: Mock<() => Promise<boolean>>;
  readBytes: Mock<OpenedCandidate['readBytes']>;
  close: Mock<() => Promise<void>>;
};

function openedFile(path: string, birthtimeMs: number | null): FakeOpened {
  return {
    path,
    fd: 42,
    birthtimeMs,
    stillAtPath: vi.fn(() => Promise.resolve(true)),
    readBytes: vi.fn<OpenedCandidate['readBytes']>(() => Promise.resolve(new Uint8Array([1]))),
    close: vi.fn(() => Promise.resolve()),
  };
}

const fileWithPath = (path: string) => expect.objectContaining({ path }) as unknown;

describe('ScreenshotFolderImport', () => {
  let onFile: ((path: string, ticket: number) => void) | null;
  let ticketOf: (() => number) | null;
  let opened: FakeOpened[];
  let watcher: { start: Mock<() => void>; stop: Mock<() => void> };
  let captureEnabled: boolean;
  let birthtimes: Map<string, number | null>;
  let captureResult: ScreenshotCaptureResult;
  let links: Set<string>;
  let gate: CaptureGate;
  let deps: {
    [K in Exclude<keyof ScreenshotFolderImportDeps, 'gate'>]: Mock<ScreenshotFolderImportDeps[K]>;
  } & { gate: CaptureGate };

  const clip = { id: 7, kind: 'image' } as unknown as Clip;

  beforeEach(() => {
    onFile = null;
    ticketOf = null;
    opened = [];
    watcher = { start: vi.fn<() => void>(), stop: vi.fn<() => void>() };
    captureEnabled = true;
    birthtimes = new Map([[SHOT, STARTED + 5_000]]);
    links = new Set();
    gate = new CaptureGate();
    captureResult = { status: 'recorded', clip, created: true };
    deps = {
      createWatcher: vi.fn<ScreenshotFolderImportDeps['createWatcher']>((report, ticket) => {
        onFile = report;
        ticketOf = ticket;
        return Promise.resolve(watcher);
      }),
      customPrefix: vi.fn<ScreenshotFolderImportDeps['customPrefix']>(() => Promise.resolve(null)),
      openFile: vi.fn<ScreenshotFolderImportDeps['openFile']>((path) => {
        if (!birthtimes.has(path) || links.has(path))
          return Promise.resolve('not-a-regular-file' as const);
        const file = openedFile(path, birthtimes.get(path) ?? null);
        opened.push(file);
        return Promise.resolve(file);
      }),
      isScreenCapture: vi.fn<ScreenshotFolderImportDeps['isScreenCapture']>(() =>
        Promise.resolve(true),
      ),
      gate,
      settings: vi.fn<ScreenshotFolderImportDeps['settings']>(() => ({
        captureEnabled,
        maxClips: 200,
      })),
      captureFile: vi.fn<ScreenshotFolderImportDeps['captureFile']>(() =>
        Promise.resolve(captureResult),
      ),
      prune: vi.fn<ScreenshotFolderImportDeps['prune']>(() => 0),
      onRecorded: vi.fn<ScreenshotFolderImportDeps['onRecorded']>(),
      onError: vi.fn<ScreenshotFolderImportDeps['onError']>(),
      now: vi.fn<ScreenshotFolderImportDeps['now']>(() => STARTED),
    };
  });

  async function started(): Promise<ScreenshotFolderImport> {
    const folder = new ScreenshotFolderImport(deps);
    await folder.start();
    return folder;
  }

  it('starts the folder watcher and imports the screenshots it reports', async () => {
    const folder = await started();

    expect(watcher.start).toHaveBeenCalledTimes(1);
    await expect(folder.handleFile(SHOT)).resolves.toBe('recorded');
    expect(deps.captureFile).toHaveBeenCalledExactlyOnceWith(
      fileWithPath(SHOT),
      STARTED,
      expect.any(Function),
    );
    // The bytes come from the descriptor the import opened, closed once the capture finished.
    expect(deps.captureFile.mock.calls[0]?.[0]).toBe(opened[0]);
    expect(opened[0]?.close).toHaveBeenCalledTimes(1);
    expect(deps.prune).toHaveBeenCalledExactlyOnceWith(200);
    expect(deps.onRecorded).toHaveBeenCalledExactlyOnceWith(clip, true);
  });

  it('wires the watcher callback to the import', async () => {
    await started();

    onFile?.(SHOT, gate.current);
    await vi.waitFor(() => expect(deps.captureFile).toHaveBeenCalledTimes(1));
    expect(ticketOf?.()).toBe(gate.current);
  });

  it('does not prune when the screenshot only bumped an existing clip', async () => {
    const folder = await started();
    captureResult = { status: 'recorded', clip, created: false };

    await expect(folder.handleFile(SHOT)).resolves.toBe('recorded');
    expect(deps.prune).not.toHaveBeenCalled();
    expect(deps.onRecorded).toHaveBeenCalledExactlyOnceWith(clip, false);
  });

  it('imports nothing while capture is paused', async () => {
    const folder = await started();
    captureEnabled = false;

    await expect(folder.handleFile(SHOT)).resolves.toBe('paused');
    expect(deps.openFile).not.toHaveBeenCalled();
    expect(deps.captureFile).not.toHaveBeenCalled();
  });

  it('re-checks pause after opening and checking the file', async () => {
    const folder = await started();
    deps.isScreenCapture.mockImplementationOnce(() => {
      captureEnabled = false;
      return Promise.resolve(true);
    });

    await expect(folder.handleFile(SHOT)).resolves.toBe('paused');
    expect(deps.captureFile).not.toHaveBeenCalled();
  });

  it('ignores pictures whose names are not screenshot names', async () => {
    const folder = await started();

    await expect(folder.handleFile('/Users/me/Desktop/holiday.png')).resolves.toBe(
      'not-a-screenshot',
    );
    expect(deps.captureFile).not.toHaveBeenCalled();
  });

  it('uses the user’s configured screenshot name', async () => {
    deps.customPrefix.mockResolvedValue('Grab');
    const path = '/Users/me/Desktop/Grab 2026-11-27 at 10.15.30.png';
    birthtimes.set(path, STARTED + 1);
    const folder = await started();

    await expect(folder.handleFile(path)).resolves.toBe('recorded');
  });

  it('still starts when the configured name cannot be read', async () => {
    deps.customPrefix.mockRejectedValue(new Error('defaults failed'));
    const folder = await started();

    expect(watcher.start).toHaveBeenCalledTimes(1);
    await expect(folder.handleFile(SHOT)).resolves.toBe('recorded');
  });

  it.each([
    ['created before the import started', STARTED - 60_000],
    ['whose creation time cannot be read', null],
  ])('never imports an older screenshot (%s)', async (_label, born) => {
    birthtimes.set(SHOT, born);
    const folder = await started();

    await expect(folder.handleFile(SHOT)).resolves.toBe('old-file');
    expect(deps.captureFile).not.toHaveBeenCalled();
  });

  it('allows for file systems that store creation times in whole seconds', async () => {
    birthtimes.set(SHOT, STARTED - 900);
    const folder = await started();

    await expect(folder.handleFile(SHOT)).resolves.toBe('recorded');
  });

  it('reports a capture the image pipeline skipped', async () => {
    captureResult = { status: 'skipped', reason: 'too-small' };
    const folder = await started();

    await expect(folder.handleFile(SHOT)).resolves.toBe('skipped-too-small');
    expect(deps.onRecorded).not.toHaveBeenCalled();
  });

  it('logs a failed capture and keeps importing', async () => {
    const folder = await started();
    deps.captureFile.mockRejectedValueOnce(new Error('decode failed'));

    await expect(folder.handleFile(SHOT)).resolves.toBe('skipped-error');
    expect(deps.onError).toHaveBeenCalledExactlyOnceWith(new Error('decode failed'));
    await expect(folder.handleFile(SHOT)).resolves.toBe('recorded');
  });

  it('imports one file at a time', async () => {
    const first = deferred<ScreenshotCaptureResult>();
    deps.captureFile.mockReturnValueOnce(first.promise);
    const other = '/Users/me/Desktop/Screenshot 2026-11-27 at 10.16.00.png';
    birthtimes.set(other, STARTED + 6_000);
    const folder = await started();

    const a = folder.handleFile(SHOT);
    const b = folder.handleFile(other);
    await vi.waitFor(() => expect(deps.captureFile).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(deps.captureFile).toHaveBeenCalledTimes(1);

    first.resolve(captureResult);
    await expect(Promise.all([a, b])).resolves.toEqual(['recorded', 'recorded']);
    expect(deps.captureFile).toHaveBeenCalledTimes(2);
  });

  it('imports nothing after stop and stops the watcher', async () => {
    const folder = await started();

    folder.stop();

    expect(watcher.stop).toHaveBeenCalledTimes(1);
    await expect(folder.handleFile(SHOT)).resolves.toBe('stopped');
  });

  it('never starts watching when stopped while the folder was being resolved', async () => {
    const pending = deferred<typeof watcher>();
    deps.createWatcher.mockReturnValueOnce(pending.promise);
    const folder = new ScreenshotFolderImport(deps);

    const starting = folder.start();
    folder.stop();
    pending.resolve(watcher);
    await starting;

    expect(watcher.start).not.toHaveBeenCalled();
    await expect(folder.handleFile(SHOT)).resolves.toBe('stopped');
  });

  it('reports a watcher that cannot be created and imports nothing', async () => {
    deps.createWatcher.mockRejectedValueOnce(new Error('no screenshots folder'));
    const folder = await started();

    expect(deps.onError).toHaveBeenCalledExactlyOnceWith(new Error('no screenshots folder'));
    await expect(folder.handleFile(SHOT)).resolves.toBe('stopped');
  });

  it('never imports a symbolic link (or anything but a regular file)', async () => {
    links.add(SHOT);
    const folder = await started();

    await expect(folder.handleFile(SHOT)).resolves.toBe('not-a-regular-file');
    expect(deps.captureFile).not.toHaveBeenCalled();
  });

  it('never imports a file that macOS does not mark as a screen capture', async () => {
    deps.isScreenCapture.mockResolvedValueOnce(false);
    const folder = await started();

    await expect(folder.handleFile(SHOT)).resolves.toBe('not-a-screen-capture');
    expect(deps.isScreenCapture).toHaveBeenCalledExactlyOnceWith(fileWithPath(SHOT));
    expect(opened[0]?.close).toHaveBeenCalledTimes(1);
    expect(deps.captureFile).not.toHaveBeenCalled();
  });

  it('stores nothing when capture is paused while the file is being saved', async () => {
    const folder = await started();
    let allowed: boolean | null = null;
    deps.captureFile.mockImplementationOnce((_path, _copiedAt, canRecord) => {
      captureEnabled = false;
      gate.invalidate(); // pause, as the app does
      allowed = canRecord(); // what the recorder checks right before the insert
      return Promise.resolve({ status: 'skipped', reason: 'paused' });
    });

    await expect(folder.handleFile(SHOT)).resolves.toBe('skipped-paused');
    expect(allowed).toBe(false);
    expect(deps.onRecorded).not.toHaveBeenCalled();
  });

  it('drops a file reported before a pause and resume, even though capture is on again', async () => {
    const folder = await started();
    deps.isScreenCapture.mockImplementationOnce(() => {
      gate.invalidate(); // pause...
      gate.invalidate(); // ...and resume while the file was checked
      return Promise.resolve(true);
    });

    await expect(folder.handleFile(SHOT)).resolves.toBe('paused');
    expect(deps.captureFile).not.toHaveBeenCalled();
  });

  it('imports a file reported after resuming', async () => {
    gate.invalidate();
    gate.invalidate();
    const folder = await started();

    await expect(folder.handleFile(SHOT)).resolves.toBe('recorded');
  });

  it('drops a screenshot that appeared while paused when capture resumes before it settles', async () => {
    const folderFiles = new Map<string, FileFacts>();
    const settling = deferred<undefined>();
    let emit: ((name: string) => void) | null = null;
    deps.createWatcher.mockImplementationOnce((report, ticket) =>
      Promise.resolve(
        new ScreenshotFolderWatcher('/Users/me/Desktop', {
          watch: (_dir, onName) => {
            emit = onName;
            return () => undefined;
          },
          stat: (path) => Promise.resolve(folderFiles.get(path) ?? null),
          sleep: () => settling.promise,
          now: () => STARTED,
          onScreenshot: report,
          ticket,
        }),
      ),
    );
    const folder = new ScreenshotFolderImport(deps);
    const handled = vi.spyOn(folder, 'handleFile');
    await folder.start();
    // Paused, as the app does it: setting off and a new generation.
    captureEnabled = false;
    gate.invalidate();
    folderFiles.set(SHOT, { size: 2048, mtimeMs: STARTED + 5_000 });

    (emit as ((name: string) => void) | null)?.('Screenshot 2026-11-27 at 10.15.30.png');
    // Resumed before the 400 ms settle ends.
    captureEnabled = true;
    gate.invalidate();
    settling.resolve(undefined);
    await vi.waitFor(() => expect(handled).toHaveBeenCalledTimes(1));

    await expect(handled.mock.results[0]?.value).resolves.toBe('paused');
    expect(deps.captureFile).not.toHaveBeenCalled();
    expect(deps.onRecorded).not.toHaveBeenCalled();
  });

  it('records nothing once the gate is closed for shutdown, even for a file seen before', async () => {
    const folder = await started();
    const ticket = gate.current;

    gate.close();

    await expect(folder.handleFile(SHOT, ticket)).resolves.toBe('paused');
    await expect(folder.handleFile(SHOT)).resolves.toBe('paused');
    expect(deps.captureFile).not.toHaveBeenCalled();
  });

  it('closes the opened file when the import is refused after opening it', async () => {
    birthtimes.set(SHOT, STARTED - 60_000);
    const folder = await started();

    await expect(folder.handleFile(SHOT)).resolves.toBe('old-file');
    expect(opened[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('starts only once', async () => {
    const folder = await started();
    await folder.start();

    expect(deps.createWatcher).toHaveBeenCalledTimes(1);
  });
});

/** A binary property list whose only object is `true` (0x09), `false` (0x08) or an integer. */
function binaryPlist(object: readonly number[]): Uint8Array {
  const header = [...new TextEncoder().encode('bplist00')];
  const offsetTableAt = header.length + object.length;
  const trailer = new Uint8Array(32);
  const view = new DataView(trailer.buffer);
  view.setUint8(6, 1); // offset size
  view.setUint8(7, 1); // object reference size
  view.setBigUint64(8, 1n); // one object
  view.setBigUint64(16, 0n); // the top object is object 0
  view.setBigUint64(24, BigInt(offsetTableAt));
  return Uint8Array.from([...header, ...object, header.length, ...trailer]);
}

describe('isAffirmativeAttribute', () => {
  it.each([
    ['a binary plist holding true', binaryPlist([0x09]), true],
    ['a binary plist holding the integer 1', binaryPlist([0x10, 0x01]), true],
    ['a binary plist holding false', binaryPlist([0x08]), false],
    ['a binary plist holding the integer 0', binaryPlist([0x10, 0x00]), false],
    ['a binary plist holding 2', binaryPlist([0x10, 0x02]), false],
    ['a truncated binary plist', new TextEncoder().encode('bplist00\t'), false],
    ['the text 1', new TextEncoder().encode('1\n'), true],
    ['the text 0', new TextEncoder().encode('0'), false],
    ['an empty value', new Uint8Array(0), false],
  ])('%s', (_label, bytes, expected) => {
    expect(isAffirmativeAttribute(bytes)).toBe(expected);
  });
});

const ATTRIBUTE = 'com.apple.metadata:kMDItemIsScreenCapture';
const TRUE_PLIST = binaryPlist([0x09]);

/**
 * A fake `fgetxattr` over a table of descriptors and their attributes, with Apple's contract: a
 * null buffer asks for the length; otherwise up to `size` bytes are copied; -1 when absent.
 */
function fakeFgetxattr(attributes: Map<number, Map<string, Uint8Array>>) {
  return vi.fn<Fgetxattr>((fd, name, value, size, position, options) => {
    expect(position).toBe(0);
    expect(options).toBe(0);
    const bytes = attributes.get(fd)?.get(name);
    if (!bytes) return -1;
    if (value === null) return bytes.length;
    const count = Math.min(size, bytes.length);
    value.set(bytes.subarray(0, count));
    return count;
  });
}

describe('readDescriptorAttribute (fgetxattr on an open descriptor)', () => {
  it('asks for the length first, then reads exactly that many bytes from the descriptor', () => {
    const fgetxattr = fakeFgetxattr(new Map([[7, new Map([[ATTRIBUTE, TRUE_PLIST]])]]));

    expect(readDescriptorAttribute(fgetxattr, 7, ATTRIBUTE)).toEqual(TRUE_PLIST);
    expect(fgetxattr).toHaveBeenNthCalledWith(1, 7, ATTRIBUTE, null, 0, 0, 0);
    expect(fgetxattr).toHaveBeenNthCalledWith(
      2,
      7,
      ATTRIBUTE,
      expect.any(Buffer),
      TRUE_PLIST.length,
      0,
      0,
    );
  });

  it('is null when the attribute is absent, oversized, or the binding throws', () => {
    const fgetxattr = fakeFgetxattr(new Map([[7, new Map([[ATTRIBUTE, new Uint8Array(5_000)]])]]));

    expect(readDescriptorAttribute(fgetxattr, 8, ATTRIBUTE)).toBeNull();
    expect(readDescriptorAttribute(fgetxattr, 7, ATTRIBUTE)).toBeNull();
    expect(fgetxattr).toHaveBeenCalledTimes(2); // the oversized value is never read
    const throwing = vi.fn<Fgetxattr>(() => {
      throw new Error('bad fd');
    });
    expect(readDescriptorAttribute(throwing, 7, ATTRIBUTE)).toBeNull();
  });

  it('is null when the value grew between the two calls', () => {
    let length = 4;
    const fgetxattr = vi.fn<Fgetxattr>((_fd, _name, value) => {
      if (value === null) return length++;
      return length;
    });

    expect(readDescriptorAttribute(fgetxattr, 7, ATTRIBUTE)).toBeNull();
  });
});

describe('isMacScreenCapture (kMDItemIsScreenCapture provenance)', () => {
  const reader = (bytes: Uint8Array | null) => vi.fn<ReadDescriptorAttribute>(() => bytes);

  it('accepts a file whose screencapture attribute on the open descriptor is true', () => {
    const read = reader(TRUE_PLIST);

    expect(isMacScreenCapture({ fd: 42 }, read)).toBe(true);
    expect(read).toHaveBeenCalledExactlyOnceWith(42, ATTRIBUTE);
  });

  it.each([
    ['absent', null],
    ['false', binaryPlist([0x08])],
    ['garbage', new TextEncoder().encode('yes please')],
  ])('rejects a file whose attribute is %s (no path-based fallback)', (_label, bytes) => {
    expect(isMacScreenCapture({ fd: 42 }, reader(bytes))).toBe(false);
  });

  it('never reads from a closed or invalid descriptor', () => {
    const read = reader(TRUE_PLIST);

    expect(isMacScreenCapture({ fd: -1 }, read)).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('describes the opened file even when its path names another file meanwhile', () => {
    // Descriptor 42 is the opened screenshot candidate (no attribute); descriptor 43 is whatever
    // the path names right now (a real screenshot). Only the descriptor counts.
    const fgetxattr = fakeFgetxattr(new Map([[43, new Map([[ATTRIBUTE, TRUE_PLIST]])]]));
    const read: ReadDescriptorAttribute = (fd, name) =>
      readDescriptorAttribute(fgetxattr, fd, name);

    expect(isMacScreenCapture({ fd: 42 }, read)).toBe(false);
    expect(isMacScreenCapture({ fd: 43 }, read)).toBe(true);
  });

  it('refuses every file (fail closed) when fgetxattr cannot be loaded', async () => {
    const onError = vi.fn();

    await expect(
      macScreenCaptureCheck({ fd: 42 }, onError, () => Promise.resolve(null)),
    ).resolves.toBe(false);
    await expect(
      macScreenCaptureCheck({ fd: 42 }, onError, () => Promise.resolve(null)),
    ).resolves.toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('accepts through the loaded binding', async () => {
    const fgetxattr = fakeFgetxattr(new Map([[42, new Map([[ATTRIBUTE, TRUE_PLIST]])]]));

    await expect(
      macScreenCaptureCheck({ fd: 42 }, vi.fn(), () => Promise.resolve(fgetxattr)),
    ).resolves.toBe(true);
  });
});
