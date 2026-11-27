import { describe, expect, it } from 'vitest';
import { detectClipKind } from './clip-kind';

describe('detectClipKind', () => {
  describe('json', () => {
    it.each([
      ['an object', '{"id": 1, "tags": ["a"]}'],
      ['an array', '[1, 2, 3]'],
      ['an empty object', '{}'],
      ['pretty-printed JSON with CRLF and padding', '  {\r\n  "a": 1\r\n}\r\n'],
    ])('detects %s', (_label, content) => {
      expect(detectClipKind(content)).toBe('json');
    });

    it.each([
      ['a JSON string literal', '"just a string"'],
      ['a JSON number', '42'],
      ['null', 'null'],
    ])('does not badge %s as json (only containers count)', (_label, content) => {
      expect(detectClipKind(content)).toBe('text');
    });

    it('falls back to other heuristics when braces do not parse', () => {
      expect(detectClipKind('{ not json')).toBe('text');
    });
  });

  describe('url', () => {
    it.each(['https://example.com', 'http://localhost:3000/api?q=1#top', 'HTTPS://EXAMPLE.COM/X'])(
      'detects %s',
      (content) => {
        expect(detectClipKind(content)).toBe('url');
      },
    );

    it('detects a URL with surrounding whitespace', () => {
      expect(detectClipKind('  https://example.com/path \n')).toBe('url');
    });

    it.each([
      ['a URL inside a sentence', 'see https://example.com for details'],
      ['a non-http scheme', 'ftp://example.com/file'],
      ['a scheme-less domain', 'example.com'],
      ['two URLs on two lines', 'https://a.example\nhttps://b.example'],
    ])('does not treat %s as a url', (_label, content) => {
      expect(detectClipKind(content)).not.toBe('url');
    });
  });

  describe('code', () => {
    it('detects multi-line code with semicolons and braces', () => {
      expect(detectClipKind('const a = 1;\nfunction f() {\n  return a;\n}')).toBe('code');
    });

    it('detects Python by its keywords', () => {
      expect(detectClipKind('def total(items):\n    return sum(items)')).toBe('code');
    });

    it('detects SQL by its leading keyword', () => {
      expect(detectClipKind('SELECT id, name\nFROM users\nWHERE id = 1')).toBe('code');
    });

    it('badges as code when exactly 30% of lines look like code', () => {
      const lines = [
        'const x = 1;',
        'let y = 2;',
        'return x;',
        ...Array<string>(7).fill('plain words'),
      ];

      expect(detectClipKind(lines.join('\n'))).toBe('code');
    });

    it('stays text when fewer than 30% of lines look like code', () => {
      const lines = ['const x = 1;', 'let y = 2;', ...Array<string>(8).fill('plain words')];

      expect(detectClipKind(lines.join('\n'))).toBe('text');
    });

    it('never badges a single line as code', () => {
      expect(detectClipKind('const answer = 42;')).toBe('text');
    });

    it('does not match keywords that are only a prefix of a longer word', () => {
      expect(detectClipKind('important notes\nformal letter')).toBe('text');
    });
  });

  describe('prose that ends lines with `;` (regression)', () => {
    it.each([
      [
        'a Polish to-do list copied from a terminal',
        [
          '- Ty: wyloguj główny login IBKR z innych urządzeń i zaloguj się ponownie do TWS paper.',
          '- Ja, po Twoim sygnale: optlab doctor i ponowny start rejestratora.',
          '- Ja, po 16:30:',
          '  a. podział League na grupy i trafność kierunku;',
          '  b. tor equity_news;',
        ].join('\n'),
      ],
      [
        'a Markdown bullet list',
        [
          '* Buy milk, eggs and fresh bread;',
          '* Call the dentist about Tuesday;',
          '* Book train tickets for the weekend;',
          '  - compare prices on both sites first;',
        ].join('\n'),
      ],
      [
        'an English numbered plan with sub-items',
        [
          '1. Me: restart the staging server and clear the cache;',
          '2. You, after my signal: run the migration script again;',
          '3. Both of us, after 5 pm:',
          '   a. review the error log for regressions;',
          '   b. update the release notes;',
        ].join('\r\n'),
      ],
    ])('keeps %s as text', (_label, content) => {
      expect(detectClipKind(content)).toBe('text');
    });
  });

  describe('code that still comes out as code', () => {
    it.each([
      [
        'JavaScript with a JSDoc block of `*` lines',
        [
          '/**',
          ' * Adds two numbers and returns the result;',
          ' * @param a first number',
          ' */',
          'function add(a, b) {',
          '  return a + b;',
          '}',
        ].join('\n'),
      ],
      [
        'a Python list comprehension',
        'def squares(nums):\n    return [n * n for n in nums if n > 0]',
      ],
      [
        'a YAML flow-style list',
        'ports:\n  - { name: http, port: 80 }\n  - { name: https, port: 443 }',
      ],
      [
        'SQL with trailing semicolons',
        'SELECT id, name\nFROM users\nWHERE active = 1\nORDER BY name;',
      ],
      ['a shell loop with flags', 'set -euo pipefail;\nfor f in *.log; do\n  gzip -9 "$f";\ndone'],
      [
        'C# with usings and an expression body',
        [
          'using System;',
          'using System.Collections.Generic;',
          'public class Greeter',
          '{',
          '    public string Hello(string name) => $"Hi {name}";',
          '}',
        ].join('\n'),
      ],
      [
        'C statements that start with `*` and `-`',
        'int total = 0;\n*ptr = total;\n-- count;\nfree(ptr);',
      ],
    ])('detects %s', (_label, content) => {
      expect(detectClipKind(content)).toBe('code');
    });

    it('still counts a keyword line as code even when it reads like words', () => {
      expect(detectClipKind('import os, sys\nprint(sys.argv)')).toBe('code');
    });
  });

  describe('text', () => {
    it.each([
      ['an empty string', ''],
      ['whitespace only', ' \n\t '],
      ['a sentence', 'Hello, world'],
      ['multi-line prose', 'Dear team,\nthanks for the update.\nBest regards'],
    ])('classifies %s as text', (_label, content) => {
      expect(detectClipKind(content)).toBe('text');
    });
  });
});
