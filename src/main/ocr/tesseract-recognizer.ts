import type { OcrBox, OcrLine, OcrResult, OcrWord } from '@shared/ocr';
import type Tesseract from 'tesseract.js';
import { unscaleResult } from './ocr-scale';
import type { OcrImage, TextRecognizer } from './ports';

/** The slice of the tesseract.js module this adapter uses; tests pass a fake. */
export interface TesseractModule {
  createWorker: typeof Tesseract.createWorker;
  /** Page segmentation mode constants (a runtime object in tesseract.js). */
  PSM: Pick<typeof Tesseract.PSM, 'AUTO'>;
}

export interface TesseractRecognizerOptions {
  readonly tesseract: TesseractModule;
  /** Folder with `<lang>.traineddata` files (tessdata_fast). Read from disk: nothing is downloaded. */
  readonly tessdataDir: string;
  /** Tesseract language codes, e.g. `['eng', 'pol']`. */
  readonly languages: readonly string[];
  /** tesseract.js version, recorded in `OcrResult.engine`. */
  readonly version: string;
  readonly now?: () => number;
}

/** LSTM engine only: the tessdata_fast models have no legacy-engine data. */
const OEM_LSTM_ONLY = 1;
// Page segmentation: PSM.AUTO (fully automatic), because screenshots mix paragraphs, columns and UI labels.
/** Lines below this confidence are almost always icons or UI chrome read as letters. */
export const MIN_LINE_CONFIDENCE = 20;

/**
 * `TextRecognizer` backed by tesseract.js (Tesseract 5 compiled to WebAssembly).
 *
 * - Fully offline: `langPath` points at the bundled tessdata folder and `cacheMethod: 'none'`
 *   stops tesseract.js from writing a copy of the models into the working directory. Without a
 *   `langPath`, tesseract.js would fetch models from a CDN, which a privacy app must never do.
 * - The worker is created on first use and kept until `dispose()`, because loading the models
 *   takes ~200 ms and each recognition reuses them.
 * - Calls are serialised: one Tesseract worker handles one image at a time.
 */
export class TesseractRecognizer implements TextRecognizer {
  readonly id: string;
  private worker: Promise<Tesseract.Worker> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly options: TesseractRecognizerOptions) {
    this.id = `tesseract.js@${options.version}/${options.languages.join('+')}`;
    this.now = options.now ?? (() => performance.now());
  }

  recognize(image: OcrImage): Promise<OcrResult> {
    const job = this.queue.then(() => this.run(image));
    this.queue = job.catch(() => undefined);
    return job;
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker) await (await worker).terminate();
  }

  private async run(image: OcrImage): Promise<OcrResult> {
    const worker = await this.ensureWorker();
    const started = this.now();
    const { data } = await worker.recognize(
      Buffer.from(image.png),
      {},
      { text: false, blocks: true },
    );
    const durationMs = Math.round(this.now() - started);
    const scaled: OcrResult = {
      engine: this.id,
      width: Math.round(image.width * image.scale),
      height: Math.round(image.height * image.scale),
      lines: mapTesseractPage(data),
      durationMs,
    };
    return unscaleResult(scaled, image.scale, image.width, image.height);
  }

  private ensureWorker(): Promise<Tesseract.Worker> {
    if (!this.worker) {
      const { tesseract, tessdataDir, languages } = this.options;
      const created = tesseract
        .createWorker([...languages], OEM_LSTM_ONLY, {
          langPath: tessdataDir,
          gzip: false,
          cacheMethod: 'none',
        })
        .then(async (worker) => {
          await worker.setParameters({ tessedit_pageseg_mode: this.options.tesseract.PSM.AUTO });
          return worker;
        });
      // A failed start (missing model file) must not poison every later call.
      created.catch(() => {
        if (this.worker === created) this.worker = null;
      });
      this.worker = created;
    }
    return this.worker;
  }
}

/** Flattens Tesseract's block → paragraph → line → word tree into lines of words. */
export function mapTesseractPage(page: Pick<Tesseract.Page, 'blocks'>): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        const words: OcrWord[] = line.words
          .map((word) => ({
            text: word.text.trim(),
            box: toBox(word.bbox),
            confidence: round(word.confidence),
          }))
          .filter((word) => word.text.length > 0);
        if (words.length === 0 || line.confidence < MIN_LINE_CONFIDENCE) continue;
        lines.push({
          // Rebuilt from the words, so line text, the text layer and copied text always agree.
          text: words.map((word) => word.text).join(' '),
          box: toBox(line.bbox),
          confidence: round(line.confidence),
          words,
        });
      }
    }
  }
  return lines;
}

function toBox({ x0, y0, x1, y1 }: Tesseract.Bbox): OcrBox {
  return { x0, y0, x1, y1 };
}

function round(confidence: number): number {
  return Math.round(confidence * 10) / 10;
}
