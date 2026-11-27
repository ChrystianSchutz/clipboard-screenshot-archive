import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectCategories } from '@shared/categories';
import { detectClipKind } from '@shared/clip-kind';
import type { HistoryQuery } from '@shared/types';
import { ClipRepository, hashContent } from './clip-repository';
import { openDatabase, registerRegexFunction, transaction } from './database';

/**
 * Performance sanity check: 50k clips, then the queries people actually type.
 *
 * Budgets are generous (a slow CI machine must not flake), the numbers are printed so a
 * regression is visible long before it breaks a budget. Seeding takes seconds, so it only runs
 * when asked for: `npm run test:bench` (vitest `--mode bench`) or with `BENCH=1` set.
 */
const CLIP_COUNT = 50_000;
/** Well below the search box debounce (120 ms) plus a frame, even on a slow CI runner. */
const BUDGET_MS = 100;
const RUNS = 15;

const WORDS = `request response timeout error handler user account invoice payment order customer
  session token cache server client deploy build release branch commit merge review config value
  report meeting budget project status update schedule review draft design layout button color
  database query index table column migration backup restore network socket proxy gateway`
  .split(/\s+/)
  .filter(Boolean);
const APPS = ['Chrome', 'VS Code', 'Slack', 'Terminal', 'Outlook', 'DBeaver', 'Notepad', 'Edge'];

/** Small deterministic PRNG (mulberry32), so every run seeds the same history. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeClip(i: number, next: () => number): string {
  const pick = (list: readonly string[]): string => list[Math.floor(next() * list.length)] ?? '';
  const sentence = (length: number): string => Array.from({ length }, () => pick(WORDS)).join(' ');
  switch (i % 10) {
    case 0:
      return `SELECT id, ${pick(WORDS)} FROM ${pick(WORDS)}s WHERE ${pick(WORDS)}_id = ${String(i)}`;
    case 1:
      return `https://docs.example.com/${pick(WORDS)}/${pick(WORDS)}?id=${String(i)}`;
    case 2:
      return `{"${pick(WORDS)}":${String(i)},"${pick(WORDS)}":"${sentence(3)}"}`;
    case 3:
      return `user${String(i)}@example.com`;
    case 4:
      return `Error: ${sentence(4)} failed\n    at handler (src/${pick(WORDS)}.ts:${String(i % 300)}:7)`;
    default:
      return `${sentence(8 + Math.floor(next() * 60))} #${String(i)}`;
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const BENCH = import.meta.env.MODE === 'bench' || process.env.BENCH === '1';

describe.runIf(BENCH)(`search performance with ${CLIP_COUNT.toLocaleString('en-US')} clips`, () => {
  let db: DatabaseSync;
  let repo: ClipRepository;
  const report: string[] = [];

  beforeAll(() => {
    db = openDatabase(':memory:');
    registerRegexFunction(db); // in the app only the search worker's connection has REGEXP
    repo = new ClipRepository(db);
    const next = random(42);
    const insertClip = db.prepare(
      `INSERT INTO clips (content, content_hash, kind, char_count, line_count, first_copied_at,
         last_copied_at, source_app)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    );
    const insertCategory = db.prepare(
      'INSERT INTO clip_categories (clip_id, category) VALUES (?, ?)',
    );
    const insertEvent = db.prepare(
      'INSERT INTO copy_events (clip_id, copied_at, source_app) VALUES (?, ?, ?)',
    );
    const start = performance.now();
    // One transaction, raw inserts: the FTS triggers still fire for every row, as in real capture.
    transaction(db, () => {
      for (let i = 0; i < CLIP_COUNT; i++) {
        const content = makeClip(i, next);
        const kind = detectClipKind(content);
        const at = 1_700_000_000_000 + i * 1000;
        const app = APPS[i % APPS.length] ?? null;
        const id = Number(
          insertClip.run(content, hashContent(content), kind, content.length, at, at, app)
            .lastInsertRowid,
        );
        insertEvent.run(id, at, app);
        for (const category of detectCategories(content, kind)) insertCategory.run(id, category);
      }
    });
    report.push(
      `seed ${CLIP_COUNT} clips (with FTS triggers): ${(performance.now() - start).toFixed(0)} ms`,
    );
  }, 120_000);

  afterAll(() => {
    // Printed on purpose: the numbers are the point of this suite (vitest --silent=false shows them).
    process.stdout.write(`\n${report.join('\n')}\n\n`);
    db.close();
  });

  /** Median wall time of `RUNS` executions of one history query (first page, 60 rows). */
  function measure(label: string, query: HistoryQuery): { ms: number; rows: number } {
    const full = { limit: 60, ...query };
    let rows = 0;
    const times: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      const start = performance.now();
      rows = repo.query(full).clips.length;
      times.push(performance.now() - start);
    }
    const ms = median(times);
    report.push(`${label.padEnd(44)} ${ms.toFixed(2).padStart(7)} ms  (${String(rows)} rows)`);
    return { ms, rows };
  }

  it.each<[string, HistoryQuery]>([
    ['common word ("timeout")', { text: 'timeout' }],
    ['rare substring ("#49999")', { text: '#49999' }],
    ['two words ("invoice payment")', { text: 'invoice payment' }],
    ['three words, one rare ("order budget 4242")', { text: 'order budget 4242' }],
    ['word + category ("customer" #sql)', { text: 'customer', category: 'sql' }],
    ['word + app ("deploy" app:Slack)', { text: 'deploy', app: 'Slack' }],
    ['no match ("zzzqqq")', { text: 'zzzqqq' }],
    ['category only (#email)', { category: 'email' }],
  ])('keeps %s under budget', (label, query) => {
    const { ms, rows } = measure(label, query);

    expect(rows).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('reports the short-word scan and the old full scan for comparison (no budget)', () => {
    measure('short word, scan fallback ("id")', { text: 'id' });
    measure('short word, scan, no match ("qx")', { text: 'qx' });
    measure('regex mode ("time\\w+t"), unchanged', { text: 'time\\w+t', regex: true });
    measure('regex mode, no match ("zz\\d+qq")', { text: 'zz\\d+qq', regex: true });

    // The pre-FTS query: ci_contains over every row. Kept here only as a yardstick.
    const legacy = db.prepare(
      `SELECT id FROM clips
       WHERE (ci_contains(content, ?) OR ci_contains(coalesce(source_url, ''), ?)
              OR ci_contains(coalesce(source_app, ''), ?))
       ORDER BY last_copied_at DESC, id DESC LIMIT 61`,
    );
    const times: number[] = [];
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      legacy.all('zzzqqq', 'zzzqqq', 'zzzqqq');
      times.push(performance.now() - start);
    }
    report.push(
      `${'old ci_contains scan, no match ("zzzqqq")'.padEnd(44)} ${median(times).toFixed(2).padStart(7)} ms`,
    );
  });
});
