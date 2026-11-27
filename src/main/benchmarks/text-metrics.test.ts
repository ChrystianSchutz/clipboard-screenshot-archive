import { describe, expect, it } from 'vitest';
import { characterErrorRate, levenshtein, normalizeWhitespace } from './text-metrics';

describe('levenshtein', () => {
  it('counts insertions, deletions and substitutions', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
  });

  it('treats a Polish letter as one character', () => {
    expect(levenshtein('źdźbło', 'zdzblo')).toBe(3);
  });
});

describe('characterErrorRate', () => {
  it('is 0 for a perfect read, whatever the line breaks and indentation', () => {
    expect(characterErrorRate('if (!ok) {\n  throw err;\n}', 'if (!ok) { throw err; }')).toBe(0);
  });

  it('is edits divided by the expected length', () => {
    expect(characterErrorRate('ECONNRESET', 'ECONNRESFT')).toBeCloseTo(0.1);
  });

  it('handles an empty reference', () => {
    expect(characterErrorRate('', '')).toBe(0);
    expect(characterErrorRate('', 'noise')).toBe(1);
  });
});

describe('normalizeWhitespace', () => {
  it('collapses whitespace runs and trims', () => {
    expect(normalizeWhitespace('  a \n\t b  ')).toBe('a b');
  });
});
