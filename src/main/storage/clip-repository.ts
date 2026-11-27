import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { CATEGORIES, isCategory, type Category } from '@shared/categories';
import { CLIP_KINDS, CLIP_PREVIEW_CHARS } from '@shared/types';
import type {
  Clip,
  ClipKind,
  ClipSource,
  ClipSummary,
  CountBy,
  HistoryPage,
  HistoryQuery,
  HistoryStats,
} from '@shared/types';
import { DAY, localDayKey, rangeStart, startOfLocalDay } from '@shared/time';
import { countLines, domainOf } from '@shared/text';
import { transaction } from './database';
import { ftsMatchExpression, splitSearchTerms } from './full-text';

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;
/**
 * Response size budget for one history page, in preview characters. A page stops early (and
 * returns a cursor) rather than exceed it, so no query can push megabytes through IPC.
 */
export const MAX_PAGE_CHARS = 256_000;
const TOP_N = 6;
const STATS_DAYS = 14;
const HOUR_HISTOGRAM_DAYS = 30;

export interface RecordInput {
  readonly content: string;
  readonly kind: ClipKind;
  /** From `detectCategories`; stored when the text is new (identical text has the same tags). */
  readonly categories: readonly Category[];
  readonly source: ClipSource;
  readonly copiedAt: number;
}

export interface RecordResult {
  readonly clip: Clip;
  /** `false` when the text was already in the history and only got bumped. */
  readonly created: boolean;
}

interface ClipMetaRow {
  id: number;
  kind: ClipKind;
  char_count: number;
  line_count: number;
  first_copied_at: number;
  last_copied_at: number;
  copy_count: number;
  pinned: 0 | 1;
  source_app: string | null;
  source_exe: string | null;
  source_url: string | null;
  /** Comma-separated, unordered (`group_concat`); `null` when the clip has no categories. */
  categories: string | null;
}

interface ClipRow extends ClipMetaRow {
  content: string;
}

interface SummaryRow extends ClipMetaRow {
  preview: string;
}

const CATEGORY_ORDER = new Map<string, number>(
  CATEGORIES.map((category, index) => [category, index]),
);

/** Parses the `group_concat` column, dropping tags this version does not know. */
function parseCategories(value: string | null): Category[] {
  if (!value) return [];
  return value
    .split(',')
    .filter(isCategory)
    .sort((a, b) => (CATEGORY_ORDER.get(a) ?? 0) - (CATEGORY_ORDER.get(b) ?? 0));
}

function toClip(row: ClipRow): Clip {
  return { ...toMeta(row), content: row.content };
}

function toSummary(row: SummaryRow): ClipSummary {
  return { ...toMeta(row), preview: row.preview };
}

function toMeta(row: ClipMetaRow): Omit<Clip, 'content'> {
  return {
    id: row.id,
    kind: row.kind,
    charCount: row.char_count,
    lineCount: row.line_count,
    firstCopiedAt: row.first_copied_at,
    lastCopiedAt: row.last_copied_at,
    copyCount: row.copy_count,
    pinned: row.pinned === 1,
    source: { app: row.source_app, exe: row.source_exe, url: row.source_url },
    categories: parseCategories(row.categories),
  };
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Every user-provided value below goes through bound parameters; SQL strings are static. */
const META_COLUMNS = `id, kind, char_count, line_count, first_copied_at, last_copied_at,
  copy_count, pinned, source_app, source_exe, source_url,
  (SELECT group_concat(category) FROM clip_categories cc WHERE cc.clip_id = clips.id) AS categories`;
const CLIP_COLUMNS = `${META_COLUMNS}, content`;
/** History rows never carry the full text: only its first characters. */
const SUMMARY_COLUMNS = `${META_COLUMNS}, substr(content, 1, ${String(CLIP_PREVIEW_CHARS)}) AS preview`;

/**
 * All SQL for the history lives here. Callers speak in domain types (`Clip`, `HistoryQuery`),
 * never in rows or SQL fragments.
 */
export class ClipRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  /** Inserts a new clip, or bumps an existing one with the same text. Always logs a copy event. */
  record(input: RecordInput): RecordResult {
    const { content, kind, categories, source, copiedAt } = input;
    return transaction(this.db, () => {
      const { id, copy_count: copyCount } = this.db
        .prepare(
          `INSERT INTO clips (content, content_hash, kind, char_count, line_count,
             first_copied_at, last_copied_at, source_app, source_exe, source_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (content_hash) DO UPDATE SET
             last_copied_at = excluded.last_copied_at,
             copy_count     = copy_count + 1,
             source_app     = excluded.source_app,
             source_exe     = excluded.source_exe,
             source_url     = excluded.source_url
           RETURNING id, copy_count`,
        )
        .get(
          content,
          hashContent(content),
          kind,
          content.length,
          countLines(content),
          copiedAt,
          copiedAt,
          source.app,
          source.exe,
          source.url,
        ) as { id: number; copy_count: number };
      const created = copyCount === 1;

      if (created && categories.length > 0) {
        const tag = this.db.prepare(
          'INSERT OR IGNORE INTO clip_categories (clip_id, category) VALUES (?, ?)',
        );
        for (const category of categories) tag.run(id, category);
      }

      this.db
        .prepare(
          `INSERT INTO copy_events (clip_id, copied_at, source_app, source_exe, source_url)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, copiedAt, source.app, source.exe, source.url);

      const clip = this.get(id);
      if (!clip) throw new Error(`Clip ${String(id)} vanished inside its own transaction`);
      return { clip, created };
    });
  }

  get(id: number): Clip | null {
    const row = this.db.prepare(`SELECT ${CLIP_COLUMNS} FROM clips WHERE id = ?`).get(id) as
      ClipRow | undefined;
    return row ? toClip(row) : null;
  }

  findByContent(content: string): Clip | null {
    const row = this.db
      .prepare(`SELECT ${CLIP_COLUMNS} FROM clips WHERE content_hash = ?`)
      .get(hashContent(content)) as ClipRow | undefined;
    return row ? toClip(row) : null;
  }

  /** Moves a clip to the top of the history without counting it as a new copy (used by "restore"). */
  touch(id: number, at: number = this.now()): void {
    this.db.prepare('UPDATE clips SET last_copied_at = ? WHERE id = ?').run(at, id);
  }

  /**
   * Makes extra text findable by plain search for this clip, without changing the clip itself:
   * e.g. `setExtraSearchText(id, 'ocr', recognisedText)` for a screenshot.
   *
   * - One entry per `(clipId, origin)`: calling again with the same origin replaces the text.
   * - `null` or blank text removes the entry.
   * - The FTS index follows through triggers (schema v2); the entry is deleted with the clip.
   * - Returns `false` (and stores nothing) when the clip does not exist.
   */
  setExtraSearchText(clipId: number, origin: string, text: string | null): boolean {
    if (text === null || text.trim() === '') {
      this.db
        .prepare('DELETE FROM clip_extra_text WHERE clip_id = ? AND origin = ?')
        .run(clipId, origin);
      return this.get(clipId) !== null;
    }
    const result = this.db
      .prepare(
        `INSERT INTO clip_extra_text (clip_id, origin, text)
         SELECT id, ?, ? FROM clips WHERE id = ?
         ON CONFLICT (clip_id, origin) DO UPDATE SET text = excluded.text`,
      )
      .run(origin, text, clipId);
    return Number(result.changes) > 0;
  }

  query(query: HistoryQuery): HistoryPage {
    const where: string[] = [];
    const params: SQLInputValue[] = [];

    const text = query.text?.trim() ?? '';
    if (text !== '' && query.regex) {
      where.push('content REGEXP ?');
      params.push(text);
    } else if (text !== '') {
      // Every word must appear somewhere in the clip's search document (text, source app or URL,
      // extra text such as OCR): "docs.python timeout". Words of 3+ characters use the trigram
      // index; shorter ones cannot, so they scan with ci_contains over the same document.
      const { indexed, short } = splitSearchTerms(text);
      if (indexed.length > 0) {
        where.push('clips.id IN (SELECT rowid FROM clips_fts WHERE clips_fts MATCH ?)');
        params.push(ftsMatchExpression(indexed));
      }
      for (const word of short) {
        where.push(
          `EXISTS (SELECT 1 FROM clip_search_documents d WHERE d.clip_id = clips.id
             AND (ci_contains(d.content, ?) OR ci_contains(d.source, ?)
                  OR ci_contains(coalesce(d.extra, ''), ?)))`,
        );
        params.push(word, word, word);
      }
    }

    if (query.app !== undefined) {
      where.push(
        'EXISTS (SELECT 1 FROM copy_events e WHERE e.clip_id = clips.id AND e.source_app = ?)',
      );
      params.push(query.app);
    }
    if (query.kind !== undefined) {
      where.push('kind = ?');
      params.push(query.kind);
    }
    if (query.pinnedOnly) where.push('pinned = 1');
    if (query.category !== undefined) {
      where.push('clips.id IN (SELECT clip_id FROM clip_categories WHERE category = ?)');
      params.push(query.category);
    }

    const since = rangeStart(query.range ?? 'all', this.now());
    if (since !== null) {
      where.push('last_copied_at >= ?');
      params.push(since);
    }

    if (query.before) {
      where.push('(last_copied_at < ? OR (last_copied_at = ? AND id < ?))');
      params.push(query.before.lastCopiedAt, query.before.lastCopiedAt, query.before.id);
    }

    const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
    const sql = `SELECT ${SUMMARY_COLUMNS} FROM clips
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY last_copied_at DESC, id DESC
      LIMIT ?`;
    // Fetch one extra row to know whether another page exists.
    const rows = this.db.prepare(sql).all(...params, limit + 1) as unknown as SummaryRow[];

    const clips = withinBudget(rows.slice(0, limit).map(toSummary), MAX_PAGE_CHARS);
    const last = clips.at(-1);
    const more = rows.length > clips.length;
    return {
      clips,
      nextCursor: more && last ? { lastCopiedAt: last.lastCopiedAt, id: last.id } : null,
    };
  }

  /** Apps that appear in the history, most used first. */
  apps(): string[] {
    const rows = this.db
      .prepare(
        `SELECT source_app AS app FROM copy_events
         WHERE source_app IS NOT NULL
         GROUP BY source_app ORDER BY COUNT(*) DESC, source_app`,
      )
      .all() as { app: string }[];
    return rows.map((row) => row.app);
  }

  delete(ids: readonly number[]): number {
    if (ids.length === 0) return 0;
    const result = this.db
      .prepare('DELETE FROM clips WHERE id IN (SELECT value FROM json_each(?))')
      .run(JSON.stringify(ids));
    return Number(result.changes);
  }

  clear(options: { keepPinned: boolean }): number {
    const sql = options.keepPinned ? 'DELETE FROM clips WHERE pinned = 0' : 'DELETE FROM clips';
    return Number(this.db.prepare(sql).run().changes);
  }

  setPinned(id: number, pinned: boolean): void {
    this.db.prepare('UPDATE clips SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
  }

  /** Keeps the newest `maxClips` unpinned clips. Pinned clips never count and are never pruned. */
  prune(maxClips: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM clips WHERE pinned = 0 AND id NOT IN (
           SELECT id FROM clips WHERE pinned = 0
           ORDER BY last_copied_at DESC, id DESC LIMIT ?)`,
      )
      .run(maxClips);
    return Number(result.changes);
  }

  stats(): HistoryStats {
    const now = this.now();
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS clips, COALESCE(SUM(copy_count), 0) AS copies,
                COALESCE(SUM(char_count), 0) AS chars, COALESCE(SUM(pinned), 0) AS pinned
         FROM clips`,
      )
      .get() as { clips: number; copies: number; chars: number; pinned: number };

    const today = startOfLocalDay(now);
    const copiesToday = (
      this.db.prepare('SELECT COUNT(*) AS n FROM copy_events WHERE copied_at >= ?').get(today) as {
        n: number;
      }
    ).n;

    const topApps = this.db
      .prepare(
        `SELECT source_app AS key, COUNT(*) AS count FROM copy_events
         WHERE source_app IS NOT NULL
         GROUP BY source_app ORDER BY count DESC, key LIMIT ?`,
      )
      .all(TOP_N) as unknown as CountBy[];

    const kindCounts = new Map(
      (
        this.db.prepare('SELECT kind, COUNT(*) AS count FROM clips GROUP BY kind').all() as {
          kind: ClipKind;
          count: number;
        }[]
      ).map((row) => [row.kind, row.count]),
    );

    const byCategory = (
      this.db
        .prepare(
          `SELECT category AS key, COUNT(*) AS count FROM clip_categories
           GROUP BY category ORDER BY count DESC, key`,
        )
        .all() as { key: string; count: number }[]
    ).filter((row): row is CountBy<Category> => isCategory(row.key));

    const urlRows = this.db
      .prepare(
        `SELECT source_url AS url, COUNT(*) AS count FROM copy_events
         WHERE source_url IS NOT NULL GROUP BY source_url`,
      )
      .all() as { url: string; count: number }[];

    // Hour-of-day and per-day buckets use local time, computed in JS so they match the UI's clock.
    const recent = (
      this.db
        .prepare('SELECT copied_at AS at FROM copy_events WHERE copied_at >= ?')
        .all(Math.min(today - (STATS_DAYS - 1) * DAY, now - HOUR_HISTOGRAM_DAYS * DAY)) as {
        at: number;
      }[]
    ).map((row) => row.at);

    return {
      totalClips: totals.clips,
      totalCopies: totals.copies,
      copiesToday,
      totalChars: totals.chars,
      pinnedClips: totals.pinned,
      topApps,
      topDomains: topDomains(urlRows),
      byKind: CLIP_KINDS.map((kind) => ({ key: kind, count: kindCounts.get(kind) ?? 0 })),
      byCategory,
      byHour: hourHistogram(recent.filter((at) => at >= now - HOUR_HISTOGRAM_DAYS * DAY)),
      byDay: dayHistogram(recent, now),
    };
  }
}

/** The leading rows whose previews fit in `budget` characters (always at least one row). */
function withinBudget(clips: readonly ClipSummary[], budget: number): ClipSummary[] {
  const kept: ClipSummary[] = [];
  let used = 0;
  for (const clip of clips) {
    used += clip.preview.length;
    if (used > budget && kept.length > 0) break;
    kept.push(clip);
  }
  return kept;
}

function topDomains(rows: readonly { url: string; count: number }[]): CountBy[] {
  const counts = new Map<string, number>();
  for (const { url, count } of rows) {
    const domain = domainOf(url);
    if (domain) counts.set(domain, (counts.get(domain) ?? 0) + count);
  }
  return [...counts]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, TOP_N);
}

export function hourHistogram(times: readonly number[]): CountBy<number>[] {
  const buckets = Array.from({ length: 24 }, () => 0);
  for (const time of times) {
    const hour = new Date(time).getHours();
    buckets[hour] = (buckets[hour] ?? 0) + 1;
  }
  return buckets.map((count, hour) => ({ key: hour, count }));
}

export function dayHistogram(times: readonly number[], now: number): CountBy[] {
  const keys: string[] = [];
  const today = startOfLocalDay(now);
  for (let offset = STATS_DAYS - 1; offset >= 0; offset--) {
    // Step back via noon to stay correct across daylight-saving changes.
    keys.push(localDayKey(today - offset * DAY + DAY / 2));
  }
  const counts = new Map(keys.map((key) => [key, 0]));
  for (const time of times) {
    const key = localDayKey(time);
    const current = counts.get(key);
    if (current !== undefined) counts.set(key, current + 1);
  }
  return keys.map((key) => ({ key, count: counts.get(key) ?? 0 }));
}
