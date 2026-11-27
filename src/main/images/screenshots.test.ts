import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageRecognitionSettings } from '@shared/image-settings';
import type { OcrResult } from '@shared/ocr';
import type { AnalysisModelState } from '@shared/screenshots';
import type { ClipSource } from '@shared/types';
import type { AnalysisRequest } from '../analysis/remote-image-analyzer';
import type { DownloadProgress, ModelStatus } from '../models/model-downloader';
import type { OcrImage } from '../ocr/ports';
import { ClipRepository } from '../storage/clip-repository';
import { openDatabase } from '../storage/database';
import { migrate, MIGRATIONS } from '../storage/migrations';
import { ImageRepository } from '../storage/image-repository';
import {
  decodeFakePng,
  FakeImage,
  imageAnalysis,
  MemoryImageFs,
  ocrResult,
} from '../test-support/image-fakes';
import { CaptureService } from '../clipboard/capture-service';
import {
  deferred,
  FakeCaptureRepository,
  FakeClipboard,
  FakeSourceProbe,
  settingsWith,
} from '../test-support/fakes';
import { KeyedQueue, type KeyedJob } from '../workers/keyed-queue';
import { WorkerUnavailableError } from '../workers/worker-client';
import { ImageCaptureService, type ImageDecoder } from './image-capture';
import { HashLocks } from './hash-locks';
import { imageHash } from './image-policy';
import { ImageStore } from './image-store';
import type { ClipboardImageReader, ImageHandle } from './ports';
import { DAMAGED_MODEL_ERROR, MAX_TEXT_RETRIES, Screenshots, SWEEP_DELAY_MS } from './screenshots';

const DIR = join('data', 'images');
const SOURCE: ClipSource = { app: 'Snipping Tool', exe: 'SnippingTool.exe', url: null };
/** The write marker token the fake write chain hands each write. */
const MARKER = 'a'.repeat(32);

/** Lets every queued promise callback run. */
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Clipboard holding at most one image. */
class FakeImageClipboard implements ClipboardImageReader {
  image: ImageHandle | null = null;
  readonly hasImage = vi.fn((): Promise<boolean> => Promise.resolve(this.image !== null));
  readonly readImage = vi.fn((): Promise<ImageHandle | null> => Promise.resolve(this.image));
}

/** Decodes the fake PNG encoding ("png:<w>x<h>:<fill>") back into a `FakeImage`. */
class FakePngDecoder implements ImageDecoder {
  readonly decode = vi.fn((png: Uint8Array): ImageHandle | null => {
    const match = /^png:(\d+)x(\d+):(\d+)$/.exec(decodeFakePng(png));
    return match ? new FakeImage(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  });
}

const hashOf = (image: FakeImage): string => imageHash(image.width, image.height, image.bitmap());

function textResult(text: string): OcrResult {
  return ocrResult({
    lines: [{ text, confidence: 90, box: { x0: 0, y0: 0, x1: 100, y1: 18 }, words: [] }],
  });
}

describe('Screenshots', () => {
  let db: DatabaseSync;
  let clock: number;
  let clipRepository: ClipRepository;
  let repository: ImageRepository;
  let fs: MemoryImageFs;
  let store: ImageStore;
  let clipboard: FakeImageClipboard;
  let ocr: {
    enqueue: ReturnType<typeof vi.fn<(job: KeyedJob<OcrImage>) => boolean>>;
    clear: ReturnType<typeof vi.fn<() => string[]>>;
  };
  let analysis: {
    enqueue: ReturnType<typeof vi.fn<(job: KeyedJob<AnalysisRequest>) => boolean>>;
    clear: ReturnType<typeof vi.fn<() => string[]>>;
    withdraw: ReturnType<typeof vi.fn<(match: (key: string) => boolean) => string[]>>;
    has: ReturnType<typeof vi.fn<(key: string) => boolean>>;
  };
  let settings: ImageRecognitionSettings;
  let modelStatus: ModelStatus;
  let model: {
    size: number;
    status: ReturnType<typeof vi.fn<() => Promise<ModelStatus>>>;
    download: ReturnType<
      typeof vi.fn<(onProgress: (progress: DownloadProgress) => void) => Promise<string>>
    >;
    cancel: ReturnType<typeof vi.fn<() => void>>;
    invalidate: ReturnType<typeof vi.fn<() => Promise<void>>>;
  };
  let writeImage: ReturnType<typeof vi.fn<(png: Uint8Array, marker?: string) => Promise<void>>>;
  let touch: ReturnType<typeof vi.fn<(clipId: number) => void>>;
  let onUpdated: ReturnType<typeof vi.fn<(clipId: number) => void>>;
  let onModelState: ReturnType<typeof vi.fn<(state: AnalysisModelState) => void>>;
  let onError: ReturnType<typeof vi.fn<(error: Error, context: string) => void>>;
  let screenshots: Screenshots;
  let locks: HashLocks;
  let nowMs: number;
  /** The app's write chain (`CaptureService.writeMarked`); by default it runs the write at once. */
  let writeMarked: ReturnType<
    typeof vi.fn<(write: (marker: string) => Promise<unknown>) => Promise<unknown>>
  >;

  function createScreenshots(
    queues: { ocr: typeof ocr | KeyedQueue<OcrImage, OcrResult> } = { ocr },
  ): Screenshots {
    const capture = new ImageCaptureService({
      clipboard,
      files: { read: () => Promise.resolve(null) },
      decoder: new FakePngDecoder(),
      store,
      locks,
      ocr: queues.ocr,
      analysis,
      settings: () => settings,
      analysisLanguage: () => 'en',
      analysisAvailable: () => created.analysisAvailable(),
    });
    const created: Screenshots = new Screenshots({
      capture,
      repository,
      store,
      locks,
      writeImage,
      touch,
      model,
      settings: () => settings,
      onUpdated,
      onModelState,
      onError,
      writeMarked: <T>(write: (marker: string) => Promise<T>) => writeMarked(write) as Promise<T>,
      now: () => nowMs,
    });
    return created;
  }

  const change = (copiedAt: number) => ({ source: SOURCE, copiedAt, isCurrent: () => true });
  const clipboardImage = (image: FakeImage): void => {
    clipboard.image = image;
  };

  const copy = (copiedAt = 1_000, isCurrent = () => true) =>
    screenshots.captureClipboard({ source: SOURCE, copiedAt, isCurrent });

  async function capturedClipId(image = new FakeImage(800, 600, 3)): Promise<number> {
    clipboard.image = image;
    const result = await copy();
    if (result.status !== 'recorded')
      throw new Error(`expected a recorded clip, got ${result.reason}`);
    return result.clip.id;
  }

  beforeEach(() => {
    db = openDatabase(':memory:');
    clock = 5_000;
    clipRepository = new ClipRepository(db, () => clock);
    repository = new ImageRepository(db, clipRepository);
    fs = new MemoryImageFs();
    store = new ImageStore(DIR, fs);
    clipboard = new FakeImageClipboard();
    ocr = { enqueue: vi.fn(() => true), clear: vi.fn(() => []) };
    analysis = {
      enqueue: vi.fn(() => true),
      clear: vi.fn(() => []),
      withdraw: vi.fn(() => []),
      has: vi.fn(() => false),
    };
    settings = { textRecognition: true, imageAnalysis: 'off', analysisLanguage: null };
    modelStatus = 'missing';
    model = {
      size: 100,
      status: vi.fn(() => Promise.resolve(modelStatus)),
      download: vi.fn(() => Promise.resolve('/models/mirage')),
      cancel: vi.fn(),
      invalidate: vi.fn(() => Promise.resolve()),
    };
    writeImage = vi.fn(() => Promise.resolve());
    touch = vi.fn();
    onUpdated = vi.fn();
    onModelState = vi.fn();
    onError = vi.fn();
    locks = new HashLocks();
    nowMs = 1_000_000;
    writeMarked = vi.fn((write: (marker: string) => Promise<unknown>) => write(MARKER));
    screenshots = createScreenshots();
  });

  afterEach(() => {
    screenshots.dispose();
    vi.useRealTimers();
    db.close();
  });

  describe('captureClipboard', () => {
    it('records a new image clip with its source and pending text recognition', async () => {
      const image = new FakeImage(800, 600, 3);
      clipboard.image = image;

      const result = await copy(1_234);

      expect(result).toMatchObject({
        status: 'recorded',
        created: true,
        clip: { kind: 'image', source: SOURCE, lastCopiedAt: 1_234 },
      });
      if (result.status !== 'recorded') return;
      expect(screenshots.details(result.clip.id)?.text.state).toBe('pending');
      expect(ocr.enqueue).toHaveBeenCalledTimes(1);
      expect(ocr.enqueue.mock.calls[0]?.[0].key).toBe(hashOf(image));
    });

    it('records the text state as off when recognition is switched off, and queues no text job', async () => {
      settings = { ...settings, textRecognition: false };
      const id = await capturedClipId();

      expect(screenshots.details(id)?.text.state).toBe('off');
      expect(ocr.enqueue).not.toHaveBeenCalled();
    });

    it('bumps an image copied again without queueing any job', async () => {
      const id = await capturedClipId();
      ocr.enqueue.mockClear();

      const again = await copy(2_000);

      expect(again).toMatchObject({
        status: 'recorded',
        created: false,
        clip: { id, copyCount: 2 },
      });
      expect(ocr.enqueue).not.toHaveBeenCalled();
      expect(analysis.enqueue).not.toHaveBeenCalled();
    });

    it('starts automatic analysis as pending and queues it when the model is ready', async () => {
      settings = { ...settings, imageAnalysis: 'automatic' };
      modelStatus = 'ready';
      await screenshots.start();

      const id = await capturedClipId();

      expect(screenshots.details(id)?.analysis.state).toBe('pending');
      expect(analysis.enqueue).toHaveBeenCalledTimes(1);
    });

    it('leaves analysis at none and queues nothing while the model is missing', async () => {
      settings = { ...settings, imageAnalysis: 'automatic' };
      await screenshots.start();

      const id = await capturedClipId();

      expect(screenshots.details(id)?.analysis.state).toBe('none');
      expect(analysis.enqueue).not.toHaveBeenCalled();
    });

    it('passes superseded and no-image skips through without recording anything', async () => {
      expect(await copy()).toEqual({ status: 'skipped', reason: 'no-image' });

      clipboard.image = new FakeImage(800, 600);
      expect(await copy(1_000, () => false)).toEqual({ status: 'skipped', reason: 'superseded' });

      expect(repository.hashes()).toEqual(new Set());
      expect(clipRepository.query({}).clips).toEqual([]);
    });
  });

  describe('pause during an in-flight capture', () => {
    it('stores nothing when capture is paused while the image file is being saved', async () => {
      clipboard.image = new FakeImage(800, 600, 3);
      const saved = deferred<undefined>();
      const save = store.save.bind(store);
      const saving = vi.spyOn(store, 'save').mockImplementationOnce(async (hash, image) => {
        await saved.promise;
        return save(hash, image);
      });
      let allowed = true;

      const capturing = screenshots.captureClipboard({
        ...change(1_000),
        canRecord: () => allowed,
      });
      await vi.waitFor(() => expect(saving).toHaveBeenCalledTimes(1));
      allowed = false; // paused (or paused and resumed) while the file was written
      saved.resolve(undefined);

      expect(await capturing).toEqual({ status: 'skipped', reason: 'paused' });
      expect(clipRepository.query({}).clips).toEqual([]);
      expect(ocr.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('restore', () => {
    it('writes the stored PNG with the marker of its write and touches the clip', async () => {
      const id = await capturedClipId(new FakeImage(800, 600, 7));

      expect(await screenshots.restore(id)).toBe(true);
      expect(writeImage).toHaveBeenCalledTimes(1);
      expect(decodeFakePng(writeImage.mock.calls[0]?.[0] ?? new Uint8Array())).toBe(
        'png:800x600:7',
      );
      expect(writeImage.mock.calls[0]?.[1]).toBe(MARKER);
      expect(touch).toHaveBeenCalledWith(id);
    });

    it('leaves self-write detection to the marker: the same pixels copied later are a real copy', async () => {
      const image = new FakeImage(800, 600, 7);
      const id = await capturedClipId(image);
      await screenshots.restore(id);
      clipboardImage(image);

      // The restore's own change never reaches here (CaptureService skips it by its marker), so
      // a capture that does is another app's copy, even with identical pixels.
      expect(await copy(2_000)).toMatchObject({
        status: 'recorded',
        clip: { id, copyCount: 2 },
      });
    });

    it('rejects when writing to the clipboard fails, without touching the clip', async () => {
      const id = await capturedClipId();
      writeImage.mockRejectedValueOnce(new Error('clipboard locked'));

      await expect(screenshots.restore(id)).rejects.toThrow('clipboard locked');
      expect(touch).not.toHaveBeenCalled();
    });

    it("writes through the app's single clipboard write chain", async () => {
      const id = await capturedClipId();

      await screenshots.restore(id);

      expect(writeMarked).toHaveBeenCalledTimes(1);
      expect(writeImage).toHaveBeenCalledTimes(1);
    });

    it('reserves its place in the write chain before the PNG has been read', async () => {
      const id = await capturedClipId();
      const png = deferred<Uint8Array>();
      vi.spyOn(store, 'read').mockReturnValueOnce(png.promise);

      const restoring = screenshots.restore(id);
      expect(writeMarked).toHaveBeenCalledTimes(1); // synchronously, while the read is pending
      png.resolve(new Uint8Array([1, 2, 3]));

      await expect(restoring).resolves.toBe(true);
      expect(writeImage).toHaveBeenCalledExactlyOnceWith(new Uint8Array([1, 2, 3]), MARKER);
    });

    it('returns false for an unknown clip', async () => {
      expect(await screenshots.restore(999)).toBe(false);
      expect(writeImage).not.toHaveBeenCalled();
    });

    describe('through the real CaptureService write chain', () => {
      let system: FakeClipboard;
      let capture: CaptureService;
      let order: string[];

      beforeEach(() => {
        system = new FakeClipboard();
        system.writeText.mockImplementation((text, marker) => {
          system.text = text;
          system.marker = marker ?? null;
          order.push(`text:${text}`);
          return Promise.resolve();
        });
        order = [];
        capture = new CaptureService({
          io: system,
          probe: new FakeSourceProbe(),
          repository: new FakeCaptureRepository(),
          settings: () => settingsWith({}),
        });
        writeImage.mockImplementation((_png, marker) => {
          system.text = ''; // an image replaces the whole clipboard
          system.marker = marker ?? null;
          order.push('image');
          return Promise.resolve();
        });
        writeMarked.mockImplementation((write) => capture.writeMarked(write));
      });

      it('mixed restores keep their requested order while the PNG is still being read', async () => {
        const id = await capturedClipId();
        const png = deferred<Uint8Array>();
        vi.spyOn(store, 'read').mockReturnValueOnce(png.promise);

        const image = screenshots.restore(id); // requested first, its PNG read is slow
        const text = capture.writeWithoutRecording('later text'); // requested second
        await flushMicrotasks();
        expect(order).toEqual([]); // the text waits for the image's reserved place
        png.resolve(new Uint8Array([9]));
        await Promise.all([image, text]);

        expect(order).toEqual(['image', 'text:later text']);
        expect(system.text).toBe('later text');
        // The last write's change is the app's own; an identical external copy is not.
        await expect(capture.handleChange()).resolves.toEqual({
          status: 'skipped',
          reason: 'self-write',
        });
        system.text = 'later text';
        await expect(capture.handleChange()).resolves.toMatchObject({ status: 'recorded' });
      });

      it("skips the image restore's own change by its marker", async () => {
        const id = await capturedClipId();

        await screenshots.restore(id);

        await expect(capture.handleChange()).resolves.toEqual({
          status: 'skipped',
          reason: 'self-write',
        });
      });
    });
  });

  describe('image', () => {
    it('serves the stored full image and thumbnail, and null for an unknown clip', async () => {
      const id = await capturedClipId(new FakeImage(1600, 1000, 5));

      expect(decodeFakePng((await screenshots.image(id, 'full')) ?? new Uint8Array())).toBe(
        'png:1600x1000:5',
      );
      expect(decodeFakePng((await screenshots.image(id, 'thumb')) ?? new Uint8Array())).toBe(
        'png:320x200:5',
      );
      expect(await screenshots.image(999, 'full')).toBeNull();
    });
  });

  describe('analyze', () => {
    it('refuses while analysis is off or the model is missing', async () => {
      const id = await capturedClipId();
      modelStatus = 'ready';
      await screenshots.start();
      expect(screenshots.analyze(id)).toBe(false);

      settings = { ...settings, imageAnalysis: 'on-demand' };
      const withoutModel = createScreenshots();
      expect(withoutModel.analyze(id)).toBe(false);
      expect(analysis.enqueue).not.toHaveBeenCalled();
      expect(onUpdated).not.toHaveBeenCalled();
    });

    it('marks the analysis pending, queues it and reports the change on demand with the model ready', async () => {
      settings = { ...settings, imageAnalysis: 'on-demand' };
      modelStatus = 'ready';
      await screenshots.start();
      const image = new FakeImage(800, 600, 2);
      const id = await capturedClipId(image);

      expect(screenshots.analyze(id)).toBe(true);
      expect(screenshots.details(id)?.analysis.state).toBe('pending');
      expect(analysis.enqueue.mock.calls[0]?.[0].key).toBe(hashOf(image));
      expect(onUpdated).toHaveBeenCalledWith(id);
    });
  });

  describe('queue callbacks', () => {
    it('stores recognised text and makes the screenshot searchable', async () => {
      const image = new FakeImage(800, 600, 3);
      const id = await capturedClipId(image);

      screenshots.textRecognized(hashOf(image), textResult('npm ERR! code ECONNRESET'));

      expect(screenshots.details(id)?.text.state).toBe('done');
      expect(clipRepository.query({ text: 'ECONNRESET' }).clips.map((clip) => clip.id)).toEqual([
        id,
      ]);
      expect(onUpdated).toHaveBeenCalledWith(id);
    });

    it('stores what a real text recognition queue returns, end to end', async () => {
      const queue = new KeyedQueue<OcrImage, OcrResult>({
        run: () => Promise.resolve(textResult('Invoice 2026/11')),
        onResult: (hash, result) => screenshots.textRecognized(hash, result),
        onFailure: (hash, error) => screenshots.textFailed(hash, error),
      });
      screenshots = createScreenshots({ ocr: queue });
      const id = await capturedClipId();

      await queue.idle();

      expect(screenshots.details(id)?.text.state).toBe('done');
      expect(clipRepository.query({ text: 'invoice' }).clips.map((clip) => clip.id)).toEqual([id]);
    });

    it('marks failed text recognition and reports the error', async () => {
      const image = new FakeImage(800, 600, 3);
      const id = await capturedClipId(image);
      const error = new Error('tesseract crashed');

      screenshots.textFailed(hashOf(image), error);

      expect(screenshots.details(id)?.text.state).toBe('failed');
      expect(onError).toHaveBeenCalledWith(error, 'text recognition');
      expect(onUpdated).toHaveBeenCalledWith(id);
    });

    it('stores a finished analysis and marks a failed one', async () => {
      const first = new FakeImage(800, 600, 3);
      const second = new FakeImage(800, 600, 4);
      const a = await capturedClipId(first);
      const b = await capturedClipId(second);
      const result = imageAnalysis({ description: ['A terminal window'] });
      const error = new Error('model crashed');
      repository.requestAnalysis(hashOf(first));
      repository.requestAnalysis(hashOf(second));

      screenshots.analysisDone(hashOf(first), result);
      screenshots.analysisFailed(hashOf(second), error);

      expect(screenshots.details(a)?.analysis).toEqual({ state: 'done', result });
      expect(screenshots.details(b)?.analysis.state).toBe('failed');
      expect(onError).toHaveBeenCalledWith(error, 'image analysis');
      expect(onUpdated.mock.calls).toEqual([[a], [b]]);
    });

    it('drops an analysis result that is no longer pending (analysis switched off meanwhile)', async () => {
      const image = new FakeImage(800, 600, 3);
      const id = await capturedClipId(image);

      screenshots.analysisDone(hashOf(image), imageAnalysis());

      expect(screenshots.details(id)?.analysis.state).toBe('none');
      expect(onUpdated).not.toHaveBeenCalled();
    });

    it(`retries text recognition after a worker crash up to ${MAX_TEXT_RETRIES} times, then fails`, async () => {
      const image = new FakeImage(800, 600, 3);
      const id = await capturedClipId(image);
      ocr.enqueue.mockClear();
      const crash = new WorkerUnavailableError('Text recognition stopped unexpectedly');

      for (let attempt = 1; attempt <= MAX_TEXT_RETRIES; attempt++) {
        screenshots.textFailed(hashOf(image), crash);
        expect(screenshots.details(id)?.text.state).toBe('pending');
        expect(ocr.enqueue).toHaveBeenCalledTimes(attempt);
      }
      expect(onUpdated).not.toHaveBeenCalled();

      screenshots.textFailed(hashOf(image), crash);
      expect(ocr.enqueue).toHaveBeenCalledTimes(MAX_TEXT_RETRIES);
      expect(screenshots.details(id)?.text.state).toBe('failed');
      expect(onError).toHaveBeenLastCalledWith(crash, 'text recognition');
      expect(onUpdated).toHaveBeenCalledWith(id);
    });

    it('retries through a real queue and stores the text once a fresh worker succeeds', async () => {
      let calls = 0;
      const queue = new KeyedQueue<OcrImage, OcrResult>({
        run: () =>
          ++calls <= MAX_TEXT_RETRIES
            ? Promise.reject(new WorkerUnavailableError('Text recognition timed out'))
            : Promise.resolve(textResult('Invoice 2026/11')),
        onResult: (hash, result) => screenshots.textRecognized(hash, result),
        onFailure: (hash, error) => screenshots.textFailed(hash, error),
      });
      screenshots = createScreenshots({ ocr: queue });
      const id = await capturedClipId();

      await queue.idle();

      expect(calls).toBe(MAX_TEXT_RETRIES + 1);
      expect(screenshots.details(id)?.text.state).toBe('done');
    });

    it('does not retry an error the recognizer itself reported', async () => {
      const image = new FakeImage(800, 600, 3);
      const id = await capturedClipId(image);
      ocr.enqueue.mockClear();

      screenshots.textFailed(hashOf(image), new Error('unsupported image'));

      expect(ocr.enqueue).not.toHaveBeenCalled();
      expect(screenshots.details(id)?.text.state).toBe('failed');
    });

    it('does not report an update for a hash without a clip', () => {
      const orphan = 'c'.repeat(64);

      screenshots.textRecognized(orphan, textResult('too late'));
      screenshots.textFailed(orphan, new Error('x'));
      screenshots.analysisDone(orphan, imageAnalysis());
      screenshots.analysisFailed(orphan, new Error('y'));

      expect(onUpdated).not.toHaveBeenCalled();
    });
  });

  describe('retryText', () => {
    it('marks failed text pending again, queues it and reports the change', async () => {
      const image = new FakeImage(800, 600, 3);
      const id = await capturedClipId(image);
      screenshots.textFailed(hashOf(image), new Error('tesseract crashed'));
      ocr.enqueue.mockClear();
      onUpdated.mockClear();

      expect(screenshots.retryText(id)).toBe(true);

      expect(screenshots.details(id)?.text.state).toBe('pending');
      expect(ocr.enqueue.mock.calls.map(([job]) => job.key)).toEqual([hashOf(image)]);
      expect(onUpdated).toHaveBeenCalledWith(id);
    });

    it('refuses while recognition is off and for an unknown clip', async () => {
      const id = await capturedClipId();
      settings = { ...settings, textRecognition: false };
      ocr.enqueue.mockClear();

      expect(screenshots.retryText(id)).toBe(false);
      settings = { ...settings, textRecognition: true };
      expect(screenshots.retryText(999)).toBe(false);
      expect(ocr.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('resume', () => {
    it('drops queued work of a switched-off feature, and everything on dispose', () => {
      settings = { ...settings, textRecognition: false };
      screenshots.resume();
      expect(ocr.clear).toHaveBeenCalledTimes(1);
      expect(analysis.clear).toHaveBeenCalledTimes(1); // analysis off, no model

      ocr.clear.mockClear();
      analysis.clear.mockClear();
      screenshots.dispose();
      expect(ocr.clear).toHaveBeenCalledTimes(1);
      expect(analysis.clear).toHaveBeenCalledTimes(1);
    });

    async function pendingClip(fill: number): Promise<{ id: number; hash: string }> {
      const image = new FakeImage(800, 600, fill);
      const id = await capturedClipId(image);
      repository.requestAnalysis(hashOf(image));
      return { id, hash: hashOf(image) };
    }

    it('requeues pending text only while recognition is on', async () => {
      const { hash } = await pendingClip(3);
      ocr.enqueue.mockClear();

      settings = { ...settings, textRecognition: false };
      screenshots.resume();
      expect(ocr.enqueue).not.toHaveBeenCalled();

      settings = { ...settings, textRecognition: true };
      screenshots.resume();
      expect(ocr.enqueue.mock.calls.map(([job]) => job.key)).toEqual([hash]);
    });

    it('cancels pending analyses that cannot run and reports each cancelled clip', async () => {
      const a = await pendingClip(3);
      const b = await pendingClip(4);
      settings = { ...settings, imageAnalysis: 'on-demand' }; // model still missing

      screenshots.resume();

      expect(screenshots.details(a.id)?.analysis.state).toBe('none');
      expect(screenshots.details(b.id)?.analysis.state).toBe('none');
      expect(onUpdated.mock.calls.map(([id]) => id).sort((x, y) => x - y)).toEqual([a.id, b.id]);
      expect(analysis.enqueue).not.toHaveBeenCalled();
    });

    it('keeps an Analyze request still pending from a v3 database in On demand mode after the upgrade', async () => {
      // A v3 database (before `analysis_trigger`) whose user clicked Analyze and quit.
      const dir = mkdtempSync(join(tmpdir(), 'archive-v3-'));
      const file = join(dir, 'history.db');
      const hash = 'c'.repeat(64);
      try {
        const v3 = new DatabaseSync(file);
        v3.function('ci_contains', () => 0);
        migrate(v3, MIGRATIONS.slice(0, 3));
        const clipId = Number(
          v3
            .prepare(
              `INSERT INTO clips (content, content_hash, kind, char_count, line_count,
                 first_copied_at, last_copied_at)
               VALUES ('Image 800×600', ?, 'image', 0, 0, 0, 0)`,
            )
            .run(`image:${hash}`).lastInsertRowid,
        );
        v3.prepare(
          `INSERT INTO clip_images (clip_id, image_hash, width, height, byte_size, analysis_state)
           VALUES (?, ?, 800, 600, 99, 'pending')`,
        ).run(clipId, hash);
        v3.close();

        // Startup of the new version: open (migrates to v4), then resume in On demand.
        screenshots.dispose();
        db.close();
        db = openDatabase(file);
        clipRepository = new ClipRepository(db, () => clock);
        repository = new ImageRepository(db, clipRepository);
        screenshots = createScreenshots();
        settings = { ...settings, imageAnalysis: 'on-demand' };
        modelStatus = 'ready';

        await screenshots.start();

        expect(screenshots.details(clipId)?.analysis.state).toBe('pending');
        expect(analysis.enqueue.mock.calls.map(([job]) => job.key)).toEqual([hash]);
      } finally {
        screenshots.dispose();
        db.close();
        db = openDatabase(':memory:'); // for afterEach
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('requeues pending analyses when the model is ready and analysis is allowed', async () => {
      const { id, hash } = await pendingClip(3);
      settings = { ...settings, imageAnalysis: 'on-demand' };
      modelStatus = 'ready';

      await screenshots.start();

      expect(analysis.enqueue.mock.calls.map(([job]) => job.key)).toEqual([hash]);
      expect(screenshots.details(id)?.analysis.state).toBe('pending');
    });
  });

  describe('model download', () => {
    it('reports progress, ends ready and resumes pending work', async () => {
      settings = { ...settings, imageAnalysis: 'on-demand' };
      const image = new FakeImage(800, 600, 3);
      await capturedClipId(image);
      repository.requestAnalysis(hashOf(image));
      model.download.mockImplementation((onProgress) => {
        onProgress({ received: 40, total: 100 });
        return Promise.resolve('/models/mirage');
      });

      expect(await screenshots.downloadModel()).toEqual({ state: 'ready' });

      expect(onModelState.mock.calls.map(([state]) => state)).toEqual([
        { state: 'downloading', received: 0, total: 100 },
        { state: 'downloading', received: 40, total: 100 },
        { state: 'ready' },
      ]);
      expect(screenshots.analysisAvailable()).toBe(true);
      expect(analysis.enqueue.mock.calls.map(([job]) => job.key)).toEqual([hashOf(image)]);
    });

    it('ends failed with the error message when the download rejects', async () => {
      model.download.mockRejectedValueOnce(new Error('checksum mismatch'));

      const state = await screenshots.downloadModel();

      expect(state).toEqual({ state: 'failed', size: 100, error: 'checksum mismatch' });
      expect(screenshots.getModelState()).toEqual(state);
      expect(screenshots.analysisAvailable()).toBe(false);
    });

    it('returns at once without downloading when the model is already ready', async () => {
      modelStatus = 'ready';
      await screenshots.start();
      onModelState.mockClear();

      expect(await screenshots.downloadModel()).toEqual({ state: 'ready' });
      expect(model.download).not.toHaveBeenCalled();
      expect(onModelState).not.toHaveBeenCalled();
    });

    it('shows a damaged model as failed, so the user can download it again', async () => {
      modelStatus = 'corrupt';
      await screenshots.start();

      expect(screenshots.getModelState()).toEqual({
        state: 'failed',
        size: 100,
        error: DAMAGED_MODEL_ERROR,
      });
      expect(screenshots.analysisAvailable()).toBe(false);

      modelStatus = 'ready';
      expect(await screenshots.downloadModel()).toEqual({ state: 'ready' });
      expect(model.download).toHaveBeenCalledTimes(1);
    });

    it('downloads again when "ready" turned out stale (the file was damaged since)', async () => {
      modelStatus = 'ready';
      await screenshots.start();
      modelStatus = 'corrupt';

      expect(await screenshots.downloadModel()).toEqual({ state: 'ready' });
      expect(model.download).toHaveBeenCalledTimes(1);
    });

    it('re-checks the model after an analysis failure and stops pending work when it is damaged', async () => {
      settings = { ...settings, imageAnalysis: 'on-demand' };
      modelStatus = 'ready';
      await screenshots.start();
      const first = new FakeImage(800, 600, 3);
      const second = new FakeImage(800, 600, 4);
      await capturedClipId(first);
      const waiting = await capturedClipId(second);
      repository.requestAnalysis(hashOf(first));
      repository.requestAnalysis(hashOf(second));
      modelStatus = 'corrupt';

      screenshots.analysisFailed(hashOf(first), new Error('Model file checksum mismatch'));

      await vi.waitFor(() => expect(screenshots.getModelState().state).toBe('failed'));
      expect(screenshots.details(waiting)?.analysis.state).toBe('none');
      expect(analysis.clear).toHaveBeenCalled();
    });

    it('cancels a download through the model', () => {
      screenshots.cancelDownload();
      expect(model.cancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('sweep', () => {
    it('removes files no clip uses and keeps the used ones', async () => {
      const kept = new FakeImage(800, 600, 3);
      const dropped = new FakeImage(800, 600, 4);
      await capturedClipId(kept);
      clipRepository.delete([await capturedClipId(dropped)]);

      await screenshots.sweep();

      expect(await store.hashes()).toEqual([hashOf(kept)]);
      expect(fs.files.has(join(DIR, `${hashOf(dropped)}.thumb.png`))).toBe(false);
      expect(fs.files.has(join(DIR, `${hashOf(kept)}.thumb.png`))).toBe(true);
    });

    it('removes lone thumbnails and temp files, keeping complete used images', async () => {
      const kept = new FakeImage(800, 600, 3);
      await capturedClipId(kept);
      const orphan = 'd'.repeat(64);
      const leftovers = [
        `${orphan}.thumb.png`,
        `${orphan}.png.1a2b3c.tmp`,
        `${hashOf(kept)}.png.4d5e6f.tmp`,
        `${hashOf(kept)}.thumb.png.778899.tmp`,
      ];
      for (const name of leftovers) fs.files.set(join(DIR, name), new Uint8Array([1]));
      fs.files.set(join(DIR, 'notes.txt'), new Uint8Array([1]));

      await screenshots.sweep();

      expect([...fs.files.keys()].map((path) => path.slice(DIR.length + 1)).sort()).toEqual(
        [`${hashOf(kept)}.png`, `${hashOf(kept)}.thumb.png`, 'notes.txt'].sort(),
      );
    });

    it('never deletes an image that is recaptured while the sweep runs', async () => {
      const image = new FakeImage(800, 600, 5);
      clipRepository.delete([await capturedClipId(image)]);
      // Hold the capture inside its lock, at "is the file already on disk?".
      const gate = deferred<undefined>();
      const realExists = fs.exists.bind(fs);
      const existsSpy = vi.spyOn(fs, 'exists').mockImplementationOnce(async (path) => {
        const found = await realExists(path);
        await gate.promise;
        return found;
      });

      clipboard.image = image;
      const recapture = copy(4_000);
      await vi.waitFor(() => expect(existsSpy).toHaveBeenCalled());
      const sweeping = screenshots.sweep();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fs.files.has(join(DIR, `${hashOf(image)}.png`))).toBe(true);

      gate.resolve(undefined);
      const result = await recapture;
      await sweeping;

      expect(result).toMatchObject({ status: 'recorded', created: true });
      expect(fs.files.has(join(DIR, `${hashOf(image)}.png`))).toBe(true);
      expect(fs.files.has(join(DIR, `${hashOf(image)}.thumb.png`))).toBe(true);
      if (result.status === 'recorded')
        expect(await screenshots.image(result.clip.id, 'full')).toBeInstanceOf(Uint8Array);
    });

    it('never asks the database about a file once disposed while the listing was pending', async () => {
      clipRepository.delete([await capturedClipId(new FakeImage(800, 600, 6))]);
      const listing = deferred<undefined>();
      const realList = fs.list.bind(fs);
      vi.spyOn(fs, 'list').mockImplementationOnce(async (dir) => {
        await listing.promise;
        return realList(dir);
      });
      const hasImage = vi.spyOn(repository, 'hasImage');

      const sweeping = screenshots.sweep();
      screenshots.dispose(); // shutdown: the database closes right after
      listing.resolve(undefined);
      await sweeping;

      expect(hasImage).not.toHaveBeenCalled();
    });

    it('shares one run between concurrent calls', async () => {
      const list = vi.spyOn(fs, 'list');

      const first = screenshots.sweep();
      const second = screenshots.sweep();

      expect(second).toBe(first);
      await Promise.all([first, second]);
      expect(list).toHaveBeenCalledTimes(1);
    });

    it('reports a failure to onError instead of rejecting', async () => {
      vi.spyOn(fs, 'list').mockRejectedValueOnce(new Error('EACCES'));

      await expect(screenshots.sweep()).resolves.toBeUndefined();

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'EACCES' }),
        'image sweep',
      );
    });

    it('debounces scheduled sweeps into one run after the delay', async () => {
      vi.useFakeTimers();
      const sweep = vi.spyOn(screenshots, 'sweep');

      screenshots.scheduleSweep();
      await vi.advanceTimersByTimeAsync(SWEEP_DELAY_MS - 1);
      screenshots.scheduleSweep();
      await vi.advanceTimersByTimeAsync(SWEEP_DELAY_MS - 1);
      expect(sweep).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(sweep).toHaveBeenCalledTimes(1);
    });
  });
});
