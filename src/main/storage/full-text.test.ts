import { describe, expect, it } from 'vitest';
import { ftsMatchExpression, MIN_INDEXED_TERM_LENGTH, splitSearchTerms } from './full-text';

describe('splitSearchTerms', () => {
  it(`sends words of ${String(MIN_INDEXED_TERM_LENGTH)}+ characters to the index and shorter ones to the scan`, () => {
    expect(splitSearchTerms('go to docs.python timeout')).toEqual({
      indexed: ['docs.python', 'timeout'],
      short: ['go', 'to'],
    });
  });

  it('lower-cases every word, including non-ASCII letters', () => {
    expect(splitSearchTerms('ŁÓDŹ Ål')).toEqual({ indexed: ['łódź'], short: ['ål'] });
  });

  it('counts characters, not UTF-16 code units', () => {
    // Two emoji are four code units but only two characters: too short for a trigram.
    expect(splitSearchTerms('👍👍')).toEqual({ indexed: [], short: ['👍👍'] });
  });

  it('ignores extra whitespace and repeated words', () => {
    expect(splitSearchTerms('  error\terror \n a a ')).toEqual({
      indexed: ['error'],
      short: ['a'],
    });
  });

  it('returns nothing for blank input', () => {
    expect(splitSearchTerms('   ')).toEqual({ indexed: [], short: [] });
  });
});

describe('ftsMatchExpression', () => {
  it('quotes every term so all of them are required, as literal phrases', () => {
    expect(ftsMatchExpression(['timeout', 'or', 'a*b'])).toBe('"timeout" "or" "a*b"');
  });

  it('escapes double quotes by doubling them', () => {
    expect(ftsMatchExpression(['say"hi"'])).toBe('"say""hi"""');
  });
});
