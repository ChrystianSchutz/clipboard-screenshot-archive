import { app, nativeImage } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { ImageAnalysis } from '@shared/image-analysis';
import { analysisLanguageFor } from '@shared/image-settings';
import type { InvokeChannel } from '@shared/ipc-contract';
import { ocrText, type OcrResult } from '@shared/ocr';
import type { AnalysisModelState } from '@shared/screenshots';
import type { Settings } from '@shared/types';
import {
  MIRAGE_ANALYZER_ID,
  MIRAGE_WEIGHTS,
  CACTUS_RUNTIME_VERSION,
} from '../analysis/mirage-model';
import { RemoteImageAnalyzer, type AnalysisRequest } from '../analysis/remote-image-analyzer';
import type { Errlog } from '../diagnostics/errlog';
import type { InvokeHandlers } from '../ipc/register';
import { ModelDownloader } from '../models/model-downloader';
import { nodeModelFetch, nodeModelFileSystem } from '../models/node-model-io';
import type { OcrImage } from '../ocr/ports';
import { RemoteTextRecognizer } from '../ocr/remote-text-recognizer';
import type { ClipRepository } from '../storage/clip-repository';
import { ImageRepository } from '../storage/image-repository';
import { spawnElectronWorker } from '../workers/electron-worker';
import { KeyedQueue } from '../workers/keyed-queue';
import {
  electronClipboardImages,
  electronImageDecoder,
  electronImageFiles,
  electronWriteImage,
  pngClipboardImages,
} from './electron-images';
import { HashLocks } from './hash-locks';
import { ImageCaptureService } from './image-capture';
import { ImageStore } from './image-store';
import { nodeImageFileSystem } from './node-image-fs';
import { serveScreenshotProtocol } from './screenshot-protocol';
import { Screenshots } from './screenshots';

/** Languages Tesseract reads (traineddata files shipped in resources/ocr/tessdata). */
const OCR_LANGUAGES = ['eng', 'pol'] as const;

export interface ScreenshotFeatureOptions {
  readonly db: DatabaseSync;
  readonly clips: ClipRepository;
  readonly settings: () => Settings;
  /** Folder of the built main bundle (worker entries sit next to it). */
  readonly mainDir: string;
  /** E2E sandbox clipboard: images are read from and written to memory, never the system clipboard. */
  readonly sandbox: {
    readImage(): Promise<Uint8Array | null>;
    writeImage(png: Uint8Array, marker?: string): Promise<void>;
  } | null;
  /** Writes composed text (lines read from a screenshot) without recording it (`writeComposedText`). */
  readonly writeText: (text: string) => Promise<void>;
  /** The app's single clipboard write chain, with write markers (`CaptureService.writeMarked`). */
  readonly writeMarked?: <T>(write: (marker?: string) => Promise<T>) => Promise<T>;
  readonly broadcast: {
    updated(clipId: number): void;
    modelState(state: AnalysisModelState): void;
    historyChanged(): void;
  };
  readonly errlog: Errlog;
}

export type ScreenshotChannel = Extract<InvokeChannel, `screenshot:${string}`>;

export interface ScreenshotFeature {
  readonly screenshots: Screenshots;
  readonly handlers: Pick<InvokeHandlers, ScreenshotChannel>;
  /**
   * E2E sandbox only: stores an analysis as if the analyzer had returned it, so the panel can be
   * tested without downloading or running the model. Returns false for a clip that is not an image.
   */
  injectAnalysis(clipId: number, analysis: ImageAnalysis): boolean;
  /**
   * E2E sandbox only: marks a screenshot's text as unreadable, as after a failed recognition, so
   * the "Try again" action can be tested. Returns false for a clip that is not an image.
   */
  injectTextFailure(clipId: number): boolean;
  /** Packaged-app smoke check only: reads the text in a PNG with the real OCR worker. */
  recognizeText(png: Uint8Array): Promise<string>;
  dispose(): Promise<void>;
}

/** Where bundled resources live: next to the app when packaged, the repo's resources/ in development. */
export function resourcesDir(mainDir: string): string {
  return app.isPackaged ? process.resourcesPath : join(mainDir, '../../resources');
}

/**
 * Builds the screenshot feature with its Electron adapters: image store in `userData/images`,
 * Tesseract and Mirage in their own utility processes, the optional model in `userData/models`,
 * and the `clip-image:` protocol. The rules live in the services; this only connects them.
 */
export function createScreenshotFeature(options: ScreenshotFeatureOptions): ScreenshotFeature {
  const { db, clips, settings, mainDir, sandbox, broadcast, errlog } = options;
  const userData = app.getPath('userData');
  const resources = resourcesDir(mainDir);

  const repository = new ImageRepository(db, clips);
  const store = new ImageStore(join(userData, 'images'), nodeImageFileSystem);
  const model = new ModelDownloader(join(userData, 'models'), MIRAGE_WEIGHTS, {
    fetch: nodeModelFetch,
    fs: nodeModelFileSystem,
  });

  const { version: tesseractVersion } = createRequire(import.meta.url)(
    'tesseract.js/package.json',
  ) as { version: string };
  const recognizer = new RemoteTextRecognizer({
    id: `tesseract.js@${tesseractVersion}/${OCR_LANGUAGES.join('+')}`,
    spawn: () =>
      spawnElectronWorker<OcrImage>({
        entry: join(mainDir, 'ocr-host.js'),
        args: [
          `--tessdata=${join(resources, 'ocr', 'tessdata')}`,
          `--languages=${OCR_LANGUAGES.join(',')}`,
        ],
        serviceName: 'Text recognition',
      }),
    onError: (error) => errlog.error(error, 'ocr-worker'),
  });
  const analyzer = new RemoteImageAnalyzer({
    id: MIRAGE_ANALYZER_ID,
    spawn: () =>
      spawnElectronWorker<AnalysisRequest>({
        entry: join(mainDir, 'analysis-host.js'),
        args: [
          `--runtime=${join(resources, 'analysis', `cactus-${CACTUS_RUNTIME_VERSION}`)}`,
          `--weights=${model.path}`,
        ],
        serviceName: 'Image analysis',
      }),
    onError: (error) => errlog.error(error, 'analysis-worker'),
  });

  // The queues call back into `screenshots`, which is created below; callbacks run only later.
  const onCallbackError = (where: string) => (key: string, error: Error) =>
    errlog.error(error, `${where}:${key.slice(0, 12)}`);
  // E2E sandbox only: a test can hold text recognition (see `exposeOcrGate`).
  const ocrGate = sandbox ? exposeOcrGate() : null;
  const ocrQueue = new KeyedQueue<OcrImage, OcrResult>({
    run: async (image) => {
      await ocrGate?.passed();
      return recognizer.recognize(image);
    },
    onResult: (hash, result) => screenshots.textRecognized(hash, result),
    onFailure: (hash, error) => screenshots.textFailed(hash, error),
    onCallbackError: onCallbackError('ocr-queue'),
  });
  const analysisQueue = new KeyedQueue<AnalysisRequest, ImageAnalysis>({
    run: ({ image, language }) => analyzer.analyze(image, language),
    onResult: (hash, analysis) => screenshots.analysisDone(hash, analysis),
    onFailure: (hash, error) => screenshots.analysisFailed(hash, error),
    onCallbackError: onCallbackError('analysis-queue'),
  });

  // One lock per image hash, shared by capture and the orphan sweep.
  const locks = new HashLocks();
  const capture = new ImageCaptureService({
    clipboard: sandbox ? pngClipboardImages(() => sandbox.readImage()) : electronClipboardImages,
    files: electronImageFiles,
    decoder: electronImageDecoder,
    store,
    locks,
    ocr: ocrQueue,
    analysis: analysisQueue,
    settings,
    analysisLanguage: () => analysisLanguageFor(settings(), app.getLocale()),
    analysisAvailable: () => screenshots.analysisAvailable(),
  });

  const screenshots: Screenshots = new Screenshots({
    capture,
    repository,
    store,
    locks,
    writeImage: sandbox ? (png, marker) => sandbox.writeImage(png, marker) : electronWriteImage,
    touch: (clipId) => {
      clips.touch(clipId);
      broadcast.historyChanged();
    },
    model: {
      size: MIRAGE_WEIGHTS.size,
      status: () => model.status(),
      download: (onProgress) => model.download(onProgress),
      cancel: () => model.cancel(),
      invalidate: () => model.invalidate(),
    },
    settings,
    onUpdated: (clipId) => {
      broadcast.updated(clipId);
      // Runs after the repository's transaction: an open search re-runs and finds the new text.
      broadcast.historyChanged();
    },
    onModelState: (state) => broadcast.modelState(state),
    onError: (error, context) => errlog.error(error, `screenshots:${context}`),
    ...(options.writeMarked ? { writeMarked: options.writeMarked } : {}),
  });

  serveScreenshotProtocol((clipId, variant) => screenshots.image(clipId, variant));
  screenshots.start().catch((error: unknown) => errlog.error(error, 'screenshots:start'));
  // Files left behind by deletions in an earlier run (or a crash between delete and sweep).
  screenshots.scheduleSweep();

  const handlers: Pick<InvokeHandlers, ScreenshotChannel> = {
    'screenshot:details': (clipId) => screenshots.details(clipId),
    'screenshot:copy-text': async (text) => {
      await options.writeText(text);
      return undefined;
    },
    'screenshot:analyze': (clipId) => screenshots.analyze(clipId),
    'screenshot:retry-text': (clipId) => screenshots.retryText(clipId),
    'screenshot:model-state': () => screenshots.getModelState(),
    'screenshot:download-model': () => screenshots.downloadModel(),
    'screenshot:cancel-download': () => {
      screenshots.cancelDownload();
      return undefined;
    },
  };

  return {
    screenshots,
    handlers,
    injectAnalysis: (clipId, analysis) => {
      const hash = repository.hashOf(clipId);
      if (hash === null) return false;
      // Results are stored only for a pending analysis, as if the user had asked for one.
      repository.requestAnalysis(hash);
      screenshots.analysisDone(hash, analysis);
      return true;
    },
    injectTextFailure: (clipId) => {
      const hash = repository.hashOf(clipId);
      if (hash === null) return false;
      repository.requestText(hash);
      repository.failText(hash);
      broadcast.updated(clipId);
      broadcast.historyChanged();
      return true;
    },
    recognizeText: async (png) => {
      const { width, height } = nativeImage.createFromBuffer(Buffer.from(png)).getSize();
      return ocrText(await recognizer.recognize({ png, width, height, scale: 1 }));
    },
    dispose: async () => {
      screenshots.dispose();
      // Refuse later jobs too (a capture still in flight), so no worker is spawned after this.
      ocrQueue.dispose();
      analysisQueue.dispose();
      model.cancel();
      await Promise.allSettled([recognizer.dispose(), analyzer.dispose()]);
    },
  };
}

/**
 * E2E sandbox only: lets Playwright hold text recognition (`globalThis.__clipboardArchiveOcrGate`,
 * reached with `app.evaluate`), to prove that the recognition result itself refreshes an open
 * search. Never created outside the sandbox.
 */
function exposeOcrGate(): { passed(): Promise<void> } {
  let held: { promise: Promise<void>; release: () => void } | null = null;
  const gate = {
    hold: () => {
      if (held) return;
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      held = { promise, release };
    },
    release: () => {
      held?.release();
      held = null;
    },
  };
  (globalThis as { __clipboardArchiveOcrGate?: typeof gate }).__clipboardArchiveOcrGate = gate;
  return { passed: () => held?.promise ?? Promise.resolve() };
}
