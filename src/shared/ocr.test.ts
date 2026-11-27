import { describe, expect, it } from 'vitest';
import { ocrText, type OcrLine } from './ocr';

const box = { x0: 0, y0: 0, x1: 10, y1: 10 };
const line = (text: string): OcrLine => ({ text, box, confidence: 90, words: [] });

describe('ocrText', () => {
  it('joins lines with newlines, in result order', () => {
    expect(
      ocrText({ lines: [line('Error: read ECONNRESET'), line('at TLSWrap.onStreamRead')] }),
    ).toBe('Error: read ECONNRESET\nat TLSWrap.onStreamRead');
  });

  it('is empty for an image without text', () => {
    expect(ocrText({ lines: [] })).toBe('');
  });
});
