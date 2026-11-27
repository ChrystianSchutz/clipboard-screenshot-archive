import { z } from 'zod';
import type { OcrLine, OcrResult } from '@shared/ocr';
import { IMAGE_LIMITS, pngDimensions } from '../images/image-policy';
import { OCR_UPSCALE } from './ocr-scale';
import type { OcrImage } from './ports';

/**
 * Validates an `OcrResult` that crossed a process boundary (from the worker, or back from the
 * database). Limits are generous for real screenshots and stop a broken engine from handing main
 * a multi-gigabyte object.
 */
export const boxSchema = z.object({
  x0: z.number(),
  y0: z.number(),
  x1: z.number(),
  y1: z.number(),
});

const word = z.object({ text: z.string().max(1_000), box: boxSchema, confidence: z.number() });

const line = z.object({
  text: z.string().max(10_000),
  box: boxSchema,
  confidence: z.number(),
  words: z.array(word).max(2_000),
});

/**
 * Aggregate limits of one result. The per-field limits alone would still admit millions of word
 * objects; a full 8K screen of 8 × 16 px glyphs holds about 260 000 characters, so these leave
 * room for every real screenshot. The worker trims its result to them (`limitOcrResult`) and main
 * rejects anything bigger, so both sides agree on the same budget.
 */
export const OCR_BUDGET = {
  maxWords: 60_000,
  /** Characters of line text plus word text. */
  maxTextChars: 1_000_000,
} as const;

export function ocrTotals(lines: readonly OcrLine[]): { words: number; textChars: number } {
  let words = 0;
  let textChars = 0;
  for (const entry of lines) {
    words += entry.words.length;
    textChars += lineChars(entry);
  }
  return { words, textChars };
}

export const ocrResultSchema: z.ZodType<OcrResult> = z
  .object({
    engine: z.string().max(200),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    lines: z.array(line).max(10_000),
    durationMs: z.number().nonnegative(),
  })
  .superRefine((result, context) => {
    const totals = ocrTotals(result.lines);
    if (totals.words > OCR_BUDGET.maxWords || totals.textChars > OCR_BUDGET.maxTextChars)
      context.addIssue({ code: 'custom', message: 'Text recognition result exceeds its budget' });
  });

/**
 * Keeps the leading lines that fit in `OCR_BUDGET` (reading order, whole lines only). What a
 * screenshot holds beyond that is not text worth indexing (noise read as letters).
 */
export function limitOcrResult(result: OcrResult): OcrResult {
  let words = 0;
  let textChars = 0;
  let kept = 0;
  for (const entry of result.lines) {
    words += entry.words.length;
    textChars += lineChars(entry);
    if (words > OCR_BUDGET.maxWords || textChars > OCR_BUDGET.maxTextChars) break;
    kept++;
  }
  return kept === result.lines.length ? result : { ...result, lines: result.lines.slice(0, kept) };
}

function lineChars(entry: OcrLine): number {
  return entry.words.reduce((sum, item) => sum + item.text.length, entry.text.length);
}

/**
 * The largest PNG main sends for recognition: an 8K image as uncompressed RGBA plus headroom.
 * PNG never needs more than that (incompressible data is stored), so a bigger buffer is not a
 * real screenshot.
 */
export const MAX_OCR_PNG_BYTES = IMAGE_LIMITS.maxPixels * 4 + 1024 * 1024;

/**
 * Most pixels the worker decodes for one request. The 2× copy is made only for images up to
 * `OCR_UPSCALE_MAX_PIXELS`, so a real request never decodes more than the largest stored image.
 */
export const MAX_OCR_DECODED_PIXELS = IMAGE_LIMITS.maxPixels;

const side = z.number().int().positive().max(IMAGE_LIMITS.maxSide);

/**
 * Whether the PNG's own header (IHDR) describes the image the request declares: `width × scale`
 * by `height × scale`, within `MAX_OCR_DECODED_PIXELS`. Checked before the decoder sees the bytes,
 * so a small declared size cannot smuggle in a PNG that decodes to gigabytes.
 */
function headerMatches(image: OcrImage): boolean {
  const size = pngDimensions(image.png);
  return (
    size !== null &&
    size.width === image.width * image.scale &&
    size.height === image.height * image.scale &&
    size.width * size.height <= MAX_OCR_DECODED_PIXELS
  );
}

/** Validates a recognition request at the worker's entry (see `runWorkerHost`). */
export const ocrImageSchema: z.ZodType<OcrImage> = z
  .object({
    png: z
      .instanceof(Uint8Array)
      .refine((png) => png.byteLength > 0 && png.byteLength <= MAX_OCR_PNG_BYTES, {
        error: 'PNG size out of range',
      }),
    width: side,
    height: side,
    scale: z.union([z.literal(1), z.literal(OCR_UPSCALE)]),
  })
  .refine((image) => image.width * image.height <= IMAGE_LIMITS.maxPixels, {
    error: 'Image has too many pixels',
  })
  .refine(headerMatches, { error: 'PNG header does not match the declared image size' });
