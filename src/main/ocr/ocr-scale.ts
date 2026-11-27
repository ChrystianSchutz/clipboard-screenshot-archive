import type { OcrBox, OcrResult } from '@shared/ocr';

/**
 * Tesseract's LSTM models read best at a cap height of roughly 20–30 px. UI and terminal text in a
 * 100 % scaled screenshot is about half of that, and enlarging the image 2× before recognition
 * fixes most misread punctuation (`${` read as `$f`, `!` read as `I`, measured on the fixtures).
 *
 * Large images (HiDPI full-screen captures) already have big enough glyphs, and upscaling them
 * would quadruple the time and memory, so they are read as they are.
 */
export const OCR_UPSCALE = 2;
/** Images up to this many pixels are upscaled (≈ 1920 × 1300). */
export const OCR_UPSCALE_MAX_PIXELS = 2_500_000;

export function ocrUpscaleFactor(width: number, height: number): number {
  return width * height <= OCR_UPSCALE_MAX_PIXELS ? OCR_UPSCALE : 1;
}

/** Maps a result read from an image enlarged `scale` times back onto the original image. */
export function unscaleResult(
  result: OcrResult,
  scale: number,
  width: number,
  height: number,
): OcrResult {
  if (scale === 1 && result.width === width && result.height === height) return result;
  const box = (b: OcrBox): OcrBox => ({
    x0: clamp(Math.floor(b.x0 / scale), width),
    y0: clamp(Math.floor(b.y0 / scale), height),
    x1: clamp(Math.ceil(b.x1 / scale), width),
    y1: clamp(Math.ceil(b.y1 / scale), height),
  });
  return {
    ...result,
    width,
    height,
    lines: result.lines.map((line) => ({
      ...line,
      box: box(line.box),
      words: line.words.map((word) => ({ ...word, box: box(word.box) })),
    })),
  };
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}
