import { describe, expect, it } from 'vitest';
import { CATEGORIES, CATEGORY_LABELS, detectCategories, isCategory } from './categories';

describe('detectCategories', () => {
  it.each(['', '   \r\n\t'])('returns no categories for blank text %j', (content) => {
    expect(detectCategories(content, 'text')).toEqual([]);
  });

  it('returns no categories for ordinary prose', () => {
    expect(detectCategories('Thanks, see you tomorrow at the office.', 'text')).toEqual([]);
  });

  describe('secret', () => {
    it.each([
      [
        'a PEM private key',
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
      ],
      [
        'a JWT',
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      ],
      ['a GitHub token', `ghp_${'a1B2c3D4e5'.repeat(4)}`],
      ['an AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
      ['a Stripe live key', `sk_live_${'4eC39HqLyjWDarjt'.repeat(2)}`],
      ['an API key inside a config line', `OPENAI_API_KEY=sk-proj-${'x1y2z3'.repeat(5)}`],
    ])('detects %s', (_label, content) => {
      expect(detectCategories(content, 'text')).toContain('secret');
    });

    it('does not flag short look-alikes', () => {
      expect(detectCategories('sk-short and AKIA123', 'text')).not.toContain('secret');
    });
  });

  describe('error', () => {
    it.each([
      [
        'a Python traceback',
        'Traceback (most recent call last):\n  File "app.py", line 3, in <module>',
      ],
      ['a JavaScript stack trace', 'TypeError: x is undefined\n    at render (app.js:10:5)'],
      [
        'a Java exception',
        'java.lang.NullPointerException\n    at com.acme.Main.run(Main.java:42)',
      ],
      ['a Go panic', 'panic: runtime error: index out of range'],
      ['a Rust compiler error', 'error[E0308]: mismatched types'],
      ['a bare exception name', 'IllegalStateException'],
    ])('detects %s', (_label, content) => {
      expect(detectCategories(content, 'text')).toContain('error');
    });

    it('does not flag prose that merely mentions errors', () => {
      expect(detectCategories('No errors were found in the build.', 'text')).not.toContain('error');
    });
  });

  describe('sql', () => {
    it.each([
      'SELECT id, name FROM users WHERE id = 1',
      'select *\nfrom orders',
      'INSERT INTO t (a) VALUES (1)',
      'UPDATE users SET name = 1',
      'WITH recent AS (SELECT 1) SELECT * FROM recent',
      'CREATE UNIQUE INDEX i ON t (a)',
    ])('detects %j', (content) => {
      expect(detectCategories(content, 'code')).toContain('sql');
    });

    it('requires the full statement shape, not just a keyword', () => {
      expect(detectCategories('Select the best option', 'text')).not.toContain('sql');
    });

    it('only matches statements at the start of the text', () => {
      expect(detectCategories('Run this: SELECT 1 FROM t', 'text')).not.toContain('sql');
    });
  });

  describe('command', () => {
    it.each([
      'npm install zod',
      '$ git status',
      'docker compose up -d',
      'PS C:\\Users\\me> winget install Git.Git',
    ])('detects %j', (content) => {
      expect(detectCategories(content, 'text')).toContain('command');
    });

    it('ignores scripts longer than three lines', () => {
      expect(
        detectCategories('npm ci\nnpm test\nnpm run build\nnpm run lint', 'code'),
      ).not.toContain('command');
    });

    it('requires an argument after the program name', () => {
      expect(detectCategories('git', 'text')).not.toContain('command');
    });
  });

  describe('single-line values', () => {
    it.each([
      ['an email address', 'ada.lovelace+news@example.co.uk', ['email']],
      ['a Windows path', 'C:\\Users\\me\\Documents\\report.docx', ['path']],
      ['a UNC path', '\\\\fileserver\\share\\notes.txt', ['path']],
      ['an absolute Unix path', '/usr/local/bin/node', ['path']],
      ['a home-relative path', '~/projects/app/', ['path']],
      ['a relative path', './src/index.ts', ['path']],
      ['a UUID', '123e4567-e89b-42d3-a456-426614174000', ['uuid']],
      ['an IPv4 address', '192.168.0.1', ['ip']],
      ['an IPv4 address with port', '10.0.0.1:8080', ['ip']],
      ['a CIDR block', '10.0.0.0/8', ['ip']],
      ['a short hex color', '#fff', ['color']],
      ['a long hex color', '#1E90FFCC', ['color']],
      ['an rgb() color', 'rgb(30, 144, 255)', ['color']],
      ['an oklch() color', 'oklch(70% 0.1 200)', ['color']],
      ['an integer', '42', ['number']],
      ['a negative decimal', '-3.14', ['number']],
      ['a number with thousands separators', '1,234,567', ['number']],
      ['a number with space separators and a decimal comma', '12 345,67', ['number']],
      ['a percentage', '15%', ['number']],
      ['scientific notation', '6.02e23', ['number']],
    ])('detects %s', (_label, content, expected) => {
      expect(detectCategories(content, 'text')).toEqual(expected);
    });

    it.each([
      ['an email inside a sentence', 'write to ada@example.com today'],
      ['an email on one of two lines', 'Ada\nada@example.com'],
      ['an out-of-range IP octet', '256.1.1.1'],
      ['a 5-digit hex color', '#12345'],
      ['a non-hex color', '#ggg'],
      ['a version number', '1.2.3'],
      ['digits followed by letters', '12abc'],
      ['a path with an illegal character', 'C:\\temp\\a|b'],
    ])('does not tag %s', (_label, content) => {
      expect(detectCategories(content, 'text')).toEqual([]);
    });

    it('finds a UUID inside a longer text', () => {
      expect(
        detectCategories('request 123e4567-e89b-42d3-a456-426614174000 failed', 'text'),
      ).toEqual(['uuid']);
    });

    it('does not tag a UUID that is part of a URL', () => {
      expect(
        detectCategories('https://example.com/orders/123e4567-e89b-42d3-a456-426614174000', 'url'),
      ).not.toContain('uuid');
    });
  });

  describe('markdown', () => {
    it('detects text with at least two markdown lines', () => {
      expect(detectCategories('# Plan\n\n- [ ] write tests\n- [x] ship', 'text')).toContain(
        'markdown',
      );
    });

    it('detects a markdown table', () => {
      expect(detectCategories('| a | b |\n| - | - |\n| 1 | 2 |', 'text')).toContain('markdown');
    });

    it('detects inline links on two lines', () => {
      expect(
        detectCategories('See [docs](https://a.example)\nand [api](https://b.example)', 'text'),
      ).toContain('markdown');
    });

    it('needs more than one markdown line', () => {
      expect(detectCategories('# Just a heading', 'text')).not.toContain('markdown');
    });

    it('only applies to plain text clips', () => {
      expect(detectCategories('# comment\n# another comment', 'code')).not.toContain('markdown');
    });
  });

  describe('html', () => {
    it('detects an HTML fragment', () => {
      expect(detectCategories('<div class="card"><p>Hi</p></div>', 'text')).toEqual(['html']);
    });

    it('detects a full document', () => {
      expect(detectCategories('<!DOCTYPE html>\n<html><body></body></html>', 'code')).toContain(
        'html',
      );
    });

    it('ignores unknown tags and comparison operators', () => {
      expect(detectCategories('<custom-widget></custom-widget>', 'text')).not.toContain('html');
      expect(detectCategories('a < b > c', 'text')).not.toContain('html');
    });
  });

  it('returns several categories in the fixed CATEGORIES order', () => {
    const content = 'SELECT * FROM users WHERE id = 1\nError: relation "users" does not exist';

    expect(detectCategories(content, 'code')).toEqual(['error', 'sql']);
  });

  it('only scans the first 20 000 characters of huge clips', () => {
    const content = `${'lorem ipsum '.repeat(2000)}AKIAIOSFODNN7EXAMPLE`;

    expect(content.length).toBeGreaterThan(20_000);
    expect(detectCategories(content, 'text')).not.toContain('secret');
  });
});

describe('isCategory', () => {
  it('accepts every known category', () => {
    expect(CATEGORIES.every((category) => isCategory(category))).toBe(true);
  });

  it.each(['Secret', 'image', '', 'toString'])('rejects %j', (value) => {
    expect(isCategory(value)).toBe(false);
  });
});

describe('CATEGORY_LABELS', () => {
  it('has a non-empty label for every category', () => {
    expect(Object.keys(CATEGORY_LABELS).sort()).toEqual([...CATEGORIES].sort());
    expect(Object.values(CATEGORY_LABELS).every((label) => label.length > 0)).toBe(true);
  });
});
