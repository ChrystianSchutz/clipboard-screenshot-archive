import { DatabaseSync } from 'node:sqlite';
import { compileUserRegex } from '@shared/user-regex';
import { migrate } from './migrations';

/**
 * Opens (and migrates) the history database.
 *
 * Uses Node's built-in `node:sqlite`, which ships inside Electron: no native module to rebuild
 * per Electron ABI, no prebuilt binaries to download, nothing to unpack from the asar archive.
 *
 * @param location file path, or `':memory:'` for tests
 */
export function openDatabase(location: string): DatabaseSync {
  const db = new DatabaseSync(location);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 2000;
  `);
  registerFunctions(db);
  migrate(db);
  return db;
}

/**
 * Opens the history read-only, for the regex search worker (src/main/search/regex-worker.ts).
 * WAL mode lets it read while the main connection writes. It is the only connection with
 * `REGEXP`, so a user regex can never run on the main thread.
 */
export function openReadOnlyDatabase(location: string): DatabaseSync {
  const db = new DatabaseSync(location, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 2000;');
  registerFunctions(db);
  registerRegexFunction(db);
  return db;
}

/**
 * `x REGEXP y` (SQLite calls `regexp(y, x)`): user regex search, compiled once per pattern.
 * A catastrophic pattern can run for seconds, so only the worker's connection registers it.
 */
export function registerRegexFunction(db: DatabaseSync): void {
  let cachedPattern: string | null = null;
  let cachedRegex: RegExp | null = null;

  db.function('regexp', { deterministic: true }, (pattern, value) => {
    if (typeof pattern !== 'string' || typeof value !== 'string') return 0;
    if (pattern !== cachedPattern) {
      const compiled = compileUserRegex(pattern);
      cachedPattern = pattern;
      cachedRegex = compiled.ok ? compiled.regex : null;
    }
    return cachedRegex?.test(value) ? 1 : 0;
  });
}

/**
 * `ci_contains(haystack, needle)`: Unicode-aware case-insensitive substring match.
 * SQLite's own `LIKE`/`lower()` only fold ASCII, so "ŁÓDŹ" would not match "łódź".
 */
function registerFunctions(db: DatabaseSync): void {
  db.function('ci_contains', { deterministic: true }, (haystack, needle) => {
    if (typeof haystack !== 'string' || typeof needle !== 'string') return 0;
    return haystack.toLocaleLowerCase().includes(needle) ? 1 : 0;
  });
}

/** Runs `work` inside a transaction; rolls back and rethrows if it throws. */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
