import type { BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import type { ClipboardWatcher } from './ports';
import { WM_CLIPBOARDUPDATE, type Win32Clipboard } from './win32/user32';

/**
 * Event-driven watcher for Windows.
 *
 * Registers a window as a clipboard format listener and receives `WM_CLIPBOARDUPDATE` through
 * Electron's `BrowserWindow.hookWindowMessage`. No polling, no CPU while idle. Apps often put
 * several formats on the clipboard in quick succession, so notifications are debounced and
 * de-duplicated with the clipboard sequence number.
 */
export class Win32ClipboardWatcher implements ClipboardWatcher {
  readonly kind = 'event';
  private timer: NodeJS.Timeout | null = null;
  private lastSequence = -1;
  private hwnd: bigint | null = null;

  constructor(
    private readonly window: BrowserWindow,
    private readonly native: Win32Clipboard,
    private readonly debounceMs = 60,
  ) {}

  start(onChange: () => void): void {
    const hwnd = windowHandle(this.window);
    this.window.hookWindowMessage(WM_CLIPBOARDUPDATE, () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        const sequence = this.native.sequenceNumber();
        if (sequence === this.lastSequence) return;
        this.lastSequence = sequence;
        onChange();
      }, this.debounceMs);
    });
    if (!this.native.addListener(hwnd)) {
      this.window.unhookWindowMessage(WM_CLIPBOARDUPDATE);
      throw new Error('AddClipboardFormatListener failed');
    }
    this.hwnd = hwnd;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.hwnd !== null) {
      this.native.removeListener(this.hwnd);
      this.hwnd = null;
    }
    if (!this.window.isDestroyed()) this.window.unhookWindowMessage(WM_CLIPBOARDUPDATE);
  }
}

/**
 * Starts `primary`; if it cannot start (e.g. `AddClipboardFormatListener` fails), reports the error
 * and starts `fallback()` instead. Returns the watcher that is really running, so the app can show
 * the actual capture mode instead of silently recording nothing.
 */
export function startWatcher(
  primary: ClipboardWatcher,
  fallback: () => ClipboardWatcher,
  onChange: (generation?: number) => void,
  onError: (error: unknown) => void,
): ClipboardWatcher {
  try {
    primary.start(onChange);
    return primary;
  } catch (error) {
    onError(error);
    const backup = fallback();
    backup.start(onChange);
    return backup;
  }
}

/** `getNativeWindowHandle()` returns the HWND as a pointer-sized little-endian buffer. */
export function windowHandle(window: Pick<BrowserWindow, 'getNativeWindowHandle'>): bigint {
  const buffer = window.getNativeWindowHandle();
  return buffer.length >= 8 ? buffer.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(0));
}

/** Optional, sharper change signals for the polling watcher. */
export interface PollingSignals {
  /**
   * The OS clipboard version: Win32 `GetClipboardSequenceNumber` (when only the listener failed)
   * or macOS `NSPasteboard.generalPasteboard.changeCount`. When given, it alone decides: nothing is
   * read at all, and every change counts (images, identical copies after a restore, everything).
   */
  readonly changeCounter?: () => number;
  /**
   * The formats on the clipboard (Electron `clipboard.read()` item types), read without any
   * payload. Part of the fallback fingerprint, and tells whether an image is there at all.
   */
  readonly formats?: () => Promise<readonly string[]>;
  /**
   * The token of the app's write marker, or `null` (see `WRITE_MARKER_FORMAT`). Part of the
   * fallback fingerprint: a restore (marked) followed by an identical copy from another app
   * (unmarked) changes the fingerprint, so the copy is reported.
   */
  readonly writeMarker?: () => Promise<string | null>;
  /**
   * A bounded identity of the clipboard image (size + hash of its PNG bytes, or the size alone
   * above the capture limit), or `null` when there is none. The only signal that reads a payload,
   * so it is asked only when the clipboard holds an image and no text, and then at a capped rate
   * (see `IMAGE_PROBE_MAX_MS`), never on every poll.
   */
  readonly imageFingerprint?: () => Promise<string | null>;
  /** Clock for the image probe's back-off (injected by tests). */
  readonly now?: () => number;
  /**
   * The capture generation (`CaptureGate.current`). Taken when a poll begins and handed to
   * `onChange` with the change it finds, so a poll that began while capture was paused and
   * resolves after resume reports the paused generation and records nothing.
   */
  readonly generation?: () => number;
}

/** The first look at an unchanged clipboard image comes this long after the last change. */
export const IMAGE_PROBE_MIN_MS = 2_000;
/**
 * The back-off between looks at an unchanged clipboard image is capped at this, so an image-only
 * copy on top of another one with the same format list is seen within 2 s.
 */
export const IMAGE_PROBE_MAX_MS = 2_000;

const IMAGE_FORMAT = 'image/png';

/**
 * Portable fallback watcher: every `intervalMs` it compares a fingerprint of the clipboard.
 *
 * Exact change detection (no payload is read, every change counts):
 * - Windows: the event watcher; if its listener cannot be registered, this poller with the Win32
 *   sequence number as `changeCounter`.
 * - macOS: this poller with `NSPasteboard.generalPasteboard.changeCount` as `changeCounter` (read
 *   in-process through the Objective-C runtime, see `loadMacPasteboardCounter`).
 *
 * Fallback (Linux, other platforms, or macOS if the counter cannot be loaded): a fingerprint of
 * the format list, the app's write marker token and a hash of the text, all cheap, checked on
 * every poll. An image payload is read only when the clipboard holds an image and no text: at
 * once when anything cheap changed (format list, marker, text hash), and otherwise every
 * `IMAGE_PROBE_MAX_MS` (2 s) while the image stays the same, never on every poll.
 *
 * Known limits of this fallback (Windows and macOS use native counters and have neither):
 * - Two image-only copies in a row with the same format list are told apart only by the image
 *   probe. If the second one is replaced (e.g. by a text copy) before the next probe, up to 2 s
 *   later, it is lost: it is no longer on the clipboard when the change is noticed, so there is
 *   nothing left to capture.
 * - Electron has no payload-free way to learn an image's size: the probe asks the platform
 *   clipboard for the PNG (which Electron decodes and re-encodes into a Blob) before the size
 *   check can refuse an oversized one. The bytes are never copied into JS memory or hashed above
 *   the limit, but the native materialization itself cannot be avoided. A large image left on
 *   the clipboard costs one such read every 2 s, not one per poll.
 */
export class PollingClipboardWatcher implements ClipboardWatcher {
  readonly kind = 'polling';
  private interval: NodeJS.Timeout | null = null;
  private lastHash: string | null = null;
  private busy = false;
  /** Bumped by every start and stop: a poll that began in another run reports nothing. */
  private run = 0;
  private readonly now: () => number;
  /** The image probe's state for the current cheap fingerprint (see `imageIdentity`). */
  private image: {
    cheap: string;
    identity: string | null;
    epoch: number;
    nextProbeAt: number;
    backoffMs: number;
  } | null = null;

  constructor(
    private readonly readText: () => Promise<string>,
    private readonly intervalMs = 500,
    private readonly signals: PollingSignals = {},
  ) {
    this.now = signals.now ?? Date.now;
  }

  start(onChange: (generation?: number) => void): void {
    this.run++;
    // Whatever is on the clipboard at startup was not copied while we were watching.
    void this.check(() => undefined);
    this.interval = setInterval(() => void this.check(onChange), this.intervalMs);
    this.interval.unref();
  }

  stop(): void {
    this.run++;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /**
   * Visible for tests: one polling tick. A poll still waiting for the clipboard when `stop()` is
   * called reports nothing when it resolves (shutdown also closes the capture gate for good).
   */
  async check(onChange: (generation?: number) => void): Promise<void> {
    if (this.busy) return; // a slow read must not overlap the next tick
    this.busy = true;
    const run = this.run;
    // The capture generation is taken now, before the clipboard is read: a copy sampled while
    // capture was paused keeps the paused generation even if capture resumes before the read ends.
    const generation = this.signals.generation?.();
    try {
      const hash = await this.fingerprint();
      if (run !== this.run) return;
      const changed = this.lastHash !== null && hash !== this.lastHash;
      this.lastHash = hash;
      if (changed) onChange(generation);
    } finally {
      this.busy = false;
    }
  }

  private async fingerprint(): Promise<string> {
    const { changeCounter, formats, writeMarker, imageFingerprint } = this.signals;
    if (changeCounter) return `seq:${changeCounter()}`;
    const types = formats ? [...(await formats())].sort() : null;
    const marker = writeMarker ? await writeMarker() : null;
    const text = await this.readText();
    const cheap = `formats:${types?.join(',') ?? '?'}|marker:${marker ?? ''}|text:${digest(text)}`;
    const hasImage = types === null || types.includes(IMAGE_FORMAT);
    if (text !== '' || !imageFingerprint || !hasImage) {
      this.image = null;
      return cheap;
    }
    return `${cheap}|image:${await this.imageIdentity(cheap, imageFingerprint)}`;
  }

  /**
   * A counter that moves when the clipboard image changes while everything cheap stays the same.
   * The image is read once after each cheap change, then again `IMAGE_PROBE_MIN_MS` later and at a
   * doubling interval capped at `IMAGE_PROBE_MAX_MS` (both 2 s, so a fixed 2 s) while it stays the
   * same; the interval resets when it differs.
   */
  private async imageIdentity(cheap: string, read: () => Promise<string | null>): Promise<number> {
    if (this.image?.cheap !== cheap) {
      // A cheap change (reported anyway): one read now, so the next image copied on top of this
      // one is told apart from it.
      this.image = {
        cheap,
        identity: await read(),
        epoch: 0,
        nextProbeAt: this.now() + IMAGE_PROBE_MIN_MS,
        backoffMs: IMAGE_PROBE_MIN_MS,
      };
      return 0;
    }
    const state = this.image;
    if (this.now() < state.nextProbeAt) return state.epoch;
    const identity = await read();
    if (identity !== state.identity) {
      state.epoch++;
      state.backoffMs = IMAGE_PROBE_MIN_MS;
    } else {
      state.backoffMs = Math.min(state.backoffMs * 2, IMAGE_PROBE_MAX_MS);
    }
    state.identity = identity;
    state.nextProbeAt = this.now() + state.backoffMs;
    return state.epoch;
  }
}

function digest(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}
