/**
 * Text recognised in a screenshot, shared by the OCR host, the main process and the renderer.
 *
 * Every text recognizer is mapped to this one shape (see `TextRecognizer` in src/main/ocr/ports.ts),
 * so the engine can be swapped without touching storage, search or the text layer. All coordinates are in
 * pixels of the original image, origin top-left, whatever resolution the engine actually read.
 */

/** Axis-aligned box: left/top inclusive, right/bottom exclusive, in image pixels. */
export interface OcrBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface OcrWord {
  readonly text: string;
  readonly box: OcrBox;
  /** 0..100. */
  readonly confidence: number;
}

/** One visual line of text, words in reading order. */
export interface OcrLine {
  readonly text: string;
  readonly box: OcrBox;
  readonly confidence: number;
  readonly words: readonly OcrWord[];
}

export interface OcrResult {
  /** Engine id and version, e.g. "tesseract.js@7.0.0/eng+pol". Stored so results can be redone. */
  readonly engine: string;
  /** Size of the image the boxes refer to. */
  readonly width: number;
  readonly height: number;
  /** Lines in the engine's reading order (top to bottom; column by column in multi-column layouts). */
  readonly lines: readonly OcrLine[];
  /** Wall time of the recognition itself. */
  readonly durationMs: number;
}

/** Plain text of a result: one line per OCR line. This is what search indexes and "Copy all" copies. */
export function ocrText(result: Pick<OcrResult, 'lines'>): string {
  return result.lines.map((line) => line.text).join('\n');
}
