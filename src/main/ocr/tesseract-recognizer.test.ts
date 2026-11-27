import { describe, expect, it, vi } from 'vitest';
import tesseract from 'tesseract.js';
import type Tesseract from 'tesseract.js';
import { deferred } from '../test-support/fakes';
import type { OcrImage } from './ports';
import {
  MIN_LINE_CONFIDENCE,
  mapTesseractPage,
  TesseractRecognizer,
  type TesseractModule,
} from './tesseract-recognizer';

/** Lets every queued promise callback run. */
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

type Bbox = Tesseract.Bbox;

const bbox = (x0: number, y0: number, x1: number, y1: number): Bbox => ({ x0, y0, x1, y1 });

/** Only the fields `mapTesseractPage` reads; tesseract.js pages carry much more. */
interface FakeWord {
  text: string;
  confidence: number;
  bbox: Bbox;
}
interface FakeLine {
  words: FakeWord[];
  confidence: number;
  bbox: Bbox;
}

const word = (text: string, confidence = 90, box = bbox(0, 0, 10, 10)): FakeWord => ({
  text,
  confidence,
  bbox: box,
});
const line = (words: FakeWord[], confidence = 90, box = bbox(0, 0, 100, 10)): FakeLine => ({
  words,
  confidence,
  bbox: box,
});

/** A page of blocks → paragraphs → lines. */
function page(...blocks: FakeLine[][][]): Pick<Tesseract.Page, 'blocks'> {
  const fake = {
    blocks: blocks.map((paragraphs) => ({ paragraphs: paragraphs.map((lines) => ({ lines })) })),
  };
  return fake as unknown as Pick<Tesseract.Page, 'blocks'>;
}

describe('mapTesseractPage', () => {
  it('flattens every block and paragraph into lines, in reading order', () => {
    const lines = mapTesseractPage(
      page(
        [[line([word('Title')])], [line([word('First')]), line([word('Second')])]],
        [[line([word('Sidebar')])]],
      ),
    );
    expect(lines.map((l) => l.text)).toEqual(['Title', 'First', 'Second', 'Sidebar']);
  });

  it('keeps the boxes of lines and words', () => {
    const [mapped] = mapTesseractPage(
      page([[line([word('git', 95, bbox(10, 20, 40, 34))], 88, bbox(10, 18, 200, 36))]]),
    );
    expect(mapped!.box).toEqual({ x0: 10, y0: 18, x1: 200, y1: 36 });
    expect(mapped!.words[0]!.box).toEqual({ x0: 10, y0: 20, x1: 40, y1: 34 });
  });

  it('trims words and drops the empty ones', () => {
    const [mapped] = mapTesseractPage(
      page([[line([word(' npm '), word('  '), word(''), word('install\n')])]]),
    );
    expect(mapped!.words.map((w) => w.text)).toEqual(['npm', 'install']);
  });

  it('rebuilds the line text from its words', () => {
    const [mapped] = mapTesseractPage(page([[line([word('cd'), word(' '), word('src/main ')])]]));
    expect(mapped!.text).toBe('cd src/main');
  });

  it('skips lines below the confidence threshold, but keeps one exactly at it', () => {
    const lines = mapTesseractPage(
      page([
        [
          line([word('|||')], MIN_LINE_CONFIDENCE - 0.1),
          line([word('OK')], MIN_LINE_CONFIDENCE),
          line([word('Fine')], 99),
        ],
      ]),
    );
    expect(lines.map((l) => l.text)).toEqual(['OK', 'Fine']);
  });

  it('skips lines with no words left', () => {
    const lines = mapTesseractPage(page([[line([]), line([word('   ')]), line([word('kept')])]]));
    expect(lines.map((l) => l.text)).toEqual(['kept']);
  });

  it('rounds confidences to one decimal place', () => {
    const [mapped] = mapTesseractPage(page([[line([word('x', 87.6549)], 91.25)]]));
    expect(mapped!.confidence).toBe(91.3);
    expect(mapped!.words[0]!.confidence).toBe(87.7);
  });

  it('returns no lines for a page without blocks', () => {
    expect(mapTesseractPage({ blocks: null })).toEqual([]);
  });
});

/** The slice of a tesseract.js worker the recognizer uses. */
class FakeTesseractWorker {
  page = page([[line([word('Hello', 96, bbox(20, 10, 120, 40))], 95, bbox(20, 10, 120, 40))]]);
  readonly setParameters = vi.fn<(parameters: Partial<Tesseract.WorkerParams>) => Promise<unknown>>(
    () => Promise.resolve({}),
  );
  readonly recognize = vi.fn<
    (
      image: Buffer,
      options: unknown,
      output: unknown,
    ) => Promise<{ data: Pick<Tesseract.Page, 'blocks'> }>
  >(() => Promise.resolve({ data: this.page }));
  readonly terminate = vi.fn(() => Promise.resolve({}));
}

function setup(options: { now?: () => number } = {}) {
  const workers: FakeTesseractWorker[] = [];
  const createWorker = vi.fn<
    (langs: string[], oem: number, options: unknown) => Promise<Tesseract.Worker>
  >(() => {
    const worker = new FakeTesseractWorker();
    workers.push(worker);
    return Promise.resolve(worker as unknown as Tesseract.Worker);
  });
  const recognizer = new TesseractRecognizer({
    tesseract: {
      createWorker: createWorker as unknown as TesseractModule['createWorker'],
      PSM: tesseract.PSM,
    },
    tessdataDir: 'C:\\app\\resources\\tessdata',
    languages: ['eng', 'pol'],
    version: '7.0.0',
    ...options,
  });
  return { recognizer, createWorker, workers };
}

const image: OcrImage = {
  png: new Uint8Array([137, 80, 78, 71]),
  width: 100,
  height: 50,
  scale: 1,
};

describe('TesseractRecognizer', () => {
  it('names itself after the engine version and languages', () => {
    expect(setup().recognizer.id).toBe('tesseract.js@7.0.0/eng+pol');
  });

  it('creates no worker before the first image', () => {
    const { createWorker } = setup();
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('starts an offline LSTM worker with the bundled models and automatic page segmentation', async () => {
    const { recognizer, createWorker, workers } = setup();

    await recognizer.recognize(image);

    expect(createWorker).toHaveBeenCalledExactlyOnceWith(['eng', 'pol'], 1, {
      langPath: 'C:\\app\\resources\\tessdata',
      gzip: false,
      cacheMethod: 'none',
    });
    expect(workers[0]!.setParameters).toHaveBeenCalledExactlyOnceWith({
      tessedit_pageseg_mode: '3',
    });
  });

  it('hands Tesseract the PNG bytes and asks for blocks only', async () => {
    const { recognizer, workers } = setup();

    await recognizer.recognize(image);

    const [png, options, output] = workers[0]!.recognize.mock.calls[0]!;
    expect(Buffer.isBuffer(png)).toBe(true);
    expect([...png]).toEqual([137, 80, 78, 71]);
    expect(options).toEqual({});
    expect(output).toEqual({ text: false, blocks: true });
  });

  it('maps the page into an OcrResult tagged with its engine', async () => {
    const { recognizer } = setup();

    const result = await recognizer.recognize(image);

    expect(result.engine).toBe('tesseract.js@7.0.0/eng+pol');
    expect(result.width).toBe(100);
    expect(result.height).toBe(50);
    expect(result.lines.map((l) => l.text)).toEqual(['Hello']);
  });

  it('reuses one worker for every image', async () => {
    const { recognizer, createWorker, workers } = setup();

    await recognizer.recognize(image);
    await recognizer.recognize(image);

    expect(createWorker).toHaveBeenCalledOnce();
    expect(workers[0]!.recognize).toHaveBeenCalledTimes(2);
  });

  it('reads one image at a time', async () => {
    const { recognizer, workers } = setup();
    const slow = deferred<{ data: Pick<Tesseract.Page, 'blocks'> }>();
    const first = recognizer.recognize(image);
    await flushMicrotasks();
    const worker = workers[0]!;
    worker.recognize.mockReturnValueOnce(slow.promise);

    const second = recognizer.recognize(image);
    const third = recognizer.recognize(image);
    await first;
    await flushMicrotasks();
    expect(worker.recognize).toHaveBeenCalledTimes(2);

    slow.resolve({ data: worker.page });
    await second;
    await third;
    expect(worker.recognize).toHaveBeenCalledTimes(3);
  });

  it('keeps going after one image fails', async () => {
    const { recognizer, workers } = setup();
    await recognizer.recognize(image);
    workers[0]!.recognize.mockRejectedValueOnce(new Error('Image too large'));

    await expect(recognizer.recognize(image)).rejects.toThrow('Image too large');
    await expect(recognizer.recognize(image)).resolves.toMatchObject({
      engine: 'tesseract.js@7.0.0/eng+pol',
    });
  });

  it('tries to start the worker again when the first start failed', async () => {
    const { recognizer, createWorker } = setup();
    createWorker.mockRejectedValueOnce(new Error('ENOENT: eng.traineddata'));

    await expect(recognizer.recognize(image)).rejects.toThrow('ENOENT: eng.traineddata');
    await expect(recognizer.recognize(image)).resolves.toMatchObject({
      lines: [{ text: 'Hello' }],
    });
    expect(createWorker).toHaveBeenCalledTimes(2);
  });

  it('maps boxes of an upscaled image back onto the original', async () => {
    const { recognizer } = setup();

    const result = await recognizer.recognize({ ...image, scale: 2 });

    expect(result.width).toBe(100);
    expect(result.height).toBe(50);
    expect(result.lines[0]!.box).toEqual({ x0: 10, y0: 5, x1: 60, y1: 20 });
    expect(result.lines[0]!.words[0]!.box).toEqual({ x0: 10, y0: 5, x1: 60, y1: 20 });
  });

  it('measures the recognition with the injected clock, in whole milliseconds', async () => {
    const now = vi.fn<() => number>().mockReturnValueOnce(1_000).mockReturnValueOnce(1_234.4);
    const { recognizer } = setup({ now });

    const result = await recognizer.recognize(image);

    expect(result.durationMs).toBe(234);
  });

  it('terminates the worker on dispose and starts a new one for the next image', async () => {
    const { recognizer, createWorker, workers } = setup();
    await recognizer.recognize(image);

    await recognizer.dispose();
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();

    await recognizer.recognize(image);
    expect(createWorker).toHaveBeenCalledTimes(2);
    expect(workers[1]!.recognize).toHaveBeenCalledOnce();
  });

  it('does nothing on dispose when no worker was started', async () => {
    const { recognizer, createWorker } = setup();
    await recognizer.dispose();
    expect(createWorker).not.toHaveBeenCalled();
  });
});
