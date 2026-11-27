import { describe, expect, it } from 'vitest';
import type { OcrLine } from '@shared/ocr';
import {
  FONT_SIZE_RATIO,
  approximateMeasure,
  displayScale,
  layoutTextLayer,
  scaleBox,
  textBetween,
  type MeasureText,
} from './text-layer-geometry';

/** Every character is exactly `fontSize / 2` wide, so `scaleX` is easy to predict. */
const halfEm: MeasureText = (text, fontSize) => text.length * fontSize * 0.5;

const helloWorld: OcrLine = {
  text: 'Hello world',
  box: { x0: 100, y0: 50, x1: 400, y1: 90 },
  confidence: 95,
  words: [
    { text: 'Hello', box: { x0: 100, y0: 50, x1: 220, y1: 90 }, confidence: 95 },
    { text: 'world', box: { x0: 260, y0: 50, x1: 400, y1: 90 }, confidence: 95 },
  ],
};

describe('displayScale / scaleBox', () => {
  it('maps image pixels to displayed pixels per axis', () => {
    const scale = displayScale({ width: 800, height: 400 }, 400, 100);
    expect(scale).toEqual({ x: 0.5, y: 0.25 });
    expect(scaleBox({ x0: 100, y0: 40, x1: 300, y1: 120 }, scale)).toEqual({
      left: 50,
      top: 10,
      width: 100,
      height: 20,
    });
  });

  it('never yields a negative size for an inverted box', () => {
    expect(scaleBox({ x0: 10, y0: 10, x1: 5, y1: 5 }, { x: 1, y: 1 })).toMatchObject({
      width: 0,
      height: 0,
    });
  });
});

describe('layoutTextLayer', () => {
  const result = { width: 800, height: 400, lines: [helloWorld] };

  it('places words and the space between them on their scaled boxes', () => {
    const [line] = layoutTextLayer(result, 400, 200, halfEm);

    expect(line!.text).toBe('Hello world');
    expect(line!.box).toEqual({ left: 50, top: 25, width: 150, height: 20 });
    expect(
      line!.pieces.map(({ kind, text, start, left, width }) => ({
        kind,
        text,
        start,
        left,
        width,
      })),
    ).toEqual([
      { kind: 'word', text: 'Hello', start: 0, left: 50, width: 60 },
      { kind: 'space', text: ' ', start: 5, left: 110, width: 20 },
      { kind: 'word', text: 'world', start: 6, left: 130, width: 70 },
    ]);
  });

  it('sizes the font from the line height and stretches text to the box', () => {
    const [line] = layoutTextLayer(result, 400, 200, halfEm);
    const hello = line!.pieces[0]!;

    expect(hello.fontSize).toBe(20 * FONT_SIZE_RATIO);
    // "Hello" is 5 × 18 px / 2 = 45 px wide at 18 px, and must cover 60 px.
    expect(hello.scaleX).toBeCloseTo(60 / 45);
  });

  it('uses one piece per line when the engine gave no word boxes', () => {
    const lineOnly: OcrLine = { ...helloWorld, words: [] };
    const [line] = layoutTextLayer({ ...result, lines: [lineOnly] }, 800, 400, halfEm);
    expect(line!.pieces).toHaveLength(1);
    expect(line!.pieces[0]).toMatchObject({
      kind: 'word',
      text: 'Hello world',
      left: 100,
      width: 300,
    });
  });

  it('lays out nothing for an image that is not displayed', () => {
    expect(layoutTextLayer(result, 0, 200, halfEm)).toEqual([]);
  });
});

describe('textBetween', () => {
  const lines = [{ text: 'first line' }, { text: 'second' }, { text: 'third line' }];

  it('returns part of one line', () => {
    expect(textBetween(lines, { line: 0, offset: 6 }, { line: 0, offset: 10 })).toBe('line');
  });

  it('joins lines with one newline, in order, for a backwards selection too', () => {
    const forwards = textBetween(lines, { line: 0, offset: 6 }, { line: 2, offset: 5 });
    expect(forwards).toBe('line\nsecond\nthird');
    expect(textBetween(lines, { line: 2, offset: 5 }, { line: 0, offset: 6 })).toBe(forwards);
  });

  it('clamps offsets past the end of a line', () => {
    expect(
      textBetween(lines, { line: 1, offset: 0 }, { line: 1, offset: Number.MAX_SAFE_INTEGER }),
    ).toBe('second');
  });
});

describe('approximateMeasure', () => {
  it('grows with text length and font size', () => {
    expect(approximateMeasure('abcd', 10)).toBeCloseTo(22);
    expect(approximateMeasure('', 10)).toBe(0);
  });
});
