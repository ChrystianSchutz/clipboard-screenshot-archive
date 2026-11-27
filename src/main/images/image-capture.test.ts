import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisLanguage } from '@shared/image-analysis';
import type { ImageRecognitionSettings } from '@shared/image-settings';
import type { AnalysisRequest } from '../analysis/remote-image-analyzer';
import type { OcrImage } from '../ocr/ports';
import { deferred } from '../test-support/fakes';
import { decodeFakePng, FakeImage, MemoryImageFs } from '../test-support/image-fakes';
import type { KeyedJob } from '../workers/keyed-queue';
import {
  ImageCaptureService,
  shouldCaptureImage,
  toOcrImage,
  type ImageCaptureDeps,
  type ImageDecoder,
} from './image-capture';
import { HashLocks } from './hash-locks';
import { ImageSkip, imageHash } from './image-policy';
import { ImageStore } from './image-store';
import type { ClipboardImageReader, ImageFileReader, ImageFileSource, ImageHandle } from './ports';

const DIR = join('data', 'images');

/** Clipboard holding at most one image; `hasImage` and `readImage` can be replaced per test. */
class FakeImageClipboard implements ClipboardImageReader {
  image: ImageHandle | null = null;
  readonly hasImage = vi.fn((): Promise<boolean> => Promise.resolve(this.image !== null));
  readonly readImage = vi.fn((): Promise<ImageHandle | null> => Promise.resolve(this.image));
}

/** Image files by path; a missing path decodes to `null`, like an unreadable file. */
class FakeImageFiles implements ImageFileReader {
  readonly images = new Map<string, ImageHandle>();
  readonly read = vi.fn((file: ImageFileSource): Promise<ImageHandle | null> =>
    Promise.resolve(this.images.get(file.path) ?? null),
  );
}

/** An opened screenshot file (its bytes are never read by these fakes). */
const fileAt = (path: string): ImageFileSource => ({
  path,
  readBytes: () => Promise.resolve('not-a-regular-file'),
});

/** Decodes the fake PNG encoding ("png:<w>x<h>:<fill>") back into a `FakeImage`. */
class FakePngDecoder implements ImageDecoder {
  broken = false;
  readonly decode = vi.fn((png: Uint8Array): ImageHandle | null => {
    if (this.broken) return null;
    const match = /^png:(\d+)x(\d+):(\d+)$/.exec(decodeFakePng(png));
    return match ? new FakeImage(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  });
}

/** The first 24 bytes of a PNG (signature + IHDR start): enough for `pngDimensions`. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function hashOf(image: FakeImage): string {
  return imageHash(image.width, image.height, image.bitmap());
}

describe('shouldCaptureImage', () => {
  it('captures an image only when the clipboard carries no text', () => {
    expect(shouldCaptureImage('', true)).toBe(true);
    expect(shouldCaptureImage('hello', true)).toBe(false);
    expect(shouldCaptureImage('', false)).toBe(false);
  });

  it('treats whitespace-only text as no text', () => {
    expect(shouldCaptureImage(' \n\t ', true)).toBe(true);
  });
});

describe('toOcrImage', () => {
  it('hands OCR a 2x copy of a small screenshot, reporting the original size', () => {
    const image = new FakeImage(800, 600, 3);
    const ocr = toOcrImage(image);

    expect(image.resizes).toEqual([{ width: 1600, height: 1200 }]);
    expect(decodeFakePng(ocr.png)).toBe('png:1600x1200:3');
    expect(ocr).toMatchObject({ width: 800, height: 600, scale: 2 });
  });

  it('hands OCR a large screenshot as it is', () => {
    const image = new FakeImage(2560, 1440);
    const ocr = toOcrImage(image);

    expect(image.resizes).toEqual([]);
    expect(decodeFakePng(ocr.png)).toBe('png:2560x1440:1');
    expect(ocr).toMatchObject({ width: 2560, height: 1440, scale: 1 });
  });
});

describe('ImageCaptureService', () => {
  let clipboard: FakeImageClipboard;
  let files: FakeImageFiles;
  let decoder: FakePngDecoder;
  let fs: MemoryImageFs;
  let store: ImageStore;
  let ocr: {
    enqueue: ReturnType<typeof vi.fn<(job: KeyedJob<OcrImage>) => boolean>>;
    clear: ReturnType<typeof vi.fn<() => string[]>>;
    withdraw: ReturnType<typeof vi.fn<(match: (key: string) => boolean) => string[]>>;
  };
  let analysis: {
    enqueue: ReturnType<typeof vi.fn<(job: KeyedJob<AnalysisRequest>) => boolean>>;
    clear: ReturnType<typeof vi.fn<() => string[]>>;
    withdraw: ReturnType<typeof vi.fn<(match: (key: string) => boolean) => string[]>>;
    has: ReturnType<typeof vi.fn<(key: string) => boolean>>;
  };
  let settings: ImageRecognitionSettings;
  let language: AnalysisLanguage;
  let modelAvailable: boolean;
  let onCaptured: ReturnType<typeof vi.fn<NonNullable<ImageCaptureDeps['onCaptured']>>>;

  function createService(): ImageCaptureService {
    return new ImageCaptureService({
      clipboard,
      files,
      decoder,
      store,
      locks: new HashLocks(),
      ocr,
      analysis,
      settings: () => settings,
      analysisLanguage: () => language,
      analysisAvailable: () => modelAvailable,
      onCaptured,
    });
  }

  function ocrJob(index = 0): KeyedJob<OcrImage> {
    return ocr.enqueue.mock.calls[index]![0];
  }

  function analysisJob(index = 0): KeyedJob<AnalysisRequest> {
    return analysis.enqueue.mock.calls[index]![0];
  }

  beforeEach(() => {
    clipboard = new FakeImageClipboard();
    files = new FakeImageFiles();
    decoder = new FakePngDecoder();
    fs = new MemoryImageFs();
    store = new ImageStore(DIR, fs);
    ocr = { enqueue: vi.fn(() => true), clear: vi.fn(() => []), withdraw: vi.fn(() => []) };
    analysis = {
      enqueue: vi.fn(() => true),
      clear: vi.fn(() => []),
      withdraw: vi.fn(() => []),
      has: vi.fn(() => false),
    };
    settings = { textRecognition: true, imageAnalysis: 'off', analysisLanguage: null };
    language = 'en';
    modelAvailable = true;
    onCaptured = vi.fn();
  });

  describe('captureFromClipboard', () => {
    it('skips when the clipboard has no image, without decoding anything', async () => {
      const outcome = await createService().captureFromClipboard();

      expect(outcome).toEqual({ status: 'skipped', reason: 'no-image' });
      expect(clipboard.readImage).not.toHaveBeenCalled();
      expect(onCaptured).not.toHaveBeenCalled();
    });

    it('skips an image that cannot be decoded', async () => {
      clipboard.hasImage.mockResolvedValue(true);
      clipboard.readImage.mockResolvedValue(null);

      expect(await createService().captureFromClipboard()).toEqual({
        status: 'skipped',
        reason: 'unreadable',
      });
    });

    it('skips icon-sized and oversized images without storing them', async () => {
      const service = createService();

      clipboard.image = new FakeImage(16, 16);
      expect(await service.captureFromClipboard()).toEqual({
        status: 'skipped',
        reason: 'too-small',
      });

      clipboard.image = new FakeImage(20_000, 40);
      expect(await service.captureFromClipboard()).toEqual({
        status: 'skipped',
        reason: 'too-large',
      });

      expect(fs.writes).toEqual([]);
      expect(ocr.enqueue).not.toHaveBeenCalled();
      expect(onCaptured).not.toHaveBeenCalled();
    });

    it('stores a screenshot under its content hash and reports it', async () => {
      const image = new FakeImage(800, 600, 9);
      clipboard.image = image;
      const hash = hashOf(image);

      const outcome = await createService().captureFromClipboard();

      expect(outcome).toMatchObject({
        status: 'captured',
        origin: 'clipboard',
        image: { hash, width: 800, height: 600, created: true },
      });
      expect(onCaptured).toHaveBeenCalledExactlyOnceWith(outcome);
      expect(fs.files.has(join(DIR, `${hash}.png`))).toBe(true);
    });

    it('queues text recognition of a new screenshot, keyed by its hash', async () => {
      const image = new FakeImage(800, 600, 9);
      clipboard.image = image;

      await createService().captureFromClipboard();

      expect(ocr.enqueue).toHaveBeenCalledTimes(1);
      expect(ocrJob().key).toBe(hashOf(image));
      const loaded = await ocrJob().load();
      expect(loaded).toMatchObject({ width: 800, height: 600, scale: 2 });
      expect(decodeFakePng(loaded.png)).toBe('png:1600x1200:9');
    });

    it('does not queue text recognition when it is switched off', async () => {
      settings = { ...settings, textRecognition: false };
      clipboard.image = new FakeImage(800, 600);

      const outcome = await createService().captureFromClipboard();

      expect(outcome.status).toBe('captured');
      expect(ocr.enqueue).not.toHaveBeenCalled();
    });

    it('reports a screenshot copied again but queues no work for it', async () => {
      clipboard.image = new FakeImage(800, 600);
      settings = { ...settings, imageAnalysis: 'automatic' };
      const service = createService();
      await service.captureFromClipboard();
      ocr.enqueue.mockClear();
      analysis.enqueue.mockClear();

      const again = await service.captureFromClipboard();

      expect(again).toMatchObject({ status: 'captured', image: { created: false } });
      expect(onCaptured).toHaveBeenCalledTimes(2);
      expect(ocr.enqueue).not.toHaveBeenCalled();
      expect(analysis.enqueue).not.toHaveBeenCalled();
    });

    it('queues automatic analysis in the chosen language with an RGB image', async () => {
      settings = { ...settings, imageAnalysis: 'automatic' };
      language = 'pl';
      const image = new FakeImage(800, 600, 4);
      clipboard.image = image;

      await createService().captureFromClipboard();

      expect(analysis.enqueue).toHaveBeenCalledTimes(1);
      expect(analysisJob().key).toBe(hashOf(image));
      const request = await analysisJob().load();
      expect(request.language).toBe('pl');
      expect(request.image).toMatchObject({
        width: 800,
        height: 600,
        originalWidth: 800,
        originalHeight: 600,
      });
      expect(request.image.rgb).toHaveLength(800 * 600 * 3);
    });

    it('does not analyse on capture when analysis is on demand or off', async () => {
      clipboard.image = new FakeImage(800, 600);
      settings = { ...settings, imageAnalysis: 'on-demand' };
      await createService().captureFromClipboard();

      clipboard.image = new FakeImage(800, 600, 2);
      settings = { ...settings, imageAnalysis: 'off' };
      await createService().captureFromClipboard();

      expect(analysis.enqueue).not.toHaveBeenCalled();
    });

    it('does not analyse automatically while the model is not downloaded', async () => {
      settings = { ...settings, imageAnalysis: 'automatic' };
      modelAvailable = false;
      clipboard.image = new FakeImage(800, 600);

      await createService().captureFromClipboard();

      expect(analysis.enqueue).not.toHaveBeenCalled();
      expect(ocr.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  describe('captureFromFile', () => {
    it('stores a screenshot file with the screenshot-folder origin', async () => {
      files.images.set('/Users/me/Desktop/Screenshot.png', new FakeImage(800, 600));

      const outcome = await createService().captureFromFile(
        fileAt('/Users/me/Desktop/Screenshot.png'),
      );

      expect(files.read).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/Users/me/Desktop/Screenshot.png' }),
      );
      expect(outcome).toMatchObject({ status: 'captured', origin: 'screenshot-folder' });
      expect(onCaptured).toHaveBeenCalledWith(outcome);
    });

    it('reports a file its reader refused before decoding as skipped', async () => {
      files.read.mockRejectedValueOnce(new ImageSkip('too-small'));

      expect(await createService().captureFromFile(fileAt('/Users/me/Desktop/icon.png'))).toEqual({
        status: 'skipped',
        reason: 'too-small',
      });
      expect(fs.writes).toEqual([]);
    });

    it('skips a file that cannot be decoded', async () => {
      expect(await createService().captureFromFile(fileAt('/Users/me/Desktop/broken.png'))).toEqual(
        {
          status: 'skipped',
          reason: 'unreadable',
        },
      );
    });
  });

  describe('main-process cost', () => {
    it('reports an image the clipboard reader refused before decoding as skipped', async () => {
      clipboard.image = new FakeImage(800, 600);
      clipboard.readImage.mockRejectedValueOnce(new ImageSkip('too-large'));

      expect(await createService().captureFromClipboard()).toEqual({
        status: 'skipped',
        reason: 'too-large',
      });
      expect(fs.writes).toEqual([]);
      expect(ocr.enqueue).not.toHaveBeenCalled();
    });

    it('still fails on any other reader error', async () => {
      clipboard.image = new FakeImage(800, 600);
      clipboard.readImage.mockRejectedValueOnce(new Error('clipboard busy'));

      await expect(createService().captureFromClipboard()).rejects.toThrow('clipboard busy');
    });

    it('stores a PNG source as it is and hands a large one to OCR without decoding it', async () => {
      const encoded = pngHeader(3000, 2000);
      clipboard.image = Object.assign(new FakeImage(3000, 2000, 4), { encoded });

      await createService().captureFromClipboard();
      const job = await ocrJob().load();

      expect(job).toEqual({ png: encoded, width: 3000, height: 2000, scale: 1 });
      expect(decoder.decode).not.toHaveBeenCalled();
    });

    it('queues jobs that hold only the hash and read the image when they start', async () => {
      const image = new FakeImage(800, 600, 3);
      clipboard.image = image;

      await createService().captureFromClipboard();

      expect(ocrJob().key).toBe(hashOf(image));
      expect(decoder.decode).not.toHaveBeenCalled();
      const job = await ocrJob().load();
      expect(decoder.decode).toHaveBeenCalledTimes(1);
      expect(job).toMatchObject({ width: 800, height: 600, scale: 2 });
    });
  });

  describe('analyze', () => {
    async function storedHash(): Promise<string> {
      const image = new FakeImage(2048, 1024, 6);
      await store.save(hashOf(image), image);
      return hashOf(image);
    }

    it('queues a stored screenshot on demand, decoding it from the store when the job runs', async () => {
      settings = { ...settings, imageAnalysis: 'on-demand' };
      const hash = await storedHash();

      expect(createService().analyze(hash)).toBe(true);
      expect(decoder.decode).not.toHaveBeenCalled();

      const request = await analysisJob().load();
      expect(analysisJob().key).toBe(hash);
      expect(request.language).toBe('en');
      expect(request.image).toMatchObject({
        width: 1024,
        height: 512,
        originalWidth: 2048,
        originalHeight: 1024,
      });
      expect(request.image.rgb).toHaveLength(1024 * 512 * 3);
    });

    it('also lets the user analyse when analysis is automatic', async () => {
      settings = { ...settings, imageAnalysis: 'automatic' };
      expect(createService().analyze(await storedHash(), 'user')).toBe(true);
    });

    it('re-queues a pending automatic analysis only in automatic mode', async () => {
      const hash = await storedHash();
      settings = { ...settings, imageAnalysis: 'on-demand' };
      expect(createService().analyze(hash, 'capture')).toBe(false);
      settings = { ...settings, imageAnalysis: 'automatic' };
      expect(createService().analyze(hash, 'capture')).toBe(true);
    });

    it('refuses when analysis is off or the model is missing', async () => {
      const hash = await storedHash();
      settings = { ...settings, imageAnalysis: 'off' };
      expect(createService().analyze(hash)).toBe(false);

      settings = { ...settings, imageAnalysis: 'on-demand' };
      modelAvailable = false;
      expect(createService().analyze(hash)).toBe(false);

      expect(analysis.enqueue).not.toHaveBeenCalled();
    });

    it('returns what the queue answers (false when the image is already queued)', async () => {
      settings = { ...settings, imageAnalysis: 'on-demand' };
      analysis.enqueue.mockReturnValue(false);
      expect(createService().analyze(await storedHash())).toBe(false);
    });

    it('fails the job when the stored image cannot be decoded', async () => {
      settings = { ...settings, imageAnalysis: 'on-demand' };
      createService().analyze(await storedHash());
      decoder.broken = true;

      await expect(analysisJob().load()).rejects.toThrow('Stored image cannot be decoded');
    });
  });

  describe('requeueOcr', () => {
    it('queues text recognition of a stored screenshot, decoded when the job runs', async () => {
      const image = new FakeImage(800, 600, 2);
      const hash = hashOf(image);
      await store.save(hash, image);

      expect(createService().requeueOcr(hash)).toBe(true);
      expect(decoder.decode).not.toHaveBeenCalled();

      expect(ocrJob().key).toBe(hash);
      const loaded = await ocrJob().load();
      expect(loaded).toMatchObject({ width: 800, height: 600, scale: 2 });
      expect(decodeFakePng(loaded.png)).toBe('png:1600x1200:2');
    });

    it('does nothing while text recognition is switched off', () => {
      settings = { ...settings, textRecognition: false };
      expect(createService().requeueOcr(hashOf(new FakeImage(800, 600)))).toBe(false);
      expect(ocr.enqueue).not.toHaveBeenCalled();
    });

    it('fails the job when the stored image cannot be decoded', async () => {
      const image = new FakeImage(800, 600);
      await store.save(hashOf(image), image);
      decoder.broken = true;

      createService().requeueOcr(hashOf(image));

      await expect(ocrJob().load()).rejects.toThrow('Stored image cannot be decoded');
    });
  });

  describe('ordering', () => {
    it('runs captures one at a time, in arrival order', async () => {
      const gate = deferred<boolean>();
      clipboard.hasImage.mockReturnValueOnce(gate.promise);
      clipboard.image = new FakeImage(800, 600);
      files.images.set('/shots/a.png', new FakeImage(640, 480));
      const service = createService();

      const first = service.captureFromClipboard();
      const second = service.captureFromFile(fileAt('/shots/a.png'));
      await new Promise((resolve) => setImmediate(resolve));
      expect(files.read).not.toHaveBeenCalled();

      gate.resolve(true);
      const outcomes = await Promise.all([first, second]);

      expect(outcomes.map((outcome) => outcome.status)).toEqual(['captured', 'captured']);
      expect(onCaptured.mock.calls.map(([outcome]) => outcome.origin)).toEqual([
        'clipboard',
        'screenshot-folder',
      ]);
    });

    it('keeps capturing after a capture fails', async () => {
      clipboard.hasImage.mockRejectedValueOnce(new Error('clipboard busy'));
      clipboard.image = new FakeImage(800, 600);
      const service = createService();

      const failed = service.captureFromClipboard();
      const next = service.captureFromClipboard();

      await expect(failed).rejects.toThrow('clipboard busy');
      await expect(next).resolves.toMatchObject({ status: 'captured' });
    });
  });

  describe('capture requests', () => {
    it('drops an image when the clipboard moved on while it was read', async () => {
      clipboard.image = new FakeImage(800, 600);
      const record = vi.fn(() => true);

      const outcome = await createService().captureFromClipboard({
        isCurrent: () => false,
        record,
      });

      expect(outcome).toEqual({ status: 'skipped', reason: 'superseded' });
      expect(fs.files.size).toBe(0);
      expect(record).not.toHaveBeenCalled();
    });

    it('never reads pixels when the clipboard moved on while the capture waited in the queue', async () => {
      clipboard.image = new FakeImage(800, 600);

      const outcome = await createService().captureFromClipboard({
        isCurrent: () => Promise.resolve(false),
      });

      expect(outcome).toEqual({ status: 'skipped', reason: 'superseded' });
      expect(clipboard.readImage).not.toHaveBeenCalled();
    });

    it('drops pixels from a restore that replaced the image during the read', async () => {
      clipboard.image = new FakeImage(800, 600);
      let marker: string | null = null;
      clipboard.readImage.mockImplementationOnce(() => {
        marker = 'c'.repeat(32); // the app's restore lands while the pixels are read
        return Promise.resolve(clipboard.image);
      });

      const outcome = await createService().captureFromClipboard({
        isCurrent: () => Promise.resolve(marker === null),
      });

      expect(outcome).toEqual({ status: 'skipped', reason: 'superseded' });
      expect(fs.files.size).toBe(0);
    });

    it('records before queueing, tells the recorder which jobs are wanted, and queues only when told to', async () => {
      clipboard.image = new FakeImage(800, 600);
      settings = { ...settings, imageAnalysis: 'automatic' };
      const order: string[] = [];
      ocr.enqueue.mockImplementation(() => {
        order.push('ocr');
        return true;
      });
      const record = vi.fn(() => {
        order.push('record');
        return true;
      });

      const outcome = await createService().captureFromClipboard({ record });

      expect(order).toEqual(['record', 'ocr']);
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ created: true }), 'clipboard', {
        text: true,
        analysis: true,
      });
      expect(outcome).toMatchObject({ status: 'captured', queued: { text: true, analysis: true } });
    });

    it('queues nothing when the recorder says no (a bump, or our own restore)', async () => {
      clipboard.image = new FakeImage(800, 600);

      const outcome = await createService().captureFromClipboard({ record: () => false });

      expect(outcome).toMatchObject({
        status: 'captured',
        queued: { text: false, analysis: false },
      });
      expect(ocr.enqueue).not.toHaveBeenCalled();
    });

    it('queues work for a new clip even when the file was already on disk, from the decoded image', async () => {
      const image = new FakeImage(800, 600, 4);
      clipboard.image = image;
      const service = createService();
      await service.captureFromClipboard({ record: () => false });

      const outcome = await service.captureFromClipboard({ record: () => true });

      expect(outcome).toMatchObject({
        status: 'captured',
        image: { created: false },
        queued: { text: true },
      });
      expect(decoder.decode).not.toHaveBeenCalled();
      expect(decodeFakePng((await ocrJob().load()).png)).toBe('png:1600x1200:4');
    });

    it('does not want analysis without the model, nor text when recognition is off', async () => {
      clipboard.image = new FakeImage(800, 600);
      settings = { textRecognition: false, imageAnalysis: 'automatic', analysisLanguage: null };
      modelAvailable = false;
      const record = vi.fn(() => true);

      await createService().captureFromClipboard({ record });

      expect(record).toHaveBeenCalledWith(expect.anything(), 'clipboard', {
        text: false,
        analysis: false,
      });
      expect(ocr.enqueue).not.toHaveBeenCalled();
      expect(analysis.enqueue).not.toHaveBeenCalled();
    });
  });
});
