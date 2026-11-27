import { describe, expect, it } from 'vitest';
import { imageAnalysis } from '../test-support/image-fakes';
import {
  ANALYSIS_BUDGET,
  analysisRequestSchema,
  analysisTextChars,
  imageAnalysisSchema,
  limitImageAnalysis,
} from './analysis-schema';

const box = { x0: 0, y0: 0, x1: 10, y1: 10 };
const accepts = (value: unknown): boolean => imageAnalysisSchema.safeParse(value).success;
const longLines = (count: number) =>
  Array.from({ length: count }, () => ({ text: 'x'.repeat(10_000), box, score: 1 }));

describe('imageAnalysisSchema aggregate budget', () => {
  it('counts description, scene, object and text characters', () => {
    const analysis = imageAnalysis({
      description: ['abc'],
      scene: { style: 'flat' },
      objects: [{ id: 1, label: 'cat', box, score: 1, position: 'left', attributes: { c: 'red' } }],
      text: [{ text: 'hello', box, score: 1 }],
    });
    expect(analysisTextChars(analysis)).toBe(3 + 9 + (3 + 4 + 4) + 5);
  });

  it('rejects a result over budget even though each field is within its own limit', () => {
    expect(accepts(imageAnalysis({ text: longLines(30) }))).toBe(true);
    expect(accepts(imageAnalysis({ text: longLines(31) }))).toBe(false);
  });

  it('trims a result to the budget, keeping scene and description first', () => {
    const analysis = imageAnalysis({
      description: ['A terminal.'],
      scene: { style: 'ui' },
      text: longLines(40),
    });
    const trimmed = limitImageAnalysis(analysis);
    expect(trimmed.description).toEqual(['A terminal.']);
    expect(trimmed.scene).toEqual({ style: 'ui' });
    expect(trimmed.text.length).toBeLessThan(30);
    expect(analysisTextChars(trimmed)).toBeLessThanOrEqual(ANALYSIS_BUDGET.maxTextChars);
    expect(accepts(trimmed)).toBe(true);
  });

  it('returns a result within the budget unchanged', () => {
    const analysis = imageAnalysis({ description: ['ok'] });
    expect(limitImageAnalysis(analysis)).toBe(analysis);
  });
});

describe('analysisRequestSchema (worker requests)', () => {
  const image = {
    rgb: new Uint8Array(4 * 3 * 3),
    width: 4,
    height: 3,
    originalWidth: 8,
    originalHeight: 6,
  };
  const acceptsRequest = (value: unknown): boolean =>
    analysisRequestSchema.safeParse(value).success;

  it('accepts a well-formed request', () => {
    expect(acceptsRequest({ image, language: 'en' })).toBe(true);
  });

  it('rejects a pixel buffer that does not match the size or is not bytes', () => {
    const short = { ...image, rgb: new Uint8Array(35) };
    const array = { ...image, rgb: Array.from({ length: 36 }, () => 0) };
    expect(acceptsRequest({ image: short, language: 'en' })).toBe(false);
    expect(acceptsRequest({ image: array, language: 'en' })).toBe(false);
  });

  it('rejects sides over the model limit, bad originals and unknown languages', () => {
    const wide = { ...image, width: 1_025, height: 1, rgb: new Uint8Array(1_025 * 3) };
    expect(acceptsRequest({ image: wide, language: 'en' })).toBe(false);
    expect(acceptsRequest({ image: { ...image, originalWidth: 0 }, language: 'en' })).toBe(false);
    expect(acceptsRequest({ image: { ...image, originalHeight: 20_000 }, language: 'en' })).toBe(
      false,
    );
    expect(acceptsRequest({ image, language: 'de' })).toBe(false);
  });
});
