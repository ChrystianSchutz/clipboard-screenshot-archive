import { describe, expect, it } from 'vitest';
import type { OcrLine, OcrResult } from '@shared/ocr';
import { pngHeader } from '../test-support/png';
import {
  limitOcrResult,
  MAX_OCR_DECODED_PIXELS,
  MAX_OCR_PNG_BYTES,
  OCR_BUDGET,
  ocrImageSchema,
  ocrResultSchema,
  ocrTotals,
} from './ocr-schema';

const box = { x0: 4, y0: 10, x1: 120, y1: 28 };

const line: OcrLine = {
  text: 'npm ERR! ECONNRESET',
  box,
  confidence: 91.5,
  words: [
    { text: 'npm', box: { x0: 4, y0: 10, x1: 30, y1: 28 }, confidence: 95 },
    { text: 'ERR!', box: { x0: 36, y0: 10, x1: 66, y1: 28 }, confidence: 88.2 },
    { text: 'ECONNRESET', box: { x0: 72, y0: 10, x1: 120, y1: 28 }, confidence: 91.4 },
  ],
};

const valid: OcrResult = {
  engine: 'tesseract.js@7.0.0/eng+pol',
  width: 640,
  height: 360,
  lines: [line],
  durationMs: 412,
};

const accepts = (value: unknown): boolean => ocrResultSchema.safeParse(value).success;

describe('ocrResultSchema', () => {
  it('accepts a well-formed result and returns it unchanged', () => {
    expect(ocrResultSchema.parse(valid)).toEqual(valid);
  });

  it('accepts a result with no text found', () => {
    expect(accepts({ ...valid, lines: [] })).toBe(true);
  });

  it('accepts a duration of zero', () => {
    expect(accepts({ ...valid, durationMs: 0 })).toBe(true);
  });

  it('rejects an image size that is not a positive whole number', () => {
    expect(accepts({ ...valid, width: 0 })).toBe(false);
    expect(accepts({ ...valid, height: -360 })).toBe(false);
    expect(accepts({ ...valid, width: 640.5 })).toBe(false);
  });

  it('rejects a negative duration', () => {
    expect(accepts({ ...valid, durationMs: -1 })).toBe(false);
  });

  it('rejects a result with missing fields', () => {
    const withoutEngine = Object.fromEntries(
      Object.entries(valid).filter(([key]) => key !== 'engine'),
    );
    expect(accepts(withoutEngine)).toBe(false);
    expect(accepts({ ...valid, lines: undefined })).toBe(false);
  });

  it('rejects a box with a non-numeric coordinate', () => {
    expect(accepts({ ...valid, lines: [{ ...line, box: { ...box, x1: '120' } }] })).toBe(false);
  });

  it('rejects more than 10 000 lines', () => {
    expect(accepts({ ...valid, lines: Array.from({ length: 10_000 }, () => line) })).toBe(true);
    expect(accepts({ ...valid, lines: Array.from({ length: 10_001 }, () => line) })).toBe(false);
  });

  it('rejects a line with more than 2 000 words', () => {
    const words = (count: number) => Array.from({ length: count }, () => line.words[0]!);
    expect(accepts({ ...valid, lines: [{ ...line, words: words(2_000) }] })).toBe(true);
    expect(accepts({ ...valid, lines: [{ ...line, words: words(2_001) }] })).toBe(false);
  });

  it('rejects over-long text', () => {
    const longWord = { ...line.words[0]!, text: 'x'.repeat(1_001) };
    expect(accepts({ ...valid, lines: [{ ...line, words: [longWord] }] })).toBe(false);
    expect(accepts({ ...valid, lines: [{ ...line, text: 'x'.repeat(10_001) }] })).toBe(false);
    expect(accepts({ ...valid, engine: 'e'.repeat(201) })).toBe(false);
  });
});

describe('OCR aggregate budget', () => {
  const wordOf = (text: string) => ({ text, box, confidence: 90 });
  const lineOf = (words: number, wordText: string) => ({
    text: wordText,
    box,
    confidence: 90,
    words: Array.from({ length: words }, () => wordOf(wordText)),
  });

  it('counts words and the characters of line and word text', () => {
    expect(ocrTotals([line])).toEqual({
      words: 3,
      textChars: line.text.length + 'npm'.length + 'ERR!'.length + 'ECONNRESET'.length,
    });
  });

  it('rejects a result whose total word count is over budget, though every field is in range', () => {
    // 31 lines of 2 000 words: each line is valid, together they are 62 000 words.
    const lines = Array.from({ length: 31 }, () => lineOf(2_000, 'a'));
    expect(accepts({ ...valid, lines: lines.slice(0, 30) })).toBe(true);
    expect(accepts({ ...valid, lines })).toBe(false);
  });

  it('rejects a result whose total text is over budget', () => {
    const long = { ...line, text: 'x'.repeat(10_000), words: [] };
    const lines = Array.from({ length: 101 }, () => long); // 1 010 000 characters
    expect(accepts({ ...valid, lines: lines.slice(0, 100) })).toBe(true);
    expect(accepts({ ...valid, lines })).toBe(false);
  });

  it('trims a result to whole leading lines within the budget, which main then accepts', () => {
    const lines = Array.from({ length: 31 }, () => lineOf(2_000, 'a'));
    const trimmed = limitOcrResult({ ...valid, lines });
    expect(trimmed.lines).toHaveLength(30);
    expect(ocrTotals(trimmed.lines).words).toBeLessThanOrEqual(OCR_BUDGET.maxWords);
    expect(accepts(trimmed)).toBe(true);
  });

  it('returns a result within the budget unchanged', () => {
    expect(limitOcrResult(valid)).toBe(valid);
  });
});

describe('ocrImageSchema (worker requests)', () => {
  // A 900 × 216 screenshot sent as its 2× copy.
  const png = pngHeader(1800, 432);
  const request = { png, width: 900, height: 216, scale: 2 };
  const acceptsRequest = (value: unknown): boolean => ocrImageSchema.safeParse(value).success;

  it('accepts a well-formed request, a Buffer included', () => {
    expect(acceptsRequest(request)).toBe(true);
    expect(
      acceptsRequest({ png: Buffer.from(pngHeader(900, 216)), width: 900, height: 216, scale: 1 }),
    ).toBe(true);
  });

  it('rejects a PNG whose header does not describe the declared size times the scale', () => {
    // Small declared size, huge PNG: the decoder must never see it.
    expect(acceptsRequest({ ...request, png: pngHeader(40_000, 40_000) })).toBe(false);
    expect(acceptsRequest({ ...request, png: pngHeader(900, 216) })).toBe(false); // scale ignored
    expect(acceptsRequest({ ...request, png: pngHeader(1800, 433) })).toBe(false);
    expect(acceptsRequest({ ...request, png: new Uint8Array([137, 80, 78, 71]) })).toBe(false);
  });

  it('rejects a request that would decode more pixels than the limit', () => {
    // Declared within the side limit, but its 2x copy exceeds the decoded-pixel cap.
    const side = Math.ceil(Math.sqrt(MAX_OCR_DECODED_PIXELS / 4)) + 1;
    const big = { png: pngHeader(side * 2, side * 2), width: side, height: side, scale: 2 };
    expect(side * side).toBeLessThanOrEqual(7680 * 4320);
    expect(acceptsRequest(big)).toBe(false);
  });

  it('rejects pixels that are not bytes, empty or over the encoded-size cap', () => {
    expect(acceptsRequest({ ...request, png: [137, 80] })).toBe(false);
    expect(acceptsRequest({ ...request, png: 'iVBORw0KGgo=' })).toBe(false);
    expect(acceptsRequest({ ...request, png: new Uint8Array(0) })).toBe(false);
    expect(acceptsRequest({ ...request, png: new Uint8Array(MAX_OCR_PNG_BYTES + 1) })).toBe(false);
  });

  it('rejects sizes outside the image limits and unknown scales', () => {
    expect(acceptsRequest({ ...request, width: 0 })).toBe(false);
    expect(acceptsRequest({ ...request, height: 2.5 })).toBe(false);
    expect(acceptsRequest({ ...request, width: 16_385 })).toBe(false);
    expect(acceptsRequest({ ...request, width: 16_000, height: 16_000 })).toBe(false);
    expect(acceptsRequest({ ...request, scale: 3 })).toBe(false);
    expect(acceptsRequest({ png, width: 900 })).toBe(false);
  });
});
