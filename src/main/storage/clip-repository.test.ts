import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectCategories, type Category } from '@shared/categories';
import {
  CLIP_KINDS,
  CLIP_PREVIEW_CHARS,
  type Clip,
  type ClipKind,
  type ClipSummary,
  type HistoryCursor,
} from '@shared/types';
import { DAY, HOUR, localDayKey, MINUTE } from '@shared/time';
import {
  ClipRepository,
  DEFAULT_PAGE_SIZE,
  dayHistogram,
  hashContent,
  hourHistogram,
  MAX_PAGE_CHARS,
  MAX_PAGE_SIZE,
  type RecordInput,
} from './clip-repository';
import { openDatabase, registerRegexFunction } from './database';

/** Local-time constructor so every expectation holds in any time zone. Month is 0-based. */
function at(year: number, month: number, day: number, hours = 0, minutes = 0): number {
  return new Date(year, month, day, hours, minutes).getTime();
}

/** "Now" for every test: Friday 27 Nov 2026, 14:00 local time. */
const NOW = at(2026, 10, 27, 14, 0);

interface CopyOptions {
  readonly at?: number;
  readonly app?: string | null;
  readonly exe?: string | null;
  readonly url?: string | null;
  readonly kind?: ClipKind;
  /** Defaults to what capture would detect for this text and kind. */
  readonly categories?: readonly Category[];
}

function copy(content: string, options: CopyOptions = {}): RecordInput {
  const kind = options.kind ?? 'text';
  return {
    content,
    kind,
    categories: options.categories ?? detectCategories(content, kind),
    source: { app: options.app ?? null, exe: options.exe ?? null, url: options.url ?? null },
    copiedAt: options.at ?? NOW,
  };
}

const ids = (clips: readonly { readonly id: number }[]): number[] => clips.map((clip) => clip.id);

describe('ClipRepository', () => {
  let db: DatabaseSync;
  let clock: number;
  let repo: ClipRepository;

  /** Records a copy and returns the stored clip. */
  const add = (content: string, options: CopyOptions = {}): Clip =>
    repo.record(copy(content, options)).clip;

  /** Test texts are short, so a row's preview is its whole text. */
  const contents = (clips: readonly ClipSummary[]): string[] => clips.map((clip) => clip.preview);

  beforeEach(() => {
    db = openDatabase(':memory:');
    registerRegexFunction(db); // in the app only the search worker's connection has REGEXP
    clock = NOW;
    repo = new ClipRepository(db, () => clock);
  });

  afterEach(() => {
    db.close();
  });

  describe('payload size', () => {
    it('lists a bounded preview, never the full text', () => {
      const big = 'x'.repeat(1_000_000);
      const { id } = add(big);

      const [row] = repo.query({}).clips;
      expect(row?.preview).toHaveLength(CLIP_PREVIEW_CHARS);
      expect(row?.charCount).toBe(1_000_000);
      expect(row).not.toHaveProperty('content');
      expect(repo.get(id)?.content).toBe(big);
    });

    it('stops a page at the size budget and continues from a cursor', () => {
      const count = 200;
      for (let index = 0; index < count; index++) {
        add(`${String(index)} `.padEnd(3_000, 'x'), { at: NOW - index * MINUTE });
      }
      const perPage = Math.floor(MAX_PAGE_CHARS / CLIP_PREVIEW_CHARS);

      const first = repo.query({ limit: MAX_PAGE_SIZE });
      expect(first.clips).toHaveLength(perPage);
      expect(first.clips.reduce((sum, clip) => sum + clip.preview.length, 0)).toBeLessThanOrEqual(
        MAX_PAGE_CHARS,
      );
      const cursor = first.nextCursor;
      if (!cursor) throw new Error('expected another page');

      const rest = repo.query({ limit: MAX_PAGE_SIZE, before: cursor });
      expect(rest.nextCursor).toBeNull();
      expect(new Set([...ids(first.clips), ...ids(rest.clips)]).size).toBe(count);
    });
  });

  describe('record', () => {
    it('creates a new clip with derived counts and the copy source', () => {
      const result = repo.record(
        copy('line one\r\nline two', {
          at: NOW - MINUTE,
          kind: 'code',
          app: 'VS Code',
          exe: 'Code.exe',
          url: null,
        }),
      );

      expect(result.created).toBe(true);
      expect(result.clip).toEqual({
        id: expect.any(Number) as number,
        content: 'line one\r\nline two',
        kind: 'code',
        charCount: 18,
        lineCount: 2,
        firstCopiedAt: NOW - MINUTE,
        lastCopiedAt: NOW - MINUTE,
        copyCount: 1,
        pinned: false,
        source: { app: 'VS Code', exe: 'Code.exe', url: null },
        categories: [],
      });
    });

    it('bumps an existing clip instead of duplicating identical text', () => {
      const first = repo.record(copy('hello', { at: NOW - HOUR }));

      const second = repo.record(copy('hello', { at: NOW }));

      expect(second.created).toBe(false);
      expect(second.clip.id).toBe(first.clip.id);
      expect(second.clip.copyCount).toBe(2);
      expect(second.clip.firstCopiedAt).toBe(NOW - HOUR);
      expect(second.clip.lastCopiedAt).toBe(NOW);
      expect(repo.query({}).clips).toHaveLength(1);
    });

    it('keeps the source of the most recent copy, even when it has no URL', () => {
      add('snippet', { app: 'Chrome', exe: 'chrome.exe', url: 'https://example.com' });

      const bumped = add('snippet', { app: 'Slack', exe: 'slack.exe', url: null });

      expect(bumped.source).toEqual({ app: 'Slack', exe: 'slack.exe', url: null });
    });

    it('logs one copy event per copy, each with its own source and time', () => {
      const clip = add('shared', { at: NOW - 2 * MINUTE, app: 'Chrome', url: 'https://a.example' });
      add('shared', { at: NOW - MINUTE, app: 'Slack' });

      const events = db
        .prepare(
          'SELECT copied_at, source_app, source_url FROM copy_events WHERE clip_id = ? ORDER BY id',
        )
        .all(clip.id);

      expect(events).toEqual([
        { copied_at: NOW - 2 * MINUTE, source_app: 'Chrome', source_url: 'https://a.example' },
        { copied_at: NOW - MINUTE, source_app: 'Slack', source_url: null },
      ]);
    });

    it('treats text that differs only in case or whitespace as different clips', () => {
      const ids = [add('Hello').id, add('hello').id, add('hello ').id];

      expect(new Set(ids).size).toBe(3);
    });

    it('measures length in UTF-16 code units, like JavaScript strings', () => {
      expect(add('zażółć 👍').charCount).toBe(9);
    });

    it('stores text with SQL metacharacters verbatim', () => {
      const content = "'; DROP TABLE clips; --";

      expect(repo.get(add(content).id)?.content).toBe(content);
    });

    it('stores the categories of a new clip and returns them in the fixed category order', () => {
      const clip = add('x', { categories: ['uuid', 'error', 'sql'] });

      expect(clip.categories).toEqual(['error', 'sql', 'uuid']);
      expect(repo.get(clip.id)?.categories).toEqual(['error', 'sql', 'uuid']);
    });

    it('keeps the categories of the first copy when identical text is copied again', () => {
      const first = add('SELECT 1 FROM t', { kind: 'code' });

      const bumped = repo.record(copy('SELECT 1 FROM t', { kind: 'code', categories: ['secret'] }));

      expect(first.categories).toEqual(['sql']);
      expect(bumped.clip.categories).toEqual(['sql']);
    });

    it('ignores duplicate categories in the input', () => {
      expect(add('x', { categories: ['sql', 'sql'] }).categories).toEqual(['sql']);
    });

    it('hides categories this version does not know (written by a newer app)', () => {
      const clip = add('x', { categories: ['sql'] });
      db.prepare("INSERT INTO clip_categories (clip_id, category) VALUES (?, 'future-tag')").run(
        clip.id,
      );

      expect(repo.get(clip.id)?.categories).toEqual(['sql']);
    });
  });

  describe('get and findByContent', () => {
    it('returns the clip by id', () => {
      const clip = add('abc');

      expect(repo.get(clip.id)).toEqual(clip);
    });

    it('returns null for an unknown id', () => {
      expect(repo.get(999)).toBeNull();
    });

    it('finds a clip by its exact text', () => {
      const clip = add('exact text');

      expect(repo.findByContent('exact text')).toEqual(clip);
    });

    it('does not find text that only matches case-insensitively', () => {
      add('Exact Text');

      expect(repo.findByContent('exact text')).toBeNull();
    });
  });

  describe('hashContent', () => {
    it('returns the hex SHA-256 of the UTF-8 text', () => {
      expect(hashContent('abc')).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    });
  });

  describe('touch', () => {
    it('moves the clip to the top without counting a new copy', () => {
      const older = add('older', { at: NOW - HOUR });
      add('newer', { at: NOW - MINUTE });

      repo.touch(older.id, NOW);

      const page = repo.query({});
      expect(contents(page.clips)).toEqual(['older', 'newer']);
      expect(page.clips[0]?.copyCount).toBe(1);
    });

    it('defaults to the injected clock', () => {
      const clip = add('x', { at: NOW - DAY });
      clock = NOW + 5 * MINUTE;

      repo.touch(clip.id);

      expect(repo.get(clip.id)?.lastCopiedAt).toBe(NOW + 5 * MINUTE);
    });

    it('does not log a copy event', () => {
      const clip = add('x', { app: 'Chrome' });

      repo.touch(clip.id);

      expect(repo.stats().totalCopies).toBe(1);
      expect(repo.stats().topApps).toEqual([{ key: 'Chrome', count: 1 }]);
    });
  });

  describe('query', () => {
    it('returns clips newest first, breaking ties by id descending', () => {
      const a = add('a', { at: NOW - HOUR });
      const b = add('b', { at: NOW });
      const c = add('c', { at: NOW });

      expect(ids(repo.query({}).clips)).toEqual([c.id, b.id, a.id]);
    });

    it('ignores blank search text', () => {
      add('a');
      add('b');

      expect(repo.query({ text: '   ' }).clips).toHaveLength(2);
    });

    describe('plain text search', () => {
      it('matches a substring case-insensitively', () => {
        add('Connection Timeout');
        add('all good');

        expect(contents(repo.query({ text: 'TIMEOUT' }).clips)).toEqual(['Connection Timeout']);
      });

      it('folds case for non-ASCII letters in both directions', () => {
        add('Łódź Fabryczna');
        add('ZAŻÓŁĆ GĘŚLĄ JAŹŃ');

        expect(contents(repo.query({ text: 'ŁÓDŹ' }).clips)).toEqual(['Łódź Fabryczna']);
        expect(contents(repo.query({ text: 'gęślą' }).clips)).toEqual(['ZAŻÓŁĆ GĘŚLĄ JAŹŃ']);
      });

      it('requires every word, each of which may match the text, the URL or the app', () => {
        add('requests timeout handling', { url: 'https://docs.python.org/3/library' });
        add('timeout in node', { url: 'https://nodejs.org/api' });
        add('python tips', { app: 'Docs Viewer' });

        expect(contents(repo.query({ text: 'node timeout' }).clips)).toEqual(['timeout in node']);
        expect(contents(repo.query({ text: 'python  tips   docs' }).clips)).toEqual([
          'python tips',
        ]);
      });

      it('matches the source URL of the latest copy', () => {
        add('some text', { url: 'https://github.com/org/repo' });

        expect(repo.query({ text: 'github.com/org' }).clips).toHaveLength(1);
      });

      it('matches the app name of the latest copy', () => {
        add('some text', { app: 'Postman' });

        expect(repo.query({ text: 'postman' }).clips).toHaveLength(1);
      });

      it('treats LIKE wildcards literally', () => {
        add('100% done');
        add('plain');
        add('snake_case');

        expect(contents(repo.query({ text: '%' }).clips)).toEqual(['100% done']);
        expect(contents(repo.query({ text: '_' }).clips)).toEqual(['snake_case']);
      });

      it('treats regex metacharacters literally when regex mode is off', () => {
        add('abc');
        add('a.c');

        expect(contents(repo.query({ text: 'a.c' }).clips)).toEqual(['a.c']);
      });

      it('treats FTS5 query syntax in the input literally', () => {
        add('cats AND dogs');
        add('cats or dogs');
        add('say "hello" now');
        add('glob a*b here');
        add('col:value pair');

        expect(contents(repo.query({ text: 'AND' }).clips)).toEqual(['cats AND dogs']);
        expect(contents(repo.query({ text: '"hello"' }).clips)).toEqual(['say "hello" now']);
        expect(contents(repo.query({ text: 'a*b' }).clips)).toEqual(['glob a*b here']);
        expect(contents(repo.query({ text: 'col:value' }).clips)).toEqual(['col:value pair']);
        expect(repo.query({ text: 'NOT' }).clips).toEqual([]);
      });

      it('matches inside words (substring, not whole-word)', () => {
        add('getUserById(42)');

        expect(repo.query({ text: 'serbyi' }).clips).toHaveLength(1);
      });

      it('mixes indexed words (3+ characters) with short words that fall back to a scan', () => {
        add('go to the docs', { app: 'Chrome' });
        add('go elsewhere', { app: 'Chrome' });
        add('read the docs', { app: 'Chrome' });

        expect(contents(repo.query({ text: 'go docs' }).clips)).toEqual(['go to the docs']);
        expect(repo.query({ text: 'go' }).clips).toHaveLength(2);
      });

      it('lets short words match the source app and URL too', () => {
        add('plain', { app: 'Qt' });

        expect(repo.query({ text: 'qt' }).clips).toHaveLength(1);
      });

      it('repeats a word without changing the result', () => {
        add('timeout');

        expect(repo.query({ text: 'timeout TIMEOUT timeout' }).clips).toHaveLength(1);
      });
    });

    describe('search index sync', () => {
      /** Clip ids the FTS index returns for a term, bypassing the repository's query builder. */
      const indexed = (term: string): number[] =>
        (
          db
            .prepare('SELECT rowid AS id FROM clips_fts WHERE clips_fts MATCH ? ORDER BY rowid')
            .all(`"${term}"`) as { id: number }[]
        ).map((row) => row.id);

      it('indexes a new clip with its text and source', () => {
        const clip = add('fresh content', { app: 'Postman', url: 'https://api.example.com/v1' });

        expect(indexed('fresh')).toEqual([clip.id]);
        expect(indexed('postman')).toEqual([clip.id]);
        expect(indexed('api.example')).toEqual([clip.id]);
      });

      it('re-indexes the source when a bump comes from another app', () => {
        const clip = add('shared text', { app: 'Chrome' });

        add('shared text', { app: 'Slack' });

        expect(indexed('slack')).toEqual([clip.id]);
        expect(indexed('chrome')).toEqual([]);
        expect(contents(repo.query({ text: 'slack shared' }).clips)).toEqual(['shared text']);
      });

      it('leaves the index alone on touch and pin', () => {
        const clip = add('stable text');

        repo.touch(clip.id, NOW + MINUTE);
        repo.setPinned(clip.id, true);

        expect(indexed('stable')).toEqual([clip.id]);
      });

      it('drops deleted clips from the index', () => {
        const gone = add('remove me');
        const kept = add('remove me not');

        repo.delete([gone.id]);

        expect(indexed('remove')).toEqual([kept.id]);
      });

      it('drops cleared clips from the index, keeping pinned ones when asked', () => {
        const pinned = add('history one');
        repo.setPinned(pinned.id, true);
        add('history two');

        repo.clear({ keepPinned: true });
        expect(indexed('history')).toEqual([pinned.id]);

        repo.clear({ keepPinned: false });
        expect(indexed('history')).toEqual([]);
      });

      it('drops pruned clips from the index', () => {
        for (let i = 0; i < 4; i++) add(`pruned ${String(i)}`, { at: NOW - i * MINUTE });

        repo.prune(1);

        expect(indexed('pruned')).toHaveLength(1);
      });
    });

    describe('extra search text', () => {
      it('makes extra text findable through the index and the short-word scan', () => {
        const clip = add('screenshot 1');

        expect(repo.setExtraSearchText(clip.id, 'ocr', 'Invoice total: 42 EUR')).toBe(true);

        expect(ids(repo.query({ text: 'invoice' }).clips)).toEqual([clip.id]);
        expect(ids(repo.query({ text: 'invoice 42' }).clips)).toEqual([clip.id]);
        expect(ids(repo.query({ text: 'screenshot total' }).clips)).toEqual([clip.id]);
      });

      it('replaces the text of the same origin and keeps other origins', () => {
        const clip = add('image');
        repo.setExtraSearchText(clip.id, 'ocr', 'first draft');
        repo.setExtraSearchText(clip.id, 'note', 'annotated');

        repo.setExtraSearchText(clip.id, 'ocr', 'second draft');

        expect(repo.query({ text: 'first' }).clips).toEqual([]);
        expect(repo.query({ text: 'second' }).clips).toHaveLength(1);
        expect(repo.query({ text: 'annotated' }).clips).toHaveLength(1);
      });

      it('removes the text for null or blank input', () => {
        const clip = add('image');
        repo.setExtraSearchText(clip.id, 'ocr', 'receipt');

        expect(repo.setExtraSearchText(clip.id, 'ocr', '  ')).toBe(true);
        expect(repo.query({ text: 'receipt' }).clips).toEqual([]);

        repo.setExtraSearchText(clip.id, 'ocr', 'receipt');
        repo.setExtraSearchText(clip.id, 'ocr', null);
        expect(repo.query({ text: 'receipt' }).clips).toEqual([]);
      });

      it('does not change the clip itself', () => {
        const clip = add('image');

        repo.setExtraSearchText(clip.id, 'ocr', 'hidden words');

        expect(repo.get(clip.id)).toEqual(clip);
      });

      it('returns false and stores nothing for an unknown clip', () => {
        expect(repo.setExtraSearchText(999, 'ocr', 'orphan')).toBe(false);
        expect(repo.setExtraSearchText(999, 'ocr', null)).toBe(false);
        expect(db.prepare('SELECT COUNT(*) AS n FROM clip_extra_text').get()).toEqual({ n: 0 });
      });

      it('survives a bump from another app', () => {
        const clip = add('image', { app: 'Snipping Tool' });
        repo.setExtraSearchText(clip.id, 'ocr', 'quarterly report');

        add('image', { app: 'Paint' });

        expect(repo.query({ text: 'quarterly paint' }).clips).toHaveLength(1);
      });

      it('is deleted with its clip', () => {
        const clip = add('image');
        repo.setExtraSearchText(clip.id, 'ocr', 'payslip');

        repo.delete([clip.id]);

        expect(repo.query({ text: 'payslip' }).clips).toEqual([]);
        expect(db.prepare('SELECT COUNT(*) AS n FROM clip_extra_text').get()).toEqual({ n: 0 });
      });
    });

    describe('regex search', () => {
      it('matches content with a case-insensitive regular expression', () => {
        add('ERROR 500 upstream');
        add('error: none');

        expect(contents(repo.query({ text: 'error\\s+\\d{3}', regex: true }).clips)).toEqual([
          'ERROR 500 upstream',
        ]);
      });

      it('searches only the text, not the URL or the app', () => {
        add('plain body', { app: 'Chrome', url: 'https://chrome.example' });

        expect(repo.query({ text: 'chrome', regex: true }).clips).toEqual([]);
      });

      it('returns an empty page instead of throwing for an invalid pattern', () => {
        add('anything');

        expect(repo.query({ text: '(unclosed', regex: true })).toEqual({
          clips: [],
          nextCursor: null,
        });
      });

      it('returns an empty page for a pattern rejected by the backtracking guard', () => {
        add('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab');

        expect(repo.query({ text: '(a+)+$', regex: true }).clips).toEqual([]);
      });
    });

    describe('filters', () => {
      it('filters by app across all copy events, not just the latest source', () => {
        add('moved around', { at: NOW - HOUR, app: 'VS Code' });
        add('moved around', { at: NOW, app: 'Chrome' });
        add('chrome only', { app: 'Chrome' });

        expect(contents(repo.query({ app: 'VS Code' }).clips)).toEqual(['moved around']);
        expect(repo.query({ app: 'Chrome' }).clips).toHaveLength(2);
      });

      it('matches the app name exactly', () => {
        add('x', { app: 'VS Code' });

        expect(repo.query({ app: 'vs code' }).clips).toEqual([]);
        expect(repo.query({ app: 'VS' }).clips).toEqual([]);
      });

      it('filters by kind', () => {
        add('{"a":1}', { kind: 'json' });
        add('plain', { kind: 'text' });

        expect(contents(repo.query({ kind: 'json' }).clips)).toEqual(['{"a":1}']);
      });

      it('returns only pinned clips when pinnedOnly is set', () => {
        const pinned = add('keep me');
        add('ephemeral');
        repo.setPinned(pinned.id, true);

        expect(contents(repo.query({ pinnedOnly: true }).clips)).toEqual(['keep me']);
      });

      it('returns everything when pinnedOnly is false', () => {
        repo.setPinned(add('keep me').id, true);
        add('ephemeral');

        expect(repo.query({ pinnedOnly: false }).clips).toHaveLength(2);
      });

      it('filters by time range relative to the injected clock, inclusive at the boundary', () => {
        add('30 min ago', { at: NOW - 30 * MINUTE });
        add('exactly 1 h ago', { at: NOW - HOUR });
        add('2 h ago', { at: NOW - 2 * HOUR });
        add('2 days ago', { at: NOW - 2 * DAY });
        add('40 days ago', { at: NOW - 40 * DAY });

        expect(contents(repo.query({ range: '1h' }).clips)).toEqual([
          '30 min ago',
          'exactly 1 h ago',
        ]);
        expect(repo.query({ range: '24h' }).clips).toHaveLength(3);
        expect(repo.query({ range: '7d' }).clips).toHaveLength(4);
        expect(repo.query({ range: '30d' }).clips).toHaveLength(4);
        expect(repo.query({ range: 'all' }).clips).toHaveLength(5);
      });

      it('moves the time window when the clock advances', () => {
        add('recent', { at: NOW - 30 * MINUTE });

        clock = NOW + HOUR;

        expect(repo.query({ range: '1h' }).clips).toEqual([]);
      });

      it('filters by category', () => {
        add('SELECT * FROM users', { kind: 'code' });
        add('ada@example.com');
        add('plain words');

        expect(contents(repo.query({ category: 'sql' }).clips)).toEqual(['SELECT * FROM users']);
        expect(contents(repo.query({ category: 'email' }).clips)).toEqual(['ada@example.com']);
        expect(repo.query({ category: 'secret' }).clips).toEqual([]);
      });

      it('finds a clip under each of its categories', () => {
        add('multi', { categories: ['sql', 'error'] });

        expect(repo.query({ category: 'sql' }).clips).toHaveLength(1);
        expect(repo.query({ category: 'error' }).clips).toHaveLength(1);
      });

      it('combines the category with text, app, kind and pinned filters', () => {
        const match = add('SELECT timeout FROM jobs', { kind: 'code', app: 'DBeaver' });
        repo.setPinned(match.id, true);
        add('SELECT timeout FROM jobs2', { kind: 'code', app: 'DBeaver' }); // not pinned
        const other = add('SELECT timeout FROM jobs3', { kind: 'code', app: 'Chrome' });
        repo.setPinned(other.id, true);
        const text = add('timeout text', { kind: 'text', app: 'DBeaver' });
        repo.setPinned(text.id, true);

        const page = repo.query({
          text: 'timeout',
          category: 'sql',
          app: 'DBeaver',
          kind: 'code',
          pinnedOnly: true,
        });

        expect(ids(page.clips)).toEqual([match.id]);
      });

      it('combines all filters with AND', () => {
        add('{"timeout":30}', { kind: 'json', app: 'Postman' });
        add('{"timeout":60}', { kind: 'json', app: 'Chrome' });
        add('timeout text', { kind: 'text', app: 'Postman' });
        add('{"other":1}', { kind: 'json', app: 'Postman' });

        const page = repo.query({ text: 'timeout', kind: 'json', app: 'Postman' });

        expect(contents(page.clips)).toEqual(['{"timeout":30}']);
      });
    });

    describe('pagination', () => {
      /** Seven clips where several share a timestamp, so ordering depends on the id tie-break. */
      function seedWithTies(): Clip[] {
        return [
          add('t0-a', { at: NOW }),
          add('t0-b', { at: NOW }),
          add('t1-a', { at: NOW - MINUTE }),
          add('t1-b', { at: NOW - MINUTE }),
          add('t1-c', { at: NOW - MINUTE }),
          add('t2-a', { at: NOW - 2 * MINUTE }),
          add('t1-d', { at: NOW - MINUTE }),
        ];
      }

      it('walks every clip exactly once across pages, even over timestamp ties', () => {
        seedWithTies();
        const expected = ids(repo.query({}).clips);

        const seen: number[] = [];
        let cursor: HistoryCursor | null = null;
        let pages = 0;
        do {
          const page = repo.query(cursor ? { limit: 3, before: cursor } : { limit: 3 });
          seen.push(...ids(page.clips));
          cursor = page.nextCursor;
          pages++;
        } while (cursor !== null);

        expect(seen).toEqual(expected);
        expect(pages).toBe(3);
      });

      it('points the cursor at the last clip of the page', () => {
        seedWithTies();

        const page = repo.query({ limit: 2 });
        const last = page.clips.at(-1);

        expect(page.nextCursor).toEqual({ lastCopiedAt: last?.lastCopiedAt, id: last?.id });
      });

      it('returns no cursor when the page holds exactly the remaining clips', () => {
        add('a');
        add('b');

        expect(repo.query({ limit: 2 }).nextCursor).toBeNull();
      });

      it('returns an empty page for an empty history', () => {
        expect(repo.query({})).toEqual({ clips: [], nextCursor: null });
      });

      it('keeps filters applied on later pages', () => {
        for (let i = 0; i < 5; i++) add(`json ${i}`, { at: NOW - i, kind: 'json' });
        for (let i = 0; i < 5; i++) add(`text ${i}`, { at: NOW - i, kind: 'text' });

        const first = repo.query({ kind: 'json', limit: 3 });
        const second = repo.query({ kind: 'json', limit: 3, before: first.nextCursor! });

        expect(contents(second.clips)).toEqual(['json 3', 'json 4']);
        expect(second.nextCursor).toBeNull();
      });

      it('walks full-text and category results exactly once across pages, over timestamp ties', () => {
        const matches: Clip[] = [];
        for (let i = 0; i < 9; i++) {
          // Three clips per timestamp, interleaved with clips that match neither filter.
          const at = NOW - Math.floor(i / 3) * MINUTE;
          matches.push(add(`SELECT ${String(i)} FROM needle`, { at, kind: 'code' }));
          add(`noise ${String(i)}`, { at });
        }
        const expected = ids(
          [...matches].sort((a, b) => b.lastCopiedAt - a.lastCopiedAt || b.id - a.id),
        );

        const seen: number[] = [];
        let cursor: HistoryCursor | null = null;
        do {
          const base = { text: 'needle', category: 'sql', limit: 2 } as const;
          const page = repo.query(cursor ? { ...base, before: cursor } : base);
          seen.push(...ids(page.clips));
          cursor = page.nextCursor;
        } while (cursor !== null);

        expect(seen).toEqual(expected);
      });
    });

    describe('limit', () => {
      function seed(count: number): void {
        for (let i = 0; i < count; i++) add(`clip ${i}`, { at: NOW - i });
      }

      it(`defaults to ${DEFAULT_PAGE_SIZE} clips per page`, () => {
        seed(DEFAULT_PAGE_SIZE + 1);

        const page = repo.query({});

        expect(page.clips).toHaveLength(DEFAULT_PAGE_SIZE);
        expect(page.nextCursor).not.toBeNull();
      });

      it.each([0, -5])('clamps a limit of %d up to 1', (limit) => {
        seed(3);

        expect(repo.query({ limit }).clips).toHaveLength(1);
      });

      it(`clamps an oversized limit down to ${MAX_PAGE_SIZE}`, () => {
        seed(MAX_PAGE_SIZE + 1);

        const page = repo.query({ limit: 10_000 });

        expect(page.clips).toHaveLength(MAX_PAGE_SIZE);
        expect(page.nextCursor).not.toBeNull();
      });
    });
  });

  describe('apps', () => {
    it('lists apps by number of copies, then alphabetically', () => {
      add('a', { app: 'Slack' });
      add('b', { app: 'Chrome' });
      add('b', { app: 'Chrome' });
      add('c', { app: 'Chrome' });
      add('d', { app: 'Edge' });

      expect(repo.apps()).toEqual(['Chrome', 'Edge', 'Slack']);
    });

    it('omits copies without a known app', () => {
      add('a', { app: null });

      expect(repo.apps()).toEqual([]);
    });

    it('includes apps that are only in older copy events of a clip', () => {
      add('same', { app: 'VS Code' });
      add('same', { app: 'Chrome' });

      expect(repo.apps().sort()).toEqual(['Chrome', 'VS Code']);
    });
  });

  describe('delete', () => {
    it('deletes the given clips and returns how many were removed', () => {
      const a = add('a');
      const b = add('b');
      const c = add('c');

      expect(repo.delete([a.id, c.id])).toBe(2);
      expect(ids(repo.query({}).clips)).toEqual([b.id]);
    });

    it('ignores ids that do not exist', () => {
      const a = add('a');

      expect(repo.delete([a.id, 12345])).toBe(1);
    });

    it('returns 0 for an empty list', () => {
      add('a');

      expect(repo.delete([])).toBe(0);
      expect(repo.query({}).clips).toHaveLength(1);
    });

    it('cascades to the copy events of deleted clips', () => {
      const clip = add('a', { app: 'Chrome' });

      repo.delete([clip.id]);

      expect(repo.apps()).toEqual([]);
      expect(repo.stats().copiesToday).toBe(0);
    });

    it('deletes a whole multi-selection, pinned clips included, and drops it from search', () => {
      const keep = add('keep this needle');
      const batch = [add('needle one'), add('needle two'), add('needle three')];
      repo.setPinned(batch[1]!.id, true);

      expect(repo.delete(ids(batch))).toBe(3);
      expect(ids(repo.query({ text: 'needle' }).clips)).toEqual([keep.id]);
      expect(repo.stats().totalClips).toBe(1);
    });

    it('runs in one transaction: when one row fails, no clip is deleted', () => {
      const a = add('a');
      const b = add('b');
      const c = add('c');
      // One row of the batch fails (as a full disk or a locked file would).
      db.exec(`CREATE TRIGGER fail_delete BEFORE DELETE ON clips WHEN old.id = ${String(b.id)}
               BEGIN SELECT RAISE(ABORT, 'disk full'); END`);

      expect(() => repo.delete([a.id, b.id, c.id])).toThrow(/disk full/);

      expect(ids(repo.query({}).clips).sort()).toEqual([a.id, b.id, c.id].sort());
      // The connection is usable afterwards: the transaction was rolled back, not left open.
      db.exec('DROP TRIGGER fail_delete');
      expect(repo.delete([a.id])).toBe(1);
    });
  });

  describe('clear', () => {
    it('removes everything when keepPinned is false', () => {
      repo.setPinned(add('pinned').id, true);
      add('loose');

      expect(repo.clear({ keepPinned: false })).toBe(2);
      expect(repo.query({}).clips).toEqual([]);
    });

    it('keeps pinned clips when keepPinned is true', () => {
      repo.setPinned(add('pinned').id, true);
      add('loose 1');
      add('loose 2');

      expect(repo.clear({ keepPinned: true })).toBe(2);
      expect(contents(repo.query({}).clips)).toEqual(['pinned']);
    });
  });

  describe('setPinned', () => {
    it('pins and unpins a clip', () => {
      const clip = add('x');

      repo.setPinned(clip.id, true);
      expect(repo.get(clip.id)?.pinned).toBe(true);

      repo.setPinned(clip.id, false);
      expect(repo.get(clip.id)?.pinned).toBe(false);
    });

    it('does nothing for an unknown id', () => {
      expect(() => repo.setPinned(999, true)).not.toThrow();
    });
  });

  describe('setPinnedMany', () => {
    it('pins and unpins several clips at once and counts the ones that exist', () => {
      const a = add('a');
      const b = add('b');
      const c = add('c');
      repo.setPinned(b.id, true);

      expect(repo.setPinnedMany([a.id, b.id, 999], true)).toBe(2);
      expect([a, b, c].map((clip) => repo.get(clip.id)?.pinned)).toEqual([true, true, false]);

      expect(repo.setPinnedMany([a.id, b.id], false)).toBe(2);
      expect(repo.query({ pinnedOnly: true }).clips).toEqual([]);
    });

    it('returns 0 for an empty list', () => {
      expect(repo.setPinnedMany([], true)).toBe(0);
    });
  });

  describe('prune', () => {
    it('keeps the newest unpinned clips and removes the rest', () => {
      for (let i = 0; i < 5; i++) add(`clip ${i}`, { at: NOW - i * MINUTE });

      const removed = repo.prune(3);

      expect(removed).toBe(2);
      expect(contents(repo.query({}).clips)).toEqual(['clip 0', 'clip 1', 'clip 2']);
    });

    it('never removes pinned clips, and they do not count towards the limit', () => {
      const oldPinned = add('old pinned', { at: NOW - DAY });
      repo.setPinned(oldPinned.id, true);
      add('new 1', { at: NOW - 2 * MINUTE });
      add('new 2', { at: NOW - MINUTE });
      add('new 3', { at: NOW });

      repo.prune(2);

      expect(contents(repo.query({}).clips)).toEqual(['new 3', 'new 2', 'old pinned']);
    });

    it('breaks timestamp ties by keeping the higher id', () => {
      add('first', { at: NOW });
      add('second', { at: NOW });

      repo.prune(1);

      expect(contents(repo.query({}).clips)).toEqual(['second']);
    });

    it('removes nothing when the history is within the limit', () => {
      add('a');
      add('b');

      expect(repo.prune(2)).toBe(0);
    });
  });

  describe('stats', () => {
    it('returns zeros and fully shaped series for an empty history', () => {
      const stats = repo.stats();

      expect(stats).toMatchObject({
        totalClips: 0,
        totalCopies: 0,
        copiesToday: 0,
        totalChars: 0,
        pinnedClips: 0,
        topApps: [],
        topDomains: [],
        byCategory: [],
      });
      expect(stats.byKind).toEqual(CLIP_KINDS.map((kind) => ({ key: kind, count: 0 })));
      expect(stats.byHour).toHaveLength(24);
      expect(stats.byHour.every((bucket) => bucket.count === 0)).toBe(true);
      expect(stats.byDay).toHaveLength(14);
      expect(stats.byDay.every((bucket) => bucket.count === 0)).toBe(true);
    });

    it('totals clips, copies, characters and pinned clips', () => {
      add('abc');
      add('abc');
      const pinned = add('hello');
      repo.setPinned(pinned.id, true);

      expect(repo.stats()).toMatchObject({
        totalClips: 2,
        totalCopies: 3,
        totalChars: 8,
        pinnedClips: 1,
      });
    });

    it('counts copies since local midnight as today', () => {
      add('yesterday', { at: at(2026, 10, 26, 23, 59) });
      add('midnight', { at: at(2026, 10, 27, 0, 0) });
      add('midnight', { at: at(2026, 10, 27, 9, 0) });

      expect(repo.stats().copiesToday).toBe(2);
    });

    it('ranks the top six apps by copy count, ties alphabetically', () => {
      const apps = ['Slack', 'Chrome', 'Edge', 'Word', 'Excel', 'Zed', 'Arc'];
      for (const app of apps) add(`from ${app}`, { app });
      add('more chrome', { app: 'Chrome' });
      add('more chrome 2', { app: 'Chrome' });
      add('more slack', { app: 'Slack' });

      expect(repo.stats().topApps).toEqual([
        { key: 'Chrome', count: 3 },
        { key: 'Slack', count: 2 },
        { key: 'Arc', count: 1 },
        { key: 'Edge', count: 1 },
        { key: 'Excel', count: 1 },
        { key: 'Word', count: 1 },
      ]);
    });

    it('aggregates top domains per host, merging "www." and counting every copy', () => {
      add('a', { url: 'https://www.github.com/org/a' });
      add('b', { url: 'https://github.com/org/b' });
      add('b', { url: 'https://github.com/org/b' });
      add('c', { url: 'https://docs.python.org/3/' });
      add('d', { url: 'file:///C:/notes.html' });
      add('e', { url: null });

      expect(repo.stats().topDomains).toEqual([
        { key: 'github.com', count: 3 },
        { key: 'docs.python.org', count: 1 },
      ]);
    });

    it('limits top domains to six, ties alphabetically', () => {
      for (const host of [
        'h.example',
        'g.example',
        'f.example',
        'e.example',
        'd.example',
        'c.example',
        'b.example',
      ]) {
        add(`from ${host}`, { url: `https://${host}/` });
      }
      add('again', { url: 'https://h.example/again' });

      expect(repo.stats().topDomains.map((entry) => entry.key)).toEqual([
        'h.example',
        'b.example',
        'c.example',
        'd.example',
        'e.example',
        'f.example',
      ]);
    });

    it('counts clips per kind in a fixed order, with zeros for missing kinds', () => {
      add('{"a":1}', { kind: 'json' });
      add('[1]', { kind: 'json' });
      add('https://x.example', { kind: 'url' });

      expect(repo.stats().byKind).toEqual([
        { key: 'json', count: 2 },
        { key: 'url', count: 1 },
        { key: 'code', count: 0 },
        { key: 'text', count: 0 },
        { key: 'image', count: 0 },
      ]);
    });

    it('counts clips (not copies) per category, most common first, ties alphabetically', () => {
      add('SELECT 1 FROM a', { kind: 'code' });
      add('SELECT 1 FROM a', { kind: 'code' }); // a bump is still one clip
      add('SELECT 2 FROM b', { kind: 'code' });
      add('ada@example.com');
      add('#ff8800');
      add('plain text');

      expect(repo.stats().byCategory).toEqual([
        { key: 'sql', count: 2 },
        { key: 'color', count: 1 },
        { key: 'email', count: 1 },
      ]);
    });

    it('leaves categories this version does not know out of the stats', () => {
      const clip = add('x', { categories: [] });
      db.prepare("INSERT INTO clip_categories (clip_id, category) VALUES (?, 'future-tag')").run(
        clip.id,
      );

      expect(repo.stats().byCategory).toEqual([]);
    });

    it('buckets copies of the last 30 days by local hour of day', () => {
      add('today 9:15', { at: at(2026, 10, 27, 9, 15) });
      add('yesterday 9:45', { at: at(2026, 10, 26, 9, 45) });
      add('today 13:00', { at: at(2026, 10, 27, 13, 0) });
      add('too old', { at: NOW - 31 * DAY });

      const byHour = repo.stats().byHour;

      expect(byHour[9]).toEqual({ key: 9, count: 2 });
      expect(byHour[13]).toEqual({ key: 13, count: 1 });
      expect(byHour.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(3);
    });

    it('buckets copies of the last 14 local days, oldest first', () => {
      add('13 days ago', { at: at(2026, 10, 14, 10, 0) });
      add('14 days ago', { at: at(2026, 10, 13, 10, 0) });
      add('today', { at: at(2026, 10, 27, 8, 0) });
      add('today again', { at: at(2026, 10, 27, 12, 0) });

      const byDay = repo.stats().byDay;

      expect(byDay[0]).toEqual({ key: '2026-11-14', count: 1 });
      expect(byDay.at(-1)).toEqual({ key: '2026-11-27', count: 2 });
      expect(byDay.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(3);
    });
  });
});

describe('hourHistogram', () => {
  it('returns 24 buckets keyed 0..23', () => {
    const buckets = hourHistogram([]);

    expect(buckets.map((bucket) => bucket.key)).toEqual(
      Array.from({ length: 24 }, (_, hour) => hour),
    );
    expect(buckets.every((bucket) => bucket.count === 0)).toBe(true);
  });

  it('counts each time in its local hour, including midnight and 23:59', () => {
    const buckets = hourHistogram([
      at(2026, 10, 27, 0, 0),
      at(2026, 10, 20, 0, 30),
      at(2026, 10, 27, 23, 59),
    ]);

    expect(buckets[0]?.count).toBe(2);
    expect(buckets[23]?.count).toBe(1);
  });
});

describe('dayHistogram', () => {
  it('returns 14 days ending today, oldest first', () => {
    const keys = dayHistogram([], NOW).map((bucket) => bucket.key);

    expect(keys).toHaveLength(14);
    expect(keys[0]).toBe('2026-11-14');
    expect(keys.at(-1)).toBe('2026-11-27');
  });

  it('produces consecutive calendar days across a month boundary', () => {
    const keys = dayHistogram([], at(2026, 2, 5, 12)).map((bucket) => bucket.key);

    expect(keys.slice(0, 3)).toEqual(['2026-02-20', '2026-02-21', '2026-02-22']);
    expect(keys.slice(-3)).toEqual(['2026-03-03', '2026-03-04', '2026-03-05']);
  });

  it('neither skips nor repeats a day across a daylight-saving change', () => {
    // Most of Europe switches on 29 Mar 2026 and the US on 8 Mar 2026; both fall in this window
    // for one of the two dates, and the test holds in time zones without DST as well.
    for (const now of [at(2026, 3, 2, 0, 30), at(2026, 2, 15, 23, 30), at(2026, 10, 3, 0, 30)]) {
      const keys = dayHistogram([], now).map((bucket) => bucket.key);
      const expected = Array.from({ length: 14 }, (_, index) => {
        const date = new Date(now);
        return localDayKey(
          new Date(date.getFullYear(), date.getMonth(), date.getDate() - 13 + index, 12).getTime(),
        );
      });

      expect(keys).toEqual(expected);
    }
  });

  it('counts times into their local day and ignores times outside the window', () => {
    const buckets = dayHistogram(
      [
        at(2026, 10, 27, 0, 0),
        at(2026, 10, 27, 23, 59),
        at(2026, 10, 26, 23, 59),
        at(2026, 10, 13, 12, 0),
        at(2026, 10, 28, 0, 0),
      ],
      NOW,
    );

    expect(buckets.at(-1)).toEqual({ key: '2026-11-27', count: 2 });
    expect(buckets.at(-2)).toEqual({ key: '2026-11-26', count: 1 });
    expect(buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(3);
  });
});
