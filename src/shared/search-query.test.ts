import { describe, expect, it } from 'vitest';
import { parseSearch, removeOperator, resolveApp, type ParsedSearch } from './search-query';

const EMPTY: ParsedSearch = { text: '', app: null, kind: null, category: null, pinned: false };

describe('parseSearch', () => {
  it('returns plain text unchanged when there are no operators', () => {
    expect(parseSearch('connection timeout')).toEqual({ ...EMPTY, text: 'connection timeout' });
  });

  it('returns an empty result for empty input', () => {
    expect(parseSearch('')).toEqual(EMPTY);
  });

  it('extracts app:, #category and leaves the remaining words as text', () => {
    expect(parseSearch('timeout app:chrome #error')).toEqual({
      ...EMPTY,
      text: 'timeout',
      app: 'chrome',
      category: 'error',
    });
  });

  it('accepts a quoted app name with spaces', () => {
    expect(parseSearch('app:"VS Code" kind:json is:pinned')).toEqual({
      ...EMPTY,
      app: 'VS Code',
      kind: 'json',
      pinned: true,
    });
  });

  it('keeps the app name as typed, without changing its case', () => {
    expect(parseSearch('app:Chrome').app).toBe('Chrome');
  });

  it('extracts operators from the middle of the text and tidies the spacing', () => {
    expect(parseSearch('  retry   kind:code   policy  ')).toEqual({
      ...EMPTY,
      text: 'retry policy',
      kind: 'code',
    });
  });

  it.each([
    ['is:url', { kind: 'url' }],
    ['is:sql', { category: 'sql' }],
    ['is:pinned', { pinned: true }],
    ['cat:email', { category: 'email' }],
  ] as const)('understands %s', (input, expected) => {
    expect(parseSearch(input)).toEqual({ ...EMPTY, ...expected });
  });

  it('treats operator keys and values case-insensitively', () => {
    expect(parseSearch('KIND:JSON Cat:SQL #Error')).toEqual({
      ...EMPTY,
      kind: 'json',
      category: 'error',
    });
  });

  it('lets the last operator of a kind win', () => {
    expect(parseSearch('kind:json kind:url').kind).toBe('url');
  });

  it.each([
    ['a URL', 'http://localhost:3000'],
    ['an unknown key', 'a:b'],
    ['an unknown kind', 'kind:video'],
    ['an unknown category', 'cat:invoice'],
    ['an unknown hashtag', '#todo'],
    ['an unknown is: value', 'is:starred'],
    ['an empty app name', 'app:""'],
  ])('keeps %s as part of the text', (_label, input) => {
    expect(parseSearch(input)).toEqual({ ...EMPTY, text: input });
  });

  it('only recognises operators at the start of a word', () => {
    expect(parseSearch('issue#error myapp:chrome')).toEqual({
      ...EMPTY,
      text: 'issue#error myapp:chrome',
    });
  });

  it('does not treat an operator glued to following text as an operator', () => {
    expect(parseSearch('#error,').category).toBeNull();
  });
});

describe('resolveApp', () => {
  const apps = ['Chrome Canary', 'Chrome', 'VS Code', 'Visual Studio', 'Command Prompt'];

  it('prefers an exact match, ignoring case', () => {
    expect(resolveApp('chrome', apps)).toBe('Chrome');
  });

  it('falls back to the first app that starts with the typed text', () => {
    expect(resolveApp('vs', apps)).toBe('VS Code');
  });

  it('prefers a prefix match over an earlier substring match', () => {
    expect(resolveApp('co', apps)).toBe('Command Prompt');
  });

  it('falls back to the first app that contains the typed text', () => {
    expect(resolveApp('studio', apps)).toBe('Visual Studio');
  });

  it('returns null when nothing matches', () => {
    expect(resolveApp('slack', apps)).toBeNull();
  });

  it('returns null for an empty app list', () => {
    expect(resolveApp('chrome', [])).toBeNull();
  });
});

describe('removeOperator', () => {
  it('removes only the operators that set the given filter and keeps the rest as typed', () => {
    const input = 'timeout #sql app:"VS Code" is:pinned kind:json';

    expect(removeOperator(input, 'category')).toBe('timeout app:"VS Code" is:pinned kind:json');
    expect(removeOperator(input, 'app')).toBe('timeout #sql is:pinned kind:json');
    expect(removeOperator(input, 'pinned')).toBe('timeout #sql app:"VS Code" kind:json');
    expect(removeOperator(input, 'kind')).toBe('timeout #sql app:"VS Code" is:pinned');
  });

  it('removes every spelling of the same filter (#sql, cat:sql, is:sql)', () => {
    expect(removeOperator('#sql a cat:error b is:email', 'category')).toBe('a b');
  });

  it('leaves look-alike tokens that are not operators untouched', () => {
    expect(removeOperator('#nope is:big http://x', 'category')).toBe('#nope is:big http://x');
  });

  it('round-trips with parseSearch: the removed filter is gone, the others stay', () => {
    const after = parseSearch(removeOperator('err #error app:chrome', 'category'));

    expect(after).toEqual({ ...EMPTY, text: 'err', app: 'chrome' });
  });
});
