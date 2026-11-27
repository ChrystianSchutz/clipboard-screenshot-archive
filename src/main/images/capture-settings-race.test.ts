import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageAnalysis } from '@shared/image-analysis';
import type { ImageRecognitionSettings } from '@shared/image-settings';
import type { OcrResult } from '@shared/ocr';
import type { AnalysisModelState } from '@shared/screenshots';
import type { ClipSource } from '@shared/types';
import type { AnalysisRequest } from '../analysis/remote-image-analyzer';
import { shutDown } from '../app/shutdown';
import { CaptureGate } from '../clipboard/capture-gate';
import { CaptureService } from '../clipboard/capture-service';
import { nullSourceProbe, type ClipboardIO } from '../clipboard/ports';
import { PollingClipboardWatcher } from '../clipboard/watchers';
import type { ModelStatus } from '../models/model-downloader';
import type { OcrImage } from '../ocr/ports';
import { ClipRepository } from '../storage/clip-repository';
import { openDatabase } from '../storage/database';
import { ImageRepository } from '../storage/image-repository';
import { deferred, settingsWith } from '../test-support/fakes';
import {
  decodeFakePng,
  FakeImage,
  imageAnalysis,
  MemoryImageFs,
  ocrResult,
} from '../test-support/image-fakes';
import { KeyedQueue } from '../workers/keyed-queue';
import { WorkerTaskError } from '../workers/worker-protocol';
import { HashLocks } from './hash-locks';
import { ImageCaptureService, type ImageDecoder } from './image-capture';
import { imageHash } from './image-policy';
import { ImageStore, type StoredImage } from './image-store';
import type { ImageHandle } from './ports';
import { DAMAGED_MODEL_ERROR, Screenshots } from './screenshots';

/**
 * Settings changes and shutdown racing a capture that is still in flight, with the real capture
 * service, repository, store and `KeyedQueue`s. Only the file save (or the sweep's delete) is held
 * by a gate, so the race is reproduced exactly where it happens in production.
 */

const DIR = join('data', 'images');
const SOURCE: ClipSource = { app: 'Snipping Tool', exe: 'SnippingTool.exe', url: null };

const hashOf = (image: FakeImage): string => imageHash(image.width, image.height, image.bitmap());

class FakePngDecoder implements ImageDecoder {
  decode(png: Uint8Array): ImageHandle | null {
    const match = /^png:(\d+)x(\d+):(\d+)$/.exec(decodeFakePng(png));
    return match ? new FakeImage(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  }
}

describe('captures racing settings changes and shutdown', () => {
  let db: DatabaseSync;
  let clips: ClipRepository;
  let repository: ImageRepository;
  let fs: MemoryImageFs;
  let store: ImageStore;
  let locks: HashLocks;
  let clipboardImage: FakeImage | null;
  let settings: ImageRecognitionSettings;
  let modelStatus: ModelStatus;
  /** When set, the next save waits for it (after the capture holds its hash lock). */
  let saveGate: Promise<unknown> | null;
  let saveStarted: ReturnType<typeof deferred<undefined>>;
  /** When set, the sweep's delete waits for it (while the sweep holds the hash lock). */
  let removeGate: Promise<unknown> | null;
  let removeStarted: ReturnType<typeof deferred<undefined>>;
  let recognize: ReturnType<typeof vi.fn<(image: OcrImage) => Promise<OcrResult>>>;
  let analyze: ReturnType<typeof vi.fn<(request: AnalysisRequest) => Promise<ImageAnalysis>>>;
  let ocrQueue: KeyedQueue<OcrImage, OcrResult>;
  let analysisQueue: KeyedQueue<AnalysisRequest, ImageAnalysis>;
  let invalidate: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let download: ReturnType<typeof vi.fn<() => Promise<string>>>;
  let onModelState: ReturnType<typeof vi.fn<(state: AnalysisModelState) => void>>;
  let capture: ImageCaptureService;
  let screenshots: Screenshots;

  beforeEach(() => {
    db = openDatabase(':memory:');
    clips = new ClipRepository(db, () => 5_000);
    repository = new ImageRepository(db, clips);
    fs = new MemoryImageFs();
    store = new ImageStore(DIR, fs);
    locks = new HashLocks();
    clipboardImage = null;
    settings = { textRecognition: true, imageAnalysis: 'automatic', analysisLanguage: null };
    modelStatus = 'ready';
    saveGate = null;
    saveStarted = deferred<undefined>();
    removeGate = null;
    removeStarted = deferred<undefined>();
    recognize = vi.fn(() =>
      Promise.resolve(
        ocrResult({
          lines: [
            {
              text: 'Invoice 2026',
              confidence: 90,
              box: { x0: 0, y0: 0, x1: 9, y1: 9 },
              words: [],
            },
          ],
        }),
      ),
    );
    analyze = vi.fn(() => Promise.resolve(imageAnalysis({ description: ['A receipt'] })));
    invalidate = vi.fn(() => Promise.resolve());
    download = vi.fn(() => Promise.resolve('/models/mirage'));
    onModelState = vi.fn();

    ocrQueue = new KeyedQueue<OcrImage, OcrResult>({
      run: (image) => recognize(image),
      onResult: (hash, result) => screenshots.textRecognized(hash, result),
      onFailure: (hash, error) => screenshots.textFailed(hash, error),
    });
    analysisQueue = new KeyedQueue<AnalysisRequest, ImageAnalysis>({
      run: (request) => analyze(request),
      onResult: (hash, result) => screenshots.analysisDone(hash, result),
      onFailure: (hash, error) => screenshots.analysisFailed(hash, error),
    });
    capture = new ImageCaptureService({
      clipboard: {
        hasImage: () => Promise.resolve(clipboardImage !== null),
        readImage: () => Promise.resolve(clipboardImage),
      },
      files: { read: () => Promise.resolve(null) },
      decoder: new FakePngDecoder(),
      store: {
        save: async (hash: string, image: ImageHandle): Promise<StoredImage> => {
          saveStarted.resolve(undefined);
          if (saveGate) await saveGate;
          return store.save(hash, image);
        },
        read: (hash, variant) => store.read(hash, variant),
      },
      locks,
      ocr: ocrQueue,
      analysis: analysisQueue,
      settings: () => settings,
      analysisLanguage: () => 'en',
      analysisAvailable: () => screenshots.analysisAvailable(),
    });
    screenshots = new Screenshots({
      capture,
      repository,
      store: {
        read: (hash, variant) => store.read(hash, variant),
        files: () => store.files(),
        removeLeftovers: (hash, names) => store.removeLeftovers(hash, names),
        remove: async (hash, names) => {
          removeStarted.resolve(undefined);
          if (removeGate) await removeGate;
          await store.remove(hash, names);
        },
      },
      locks,
      writeImage: () => Promise.resolve(),
      touch: () => undefined,
      model: {
        size: 100,
        status: () => Promise.resolve(modelStatus),
        download,
        cancel: () => undefined,
        invalidate,
      },
      settings: () => settings,
      onUpdated: () => undefined,
      onModelState,
      onError: () => undefined,
    });
  });

  afterEach(() => {
    screenshots.dispose();
    if (db.isOpen) db.close();
  });

  const copy = () =>
    screenshots.captureClipboard({ source: SOURCE, copiedAt: 1_000, isCurrent: () => true });

  /** Starts a capture of `image` and waits until it holds its lock, inside the gated save. */
  async function captureHeldInSave(image: FakeImage) {
    const gate = deferred<undefined>();
    saveGate = gate.promise;
    clipboardImage = image;
    const result = copy();
    await saveStarted.promise;
    return { result, release: () => gate.resolve(undefined) };
  }

  async function settle(): Promise<void> {
    await ocrQueue.idle();
    await analysisQueue.idle();
  }

  async function recordedId(result: ReturnType<typeof copy>): Promise<number> {
    const outcome = await result;
    if (outcome.status !== 'recorded') throw new Error(`not recorded: ${outcome.reason}`);
    return outcome.clip.id;
  }

  it('never recognises or analyses an image whose features were switched off during its save', async () => {
    await screenshots.start();
    const image = new FakeImage(800, 600, 3);
    const held = await captureHeldInSave(image);

    settings = { ...settings, textRecognition: false, imageAnalysis: 'off' };
    screenshots.settingsChanged(); // clears both queues before the row exists
    held.release();
    const id = await recordedId(held.result);
    await settle();

    expect(recognize).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    expect(screenshots.details(id)).toMatchObject({
      text: { state: 'off', result: null },
      analysis: { state: 'none', result: null },
    });
    expect(clips.query({ text: 'invoice' }).clips).toEqual([]);
    expect(clips.query({ text: 'receipt' }).clips).toEqual([]);
  });

  it('leaves no analysis pending when automatic analysis becomes on-demand during the save', async () => {
    await screenshots.start();
    const held = await captureHeldInSave(new FakeImage(800, 600, 4));

    settings = { ...settings, imageAnalysis: 'on-demand' };
    screenshots.settingsChanged();
    held.release();
    const id = await recordedId(held.result);
    await settle();

    expect(analyze).not.toHaveBeenCalled();
    expect(screenshots.details(id)?.analysis.state).toBe('none');
    // Text recognition was untouched and still runs.
    expect(screenshots.details(id)?.text.state).toBe('done');
  });

  it('withdraws the jobs a row started with when the feature goes off between commit and dispatch', async () => {
    await screenshots.start();
    const image = new FakeImage(800, 600, 5);
    clipboardImage = image;
    // The record step itself flips the settings: the row is committed as pending, but at dispatch
    // both features are off.
    const record = vi.spyOn(repository, 'record').mockImplementationOnce((input) => {
      const entry = ImageRepository.prototype.record.call(repository, input);
      settings = { ...settings, textRecognition: false, imageAnalysis: 'off' };
      return entry;
    });

    const id = await recordedId(copy());
    await settle();

    expect(record).toHaveBeenCalledOnce();
    expect(recognize).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    expect(screenshots.details(id)).toMatchObject({
      text: { state: 'off' },
      analysis: { state: 'none' },
    });
    expect(repository.pendingText()).toEqual([]);
    expect(repository.pendingAnalysis()).toEqual([]);
  });

  it('reads an image once when recognition is switched off and on again during its save', async () => {
    await screenshots.start();
    settings = { ...settings, imageAnalysis: 'off' };
    const held = await captureHeldInSave(new FakeImage(800, 600, 6));

    settings = { ...settings, textRecognition: false };
    screenshots.settingsChanged();
    settings = { ...settings, textRecognition: true };
    screenshots.settingsChanged();
    held.release();
    const id = await recordedId(held.result);
    await settle();

    expect(recognize).toHaveBeenCalledOnce();
    expect(screenshots.details(id)?.text.state).toBe('done');
    expect(clips.query({ text: 'invoice' }).clips.map((clip) => clip.id)).toEqual([id]);
  });

  it('queues nothing for a capture still saving at shutdown, and the row waits for the next start', async () => {
    await screenshots.start();
    const held = await captureHeldInSave(new FakeImage(800, 600, 7));

    screenshots.dispose();
    ocrQueue.dispose();
    analysisQueue.dispose();
    held.release();
    const id = await recordedId(held.result);
    await settle();

    expect(recognize).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    // Still pending: the next run's `resume()` reads it.
    expect(screenshots.details(id)?.text.state).toBe('pending');
  });

  it('lets a recapture wait while the sweep holds the lock, then stores the image again', async () => {
    const image = new FakeImage(800, 600, 8);
    clipboardImage = image;
    clips.delete([await recordedId(copy())]);
    await settle();
    const gate = deferred<undefined>();
    removeGate = gate.promise;
    saveStarted = deferred<undefined>();

    const sweeping = screenshots.sweep();
    await removeStarted.promise; // the sweep decided "orphan" and holds the lock
    const recapture = copy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(locks.isLocked(hashOf(image))).toBe(true);
    const saving = saveStarted.promise.then(() => 'saving');
    expect(await Promise.race([saving, Promise.resolve('waiting')])).toBe('waiting');

    gate.resolve(undefined);
    await sweeping;
    const id = await recordedId(recapture);

    // The sweep deleted the old files first; the capture then wrote them again.
    expect(fs.files.has(join(DIR, `${hashOf(image)}.png`))).toBe(true);
    expect(fs.files.has(join(DIR, `${hashOf(image)}.thumb.png`))).toBe(true);
    expect(await screenshots.image(id, 'full')).toBeInstanceOf(Uint8Array);
  });

  it('marks the model damaged when the worker reports bad weights, even if its marker still says ready', async () => {
    await screenshots.start();
    settings = { ...settings, textRecognition: false, imageAnalysis: 'on-demand' };
    const first = new FakeImage(800, 600, 9);
    const second = new FakeImage(800, 600, 10);
    clipboardImage = first;
    const a = await recordedId(copy());
    clipboardImage = second;
    const b = await recordedId(copy());
    repository.requestAnalysis(hashOf(second));
    analyze.mockRejectedValueOnce(
      new WorkerTaskError('The image analysis model is damaged', 'weights-integrity'),
    );
    // A stale marker: the downloader would still answer "ready".
    modelStatus = 'ready';

    expect(screenshots.analyze(a)).toBe(true);
    await settle();

    expect(invalidate).toHaveBeenCalledOnce();
    expect(screenshots.getModelState()).toEqual({
      state: 'failed',
      size: 100,
      error: DAMAGED_MODEL_ERROR,
    });
    expect(screenshots.details(a)?.analysis.state).toBe('failed');
    expect(screenshots.details(b)?.analysis.state).toBe('none'); // pending work stopped
    expect(screenshots.analyze(b)).toBe(false);

    // Recovery is offered: the download runs instead of trusting the stale "ready".
    await screenshots.downloadModel();
    expect(download).toHaveBeenCalledOnce();
    expect(screenshots.getModelState()).toEqual({ state: 'ready' });
  });

  it('withdraws automatic analyses behind a busy worker when switched to On demand, and keeps explicit ones', async () => {
    await screenshots.start();
    settings = { ...settings, textRecognition: false }; // automatic analysis only
    const busy = deferred<ImageAnalysis>();
    analyze.mockImplementationOnce(() => busy.promise);
    clipboardImage = new FakeImage(800, 600, 11);
    const running = await recordedId(copy()); // its automatic job holds the worker
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    clipboardImage = new FakeImage(800, 600, 12);
    const waiting = await recordedId(copy()); // automatic, queued behind it
    clipboardImage = new FakeImage(800, 600, 13);
    const explicit = await recordedId(copy()); // automatic, queued...
    expect(screenshots.analyze(explicit)).toBe(true); // ...then asked for by the user

    settings = { ...settings, imageAnalysis: 'on-demand' };
    screenshots.settingsChanged();
    busy.resolve(imageAnalysis({ description: ['Late automatic result'] }));
    await settle();

    // Only the explicit request ran after the switch; the busy job's result was thrown away.
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(screenshots.details(running)?.analysis.state).toBe('none');
    expect(screenshots.details(waiting)?.analysis.state).toBe('none');
    expect(screenshots.details(explicit)?.analysis.state).toBe('done');
    expect(repository.pendingAnalysis()).toEqual([]);
    // Switching back to automatic does not resurrect the withdrawn work by itself.
    settings = { ...settings, imageAnalysis: 'automatic' };
    screenshots.settingsChanged();
    await settle();
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it('keeps an explicit Analyze request pending across a switch to On demand while the worker is busy', async () => {
    await screenshots.start();
    settings = { ...settings, textRecognition: false, imageAnalysis: 'on-demand' };
    clipboardImage = new FakeImage(800, 600, 14);
    const first = await recordedId(copy());
    clipboardImage = new FakeImage(800, 600, 15);
    const second = await recordedId(copy());
    const busy = deferred<ImageAnalysis>();
    analyze.mockImplementationOnce(() => busy.promise);
    expect(screenshots.analyze(first)).toBe(true);
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    expect(screenshots.analyze(second)).toBe(true);

    screenshots.settingsChanged(); // e.g. another setting changed: still On demand
    busy.resolve(imageAnalysis({ description: ['First'] }));
    await settle();

    expect(screenshots.details(first)?.analysis.state).toBe('done');
    expect(screenshots.details(second)?.analysis.state).toBe('done');
  });

  describe("through the app's capture gate and shutdown order", () => {
    let gate: CaptureGate;
    let clipboardText: string;
    let service: CaptureService;

    beforeEach(() => {
      gate = new CaptureGate();
      clipboardText = '';
      const io: ClipboardIO = {
        readText: () => Promise.resolve(clipboardText),
        writeText: () => Promise.resolve(),
        readWriteMarker: () => Promise.resolve(null),
      };
      service = new CaptureService({
        io,
        probe: nullSourceProbe,
        repository: clips,
        settings: () => settingsWith({ captureEnabled: true }),
        images: screenshots,
        gate,
      });
    });

    /** The app's `stop()`: gate first, then the watcher, the feature, the queues, the database. */
    const appShutdown = (watcher?: PollingClipboardWatcher) =>
      shutDown(gate, [
        () => watcher?.stop(),
        () => screenshots.dispose(),
        () => ocrQueue.dispose(),
        () => analysisQueue.dispose(),
        () => db.close(),
      ]);

    it('commits nothing for a capture still saving at shutdown, and never touches the closed database', async () => {
      await screenshots.start();
      const gateSave = deferred<undefined>();
      saveGate = gateSave.promise;
      clipboardImage = new FakeImage(800, 600, 16);
      const outcome = service.handleChange();
      await saveStarted.promise;

      appShutdown();
      gateSave.resolve(undefined);

      await expect(outcome).resolves.toEqual({ status: 'skipped', reason: 'paused' });
      expect(db.isOpen).toBe(false);
      expect(recognize).not.toHaveBeenCalled();
      expect(analyze).not.toHaveBeenCalled();
    });

    it('records nothing for a poll that began while paused and resolves after resume', async () => {
      await screenshots.start();
      const read = deferred<string>();
      let reads = 0;
      const outcomes: Promise<unknown>[] = [];
      const onChange = vi.fn((generation?: number) => {
        outcomes.push(service.handleChange(generation));
      });
      const watcher = new PollingClipboardWatcher(
        () => {
          reads++;
          return reads === 1 ? Promise.resolve('before') : read.promise;
        },
        60_000,
        { generation: () => gate.current },
      );
      await watcher.check(onChange); // the baseline poll

      gate.invalidate(); // pause
      const poll = watcher.check(onChange); // samples the clipboard while paused
      gate.invalidate(); // resume before the read resolves
      clipboardText = 'copied while paused';
      read.resolve('copied while paused');
      await poll;

      expect(onChange).toHaveBeenCalledTimes(1);
      await expect(Promise.all(outcomes)).resolves.toEqual([
        { status: 'skipped', reason: 'paused' },
      ]);
      expect(clips.query({ text: 'copied while paused' }).clips).toEqual([]);
    });

    it('records nothing for a poll that resolves after stop()', async () => {
      await screenshots.start();
      const read = deferred<string>();
      let reads = 0;
      const onChange = vi.fn(() => void service.handleChange());
      const watcher = new PollingClipboardWatcher(() => {
        reads++;
        return reads === 1 ? Promise.resolve('before') : read.promise;
      }, 60_000);
      watcher.start(onChange);
      await vi.waitFor(() => expect(reads).toBe(1)); // the baseline poll
      const poll = watcher.check(onChange); // a poll still waiting for the clipboard

      appShutdown(watcher);
      clipboardText = 'copied during shutdown';
      read.resolve('copied during shutdown');
      await poll;

      expect(onChange).not.toHaveBeenCalled();
      // Even a change reported after shutdown finds the gate closed for good.
      await expect(service.handleChange()).resolves.toEqual({
        status: 'skipped',
        reason: 'paused',
      });
      expect(db.isOpen).toBe(false);
    });
  });
});
