import { describe, expect, it } from 'vitest';
import { inlineSegments, normalizeNewlines, sideBySide, type DiffRow } from './text-diff';

/** Compact view of the rows: type plus the plain text and line number of each side. */
function outline(rows: readonly DiffRow[]): [string, string | null, string | null][] {
  const cell = (side: DiffRow['left']): string | null =>
    side ? `${side.lineNo}:${side.segments.map((segment) => segment.text).join('')}` : null;
  return rows.map((row) => [row.type, cell(row.left), cell(row.right)]);
}

describe('normalizeNewlines', () => {
  it('turns CRLF and lone CR into LF', () => {
    expect(normalizeNewlines('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });
});

describe('inlineSegments', () => {
  it('marks only the changed word on each side', () => {
    const { left, right } = inlineSegments('timeout = 30', 'timeout = 60');

    expect(left).toEqual([
      { text: 'timeout = ', changed: false },
      { text: '30', changed: true },
    ]);
    expect(right).toEqual([
      { text: 'timeout = ', changed: false },
      { text: '60', changed: true },
    ]);
  });

  it('reconstructs both original lines from their segments', () => {
    const { left, right } = inlineSegments('the quick brown fox', 'the slow brown dog');

    expect(left.map((segment) => segment.text).join('')).toBe('the quick brown fox');
    expect(right.map((segment) => segment.text).join('')).toBe('the slow brown dog');
  });
});

describe('sideBySide', () => {
  it('returns only "same" rows for identical text', () => {
    const result = sideBySide('a\nb', 'a\nb');

    expect(outline(result.rows)).toEqual([
      ['same', '1:a', '1:a'],
      ['same', '2:b', '2:b'],
    ]);
    expect(result.addedLines).toBe(0);
    expect(result.removedLines).toBe(0);
  });

  it('returns no rows for two empty texts', () => {
    expect(sideBySide('', '')).toEqual({ rows: [], addedLines: 0, removedLines: 0 });
  });

  it('shows a pure insertion as "added" rows with only a right cell', () => {
    const result = sideBySide('a\nc', 'a\nb\nc');

    expect(outline(result.rows)).toEqual([
      ['same', '1:a', '1:a'],
      ['added', null, '2:b'],
      ['same', '2:c', '3:c'],
    ]);
    expect(result.addedLines).toBe(1);
    expect(result.removedLines).toBe(0);
  });

  it('shows a pure deletion as "removed" rows with only a left cell', () => {
    const result = sideBySide('a\nb\nc', 'a\nc');

    expect(outline(result.rows)).toEqual([
      ['same', '1:a', '1:a'],
      ['removed', '2:b', null],
      ['same', '3:c', '2:c'],
    ]);
    expect(result.removedLines).toBe(1);
    expect(result.addedLines).toBe(0);
  });

  it('treats everything as added when the left side is empty', () => {
    const result = sideBySide('', 'x\ny');

    expect(outline(result.rows)).toEqual([
      ['added', null, '1:x'],
      ['added', null, '2:y'],
    ]);
  });

  it('pairs a replaced line into one "modified" row with word-level segments', () => {
    const result = sideBySide('host: a\nport: 80\n', 'host: a\nport: 8080\n');
    const modified = result.rows[1];

    expect(outline(result.rows)).toEqual([
      ['same', '1:host: a', '1:host: a'],
      ['modified', '2:port: 80', '2:port: 8080'],
    ]);
    expect(modified?.left?.segments).toContainEqual({ text: '80', changed: true });
    expect(modified?.right?.segments).toContainEqual({ text: '8080', changed: true });
    expect(modified?.left?.segments).toContainEqual({ text: 'port: ', changed: false });
    expect(result.addedLines).toBe(1);
    expect(result.removedLines).toBe(1);
  });

  it('pairs uneven replace blocks line by line and reports the surplus as added', () => {
    const result = sideBySide('keep\nold 1\nend', 'keep\nnew 1\nnew 2\nnew 3\nend');

    expect(outline(result.rows)).toEqual([
      ['same', '1:keep', '1:keep'],
      ['modified', '2:old 1', '2:new 1'],
      ['added', null, '3:new 2'],
      ['added', null, '4:new 3'],
      ['same', '3:end', '5:end'],
    ]);
    expect(result.removedLines).toBe(1);
    expect(result.addedLines).toBe(3);
  });

  it('reports the surplus of a longer removed block as removed', () => {
    const result = sideBySide('old 1\nold 2\nold 3\nend', 'new 1\nend');

    expect(outline(result.rows)).toEqual([
      ['modified', '1:old 1', '1:new 1'],
      ['removed', '2:old 2', null],
      ['removed', '3:old 3', null],
      ['same', '4:end', '2:end'],
    ]);
    expect(result.removedLines).toBe(3);
    expect(result.addedLines).toBe(1);
  });

  it('considers CRLF and LF versions of the same text equal', () => {
    const result = sideBySide('a\r\nb\r\n', 'a\nb\n');

    expect(result.rows.every((row) => row.type === 'same')).toBe(true);
    expect(result.rows).toHaveLength(2);
  });

  it('ignores a missing newline at the end of one side', () => {
    const result = sideBySide('a\nb\n', 'a\nb');

    expect(outline(result.rows)).toEqual([
      ['same', '1:a', '1:a'],
      ['same', '2:b', '2:b'],
    ]);
  });

  it('keeps blank lines as rows of their own', () => {
    const result = sideBySide('a\n\nb', 'a\n\nb');

    expect(outline(result.rows)).toEqual([
      ['same', '1:a', '1:a'],
      ['same', '2:', '2:'],
      ['same', '3:b', '3:b'],
    ]);
  });

  it('numbers lines independently on each side across several hunks', () => {
    const left = ['1', '2', '3', '4', '5', '6'].join('\n');
    const right = ['0', '1', '2', '4', '5', 'six', '7'].join('\n');

    const rows = sideBySide(left, right).rows;
    const leftNumbers = rows.flatMap((row) => (row.left ? [row.left.lineNo] : []));
    const rightNumbers = rows.flatMap((row) => (row.right ? [row.right.lineNo] : []));

    expect(leftNumbers).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rightNumbers).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
