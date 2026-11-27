import type { WebContents } from 'electron';
import { once } from 'node:events';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaptureInfo } from '@shared/types';

/**
 * Self-check for the packaged app, run by CI with `CLIPBOARD_ARCHIVE_SMOKE=1` (see
 * `scripts/smoke-packaged.mjs`). It checks exactly this, nothing more:
 * - the app started (every service built, IPC registered);
 * - the native clipboard module (koffi) loaded and the Win32 clipboard listener is registered;
 * - the renderer document loaded from the package and React rendered the palette (a failed load
 *   shows Chromium's error page, which still runs the preload, so the bridge alone proves nothing);
 * - the sandboxed renderer reached main through the preload bridge, past the IPC sender check
 *   (so the packaged `app://` document is trusted and the preload ran);
 * - a regex search answered, so the search worker thread started from inside the package;
 * - text recognition read a word the renderer drew, so the OCR utility process, tesseract.js
 *   (unpacked from the asar) and the bundled language data all load from the package.
 * By default it never reads or writes the clipboard, and it does not prove that copies are captured.
 * Only on CI, with `--capture` (see `runOsCaptureCheck`), it also checks real OS copies made by the
 * script on the runner's clipboard, each acknowledged by the app with its outcome: an ordinary copy
 * is recorded, a private one (DWORD 0) is skipped as `private-format`, and the same writer's public
 * copy (DWORD 1) is recorded.
 */
export interface SmokeReport {
  readonly ok: boolean;
  readonly platform: string;
  readonly capture: CaptureInfo;
  readonly rendered: boolean;
  readonly preloadBridge: boolean;
  readonly ipcRoundTrip: boolean;
  readonly regexWorker: boolean;
  readonly textRecognition: boolean;
  /** Result of the CI-only OS copy check, or `null` when it was not asked for. */
  readonly osCapture: OsCaptureReport | null;
  readonly error: string | null;
}

export interface SmokeInput {
  readonly renderer: WebContents;
  readonly capture: CaptureInfo;
  readonly version: string;
  readonly reportPath: string;
  /** Reads the text in a PNG with the app's OCR worker. */
  readonly recognizeText: (png: Uint8Array) => Promise<string>;
  /** CI-only OS copy check (`runOsCaptureCheck`); absent in an ordinary smoke run. */
  readonly osCapture?: (() => Promise<OsCaptureReport>) | undefined;
}

export interface OsCaptureReport {
  /** The ordinary copy (`Set-Clipboard`) was acknowledged as recorded and is in the history. */
  readonly normalRecorded: boolean;
  /**
   * The copy marked `CanIncludeInClipboardHistory = 0` was acknowledged as skipped with reason
   * `private-format` and is not in the history.
   */
  readonly privateSkipped: boolean;
  /** Positive control: the same writer with the DWORD set to 1 was acknowledged as recorded. */
  readonly publicRecorded: boolean;
  /** The app's acknowledged outcome of each copy (`recorded`, `skipped:<reason>`, or null). */
  readonly outcomes: {
    readonly normal: string | null;
    readonly secret: string | null;
    readonly public: string | null;
  };
  readonly error: string | null;
}

/** Written by the app when it listens; the script starts copying only then. */
export const OS_CAPTURE_READY_FILE = 'smoke-capture-ready';
/**
 * Appended by the app, one JSON line per handled clipboard change: `{ "sequence": n, "outcome":
 * "recorded" | "skipped:<reason>" | "error" }`. The script waits for the line of each copy's final
 * clipboard sequence number before it makes the next copy.
 */
export const OS_CAPTURE_ACK_FILE = 'smoke-capture-acks.jsonl';
/**
 * Written by the script after all copies: for `normal`, `secret` and `public`, the token it copied
 * and the clipboard sequence number its copy left behind.
 */
export const OS_CAPTURE_DONE_FILE = 'smoke-capture-done.json';

/** The app's outcome for one handled clipboard change. */
export interface CaptureAck {
  readonly sequence: number | null;
  readonly outcome: string;
}

/** The app half of the acknowledgment: remembers each outcome and appends it to the ack file. */
export class CaptureAcks {
  private readonly acks: CaptureAck[] = [];
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  /** Records one handled change; the file write is chained so lines never interleave. */
  record(sequence: number | null, outcome: { status: string; reason?: string } | 'error'): void {
    const text =
      outcome === 'error'
        ? 'error'
        : outcome.status === 'recorded'
          ? 'recorded'
          : `skipped:${outcome.reason ?? 'unknown'}`;
    const ack = { sequence, outcome: text };
    this.acks.push(ack);
    this.writes = this.writes
      .then(() => appendFile(join(this.dir, OS_CAPTURE_ACK_FILE), `${JSON.stringify(ack)}\n`))
      .catch(() => undefined);
  }

  /** The outcome acknowledged for `sequence`, or null when no change with it was handled. */
  outcomeOf(sequence: number): string | null {
    return this.acks.findLast((ack) => ack.sequence === sequence)?.outcome ?? null;
  }
}

interface CopyReport {
  readonly token: string;
  readonly sequence: number;
}

type CopyReports = Record<'normal' | 'secret' | 'public', CopyReport>;

export interface OsCaptureInput {
  /** Folder shared with the script (the smoke run's temp profile). */
  readonly dir: string;
  /** Whether the history holds a clip with exactly this text. */
  readonly hasClip: (text: string) => boolean;
  /** The outcomes the app acknowledged (see `CaptureAcks`). */
  readonly acks: Pick<CaptureAcks, 'outcomeOf'>;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The app half of the CI-only OS copy check: announce readiness, let the script copy an ordinary,
 * a private (DWORD 0) and a public (DWORD 1) token through the real Windows clipboard while the app
 * acknowledges each handled change, then check each copy's acknowledged outcome and the history.
 * A lost notification or an unreadable marker leaves no `skipped:private-format` acknowledgment,
 * so it fails instead of passing as "not recorded".
 */
export async function runOsCaptureCheck(input: OsCaptureInput): Promise<OsCaptureReport> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const timeoutMs = input.timeoutMs ?? 90_000;
  const pollMs = 100;
  const none = { normal: null, secret: null, public: null };
  try {
    await writeFile(join(input.dir, OS_CAPTURE_READY_FILE), '');
    let copies: CopyReports | null = null;
    for (let waited = 0; copies === null; waited += pollMs) {
      if (waited >= timeoutMs) throw new Error('The script never reported its copies');
      copies = await readCopies(join(input.dir, OS_CAPTURE_DONE_FILE));
      if (copies === null) await sleep(pollMs);
    }
    const outcomes = {
      normal: input.acks.outcomeOf(copies.normal.sequence),
      secret: input.acks.outcomeOf(copies.secret.sequence),
      public: input.acks.outcomeOf(copies.public.sequence),
    };
    return {
      normalRecorded: outcomes.normal === 'recorded' && input.hasClip(copies.normal.token),
      privateSkipped:
        outcomes.secret === 'skipped:private-format' && !input.hasClip(copies.secret.token),
      publicRecorded: outcomes.public === 'recorded' && input.hasClip(copies.public.token),
      outcomes,
      error: null,
    };
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : String(caught);
    return {
      normalRecorded: false,
      privateSkipped: false,
      publicRecorded: false,
      outcomes: none,
      error,
    };
  }
}

async function readCopies(path: string): Promise<CopyReports | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null; // not written yet
  }
  const parsed = JSON.parse(raw) as Partial<Record<keyof CopyReports, unknown>>;
  const copy = (value: unknown): CopyReport => {
    const { token, sequence } = (value ?? {}) as { token?: unknown; sequence?: unknown };
    if (typeof token !== 'string' || !token || !Number.isSafeInteger(sequence)) {
      throw new Error('The script reported malformed copies');
    }
    return { token, sequence: sequence as number };
  };
  return { normal: copy(parsed.normal), secret: copy(parsed.secret), public: copy(parsed.public) };
}

export async function runSmokeCheck(input: SmokeInput): Promise<SmokeReport> {
  const { renderer, capture, version } = input;
  let rendered = false;
  let preloadBridge = false;
  let ipcRoundTrip = false;
  let regexWorker = false;
  let textRecognition = false;
  let error: string | null = null;
  try {
    if (renderer.isLoading()) await once(renderer, 'did-stop-loading');
    rendered = (await renderer.executeJavaScript(RENDERED_PALETTE)) === true;
    preloadBridge =
      (await renderer.executeJavaScript('typeof window.clipboardArchive')) === 'object';
    ipcRoundTrip =
      (await renderer.executeJavaScript(
        'window.clipboardArchive.app.info().then((info) => info.version)',
      )) === version;
    regexWorker =
      (await renderer.executeJavaScript(
        "window.clipboardArchive.history.query({ text: 'a+', regex: true, limit: 1 })" +
          '.then((page) => Array.isArray(page.clips))',
      )) === true;
    const dataUrl = (await renderer.executeJavaScript(DRAW_OCR_PROBE)) as string;
    const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    textRecognition = (await input.recognizeText(png)).includes(OCR_PROBE_WORD);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const osCapture = input.osCapture ? await input.osCapture() : null;
  const osCaptureOk =
    osCapture === null ||
    (osCapture.normalRecorded && osCapture.privateSkipped && osCapture.publicRecorded);

  const nativeCapture =
    process.platform !== 'win32' || (capture.mode === 'event' && capture.sourceDetection);
  const report: SmokeReport = {
    ok:
      rendered &&
      preloadBridge &&
      ipcRoundTrip &&
      regexWorker &&
      textRecognition &&
      nativeCapture &&
      osCaptureOk,
    platform: process.platform,
    capture,
    rendered,
    preloadBridge,
    ipcRoundTrip,
    regexWorker,
    textRecognition,
    osCapture,
    error,
  };
  await writeFile(input.reportPath, JSON.stringify(report, null, 2));
  return report;
}

/** Resolves true once the palette's root element exists (React rendered), false after 10 s. */
const RENDERED_PALETTE = `new Promise((resolve) => {
  const deadline = Date.now() + 10000;
  const check = () => {
    if (document.querySelector('.palette')) resolve(true);
    else if (Date.now() > deadline) resolve(false);
    else setTimeout(check, 50);
  };
  check();
})`;

/** A word the OCR probe draws and must read back. */
const OCR_PROBE_WORD = 'CLIPBOARD';

/** Draws the probe word black on white in the renderer and returns it as a PNG data URL. */
const DRAW_OCR_PROBE = `(() => {
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000000';
  context.font = '48px Arial, sans-serif';
  context.textBaseline = 'middle';
  context.fillText('${OCR_PROBE_WORD}', 24, 48);
  return canvas.toDataURL('image/png');
})()`;
