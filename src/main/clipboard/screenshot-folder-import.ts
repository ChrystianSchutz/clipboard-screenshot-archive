import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import type { Clip, Settings } from '@shared/types';
import { createMacScreenshotWatcher } from '../images/node-screenshot-folder';
import type { ImageFileSource } from '../images/ports';
import type { ScreenshotCaptureResult } from '../images/screenshots';
import type { CaptureGate } from './capture-gate';
import { loadFgetxattr, readDescriptorAttribute, type Fgetxattr } from './mac/xattr';
import { openRegularFile, type OpenedRegularFile } from './regular-file';

/**
 * macOS screenshots (Cmd+Shift+3/4/5) land in a folder, not on the clipboard. When the user opts
 * in ("Import screenshots from the screenshot folder", off by default), this brings them into the
 * history like clipboard screenshots, under the same rules: nothing while capture is paused,
 * retention (`maxClips`) applies, and text recognition follows the settings.
 *
 * The folder is usually the Desktop, full of other pictures, so a file is imported only when:
 * - its name looks like one macOS gives screenshots ("Screenshot 2026-11-27 at 10.15.30.png",
 *   localised, or the user's own `com.apple.screencapture name`);
 * - it is a regular file in the folder itself, not a symbolic link (checked with `lstat`, then
 *   opened once with `O_NOFOLLOW`, see `openRegularFile`), so no bytes come from outside the folder;
 * - it was created after the import started (birth time of the open file, not just modification
 *   time), so an older picture that is renamed, touched or copied in is never swallowed;
 * - macOS marks it as a screen capture with an affirmative `kMDItemIsScreenCapture` extended
 *   attribute, read with `fgetxattr` on the open descriptor (see `isMacScreenCapture`), so a fresh
 *   picture that merely has a screenshot-like name is not taken;
 * - the folder watcher saw it appear and finish writing (see `ScreenshotFolderWatcher`).
 *
 * Facts, provenance and bytes all come from the one descriptor opened for the file: a file swapped
 * in at the same path after the provenance check is never the one archived.
 *
 * The capture ticket (`CaptureGate` generation) is the one the folder watcher took when it first
 * saw the file, before its settle time: a screenshot taken while capture was paused is dropped
 * even if capture is resumed before the file has settled.
 */

/** Names macOS gives screenshots, by system language (default `com.apple.screencapture name`). */
export const MAC_SCREENSHOT_PREFIXES: readonly string[] = [
  'Screenshot',
  'Screen Shot',
  'Bildschirmfoto',
  'Capture d’écran',
  "Capture d'écran",
  'Captura de pantalla',
  'Captura de Tela',
  'Istantanea schermo',
  'Zrzut ekranu',
  'Schermafbeelding',
  'Skärmavbild',
  'Skærmbillede',
  'Skjermbilde',
  'Näyttökuva',
  'Snímek obrazovky',
  'Képernyőfotó',
  'Ekran Resmi',
  'Снимок экрана',
  'スクリーンショット',
  '스크린샷',
  '截屏',
  '屏幕快照',
  '螢幕截圖',
];

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a file name looks like a macOS screenshot: a known (or the configured) prefix, then the
 * date and time stamp macOS adds, or, with the stamp turned off, nothing but a counter.
 */
export function isMacScreenshotName(path: string, customPrefix: string | null = null): boolean {
  // File-system events may deliver decomposed (NFD) names; the prefixes are composed (NFC).
  const name = posix.basename(path.replaceAll('\\', '/')).normalize('NFC');
  if (name.startsWith('.') || name.length > 255) return false;
  const custom = customPrefix?.trim().normalize('NFC');
  const prefixes = custom ? [custom, ...MAC_SCREENSHOT_PREFIXES] : MAC_SCREENSHOT_PREFIXES;
  const prefix = prefixes.map((value) => escapeRegExp(value.normalize('NFC'))).join('|');
  const stamped = new RegExp(
    `^(?:${prefix}) \\d{4}-\\d{2}-\\d{2}\\b.*\\d{1,2}[.:]\\d{2}[.:]\\d{2}.*\\.(?:png|jpe?g)$`,
    'iu',
  );
  const unstamped = new RegExp(`^(?:${prefix})(?: \\d+)?\\.(?:png|jpe?g)$`, 'iu');
  return stamped.test(name) || unstamped.test(name);
}

/** Slack on the birth-time check: some file systems store times with 1 s resolution. */
const BIRTH_TIME_SLACK_MS = 1_000;

export type ScreenshotImportOutcome =
  | 'recorded'
  | 'stopped'
  | 'paused'
  | 'not-a-screenshot'
  | 'not-a-regular-file'
  | 'not-a-screen-capture'
  | 'old-file'
  | `skipped-${string}`;

/** A candidate opened once (see `openRegularFile`); every later step refers to this descriptor. */
export type OpenedCandidate = OpenedRegularFile;

export interface ScreenshotFolderImportDeps {
  /**
   * Creates the folder watcher; it reports each new, fully written image file by path, with the
   * capture ticket it took from `ticket` when it first saw the file (before the file settled).
   */
  readonly createWatcher: (
    onFile: (path: string, ticket: number) => void,
    ticket: () => number,
  ) => Promise<{ start(): void; stop(): void }>;
  /** The user's custom screenshot name (`com.apple.screencapture name`), or `null`. */
  readonly customPrefix: () => Promise<string | null>;
  /**
   * Opens the file once, only if it is a regular file at the path itself (never through a link);
   * `not-a-regular-file` for a link, folder, socket, device, or a file that is gone.
   */
  readonly openFile: (path: string) => Promise<OpenedCandidate | 'not-a-regular-file'>;
  /**
   * Whether macOS marks the open file as a screen capture, read from the open descriptor (false
   * when that cannot be told).
   */
  readonly isScreenCapture: (file: OpenedCandidate) => Promise<boolean>;
  readonly settings: () => Pick<Settings, 'captureEnabled' | 'maxClips'>;
  /** The capture generation shared with clipboard capture (pause, resume, shutdown). */
  readonly gate: CaptureGate;
  /**
   * Stores the file as an image clip (`Screenshots.captureFile`), reading its bytes from the open
   * descriptor; `canRecord` is checked right before the database insert.
   */
  readonly captureFile: (
    file: ImageFileSource,
    copiedAt: number,
    canRecord: () => boolean,
  ) => Promise<ScreenshotCaptureResult>;
  readonly prune: (maxClips: number) => number;
  /** Same callback as for clipboard captures: sweep after pruning, refresh the history. */
  readonly onRecorded: (clip: Clip, created: boolean) => void;
  readonly onError: (error: unknown) => void;
  readonly now: () => number;
}

/** Owns the folder watcher's lifetime and applies the capture rules to each file it reports. */
export class ScreenshotFolderImport {
  private state: 'idle' | 'starting' | 'running' | 'stopped' = 'idle';
  private watcher: { start(): void; stop(): void } | null = null;
  private customPrefix: string | null = null;
  private startedAt = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ScreenshotFolderImportDeps) {}

  async start(): Promise<void> {
    if (this.state !== 'idle') return;
    this.state = 'starting';
    this.startedAt = this.deps.now();
    try {
      const [prefix, watcher] = await Promise.all([
        this.deps.customPrefix().catch(() => null),
        this.deps.createWatcher(
          (path, ticket) => void this.handleFile(path, ticket),
          () => this.deps.gate.current,
        ),
      ]);
      // Stopped (app quitting) while the folder was being resolved: never start watching.
      if (!this.is('starting')) return;
      this.customPrefix = prefix;
      this.watcher = watcher;
      watcher.start();
      this.state = 'running';
    } catch (error) {
      if (this.state === 'starting') this.state = 'idle';
      this.deps.onError(error);
    }
  }

  /** The current state, read afresh (it may change across an await). */
  private is(state: typeof this.state): boolean {
    return this.state === state;
  }

  stop(): void {
    this.state = 'stopped';
    this.watcher?.stop();
    this.watcher = null;
  }

  /**
   * One reported file; imports run one at a time (each decodes a full-size image). `generation` is
   * the capture ticket the watcher took when it first saw the file (default: now); a pause, resume
   * or shutdown after that drops the import.
   */
  handleFile(
    path: string,
    generation: number = this.deps.gate.current,
  ): Promise<ScreenshotImportOutcome> {
    const outcome = this.queue.then(() => this.importFile(path, generation));
    this.queue = outcome.catch(() => undefined);
    return outcome.catch((error: unknown) => {
      this.deps.onError(error);
      return 'skipped-error' as const;
    });
  }

  /** Whether an import taken at `generation` may still commit. */
  private canRecord(generation: number): boolean {
    return (
      this.is('running') &&
      this.deps.gate.isCurrent(generation) &&
      this.deps.settings().captureEnabled
    );
  }

  private async importFile(path: string, generation: number): Promise<ScreenshotImportOutcome> {
    if (this.state !== 'running') return 'stopped';
    if (!this.canRecord(generation)) return 'paused';
    if (!isMacScreenshotName(path, this.customPrefix)) return 'not-a-screenshot';
    const file = await this.deps.openFile(path);
    if (file === 'not-a-regular-file') return 'not-a-regular-file';
    try {
      return await this.importOpened(file, generation);
    } finally {
      await file.close();
    }
  }

  private async importOpened(
    file: OpenedCandidate,
    generation: number,
  ): Promise<ScreenshotImportOutcome> {
    const born = file.birthtimeMs;
    if (born === null || born < this.startedAt - BIRTH_TIME_SLACK_MS) return 'old-file';
    if (!(await this.deps.isScreenCapture(file))) return 'not-a-screen-capture';
    // The settings may have changed while the file was checked.
    if (!this.is('running')) return 'stopped';
    if (!this.canRecord(generation)) return 'paused';

    // The bytes come from the same descriptor whose provenance was just checked.
    const result = await this.deps.captureFile(file, this.deps.now(), () =>
      this.canRecord(generation),
    );
    if (result.status === 'skipped') return `skipped-${result.reason}`;
    if (result.created) this.deps.prune(this.deps.settings().maxClips);
    this.deps.onRecorded(result.clip, result.created);
    return 'recorded';
  }
}

const run = promisify(execFile);

/** `defaults read com.apple.screencapture name` (exits 1 when the user never set one). */
async function readScreencaptureName(): Promise<string | null> {
  try {
    const { stdout } = await run('/usr/bin/defaults', ['read', 'com.apple.screencapture', 'name'], {
      timeout: 5_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** The attribute `screencapture` sets on the files it writes. */
const SCREEN_CAPTURE_ATTRIBUTE = 'com.apple.metadata:kMDItemIsScreenCapture';

/** Reads an extended attribute from an open descriptor (see `readDescriptorAttribute`). */
export type ReadDescriptorAttribute = (fd: number, name: string) => Uint8Array | null;

/**
 * Whether an extended attribute value says "yes": a binary property list whose top object is
 * `true` or the integer 1 (how `screencapture` writes `kMDItemIsScreenCapture`), or the text `1` /
 * `true`. A present but false value, `0`, garbage or an empty value is "no".
 */
export function isAffirmativeAttribute(bytes: Uint8Array): boolean {
  const header = new TextDecoder().decode(bytes.subarray(0, 8));
  if (header === 'bplist00') return binaryPlistTopIsTrue(bytes);
  const text = new TextDecoder().decode(bytes).trim().toLowerCase();
  return text === '1' || text === 'true';
}

/** Whether the top object of a binary property list is `true` or the integer 1. */
function binaryPlistTopIsTrue(bytes: Uint8Array): boolean {
  if (bytes.length < 8 + 1 + 32) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trailer = bytes.length - 32;
  const offsetSize = view.getUint8(trailer + 6);
  const objects = view.getBigUint64(trailer + 8);
  const top = view.getBigUint64(trailer + 16);
  const tableAt = view.getBigUint64(trailer + 24);
  if (offsetSize < 1 || offsetSize > 8 || top >= objects) return false;
  const entryAt = tableAt + top * BigInt(offsetSize);
  if (entryAt + BigInt(offsetSize) > BigInt(trailer)) return false;
  let offset = 0;
  for (let index = 0; index < offsetSize; index++) {
    offset = offset * 256 + view.getUint8(Number(entryAt) + index);
  }
  if (offset < 8 || offset >= trailer) return false;
  const marker = view.getUint8(offset);
  if (marker === 0x09) return true; // `true`
  if (marker >> 4 !== 0x1) return false; // `false` (0x08), or neither a boolean nor an integer
  const width = 2 ** (marker & 0x0f);
  if (width > 8 || offset + 1 + width > trailer) return false;
  let value = 0n;
  for (let index = 0; index < width; index++) {
    value = value * 256n + BigInt(view.getUint8(offset + 1 + index));
  }
  return value === 1n;
}

/** What a provenance check needs of the open file (see `OpenedRegularFile`). */
export type ProvenanceFile = Pick<OpenedRegularFile, 'fd'>;

/**
 * Whether macOS marks the open file as a screen capture. `screencapture` writes the extended
 * attribute `com.apple.metadata:kMDItemIsScreenCapture` (a binary plist holding `true`) on every
 * file it saves. It is read with `fgetxattr` on the descriptor the bytes are later read from
 * (see `mac/xattr.ts`), never through the path: a path that names another file for a moment
 * cannot lend it that file's metadata.
 *
 * The value must be affirmative. A missing, false or unreadable attribute means "not a screen
 * capture": there is no path-based fallback (`xattr`, `mdls`, Spotlight), because none of them
 * can be bound to the descriptor. A copy that lost its extended attributes is therefore not
 * imported; a file is never imported on its name alone.
 */
export function isMacScreenCapture(
  file: ProvenanceFile,
  readAttribute: ReadDescriptorAttribute,
): boolean {
  if (!Number.isInteger(file.fd) || file.fd < 0) return false;
  const value = readAttribute(file.fd, SCREEN_CAPTURE_ATTRIBUTE);
  return value !== null && isAffirmativeAttribute(value);
}

/**
 * `isMacScreenCapture` with libSystem's `fgetxattr`, or `null` (fail closed: every file is
 * refused) when it cannot be loaded. Exported for tests (`load` is faked there).
 */
export async function macScreenCaptureCheck(
  file: ProvenanceFile,
  onError: (error: unknown) => void,
  load: () => Promise<Fgetxattr | null> = loadFgetxattr,
): Promise<boolean> {
  const fgetxattr = await load();
  if (!fgetxattr) {
    if (!fgetxattrMissingLogged) {
      fgetxattrMissingLogged = true;
      onError(new Error('fgetxattr unavailable: screenshot-folder imports are refused'));
    }
    return false;
  }
  return isMacScreenCapture(file, (fd, name) => readDescriptorAttribute(fgetxattr, fd, name));
}

let fgetxattrMissingLogged = false;

/** The import with real macOS adapters (screenshots folder, `defaults`, descriptor, provenance). */
export function createMacScreenshotImport(
  deps: Pick<
    ScreenshotFolderImportDeps,
    'settings' | 'gate' | 'captureFile' | 'prune' | 'onRecorded' | 'onError'
  >,
): ScreenshotFolderImport {
  return new ScreenshotFolderImport({
    ...deps,
    createWatcher: (onFile, ticket) => createMacScreenshotWatcher(onFile, ticket),
    customPrefix: readScreencaptureName,
    openFile: openRegularFile,
    isScreenCapture: (file) => macScreenCaptureCheck(file, deps.onError),
    now: Date.now,
  });
}
