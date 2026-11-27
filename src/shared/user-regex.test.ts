import { describe, expect, it } from 'vitest';
import { compileUserRegex, MAX_PATTERN_LENGTH } from './user-regex';

describe('compileUserRegex', () => {
  it('compiles a valid pattern as a case-insensitive regex', () => {
    const result = compileUserRegex('err(or)?\\s+\\d{3}');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.regex.flags).toBe('i');
    expect(result.regex.test('ERROR 404')).toBe(true);
  });

  it('compiles without the global flag, so repeated test() calls are stateless', () => {
    const result = compileUserRegex('a');
    if (!result.ok) throw new Error(result.error);

    expect([result.regex.test('a'), result.regex.test('a')]).toEqual([true, true]);
  });

  it('rejects an empty pattern', () => {
    expect(compileUserRegex('')).toEqual({ ok: false, error: 'Empty pattern' });
  });

  it(`accepts a pattern of exactly ${MAX_PATTERN_LENGTH} characters`, () => {
    expect(compileUserRegex('a'.repeat(MAX_PATTERN_LENGTH)).ok).toBe(true);
  });

  it('rejects a pattern one character over the limit', () => {
    expect(compileUserRegex('a'.repeat(MAX_PATTERN_LENGTH + 1))).toEqual({
      ok: false,
      error: `Pattern is longer than ${MAX_PATTERN_LENGTH} characters`,
    });
  });

  describe('catastrophic backtracking guard', () => {
    it.each(['(a+)+', '(\\w*)*', '(x+)*y', '(ab{2,})+', '(a{1,3}){2}', '(\\d+) +', '(?:a+)+'])(
      'rejects the nested quantifier %s',
      (pattern) => {
        expect(compileUserRegex(pattern)).toEqual({
          ok: false,
          error: 'Nested quantifiers like (a+)+ are not allowed',
        });
      },
    );

    it.each(['(abc)+', '(a+)b+', 'a+b*', '(\\d{4})-(\\d{2})', '\\(a+\\)+'])(
      'allows the safe pattern %s',
      (pattern) => {
        expect(compileUserRegex(pattern).ok).toBe(true);
      },
    );
  });

  it('returns the engine message without the redundant "Invalid regular expression" prefix', () => {
    const result = compileUserRegex('(unclosed');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toMatch(/^Invalid regular expression/);
    expect(result.error).toMatch(/unterminated group/i);
  });

  it.each(['[a-', '*abc', 'a{2,1}'])(
    'reports %s as invalid syntax instead of throwing',
    (pattern) => {
      expect(compileUserRegex(pattern).ok).toBe(false);
    },
  );
});
