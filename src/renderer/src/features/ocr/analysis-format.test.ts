import { describe, expect, it } from 'vitest';
import {
  analysisEntities,
  downloadPercent,
  entityBox,
  formatDuration,
  formatMegabytes,
  formatScore,
  languageName,
} from './analysis-format';
import { imageAnalysis } from './test-fixtures';

describe('analysisEntities', () => {
  it('groups boxes of one entity, keeping first-seen order and the best score', () => {
    expect(analysisEntities(imageAnalysis().objects)).toEqual([
      { id: 1, label: 'dialog box', score: 0.914, position: 'center', boxCount: 2 },
      { id: 2, label: 'button', score: 0.5, position: undefined, boxCount: 1 },
    ]);
  });
});

describe('entityBox', () => {
  const analysis = imageAnalysis();

  it('covers every box of the entity', () => {
    expect(entityBox(analysis, 1)).toEqual({ x0: 100, y0: 40, x1: 340, y1: 160 });
  });

  it('is null for no selection or an unknown entity', () => {
    expect(entityBox(analysis, null)).toBeNull();
    expect(entityBox(analysis, 99)).toBeNull();
  });

  it('rescales when the analyzer saw the image at another size', () => {
    expect(entityBox(analysis, 2, { width: 1600, height: 800 })).toEqual({
      x0: 800,
      y0: 400,
      x1: 960,
      y1: 480,
    });
    expect(entityBox(analysis, 2, { width: 800, height: 400 })).toEqual({
      x0: 400,
      y0: 200,
      x1: 480,
      y1: 240,
    });
  });
});

describe('formatters', () => {
  it('formats sizes, progress, scores, durations and languages', () => {
    expect(formatMegabytes(22_400_000)).toBe('22 MB');
    expect(downloadPercent({ state: 'downloading', received: 9_900_000, total: 22_000_000 })).toBe(
      45,
    );
    expect(downloadPercent({ state: 'downloading', received: 5, total: 0 })).toBeNull();
    expect(downloadPercent({ state: 'downloading', received: 30, total: 20 })).toBe(100);
    expect(formatScore(0.876)).toBe('88%');
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(1234)).toBe('1.2 s');
    expect(languageName('pl')).toBe('Polish');
  });
});
