import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, registerRegexFunction, transaction } from './database';
import { MIGRATIONS, schemaVersion } from './migrations';

describe('openDatabase', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openDatabase(':memory:');
    registerRegexFunction(db); // in the app only the search worker's connection has REGEXP
  });

  afterEach(() => {
    db.close();
  });

  /** Evaluates one SQL expression with bound parameters. */
  function evaluate(expression: string, ...params: (string | null)[]): unknown {
    const row = db.prepare(`SELECT ${expression} AS v`).get(...params) as { v: unknown };
    return row.v;
  }

  it('returns a fully migrated database', () => {
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
  });

  it('enables foreign key enforcement', () => {
    expect(evaluate('(SELECT foreign_keys FROM pragma_foreign_keys)')).toBe(1);
  });

  describe('REGEXP', () => {
    it('matches case-insensitively', () => {
      expect(evaluate("'Connection TIMEOUT after 30s' REGEXP ?", 'timeout\\s+after')).toBe(1);
    });

    it('returns 0 when the pattern does not match', () => {
      expect(evaluate("'hello' REGEXP ?", '^world')).toBe(0);
    });

    it('returns 0 instead of throwing for invalid syntax', () => {
      expect(evaluate("'abc' REGEXP ?", '(unclosed')).toBe(0);
    });

    it('returns 0 for patterns rejected by the backtracking guard', () => {
      expect(evaluate("'aaaa' REGEXP ?", '(a+)+')).toBe(0);
    });

    it('returns 0 for NULL operands', () => {
      expect(evaluate('NULL REGEXP ?', 'a')).toBe(0);
      expect(evaluate("'a' REGEXP ?", null)).toBe(0);
    });

    it('uses the new pattern when it changes between calls (no stale cache)', () => {
      expect(evaluate("'abc' REGEXP ?", 'b')).toBe(1);
      expect(evaluate("'abc' REGEXP ?", 'x')).toBe(0);
      expect(evaluate("'abc' REGEXP ?", 'b')).toBe(1);
    });

    it('evaluates each row against the same pattern', () => {
      const rows = db
        .prepare(
          "SELECT v FROM (SELECT 'apple' AS v UNION ALL SELECT 'Banana' UNION ALL SELECT 'cherry') WHERE v REGEXP ? ORDER BY v",
        )
        .all('an') as { v: string }[];

      expect(rows.map((row) => row.v)).toEqual(['Banana']);
    });
  });

  describe('ci_contains', () => {
    it('finds a lower-case needle in mixed-case ASCII', () => {
      expect(evaluate('ci_contains(?, ?)', 'Hello World', 'world')).toBe(1);
    });

    it('folds Polish letters, which SQLite lower() and LIKE do not', () => {
      expect(evaluate('ci_contains(?, ?)', 'ZAŻÓŁĆ GĘŚLĄ JAŹŃ', 'gęślą')).toBe(1);
      expect(evaluate("lower('ŁÓDŹ') = 'łódź'")).toBe(0);
    });

    it('expects the caller to lower-case the needle', () => {
      expect(evaluate('ci_contains(?, ?)', 'łódź', 'ŁÓDŹ')).toBe(0);
    });

    it('returns 0 when the needle is absent', () => {
      expect(evaluate('ci_contains(?, ?)', 'abc', 'abd')).toBe(0);
    });

    it('matches an empty needle', () => {
      expect(evaluate('ci_contains(?, ?)', 'anything', '')).toBe(1);
    });

    it('returns 0 for NULL operands', () => {
      expect(evaluate('ci_contains(?, ?)', null, 'a')).toBe(0);
    });
  });
});

describe('transaction', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  const settingsCount = (): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number }).n;

  it('commits the work and returns its result', () => {
    const result = transaction(db, () => {
      db.prepare("INSERT INTO settings (key, value) VALUES ('a', '1')").run();
      return 'done';
    });

    expect(result).toBe('done');
    expect(settingsCount()).toBe(1);
  });

  it('rolls back every statement and rethrows the original error', () => {
    const failure = new Error('boom');

    expect(() =>
      transaction(db, () => {
        db.prepare("INSERT INTO settings (key, value) VALUES ('a', '1')").run();
        throw failure;
      }),
    ).toThrow(failure);
    expect(settingsCount()).toBe(0);
  });

  it('leaves the connection usable for a new transaction after a rollback', () => {
    expect(() =>
      transaction(db, () => {
        throw new Error('first');
      }),
    ).toThrow('first');

    transaction(db, () => db.prepare("INSERT INTO settings (key, value) VALUES ('b', '2')").run());

    expect(settingsCount()).toBe(1);
  });
});
