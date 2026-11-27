import type { DatabaseSync } from 'node:sqlite';
import { detectCategories } from '@shared/categories';
import type { ClipKind } from '@shared/types';

/**
 * One schema step. Most are plain SQL; a step that needs JavaScript (for example to backfill
 * rows with logic that only exists in TypeScript) is a function. Either way the runner wraps it
 * in a transaction together with the `user_version` bump, so a step applies fully or not at all.
 */
export type Migration = string | ((db: DatabaseSync) => void);

/**
 * Forward-only schema migrations, tracked with `PRAGMA user_version`.
 * Append new entries; never edit a migration that has shipped.
 */
export const MIGRATIONS: readonly Migration[] = [
  // 1: clips (one row per unique text) + copy_events (one row per copy) + settings.
  `
  CREATE TABLE clips (
    id              INTEGER PRIMARY KEY,
    content         TEXT    NOT NULL,
    content_hash    TEXT    NOT NULL UNIQUE,
    kind            TEXT    NOT NULL CHECK (kind IN ('json', 'url', 'code', 'text')),
    char_count      INTEGER NOT NULL,
    line_count      INTEGER NOT NULL,
    first_copied_at INTEGER NOT NULL,
    last_copied_at  INTEGER NOT NULL,
    copy_count      INTEGER NOT NULL DEFAULT 1,
    pinned          INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    source_app      TEXT,
    source_exe      TEXT,
    source_url      TEXT
  ) STRICT;

  CREATE INDEX clips_recent ON clips (last_copied_at DESC, id DESC);

  CREATE TABLE copy_events (
    id          INTEGER PRIMARY KEY,
    clip_id     INTEGER NOT NULL REFERENCES clips (id) ON DELETE CASCADE,
    copied_at   INTEGER NOT NULL,
    source_app  TEXT,
    source_exe  TEXT,
    source_url  TEXT
  ) STRICT;

  CREATE INDEX copy_events_clip ON copy_events (clip_id);
  CREATE INDEX copy_events_app  ON copy_events (source_app, clip_id);
  CREATE INDEX copy_events_time ON copy_events (copied_at);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
  `,

  // 2: automatic categories + full-text search (FTS5, trigram tokenizer).
  addCategoriesAndSearch,

  // 3: image clips (screenshots) with their recognised text and analysis.
  addImageClips,

  // 4: who asked for a pending analysis: the capture (`auto`, withdrawn when the user switches to
  // "On demand") or the user's Analyze action (`user`, kept). v3 did not record who asked, so a
  // request still pending from v3 counts as `user`: an explicit click is never withdrawn, at the
  // cost of possibly running one leftover automatic analysis.
  `
  ALTER TABLE clip_images ADD COLUMN analysis_trigger TEXT NOT NULL DEFAULT 'auto'
    CHECK (analysis_trigger IN ('auto', 'user'));
  UPDATE clip_images SET analysis_trigger = 'user' WHERE analysis_state = 'pending';
  `,
];

/**
 * Schema v2.
 *
 * - `clip_categories`: the tags `detectCategories` gave a clip at capture time.
 * - `clip_extra_text`: searchable text that is not part of the clip itself, keyed by origin
 *   (e.g. `'ocr'` for text recognised in a screenshot). Written through
 *   `ClipRepository.setExtraSearchText`.
 * - `clip_search_documents`: THE definition of what is searchable for a clip. The FTS index is
 *   only ever filled from this view, so adding a new source of searchable text means changing
 *   this view (in a new migration), nothing else.
 * - `clips_fts`: contentless FTS5 index over that view (rowid = clip id). The trigram tokenizer
 *   gives case-insensitive substring matching (Unicode-aware, so "łódź" finds "ŁÓDŹ") for
 *   terms of 3+ characters. Contentless: the text lives once, in `clips`/`clip_extra_text`.
 * - Triggers keep the index in sync on insert, on a bump that changes the source, on delete
 *   (including `clear`, `prune` and cascades) and when extra text changes.
 */
function addCategoriesAndSearch(db: DatabaseSync): void {
  db.exec(`
  CREATE TABLE clip_categories (
    clip_id  INTEGER NOT NULL REFERENCES clips (id) ON DELETE CASCADE,
    category TEXT    NOT NULL,
    PRIMARY KEY (clip_id, category)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX clip_categories_category ON clip_categories (category, clip_id);

  CREATE TABLE clip_extra_text (
    clip_id INTEGER NOT NULL REFERENCES clips (id) ON DELETE CASCADE,
    origin  TEXT    NOT NULL,
    text    TEXT    NOT NULL,
    PRIMARY KEY (clip_id, origin)
  ) STRICT, WITHOUT ROWID;

  CREATE VIEW clip_search_documents (clip_id, content, source, extra) AS
    SELECT c.id,
           c.content,
           concat_ws(' ', c.source_app, c.source_url),
           (SELECT group_concat(x.text, char(10)) FROM clip_extra_text x WHERE x.clip_id = c.id)
    FROM clips c;

  CREATE VIRTUAL TABLE clips_fts USING fts5 (
    content, source, extra,
    content = '', contentless_delete = 1, tokenize = 'trigram'
  );

  CREATE TRIGGER clips_fts_insert AFTER INSERT ON clips BEGIN
    INSERT INTO clips_fts (rowid, content, source, extra)
      SELECT clip_id, content, source, extra FROM clip_search_documents WHERE clip_id = new.id;
  END;

  CREATE TRIGGER clips_fts_update AFTER UPDATE OF content, source_app, source_url ON clips
  WHEN old.content IS NOT new.content
    OR old.source_app IS NOT new.source_app
    OR old.source_url IS NOT new.source_url
  BEGIN
    DELETE FROM clips_fts WHERE rowid = old.id;
    INSERT INTO clips_fts (rowid, content, source, extra)
      SELECT clip_id, content, source, extra FROM clip_search_documents WHERE clip_id = new.id;
  END;

  CREATE TRIGGER clips_fts_delete AFTER DELETE ON clips BEGIN
    DELETE FROM clips_fts WHERE rowid = old.id;
  END;

  CREATE TRIGGER clip_extra_text_insert AFTER INSERT ON clip_extra_text BEGIN
    DELETE FROM clips_fts WHERE rowid = new.clip_id;
    INSERT INTO clips_fts (rowid, content, source, extra)
      SELECT clip_id, content, source, extra FROM clip_search_documents WHERE clip_id = new.clip_id;
  END;

  CREATE TRIGGER clip_extra_text_update AFTER UPDATE ON clip_extra_text BEGIN
    DELETE FROM clips_fts WHERE rowid IN (old.clip_id, new.clip_id);
    INSERT INTO clips_fts (rowid, content, source, extra)
      SELECT clip_id, content, source, extra FROM clip_search_documents
      WHERE clip_id IN (old.clip_id, new.clip_id);
  END;

  CREATE TRIGGER clip_extra_text_delete AFTER DELETE ON clip_extra_text BEGIN
    DELETE FROM clips_fts WHERE rowid = old.clip_id;
    INSERT INTO clips_fts (rowid, content, source, extra)
      SELECT clip_id, content, source, extra FROM clip_search_documents WHERE clip_id = old.clip_id;
  END;
  `);

  // Backfill: categories need the TypeScript rules, the index is filled straight from the view.
  const tag = db.prepare('INSERT INTO clip_categories (clip_id, category) VALUES (?, ?)');
  const clips = db.prepare('SELECT id, content, kind FROM clips').iterate() as Iterable<{
    id: number;
    content: string;
    kind: ClipKind;
  }>;
  for (const clip of clips) {
    for (const category of detectCategories(clip.content, clip.kind)) tag.run(clip.id, category);
  }
  db.exec(`
    INSERT INTO clips_fts (rowid, content, source, extra)
      SELECT clip_id, content, source, extra FROM clip_search_documents;
  `);
}

/**
 * Schema v3.
 *
 * - `clips.kind` also allows `'image'`. SQLite cannot change a CHECK constraint in place, so the
 *   table is rebuilt with the documented procedure (https://sqlite.org/lang_altertable.html#otheralter):
 *   new table, copy, drop, rename, then recreate what depended on it (index, view, triggers). Clip
 *   ids are kept, so `copy_events`, `clip_categories`, `clip_extra_text` and the FTS rows (rowid =
 *   clip id) stay valid as they are. The runner turns foreign keys off around migrations (dropping
 *   the old table would otherwise cascade-delete every copy event) and checks them afterwards.
 * - `clip_images`: one row per image clip. The pixels live in the content-addressed image store
 *   (`image_hash`); the recognised text (Tesseract) and the analysis (Mirage) are stored as JSON
 *   next to each other, each with its own state. Their searchable text goes through
 *   `clip_extra_text` (origins `'ocr'` and `'analysis'`), so the search view needs no change.
 */
function addImageClips(db: DatabaseSync): void {
  db.exec(`
  DROP TRIGGER clip_extra_text_insert;
  DROP TRIGGER clip_extra_text_update;
  DROP TRIGGER clip_extra_text_delete;
  DROP VIEW clip_search_documents;

  CREATE TABLE clips_v3 (
    id              INTEGER PRIMARY KEY,
    content         TEXT    NOT NULL,
    content_hash    TEXT    NOT NULL UNIQUE,
    kind            TEXT    NOT NULL CHECK (kind IN ('json', 'url', 'code', 'text', 'image')),
    char_count      INTEGER NOT NULL,
    line_count      INTEGER NOT NULL,
    first_copied_at INTEGER NOT NULL,
    last_copied_at  INTEGER NOT NULL,
    copy_count      INTEGER NOT NULL DEFAULT 1,
    pinned          INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    source_app      TEXT,
    source_exe      TEXT,
    source_url      TEXT
  ) STRICT;

  INSERT INTO clips_v3 (id, content, content_hash, kind, char_count, line_count, first_copied_at,
                        last_copied_at, copy_count, pinned, source_app, source_exe, source_url)
    SELECT id, content, content_hash, kind, char_count, line_count, first_copied_at,
           last_copied_at, copy_count, pinned, source_app, source_exe, source_url
    FROM clips;

  DROP TABLE clips;
  ALTER TABLE clips_v3 RENAME TO clips;

  CREATE INDEX clips_recent ON clips (last_copied_at DESC, id DESC);

  CREATE VIEW clip_search_documents (clip_id, content, source, extra) AS
    SELECT c.id,
           c.content,
           concat_ws(' ', c.source_app, c.source_url),
           (SELECT group_concat(x.text, char(10)) FROM clip_extra_text x WHERE x.clip_id = c.id)
    FROM clips c;

  CREATE TRIGGER clips_fts_insert AFTER INSERT ON clips BEGIN
    INSERT INTO clips_fts (rowid, content, source, extra)
      SELECT clip_id, content, source, extra FROM clip_search_documents WHERE clip_id = new.id;
  END;

  CREATE TRIGGER clips_fts_update AFTER UPDATE OF content, source_app, source_url ON clips
  WHEN old.content IS NOT new.content
    OR old.source_app IS NOT new.source_app
    OR old.source_url IS NOT new.source_url
  BEGIN
    DELETE FROM clips_fts WHERE rowid = old.id;
    INSERT INTO clips_fts (rowid, content, source, extra)
      SELECT clip_id, content, source, extra FROM clip_search_documents WHERE clip_id = new.id;
  END;

  CREATE TRIGGER clips_fts_delete AFTER DELETE ON clips BEGIN
    DELETE FROM clips_fts WHERE rowid = old.id;
  END;

  CREATE TRIGGER clip_extra_text_insert AFTER INSERT ON clip_extra_text BEGIN
    DELETE FROM clips_fts WHERE rowid = new.clip_id;
    INSERT INTO clips_fts (rowid, content, source, extra)
      SELECT clip_id, content, source, extra FROM clip_search_documents WHERE clip_id = new.clip_id;
  END;

  CREATE TRIGGER clip_extra_text_update AFTER UPDATE ON clip_extra_text BEGIN
    DELETE FROM clips_fts WHERE rowid IN (old.clip_id, new.clip_id);
    INSERT INTO clips_fts (rowid, content, source, extra)
      SELECT clip_id, content, source, extra FROM clip_search_documents
      WHERE clip_id IN (old.clip_id, new.clip_id);
  END;

  CREATE TRIGGER clip_extra_text_delete AFTER DELETE ON clip_extra_text BEGIN
    DELETE FROM clips_fts WHERE rowid = old.clip_id;
    INSERT INTO clips_fts (rowid, content, source, extra)
      SELECT clip_id, content, source, extra FROM clip_search_documents WHERE clip_id = old.clip_id;
  END;

  CREATE TABLE clip_images (
    clip_id        INTEGER PRIMARY KEY REFERENCES clips (id) ON DELETE CASCADE,
    image_hash     TEXT    NOT NULL UNIQUE CHECK (length(image_hash) = 64),
    width          INTEGER NOT NULL CHECK (width > 0),
    height         INTEGER NOT NULL CHECK (height > 0),
    byte_size      INTEGER NOT NULL CHECK (byte_size >= 0),
    ocr_state      TEXT    NOT NULL DEFAULT 'pending'
                   CHECK (ocr_state IN ('pending', 'done', 'failed', 'off')),
    ocr_json       TEXT,
    analysis_state TEXT    NOT NULL DEFAULT 'none'
                   CHECK (analysis_state IN ('none', 'pending', 'done', 'failed')),
    analysis_json  TEXT
  ) STRICT;

  CREATE INDEX clip_images_ocr_pending ON clip_images (ocr_state) WHERE ocr_state = 'pending';
  CREATE INDEX clip_images_analysis_pending ON clip_images (analysis_state)
    WHERE analysis_state = 'pending';
  `);
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): void {
  const current = schemaVersion(db);
  if (current > migrations.length) {
    throw new Error(
      `Database schema v${current} is newer than this app (v${migrations.length}). Update Clipboard & Screenshot Archive.`,
    );
  }
  if (current === migrations.length) return;

  // Steps may rebuild a table (v3). With foreign keys on, dropping the old parent table would
  // cascade-delete its children, and the pragma cannot change inside a transaction, so it is
  // switched off around the steps; each step must leave no dangling reference before it commits.
  const enforced =
    (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (let version = current; version < migrations.length; version++) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const step = migrations[version] ?? '';
        if (typeof step === 'string') db.exec(step);
        else step(db);
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length > 0) {
          throw new Error(
            `Migration to v${version + 1} left ${violations.length} broken references`,
          );
        }
        db.exec(`PRAGMA user_version = ${version + 1}`);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  } finally {
    if (enforced) db.exec('PRAGMA foreign_keys = ON');
  }
}
