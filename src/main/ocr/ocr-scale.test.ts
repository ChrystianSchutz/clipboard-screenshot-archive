import { describe, expect, it } from 'vitest';
import type { OcrResult } from '@shared/ocr';
import { OCR_UPSCALE, OCR_UPSCALE_MAX_PIXELS, ocrUpscaleFactor, unscaleResult } from './ocr-scale';

describe('ocrUpscaleFactor', () => {
  it('enlarges region screenshots, whose UI text is too small for the LSTM models', () => {
    expect(ocrUpscaleFactor(900, 216)).toBe(OCR_UPSCALE);
    expect(ocrUpscaleFactor(1920, 1080)).toBe(OCR_UPSCALE);
  });

  it('reads large captures as they are', () => {
    expect(ocrUpscaleFactor(2560, 1440)).toBe(1);
    expect(ocrUpscaleFactor(3840, 2160)).toBe(1);
  });

  it('has an inclusive pixel limit', () => {
    expect(ocrUpscaleFactor(OCR_UPSCALE_MAX_PIXELS, 1)).toBe(OCR_UPSCALE);
    expect(ocrUpscaleFactor(OCR_UPSCALE_MAX_PIXELS + 1, 1)).toBe(1);
  });
});

describe('unscaleResult', () => {
  const scaled: OcrResult = {
    engine: 'test',
    width: 200,
    height: 100,
    durationMs: 5,
    lines: [
      {
        text: 'ECONNRESET',
        box: { x0: 11, y0: 21, x1: 101, y1: 41 },
        confidence: 95,
        words: [{ text: 'ECONNRESET', box: { x0: 11, y0: 21, x1: 101, y1: 41 }, confidence: 95 }],
      },
    ],
  };

  it('maps boxes back to the original image, growing them outwards to whole pixels', () => {
    const result = unscaleResult(scaled, 2, 100, 50);
    expect(result.width).toBe(100);
    expect(result.height).toBe(50);
    expect(result.lines[0]!.box).toEqual({ x0: 5, y0: 10, x1: 51, y1: 21 });
    expect(result.lines[0]!.words[0]!.box).toEqual({ x0: 5, y0: 10, x1: 51, y1: 21 });
  });

  it('keeps text, confidence and timing', () => {
    const result = unscaleResult(scaled, 2, 100, 50);
    expect(result.lines[0]!.text).toBe('ECONNRESET');
    expect(result.lines[0]!.confidence).toBe(95);
    expect(result.durationMs).toBe(5);
  });

  it('clamps boxes that spill over the image edge', () => {
    const spill: OcrResult = {
      ...scaled,
      lines: [{ ...scaled.lines[0]!, box: { x0: -4, y0: -4, x1: 260, y1: 130 }, words: [] }],
    };
    expect(unscaleResult(spill, 2, 100, 50).lines[0]!.box).toEqual({
      x0: 0,
      y0: 0,
      x1: 100,
      y1: 50,
    });
  });

  it('returns the same object when nothing was scaled', () => {
    const plain = { ...scaled, width: 100, height: 50 };
    expect(unscaleResult(plain, 1, 100, 50)).toBe(plain);
  });
});
