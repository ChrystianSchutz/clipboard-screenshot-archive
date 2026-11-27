import { describe, expect, it } from 'vitest';
import type { DiffCell } from '@shared/text-diff';
import { compareTexts, type Comparison } from './comparison';

const lineText = (cell: DiffCell | null): string | null =>
  cell ? cell.segments.map((segment) => segment.text).join('') : null;

/** The lines one side of the side-by-side view shows. */
function sideLines(comparison: Comparison, side: 'left' | 'right'): (string | null)[] {
  return comparison.lines.rows.map((row) => lineText(row[side]));
}

describe('compareTexts', () => {
  it('reports adjacent 64-bit ids as changed data and shows their exact digits side by side', () => {
    const comparison = compareTexts('{"id":9007199254740992}', '{"id":9007199254740993}', {
      ignoreArrayOrder: false,
    });

    expect(comparison.mode === 'json' && comparison.summary).toEqual({
      added: 0,
      removed: 0,
      changed: 1,
    });
    expect(comparison.lines.rows.map((row) => row.type)).toEqual(['same', 'modified', 'same']);
    expect(sideLines(comparison, 'left')[1]).toBe('  "id": 9007199254740992');
    expect(sideLines(comparison, 'right')[1]).toBe('  "id": 9007199254740993');
  });

  it('keeps an own "__proto__" key, in the changes and side by side, when ignoring array order', () => {
    const comparison = compareTexts('[{"__proto__":{"admin":true}}]', '[{}]', {
      ignoreArrayOrder: true,
    });

    expect(comparison.mode === 'json' && comparison.summary).toEqual({
      added: 1,
      removed: 1,
      changed: 0,
    });
    expect(sideLines(comparison, 'left')).toContain('    "__proto__": {');
  });
});
