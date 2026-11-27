import { posix } from 'node:path';

// macOS-only feature: POSIX paths, also when the tests run on Windows.
const { isAbsolute, join } = posix;

/**
 * macOS saves screenshots (Cmd+Shift+3/4/5) as files instead of putting them on the clipboard.
 * This module finds that folder and reports each new screenshot file once it is fully written.
 * Only the Control variants (Cmd+Ctrl+Shift+4) use the clipboard, which the normal capture covers.
 */

/** Reads `defaults read com.apple.screencapture location`; `null` when the key is not set. */
export type ReadScreencaptureDefaults = () => Promise<string | null>;

/** The folder from the `defaults` output: trimmed, `~` expanded, relative paths rejected. */
export function parseScreenshotLocation(output: string | null, homeDir: string): string | null {
  const value = output?.trim() ?? '';
  if (!value) return null;
  const expanded =
    value === '~' ? homeDir : value.startsWith('~/') ? join(homeDir, value.slice(2)) : value;
  return isAbsolute(expanded) ? expanded : null;
}

/** Where screenshots go: the user's configured folder, or the Desktop (the macOS default). */
export async function resolveScreenshotFolder(
  read: ReadScreencaptureDefaults,
  homeDir: string,
): Promise<string> {
  let output: string | null = null;
  try {
    output = await read();
  } catch {
    // `defaults` exits with 1 when the key was never set: that just means "Desktop".
  }
  return parseScreenshotLocation(output, homeDir) ?? join(homeDir, 'Desktop');
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g)$/i;

/**
 * Screenshot files worth reading. macOS first writes a hidden temp file (`.Screenshot …`) and
 * renames it when done, so hidden names are skipped. HEIC/TIFF/PDF (other `screencapture` types)
 * are skipped too: Chromium cannot decode them everywhere.
 */
export function isScreenshotCandidate(fileName: string): boolean {
  return !fileName.startsWith('.') && IMAGE_EXTENSIONS.test(fileName);
}

export interface FileFacts {
  readonly size: number;
  readonly mtimeMs: number;
}

export interface ScreenshotFolderDeps {
  /** Starts watching `dir`; calls back with a file name for every change; returns a stop function. */
  readonly watch: (dir: string, onName: (fileName: string) => void) => () => void;
  readonly stat: (path: string) => Promise<FileFacts | null>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /**
   * Reports a fully written screenshot with the capture ticket taken when the file was first seen
   * (see `ticket`), so a pause during its settle time drops it even if capture resumed since.
   */
  readonly onScreenshot: (path: string, ticket: number) => void;
  /**
   * The capture generation (`CaptureGate.current`), taken the moment a candidate is first seen,
   * before its size has settled. Default: always 0 (no gate).
   */
  readonly ticket?: () => number;
  /** How long a file's size must stay the same before it counts as fully written. */
  readonly settleMs?: number;
}

/** Bound on remembered first-seen tickets (files seen but not yet settled or rejected). */
const MAX_FIRST_SEEN = 1_024;

/**
 * Watches the screenshots folder and reports each new screenshot exactly once.
 *
 * - Files that existed before `start()` are not imported: the archive starts when the user
 *   enables it, it does not swallow years of Desktop screenshots.
 * - A file is reported only when its size is non-zero and unchanged across `settleMs`.
 * - File-system events come in bursts (create, modify, rename); each path is checked at most
 *   once at a time and reported at most once.
 * - The capture ticket is taken when a path is first seen, not when it is reported: a screenshot
 *   that appears while capture is paused keeps the paused generation through its settle time (and
 *   through later events for the same path), so resuming before it settles never records it.
 */
export class ScreenshotFolderWatcher {
  private stopWatching: (() => void) | null = null;
  private startedAt = 0;
  private readonly inFlight = new Set<string>();
  private readonly reported = new Set<string>();
  /** The capture ticket of each path seen but not yet reported or rejected (insertion order). */
  private readonly firstSeen = new Map<string, number>();
  /** Bumped by every start and stop: a check that began in another run reports nothing. */
  private run = 0;
  private readonly settleMs: number;

  constructor(
    private readonly dir: string,
    private readonly deps: ScreenshotFolderDeps,
  ) {
    this.settleMs = deps.settleMs ?? 400;
  }

  start(): void {
    if (this.stopWatching) return;
    // Small slack: on some file systems mtime has 1 s resolution.
    this.startedAt = this.deps.now() - 1_000;
    this.run++;
    this.stopWatching = this.deps.watch(this.dir, (fileName) => void this.consider(fileName));
  }

  stop(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    this.run++;
    this.firstSeen.clear();
  }

  /** Visible for tests: resolves when the file has been reported or rejected. */
  async consider(fileName: string): Promise<void> {
    if (!isScreenshotCandidate(fileName) || !this.stopWatching) return;
    const path = join(this.dir, fileName);
    // Reported, or dropped after its first-seen ticket was evicted.
    if (this.reported.has(path)) return;
    // The ticket is taken now, at first sight, before the file has settled.
    if (!this.firstSeen.has(path)) this.rememberTicket(path);
    if (this.inFlight.has(path)) return;
    const run = this.run;
    this.inFlight.add(path);
    try {
      const verdict = await this.check(path);
      // A check that finishes after stop() reports nothing and is not remembered, so the file
      // is picked up again (with a fresh ticket) after the next start().
      if (run !== this.run) return; // stop() bumps `run`
      if (verdict === 'rejected') this.firstSeen.delete(path);
      if (verdict !== 'complete') return;
      const ticket = this.firstSeen.get(path);
      this.firstSeen.delete(path);
      this.reported.add(path);
      // Its first-seen ticket was evicted (a burst of more than `MAX_FIRST_SEEN` candidates): the
      // generation it was first seen in is unknown, so it is dropped, never given a fresh ticket.
      if (ticket === undefined) return;
      this.deps.onScreenshot(path, ticket);
    } finally {
      this.inFlight.delete(path);
    }
  }

  private ticket(): number {
    return this.deps.ticket?.() ?? 0;
  }

  private rememberTicket(path: string): void {
    if (this.firstSeen.size >= MAX_FIRST_SEEN) {
      const oldest = this.firstSeen.keys().next();
      if (!oldest.done) {
        this.firstSeen.delete(oldest.value);
        // Dropped for good: a later event for that path must not take a fresh ticket for it.
        this.reported.add(oldest.value);
      }
    }
    this.firstSeen.set(path, this.ticket());
  }

  /** `complete`: report it; `pending`: still being written (a later event checks again). */
  private async check(path: string): Promise<'complete' | 'pending' | 'rejected'> {
    const first = await this.deps.stat(path);
    if (!first || first.mtimeMs < this.startedAt) return 'rejected';
    await this.deps.sleep(this.settleMs);
    const second = await this.deps.stat(path);
    if (second === null) return 'rejected';
    return second.size > 0 && second.size === first.size ? 'complete' : 'pending';
  }
}
