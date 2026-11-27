import { describe, expect, it } from 'vitest';
import {
  compactNumber,
  countLines,
  domainOf,
  firstLine,
  joinedLength,
  joinTexts,
  pluralize,
} from './text';

describe('countLines', () => {
  it('returns 0 for empty text', () => {
    expect(countLines('')).toBe(0);
  });

  it('returns 1 for a single line without a newline', () => {
    expect(countLines('hello')).toBe(1);
  });

  it('treats LF, CRLF and lone CR as one line break each', () => {
    expect(countLines('a\nb\r\nc\rd')).toBe(4);
  });

  it('counts the empty line after a trailing newline', () => {
    expect(countLines('a\n')).toBe(2);
  });
});

describe('firstLine', () => {
  it('returns the first non-blank line', () => {
    expect(firstLine('\n   \r\n  second line\nthird')).toBe('second line');
  });

  it('collapses runs of whitespace, including tabs, into single spaces', () => {
    expect(firstLine('  a\t\tb    c  ')).toBe('a b c');
  });

  it('returns an empty string for blank content', () => {
    expect(firstLine(' \n\t\n')).toBe('');
  });

  it('keeps a line that is exactly maxLength long', () => {
    expect(firstLine('abcde', 5)).toBe('abcde');
  });

  it('truncates a longer line to maxLength characters, ending in an ellipsis', () => {
    expect(firstLine('abcdefgh', 5)).toBe('abcd…');
  });

  it('defaults to 160 characters', () => {
    expect(firstLine('x'.repeat(500))).toHaveLength(160);
  });
});

describe('compactNumber', () => {
  it.each([
    [0, '0'],
    [842, '842'],
    [999, '999'],
    [1000, '1k'],
    [1234, '1.2k'],
    [9999, '10k'],
    [10_000, '10k'],
    [48_400, '48k'],
    [1_000_000, '1M'],
    [1_340_000, '1.3M'],
    [25_000_000, '25M'],
  ])('renders %d as %s', (value, expected) => {
    expect(compactNumber(value)).toBe(expected);
  });
});

describe('pluralize', () => {
  it('uses the singular for exactly one', () => {
    expect(pluralize(1, 'clip')).toBe('1 clip');
  });

  it.each([0, 2, 1000])('uses the default "s" plural for %d', (count) => {
    expect(pluralize(count, 'clip')).toBe(`${count} clips`);
  });

  it('accepts an irregular plural', () => {
    expect(pluralize(3, 'entry', 'entries')).toBe('3 entries');
  });
});

describe('domainOf', () => {
  it('returns the host name without "www."', () => {
    expect(domainOf('https://www.example.com/path?q=1')).toBe('example.com');
  });

  it('lower-cases the host, as URL parsing does', () => {
    expect(domainOf('http://WWW.Example.COM')).toBe('example.com');
  });

  it('keeps other subdomains and ignores the port', () => {
    expect(domainOf('https://docs.python.org:8443/3/')).toBe('docs.python.org');
  });

  it('only strips a leading "www.", not "www2." or an inner "www."', () => {
    expect(domainOf('https://www2.example.com')).toBe('www2.example.com');
    expect(domainOf('https://a.www.example.com')).toBe('a.www.example.com');
  });

  it.each(['ftp://example.com/file', 'file:///C:/temp/a.txt', 'mailto:me@example.com'])(
    'returns null for the non-http URL %s',
    (url) => {
      expect(domainOf(url)).toBeNull();
    },
  );

  it.each(['', 'example.com', 'not a url'])(
    'returns null for the unparsable string "%s"',
    (url) => {
      expect(domainOf(url)).toBeNull();
    },
  );
});

describe('joinTexts and joinedLength', () => {
  it('joins in order, one text per line', () => {
    expect(joinTexts(['first', 'second\nline', 'third'])).toBe('first\nsecond\nline\nthird');
    expect(joinTexts([])).toBe('');
  });

  it('measures the joined text without building it', () => {
    for (const texts of [[], ['a'], ['ab', '', 'cde'], ['x'.repeat(10), 'y']]) {
      expect(joinedLength(texts.map((text) => text.length))).toBe(joinTexts(texts).length);
    }
  });
});
