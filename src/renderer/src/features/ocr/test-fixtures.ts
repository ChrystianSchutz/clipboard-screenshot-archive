/**
 * Test data and a fake preload bridge for the screenshot component tests. Not a test file itself
 * (vitest only runs `*.test.ts(x)`), and nothing outside tests imports it.
 */
import { act } from '@testing-library/react';
import { vi } from 'vitest';
import type { ImageAnalysis } from '@shared/image-analysis';
import type { ClipboardArchiveApi } from '@shared/ipc-contract';
import type { OcrLine, OcrResult } from '@shared/ocr';
import type { AnalysisModelState, ScreenshotDetails } from '@shared/screenshots';
import type { Settings } from '@shared/types';

export function ocrLine(text: string, x0: number, y0: number, x1: number, y1: number): OcrLine {
  return { text, box: { x0, y0, x1, y1 }, confidence: 90, words: [] };
}

/** Two lines on an 800 × 400 screenshot. */
export function ocrResult(
  lines: readonly OcrLine[] = [
    ocrLine('Hello world', 10, 10, 200, 30),
    ocrLine('Second line', 10, 40, 180, 60),
  ],
): OcrResult {
  return { engine: 'tesseract.js@7.0.0/eng', width: 800, height: 400, lines, durationMs: 120 };
}

/** An analysis of the same 800 × 400 screenshot: a dialog (two boxes, one entity) and a button. */
export function imageAnalysis(overrides: Partial<ImageAnalysis> = {}): ImageAnalysis {
  return {
    engine: 'mirage.cact@3d03cee/cactus@4.1.4',
    language: 'en',
    width: 800,
    height: 400,
    description: ['A settings dialog.', 'It has an OK button.'],
    scene: { setting: 'indoor', style: 'screenshot' },
    objects: [
      {
        id: 1,
        label: 'dialog box',
        box: { x0: 100, y0: 40, x1: 300, y1: 120 },
        score: 0.914,
        position: 'center',
        attributes: {},
      },
      {
        id: 2,
        label: 'button',
        box: { x0: 400, y0: 200, x1: 480, y1: 240 },
        score: 0.5,
        attributes: { color: 'blue' },
      },
      {
        id: 1,
        label: 'dialog box',
        box: { x0: 120, y0: 100, x1: 340, y1: 160 },
        score: 0.7,
        attributes: {},
      },
    ],
    text: [
      { text: 'Settings', box: { x0: 110, y0: 45, x1: 200, y1: 60 }, score: 0.9 },
      { text: 'OK', box: { x0: 410, y0: 205, x1: 440, y1: 230 }, score: 0.8 },
    ],
    durationMs: 1234,
    ...overrides,
  };
}

export function screenshotDetails(
  clipId: number,
  overrides: Partial<ScreenshotDetails> = {},
): ScreenshotDetails {
  return {
    clipId,
    width: 800,
    height: 400,
    byteSize: 51_200,
    text: { state: 'done', result: ocrResult() },
    analysis: { state: 'done', result: imageAnalysis() },
    ...overrides,
  };
}

export function settingsFixture(overrides: Partial<Settings> = {}): Settings {
  return {
    captureEnabled: true,
    importScreenshotFolder: false,
    launchAtLogin: false,
    maxClips: 2000,
    excludedApps: [],
    shortcuts: { openHistory: 'CommandOrControl+Alt+V', compare: 'CommandOrControl+Alt+C' },
    theme: 'system',
    accentColor: '#0078d4',
    textRecognition: true,
    imageAnalysis: 'on-demand',
    analysisLanguage: null,
    ...overrides,
  };
}

type Screenshots = ClipboardArchiveApi['screenshots'];
type SettingsApi = ClipboardArchiveApi['settings'];

/** A tiny event source with the bridge's `on…(listener) → unsubscribe` shape. */
class Channel<T> {
  private readonly listeners = new Set<(value: T) => void>();
  readonly subscribe = (listener: (value: T) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  emit(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
  get size(): number {
    return this.listeners.size;
  }
}

/**
 * Installs a fake `window.clipboardArchive` with only the parts the screenshot components use.
 * Every method is a `vi.fn`, so tests can change answers and check calls; `emit…` push events.
 */
export function installFakeApi(
  options: {
    details?: (clipId: number) => Promise<ScreenshotDetails | null>;
    model?: AnalysisModelState;
    settings?: Settings;
  } = {},
) {
  const updated = new Channel<number>();
  const modelEvents = new Channel<AnalysisModelState>();
  const settingsEvents = new Channel<Settings>();

  // Typed against the real bridge, so a contract change breaks the fake at compile time.
  const screenshots = {
    details: vi.fn<Screenshots['details']>(
      options.details ?? ((clipId) => Promise.resolve(screenshotDetails(clipId))),
    ),
    copyText: vi.fn<Screenshots['copyText']>(() => Promise.resolve()),
    analyze: vi.fn<Screenshots['analyze']>(() => Promise.resolve(true)),
    retryText: vi.fn<Screenshots['retryText']>(() => Promise.resolve(true)),
    modelState: vi.fn<Screenshots['modelState']>(() =>
      Promise.resolve(options.model ?? { state: 'ready' }),
    ),
    downloadModel: vi.fn<Screenshots['downloadModel']>(() =>
      Promise.resolve({ state: 'downloading', received: 0, total: 22_000_000 }),
    ),
    cancelDownload: vi.fn<Screenshots['cancelDownload']>(() => Promise.resolve()),
    onUpdated: vi.fn<Screenshots['onUpdated']>(updated.subscribe),
    onModelState: vi.fn<Screenshots['onModelState']>(modelEvents.subscribe),
  };
  const settings = {
    get: vi.fn<SettingsApi['get']>(() => Promise.resolve(options.settings ?? settingsFixture())),
    update: vi.fn<SettingsApi['update']>(),
    onChanged: vi.fn<SettingsApi['onChanged']>(settingsEvents.subscribe),
  };

  Object.defineProperty(window, 'clipboardArchive', {
    configurable: true,
    value: { screenshots, settings },
  });

  return {
    screenshots,
    settings,
    emitUpdated: (clipId: number) => updated.emit(clipId),
    emitModelState: (state: AnalysisModelState) => modelEvents.emit(state),
    emitSettings: (next: Settings) => settingsEvents.emit(next),
    /** Live subscriptions per event, to check that components unsubscribe. */
    listenerCount: () => updated.size + modelEvents.size + settingsEvents.size,
  };
}

/** Makes every `<img>` report this rendered size (jsdom does no layout). */
export function stubImageSize(width: number, height: number): void {
  vi.spyOn(HTMLImageElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width,
    height,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    toJSON: () => ({}),
  });
}

/**
 * jsdom has no canvas and logs "Not implemented" for every `getContext` call; the text layer then
 * falls back to its approximate measurer anyway, so make that explicit and quiet.
 */
export function disableCanvas(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
}

/** Runs `change` inside React's `act` and lets the promises it starts settle. */
export async function settle(change: () => void = () => undefined): Promise<void> {
  await act(async () => {
    change();
    await Promise.resolve();
  });
}

/** A promise with its resolver, to control when a fake IPC call answers. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
