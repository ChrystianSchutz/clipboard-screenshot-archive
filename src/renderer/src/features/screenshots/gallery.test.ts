import { describe, expect, it } from 'vitest';
import type { OcrResult } from '@shared/ocr';
import {
  emptyHint,
  formatBytes,
  imageDimensions,
  isGridKey,
  moveInGrid,
  tileStatuses,
} from './gallery';

// Seven tiles in three columns:
//   1 2 3
//   4 5 6
//   7
const IDS = [1, 2, 3, 4, 5, 6, 7];

describe('moveInGrid', () => {
  it('selects the first tile when nothing (or a vanished tile) is selected', () => {
    expect(moveInGrid(IDS, null, 'ArrowDown', 3)).toBe(1);
    expect(moveInGrid(IDS, 99, 'ArrowRight', 3)).toBe(1);
    expect(moveInGrid([], null, 'ArrowDown', 3)).toBeNull();
  });

  it('steps left and right through the list, wrapping rows and stopping at the ends', () => {
    expect(moveInGrid(IDS, 3, 'ArrowRight', 3)).toBe(4);
    expect(moveInGrid(IDS, 4, 'ArrowLeft', 3)).toBe(3);
    expect(moveInGrid(IDS, 1, 'ArrowLeft', 3)).toBe(1);
    expect(moveInGrid(IDS, 7, 'ArrowRight', 3)).toBe(7);
  });

  it('jumps a whole row up and down and stays put at the top', () => {
    expect(moveInGrid(IDS, 2, 'ArrowDown', 3)).toBe(5);
    expect(moveInGrid(IDS, 5, 'ArrowUp', 3)).toBe(2);
    expect(moveInGrid(IDS, 2, 'ArrowUp', 3)).toBe(2);
  });

  it('goes down into a partial last row onto its last tile, and not past the end', () => {
    expect(moveInGrid(IDS, 5, 'ArrowDown', 3)).toBe(7);
    expect(moveInGrid(IDS, 4, 'ArrowDown', 3)).toBe(7);
    expect(moveInGrid(IDS, 7, 'ArrowDown', 3)).toBe(7);
  });

  it('Home and End go to the first and last tile; a bad column count acts as one column', () => {
    expect(moveInGrid(IDS, 5, 'Home', 3)).toBe(1);
    expect(moveInGrid(IDS, 2, 'End', 3)).toBe(7);
    expect(moveInGrid(IDS, 2, 'ArrowDown', 0)).toBe(3);
  });

  it('recognises only grid keys', () => {
    expect(isGridKey('ArrowUp')).toBe(true);
    expect(isGridKey('End')).toBe(true);
    expect(isGridKey('Enter')).toBe(false);
    expect(isGridKey('Delete')).toBe(false);
  });
});

describe('tile labels', () => {
  it('takes the dimensions from the image label', () => {
    expect(imageDimensions('Image 900×216')).toBe('900×216');
    expect(imageDimensions('900×216')).toBe('900×216');
  });

  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(42_400)).toBe('42 KB');
    expect(formatBytes(3_250_000)).toBe('3.3 MB');
    expect(formatBytes(-1)).toBe('');
  });

  const result = (lines: string[]): OcrResult => ({
    engine: 'test',
    width: 10,
    height: 10,
    durationMs: 1,
    lines: lines.map((text) => ({
      text,
      box: { x0: 0, y0: 0, x1: 1, y1: 1 },
      confidence: 90,
      words: [],
    })),
  });

  it('shows the text and analysis states that matter', () => {
    const none = { state: 'none', result: null } as const;
    expect(tileStatuses({ text: { state: 'pending', result: null }, analysis: none })).toEqual([
      { label: 'Reading text…', tone: 'busy' },
    ]);
    expect(
      tileStatuses({ text: { state: 'done', result: result(['ECONNRESET']) }, analysis: none }),
    ).toEqual([{ label: 'Text', tone: 'ok' }]);
    expect(
      tileStatuses({ text: { state: 'done', result: result([' ']) }, analysis: none }),
    ).toEqual([{ label: 'No text', tone: 'muted' }]);
    expect(tileStatuses({ text: { state: 'off', result: null }, analysis: none })).toEqual([]);
    expect(
      tileStatuses({
        text: { state: 'failed', result: null },
        analysis: { state: 'done', result: null },
      }),
    ).toEqual([
      { label: 'Text failed', tone: 'error' },
      { label: 'Analyzed', tone: 'ok' },
    ]);
    expect(
      tileStatuses({
        text: { state: 'off', result: null },
        analysis: { state: 'pending', result: null },
      }),
    ).toEqual([{ label: 'Analyzing…', tone: 'busy' }]);
  });
});

describe('emptyHint', () => {
  it('names the screenshot keys of each platform', () => {
    expect(emptyHint('win32')).toMatchObject({ keys: 'Win+Shift+S', needsFolderImport: false });
    expect(emptyHint('darwin')).toMatchObject({ keys: 'Cmd+Shift+4', needsFolderImport: true });
    expect(emptyHint('darwin').after).toContain('folder import in Settings');
    expect(emptyHint('linux').needsFolderImport).toBe(false);
  });
});
