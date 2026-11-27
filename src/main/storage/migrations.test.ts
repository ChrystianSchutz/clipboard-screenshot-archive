import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS, schemaVersion, type Migration } from './migrations';

function tableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

describe('migrate', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('starts an empty database at schema version 0', () => {
    expect(schemaVersion(db)).toBe(0);
  });

  it('creates every table and records the latest version on a fresh database', () => {
    migrate(db);

    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(tableNames(db)).toEqual([
      'clip_categories',
      'clip_extra_text',
      'clip_images',
      'clips',
      // The FTS5 virtual table and its shadow tables.
      'clips_fts',
      'clips_fts_config',
      'clips_fts_data',
      'clips_fts_docsize',
      'clips_fts_idx',
      'copy_events',
      'settings',
    ]);
  });

  it('is idempotent: running it again changes nothing and does not throw', () => {
    migrate(db);

    expect(() => migrate(db)).not.toThrow();
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
  });

  it('applies only the migrations that are missing', () => {
    migrate(db, ['CREATE TABLE a (x INTEGER)']);

    migrate(db, ['CREATE TABLE a (x INTEGER)', 'CREATE TABLE b (y INTEGER)']);

    expect(schemaVersion(db)).toBe(2);
    expect(tableNames(db)).toEqual(['a', 'b']);
  });

  it('refuses to open a database written by a newer app version', () => {
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);

    expect(() => migrate(db)).toThrow(
      `Database schema v${MIGRATIONS.length + 1} is newer than this app (v${MIGRATIONS.length}). Update Clipboard & Screenshot Archive.`,
    );
  });

  it('rolls back a failing migration completely and keeps the previous version', () => {
    const migrations = ['CREATE TABLE a (x INTEGER)', 'CREATE TABLE b (y INTEGER); NOT VALID SQL'];

    expect(() => migrate(db, migrations)).toThrow();

    expect(schemaVersion(db)).toBe(1);
    expect(tableNames(db)).toEqual(['a']);
  });

  it('runs a function step with the database, inside the same transaction as the version bump', () => {
    const seen: number[] = [];

    migrate(db, [
      'CREATE TABLE a (x INTEGER)',
      (database) => {
        seen.push(schemaVersion(database));
        database.prepare('INSERT INTO a (x) VALUES (?)').run(7);
      },
    ]);

    expect(seen).toEqual([1]);
    expect(schemaVersion(db)).toBe(2);
    expect(db.prepare('SELECT x FROM a').all()).toEqual([{ x: 7 }]);
  });

  it('rolls back a throwing function step, including what it wrote before throwing', () => {
    const migrations: Migration[] = [
      'CREATE TABLE a (x INTEGER)',
      (database) => {
        database.exec('CREATE TABLE b (y INTEGER); INSERT INTO a (x) VALUES (1);');
        throw new Error('backfill failed');
      },
    ];

    expect(() => migrate(db, migrations)).toThrow('backfill failed');

    expect(schemaVersion(db)).toBe(1);
    expect(tableNames(db)).toEqual(['a']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM a').get()).toEqual({ n: 0 });
  });

  describe('schema v1 constraints', () => {
    beforeEach(() => {
      migrate(db);
    });

    const insertClip = (kind: string, hash: string): void => {
      db.prepare(
        `INSERT INTO clips (content, content_hash, kind, char_count, line_count, first_copied_at, last_copied_at)
         VALUES ('x', ?, ?, 1, 1, 0, 0)`,
      ).run(hash, kind);
    };

    it('rejects an unknown clip kind', () => {
      expect(() => insertClip('video', 'h1')).toThrow(/CHECK constraint failed/);
    });

    it('rejects a duplicate content hash', () => {
      insertClip('text', 'same');

      expect(() => insertClip('text', 'same')).toThrow(/UNIQUE constraint failed/);
    });
  });
});

describe('migration v2: categories and full-text search', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  const insertV1Clip = (
    content: string,
    kind: string,
    app: string | null = null,
    url: string | null = null,
  ): number =>
    Number(
      db
        .prepare(
          `INSERT INTO clips (content, content_hash, kind, char_count, line_count, first_copied_at,
             last_copied_at, source_app, source_url)
           VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?)`,
        )
        .run(content, `hash:${content}`, kind, content.length, app, url).lastInsertRowid,
    );

  const categoriesOf = (id: number): string[] =>
    (
      db
        .prepare('SELECT category FROM clip_categories WHERE clip_id = ? ORDER BY category')
        .all(id) as { category: string }[]
    ).map((row) => row.category);

  const matching = (expression: string): number[] =>
    (
      db
        .prepare('SELECT rowid AS id FROM clips_fts WHERE clips_fts MATCH ? ORDER BY rowid')
        .all(expression) as { id: number }[]
    ).map((row) => row.id);

  it('upgrades a v1 database that has data: backfills categories and the search index', () => {
    migrate(db, MIGRATIONS.slice(0, 1));
    const sql = insertV1Clip('SELECT * FROM orders WHERE id = 1', 'code', 'DBeaver');
    const mail = insertV1Clip('ada@example.com', 'text', null, 'https://mail.example.com/inbox');
    const plain = insertV1Clip('Zażółć gęślą jaźń', 'text');

    migrate(db);

    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(categoriesOf(sql)).toEqual(['sql']);
    expect(categoriesOf(mail)).toEqual(['email']);
    expect(categoriesOf(plain)).toEqual([]);
    expect(matching('"orders"')).toEqual([sql]);
    expect(matching('"dbeaver"')).toEqual([sql]);
    expect(matching('"mail.example"')).toEqual([mail]);
    expect(matching('"GĘŚLĄ"')).toEqual([plain]);
  });

  it('keeps the index in sync after the upgrade: insert, source change and delete', () => {
    migrate(db, MIGRATIONS.slice(0, 1));
    const old = insertV1Clip('legacy row', 'text', 'Notepad');
    migrate(db);

    const fresh = insertV1Clip('fresh row', 'text', 'Slack');
    db.prepare("UPDATE clips SET source_app = 'Teams' WHERE id = ?").run(old);
    db.prepare('DELETE FROM clips WHERE id = ?').run(fresh);

    expect(matching('"row"')).toEqual([old]);
    expect(matching('"teams"')).toEqual([old]);
    expect(matching('"notepad"')).toEqual([]);
    expect(matching('"slack"')).toEqual([]);
  });

  it('deletes categories and extra text together with their clip', () => {
    migrate(db);
    const id = insertV1Clip('SELECT 1 FROM dual', 'code');
    db.prepare("INSERT INTO clip_categories (clip_id, category) VALUES (?, 'sql')").run(id);
    db.prepare(
      "INSERT INTO clip_extra_text (clip_id, origin, text) VALUES (?, 'ocr', 'invoice')",
    ).run(id);

    db.prepare('DELETE FROM clips WHERE id = ?').run(id);

    const count = (table: string): unknown =>
      db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    expect(count('clip_categories')).toEqual({ n: 0 });
    expect(count('clip_extra_text')).toEqual({ n: 0 });
    expect(matching('"invoice"')).toEqual([]);
  });

  it('builds every search document from the clip_search_documents view', () => {
    migrate(db);
    const id = insertV1Clip('body text', 'text', 'Chrome', 'https://example.com/a');
    db.prepare(
      "INSERT INTO clip_extra_text (clip_id, origin, text) VALUES (?, 'ocr', 'from image')",
    ).run(id);
    db.prepare(
      "INSERT INTO clip_extra_text (clip_id, origin, text) VALUES (?, 'note', 'by hand')",
    ).run(id);

    const document = db
      .prepare('SELECT content, source, extra FROM clip_search_documents WHERE clip_id = ?')
      .get(id) as { content: string; source: string; extra: string };

    expect(document.content).toBe('body text');
    expect(document.source).toBe('Chrome https://example.com/a');
    expect(document.extra.split('\n').sort()).toEqual(['by hand', 'from image']);
    expect(matching('"from image"')).toEqual([id]);
  });
});

describe('migration v3: image clips', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  const insertClip = (content: string, kind: string, app: string | null = null): number =>
    Number(
      db
        .prepare(
          `INSERT INTO clips (content, content_hash, kind, char_count, line_count, first_copied_at,
             last_copied_at, source_app)
           VALUES (?, ?, ?, ?, 1, 0, 0, ?)`,
        )
        .run(content, `hash:${content}`, kind, content.length, app).lastInsertRowid,
    );

  const matching = (expression: string): number[] =>
    (
      db
        .prepare('SELECT rowid AS id FROM clips_fts WHERE clips_fts MATCH ? ORDER BY rowid')
        .all(expression) as { id: number }[]
    ).map((row) => row.id);

  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  it('rebuilds clips without losing a row, a copy event, a category, extra text or the index', () => {
    migrate(db, MIGRATIONS.slice(0, 2));
    const sql = insertClip('SELECT * FROM invoices', 'code', 'DBeaver');
    const note = insertClip('meeting notes', 'text', 'Notepad');
    db.prepare('INSERT INTO copy_events (clip_id, copied_at) VALUES (?, 1), (?, 2), (?, 3)').run(
      sql,
      sql,
      note,
    );
    db.prepare("INSERT INTO clip_categories (clip_id, category) VALUES (?, 'sql')").run(sql);
    db.prepare(
      "INSERT INTO clip_extra_text (clip_id, origin, text) VALUES (?, 'ocr', 'quarterly')",
    ).run(note);

    migrate(db);

    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT id, kind FROM clips ORDER BY id').all()).toEqual([
      { id: sql, kind: 'code' },
      { id: note, kind: 'text' },
    ]);
    expect(count('copy_events')).toBe(3);
    expect(count('clip_categories')).toBe(1);
    expect(matching('"invoices"')).toEqual([sql]);
    expect(matching('"quarterly"')).toEqual([note]);
    expect(matching('"dbeaver"')).toEqual([sql]);
    // Foreign keys are enforced again afterwards.
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });

  it('accepts image clips and keeps every trigger working on the rebuilt table', () => {
    migrate(db, MIGRATIONS.slice(0, 2));
    const old = insertClip('legacy row', 'text', 'Notepad');
    migrate(db);

    const image = insertClip('Image 800×600', 'image', 'Snipping Tool');
    db.prepare(
      "INSERT INTO clip_extra_text (clip_id, origin, text) VALUES (?, 'ocr', 'ECONNRESET')",
    ).run(image);
    db.prepare("UPDATE clips SET source_app = 'Teams' WHERE id = ?").run(old);

    expect(matching('"econnreset"')).toEqual([image]);
    expect(matching('"snipping"')).toEqual([image]);
    expect(matching('"teams"')).toEqual([old]);
    expect(matching('"notepad"')).toEqual([]);

    db.prepare("UPDATE clip_extra_text SET text = 'ETIMEDOUT' WHERE clip_id = ?").run(image);
    expect(matching('"econnreset"')).toEqual([]);
    expect(matching('"etimedout"')).toEqual([image]);
  });

  it('stores one image row per clip and deletes it with the clip', () => {
    migrate(db);
    const image = insertClip('Image 10×10', 'image');
    const hash = 'a'.repeat(64);
    db.prepare(
      'INSERT INTO clip_images (clip_id, image_hash, width, height, byte_size) VALUES (?, ?, 10, 10, 99)',
    ).run(image, hash);

    expect(db.prepare('SELECT ocr_state, analysis_state FROM clip_images').get()).toEqual({
      ocr_state: 'pending',
      analysis_state: 'none',
    });
    expect(() =>
      db
        .prepare(
          'INSERT INTO clip_images (clip_id, image_hash, width, height, byte_size) VALUES (?, ?, 1, 1, 1)',
        )
        .run(image, 'b'.repeat(64)),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      db.prepare("UPDATE clip_images SET ocr_state = 'maybe' WHERE clip_id = ?").run(image),
    ).toThrow(/CHECK constraint failed/);

    db.prepare('DELETE FROM clips WHERE id = ?').run(image);
    expect(count('clip_images')).toBe(0);
  });

  it("v4 marks an analysis still pending from v3 as the user's request, and others as automatic", () => {
    migrate(db, MIGRATIONS.slice(0, 3));
    const pending = insertClip('Image pending', 'image');
    const done = insertClip('Image done', 'image');
    const insertImage = db.prepare(
      'INSERT INTO clip_images (clip_id, image_hash, width, height, byte_size, analysis_state) VALUES (?, ?, 1, 1, 1, ?)',
    );
    insertImage.run(pending, 'a'.repeat(64), 'pending');
    insertImage.run(done, 'b'.repeat(64), 'done');

    migrate(db);

    expect(
      db.prepare('SELECT clip_id, analysis_trigger FROM clip_images ORDER BY clip_id').all(),
    ).toEqual([
      { clip_id: pending, analysis_trigger: 'user' },
      { clip_id: done, analysis_trigger: 'auto' },
    ]);
  });

  it('rolls back a step that leaves broken references, and keeps foreign keys on', () => {
    const broken: Migration = (database) => {
      database.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT');
      database.exec('CREATE TABLE child (parent_id INTEGER REFERENCES parent (id)) STRICT');
      database.exec('INSERT INTO child (parent_id) VALUES (42)');
    };

    expect(() => migrate(db, [broken])).toThrow(/left 1 broken references/);
    expect(schemaVersion(db)).toBe(0);
    expect(tableNames(db)).toEqual([]);
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });
});
