import { describe, expect, it } from 'vitest';
import {
  analysisSearchText,
  screenshotSearchText,
  type AnalysisObject,
  type ImageAnalysis,
} from './image-analysis';

const box = { x0: 0, y0: 0, x1: 10, y1: 10 };
const object = (label: string, id = 1): AnalysisObject => ({
  id,
  label,
  box,
  score: 0.5,
  attributes: {},
});
const analysis = (overrides: Partial<ImageAnalysis> = {}): ImageAnalysis => ({
  engine: 'test',
  language: 'en',
  width: 10,
  height: 10,
  description: ['error dialog over a code editor', 'the dialog reports a failed request'],
  scene: { setting: 'screenshot', style: 'dark theme' },
  objects: [object('dialog box'), object('button', 2), object('button', 3)],
  text: [{ text: 'not indexed here', box, score: 0.4 }],
  durationMs: 1,
  ...overrides,
});

describe('analysisSearchText', () => {
  it('indexes the description, scene words and each object label once, so "error dialog" finds the image', () => {
    expect(analysisSearchText(analysis())).toBe(
      'error dialog over a code editor\nthe dialog reports a failed request\nscreenshot dark theme\ndialog box button',
    );
  });

  it("leaves out the analyzer's own text reading (Tesseract's text is indexed instead)", () => {
    expect(analysisSearchText(analysis())).not.toContain('not indexed');
  });

  it('is empty for an empty analysis', () => {
    expect(analysisSearchText(analysis({ description: [], scene: {}, objects: [] }))).toBe('');
  });
});

describe('screenshotSearchText', () => {
  const ocr = { lines: [{ text: 'Error: read ECONNRESET', box, confidence: 90, words: [] }] };
  const short = (description: string) =>
    analysis({ scene: {}, objects: [], description: [description] });

  it('puts the recognised text first, then the analysis', () => {
    expect(screenshotSearchText(ocr, short('terminal window'))).toBe(
      'Error: read ECONNRESET\nterminal window',
    );
  });

  it('works with either part missing', () => {
    expect(screenshotSearchText(ocr, null)).toBe('Error: read ECONNRESET');
    expect(screenshotSearchText(null, short('bar chart'))).toBe('bar chart');
    expect(screenshotSearchText(null, null)).toBe('');
  });
});
