import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '../test-support/fakes';
import type { ClipboardWatcher } from './ports';
import {
  IMAGE_PROBE_MAX_MS,
  IMAGE_PROBE_MIN_MS,
  PollingClipboardWatcher,
  Win32ClipboardWatcher,
  startWatcher,
  windowHandle,
} from './watchers';
import { WM_CLIPBOARDUPDATE, type Win32Clipboard } from './win32/user32';

describe('windowHandle', () => {
  it('reads a 64-bit HWND from an 8-byte little-endian buffer', () => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(0x0000_7ff6_1234_abcdn);

    expect(windowHandle({ getNativeWindowHandle: () => buffer })).toBe(0x0000_7ff6_1234_abcdn);
  });

  it('reads a 32-bit HWND from a 4-byte little-endian buffer', () => {
    const buffer = Buffer.from([0xcd, 0xab, 0x34, 0x12]);

    expect(windowHandle({ getNativeWindowHandle: () => buffer })).toBe(0x1234_abcdn);
  });

  it('keeps the top bit of a 32-bit handle unsigned', () => {
    const buffer = Buffer.from([0xff, 0xff, 0xff, 0xff]);

    expect(windowHandle({ getNativeWindowHandle: () => buffer })).toBe(0xffff_ffffn);
  });
});

/** The parts of `BrowserWindow` the watcher touches, with the hooked callback exposed. */
class FakeWindow {
  hooks = new Map<number, () => void>();
  destroyed = false;
  handle = Buffer.from([0x10, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

  readonly hookWindowMessage = vi.fn((message: number, callback: () => void) => {
    this.hooks.set(message, callback);
  });
  readonly unhookWindowMessage = vi.fn((message: number) => {
    this.hooks.delete(message);
  });
  readonly getNativeWindowHandle = vi.fn(() => this.handle);
  readonly isDestroyed = vi.fn(() => this.destroyed);

  /** Simulates Windows posting WM_CLIPBOARDUPDATE to the window. */
  postClipboardUpdate(): void {
    const callback = this.hooks.get(WM_CLIPBOARDUPDATE);
    if (!callback) throw new Error('WM_CLIPBOARDUPDATE is not hooked');
    callback();
  }

  asBrowserWindow(): BrowserWindow {
    return this as unknown as BrowserWindow;
  }
}

class FakeNative implements Win32Clipboard {
  sequence = 1;
  listenerResult = true;

  readonly addListener = vi.fn<Win32Clipboard['addListener']>(() => this.listenerResult);
  readonly removeListener = vi.fn<Win32Clipboard['removeListener']>(() => true);
  readonly sequenceNumber = vi.fn(() => this.sequence);
  readonly formatPresence = vi.fn<Win32Clipboard['formatPresence']>(() => 'absent');
  readonly ownerProcess = vi.fn(() => null);
  readonly processImagePath = vi.fn(() => null);
  readonly readHtmlHeader = vi.fn(() => null);
  readonly readDwordFormat = vi.fn<Win32Clipboard['readDwordFormat']>(() => ({ state: 'absent' }));
}

describe('Win32ClipboardWatcher', () => {
  const DEBOUNCE_MS = 60;
  const HWND = 0x2010n;

  let window: FakeWindow;
  let native: FakeNative;
  let watcher: Win32ClipboardWatcher;
  let onChange: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    window = new FakeWindow();
    native = new FakeNative();
    watcher = new Win32ClipboardWatcher(window.asBrowserWindow(), native, DEBOUNCE_MS);
    onChange = vi.fn<() => void>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is an event-driven watcher', () => {
    expect(watcher.kind).toBe('event');
  });

  it('registers the window as a clipboard listener and hooks WM_CLIPBOARDUPDATE', () => {
    watcher.start(onChange);

    expect(native.addListener).toHaveBeenCalledExactlyOnceWith(HWND);
    expect(window.hookWindowMessage).toHaveBeenCalledWith(WM_CLIPBOARDUPDATE, expect.any(Function));
  });

  it('reports a change once the debounce interval has passed', () => {
    watcher.start(onChange);

    window.postClipboardUpdate();
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    expect(onChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('collapses a burst of notifications into one change', () => {
    watcher.start(onChange);

    for (let i = 0; i < 5; i++) {
      native.sequence++;
      window.postClipboardUpdate();
      vi.advanceTimersByTime(DEBOUNCE_MS / 2);
    }
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('ignores a notification when the clipboard sequence number has not moved', () => {
    watcher.start(onChange);
    window.postClipboardUpdate();
    vi.advanceTimersByTime(DEBOUNCE_MS);

    window.postClipboardUpdate();
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('reports separate changes that are further apart than the debounce interval', () => {
    watcher.start(onChange);

    window.postClipboardUpdate();
    vi.advanceTimersByTime(DEBOUNCE_MS);
    native.sequence++;
    window.postClipboardUpdate();
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('reads the sequence number after the debounce, not when the message arrives', () => {
    watcher.start(onChange);

    window.postClipboardUpdate();

    expect(native.sequenceNumber).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(native.sequenceNumber).toHaveBeenCalledTimes(1);
  });

  it('throws and unhooks the message when AddClipboardFormatListener fails', () => {
    native.listenerResult = false;

    expect(() => watcher.start(onChange)).toThrow('AddClipboardFormatListener failed');
    expect(window.unhookWindowMessage).toHaveBeenCalledWith(WM_CLIPBOARDUPDATE);
    expect(window.hooks.size).toBe(0);
  });

  it('does not remove a listener on stop after a failed start', () => {
    native.listenerResult = false;
    expect(() => watcher.start(onChange)).toThrow();

    watcher.stop();

    expect(native.removeListener).not.toHaveBeenCalled();
  });

  it('removes the listener and unhooks the message on stop', () => {
    watcher.start(onChange);

    watcher.stop();

    expect(native.removeListener).toHaveBeenCalledExactlyOnceWith(HWND);
    expect(window.unhookWindowMessage).toHaveBeenCalledWith(WM_CLIPBOARDUPDATE);
  });

  it('cancels a pending debounced change on stop', () => {
    watcher.start(onChange);
    window.postClipboardUpdate();

    watcher.stop();
    vi.advanceTimersByTime(DEBOUNCE_MS * 2);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes the listener only once when stopped twice', () => {
    watcher.start(onChange);

    watcher.stop();
    watcher.stop();

    expect(native.removeListener).toHaveBeenCalledTimes(1);
  });

  it('does not touch a destroyed window on stop', () => {
    watcher.start(onChange);
    window.destroyed = true;

    watcher.stop();

    expect(window.unhookWindowMessage).not.toHaveBeenCalled();
    expect(native.removeListener).toHaveBeenCalledTimes(1);
  });

  it('uses a 60 ms debounce by default', () => {
    const defaultWatcher = new Win32ClipboardWatcher(window.asBrowserWindow(), native);
    defaultWatcher.start(onChange);

    window.postClipboardUpdate();
    vi.advanceTimersByTime(59);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('PollingClipboardWatcher', () => {
  let clipboardText: string;
  let readText: ReturnType<typeof vi.fn<() => Promise<string>>>;
  let onChange: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    clipboardText = 'initial';
    readText = vi.fn<() => Promise<string>>(() => Promise.resolve(clipboardText));
    onChange = vi.fn<() => void>();
  });

  it('is a polling watcher', () => {
    expect(new PollingClipboardWatcher(readText).kind).toBe('polling');
  });

  describe('check', () => {
    it('treats the first read as the baseline, not as a change', async () => {
      const watcher = new PollingClipboardWatcher(readText);

      await watcher.check(onChange);

      expect(onChange).not.toHaveBeenCalled();
    });

    it('reports a change when the text differs from the previous read', async () => {
      const watcher = new PollingClipboardWatcher(readText);
      await watcher.check(onChange);

      clipboardText = 'copied';
      await watcher.check(onChange);

      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('does not report unchanged text', async () => {
      const watcher = new PollingClipboardWatcher(readText);
      await watcher.check(onChange);

      await watcher.check(onChange);
      await watcher.check(onChange);

      expect(onChange).not.toHaveBeenCalled();
    });

    it('reports a change back to an earlier text (A → B → A)', async () => {
      const watcher = new PollingClipboardWatcher(readText);
      await watcher.check(onChange);
      clipboardText = 'B';
      await watcher.check(onChange);

      clipboardText = 'initial';
      await watcher.check(onChange);

      expect(onChange).toHaveBeenCalledTimes(2);
    });

    it('skips a tick that starts while the previous read is still running', async () => {
      const slowRead = deferred<string>();
      readText.mockReturnValueOnce(slowRead.promise);
      const watcher = new PollingClipboardWatcher(readText);

      const first = watcher.check(onChange);
      await watcher.check(onChange);
      slowRead.resolve('initial');
      await first;

      expect(readText).toHaveBeenCalledTimes(1);
    });

    it('recovers after a failed read', async () => {
      readText.mockRejectedValueOnce(new Error('clipboard locked'));
      const watcher = new PollingClipboardWatcher(readText);

      await expect(watcher.check(onChange)).rejects.toThrow('clipboard locked');
      await watcher.check(onChange);
      clipboardText = 'changed';
      await watcher.check(onChange);

      expect(onChange).toHaveBeenCalledTimes(1);
    });
  });

  describe('image-only copies (no text on the clipboard)', () => {
    let image: string | null;
    let imageFingerprint: ReturnType<typeof vi.fn<() => Promise<string | null>>>;

    beforeEach(() => {
      clipboardText = '';
      image = null;
      imageFingerprint = vi.fn<() => Promise<string | null>>(() => Promise.resolve(image));
    });

    it('reports two different images copied in a row once the backed-off image probe runs', async () => {
      let now = 0;
      const watcher = new PollingClipboardWatcher(readText, 500, {
        imageFingerprint,
        now: () => now,
      });
      image = 'png-a';
      await watcher.check(onChange);

      image = 'png-b';
      now += 500;
      await watcher.check(onChange); // too soon: the image is not read on every poll
      expect(onChange).not.toHaveBeenCalled();
      now = IMAGE_PROBE_MIN_MS;
      await watcher.check(onChange);

      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('reports an image replacing text at once (the format list changed), and not again', async () => {
      let formats: string[] = ['text/plain'];
      clipboardText = 'typed';
      const watcher = new PollingClipboardWatcher(readText, 500, {
        imageFingerprint,
        formats: () => Promise.resolve(formats),
      });
      await watcher.check(onChange);

      formats = ['image/png'];
      clipboardText = '';
      image = 'png-a';
      await watcher.check(onChange);
      await watcher.check(onChange);

      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('reads an unchanged image at a backed-off rate, never on every poll', async () => {
      let now = 0;
      image = 'big-png';
      const watcher = new PollingClipboardWatcher(readText, 500, {
        imageFingerprint,
        formats: () => Promise.resolve(['image/png']),
        now: () => now,
      });

      for (; now <= 60_000; now += 500) await watcher.check(onChange);

      // 121 polls; one read every 2 s (the capped back-off), never one per poll.
      expect(imageFingerprint.mock.calls.length).toBeLessThanOrEqual(31);
      expect(onChange).not.toHaveBeenCalled();
    });

    it('still sees a new image-only copy within 2 s after a long unchanged stretch', async () => {
      let now = 0;
      image = 'png-a';
      const watcher = new PollingClipboardWatcher(readText, 500, {
        imageFingerprint,
        formats: () => Promise.resolve(['image/png']),
        now: () => now,
      });
      for (; now <= 60_000; now += 500) await watcher.check(onChange);

      image = 'png-b'; // same format list, no text: only the image probe can tell
      const copiedAt = now;
      for (; now <= copiedAt + IMAGE_PROBE_MAX_MS; now += 500) await watcher.check(onChange);

      expect(IMAGE_PROBE_MAX_MS).toBeLessThanOrEqual(2_000);
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('never reads an image payload when the format list has no image', async () => {
      const watcher = new PollingClipboardWatcher(readText, 500, {
        imageFingerprint,
        formats: () => Promise.resolve(['text/html']),
      });

      await watcher.check(onChange);
      await watcher.check(onChange);

      expect(imageFingerprint).not.toHaveBeenCalled();
    });

    it('never asks for the image while the clipboard holds text', async () => {
      clipboardText = 'plain text';
      const watcher = new PollingClipboardWatcher(readText, 500, { imageFingerprint });

      await watcher.check(onChange);
      clipboardText = 'more text';
      await watcher.check(onChange);

      expect(imageFingerprint).not.toHaveBeenCalled();
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('reports text replacing an image', async () => {
      image = 'png-a';
      const watcher = new PollingClipboardWatcher(readText, 500, { imageFingerprint });
      await watcher.check(onChange);

      clipboardText = 'typed';
      image = null;
      await watcher.check(onChange);

      expect(onChange).toHaveBeenCalledTimes(1);
    });
  });

  describe('write marker in the fallback fingerprint', () => {
    it('reports an identical copy from another app right after a marked restore', async () => {
      let marker: string | null = null;
      clipboardText = 'same text';
      const watcher = new PollingClipboardWatcher(readText, 500, {
        formats: () => Promise.resolve(['text/plain']),
        writeMarker: () => Promise.resolve(marker),
      });
      await watcher.check(onChange);

      marker = 'a'.repeat(32); // the app restores the same text, with its marker
      await watcher.check(onChange);
      marker = null; // another app copies the identical text: no marker
      await watcher.check(onChange);

      expect(onChange).toHaveBeenCalledTimes(2);
    });
  });

  describe('capture generation', () => {
    it('reports the generation taken when the poll began, not when it resolved', async () => {
      const pending = deferred<string>();
      let reads = 0;
      let generation = 1;
      const report = vi.fn<(generation?: number) => void>();
      const watcher = new PollingClipboardWatcher(
        () => {
          reads++;
          return reads === 1 ? Promise.resolve('before') : pending.promise;
        },
        500,
        { generation: () => generation },
      );
      await watcher.check(report);
      generation = 2; // paused
      const poll = watcher.check(report);

      generation = 3; // resumed while the read was still pending
      pending.resolve('after');
      await poll;

      expect(report).toHaveBeenCalledExactlyOnceWith(2);
    });
  });

  describe('stop', () => {
    it('reports nothing for a poll that resolves after stop()', async () => {
      const pending = deferred<string>();
      let reads = 0;
      const watcher = new PollingClipboardWatcher(() => {
        reads++;
        return reads === 1 ? Promise.resolve('before') : pending.promise;
      });
      await watcher.check(onChange);
      const poll = watcher.check(onChange);

      watcher.stop();
      pending.resolve('after');
      await poll;

      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('native change counter', () => {
    it('decides by the counter alone, without reading the clipboard', async () => {
      let sequence = 7;
      const watcher = new PollingClipboardWatcher(readText, 500, {
        changeCounter: () => sequence,
      });
      await watcher.check(onChange);
      await watcher.check(onChange);
      expect(onChange).not.toHaveBeenCalled();

      // Two image copies: the text never changes, the counter does.
      sequence = 8;
      await watcher.check(onChange);
      sequence = 9;
      await watcher.check(onChange);

      expect(onChange).toHaveBeenCalledTimes(2);
      expect(readText).not.toHaveBeenCalled();
    });
  });

  describe('start and stop', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('takes a baseline at start and then polls every interval', async () => {
      const watcher = new PollingClipboardWatcher(readText, 500);
      watcher.start(onChange);
      await vi.advanceTimersByTimeAsync(0);
      expect(readText).toHaveBeenCalledTimes(1);

      clipboardText = 'copied';
      await vi.advanceTimersByTimeAsync(500);

      expect(readText).toHaveBeenCalledTimes(2);
      expect(onChange).toHaveBeenCalledTimes(1);
      watcher.stop();
    });

    it('does not report the text that was already on the clipboard at start', async () => {
      const watcher = new PollingClipboardWatcher(readText, 500);
      watcher.start(onChange);

      await vi.advanceTimersByTimeAsync(1500);

      expect(onChange).not.toHaveBeenCalled();
      watcher.stop();
    });

    it('stops polling after stop', async () => {
      const watcher = new PollingClipboardWatcher(readText, 500);
      watcher.start(onChange);
      await vi.advanceTimersByTimeAsync(0);

      watcher.stop();
      clipboardText = 'copied later';
      await vi.advanceTimersByTimeAsync(5000);

      expect(readText).toHaveBeenCalledTimes(1);
      expect(onChange).not.toHaveBeenCalled();
    });

    it('can be stopped before it was started', () => {
      expect(() => new PollingClipboardWatcher(readText).stop()).not.toThrow();
    });
  });
});

describe('startWatcher', () => {
  const fakeWatcher = (kind: ClipboardWatcher['kind']): ClipboardWatcher => ({
    kind,
    start: vi.fn(),
    stop: vi.fn(),
  });

  it('keeps the primary watcher when it starts', () => {
    const primary = fakeWatcher('event');
    const fallback = vi.fn(() => fakeWatcher('polling'));
    const onChange = vi.fn();
    const startPrimary = vi.spyOn(primary, 'start');

    expect(startWatcher(primary, fallback, onChange, vi.fn())).toBe(primary);
    expect(startPrimary).toHaveBeenCalledWith(onChange);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back to polling when the Win32 listener cannot be registered', () => {
    const native = new FakeNative();
    native.listenerResult = false;
    const primary = new Win32ClipboardWatcher(new FakeWindow().asBrowserWindow(), native);
    const backup = fakeWatcher('polling');
    const startBackup = vi.spyOn(backup, 'start');
    const onChange = vi.fn();
    const onError = vi.fn();

    const running = startWatcher(primary, () => backup, onChange, onError);

    expect(running).toBe(backup);
    expect(running.kind).toBe('polling');
    expect(startBackup).toHaveBeenCalledWith(onChange);
    expect(onError).toHaveBeenCalledExactlyOnceWith(new Error('AddClipboardFormatListener failed'));
  });
});
