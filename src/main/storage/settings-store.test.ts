import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { SettingsPatch } from '@shared/ipc-contract';
import { openDatabase } from './database';
import { DEFAULT_SETTINGS, MAX_CLIPS, MIN_CLIPS, SettingsStore } from './settings-store';

describe('SettingsStore', () => {
  let db: DatabaseSync;
  let store: SettingsStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new SettingsStore(db);
  });

  afterEach(() => {
    db.close();
  });

  /** Writes a raw settings document, as an older or corrupted app version might have. */
  const writeRaw = (value: string): void => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('settings', ?)").run(value);
  };

  const readRaw = (): unknown => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  };

  describe('get', () => {
    it('returns the defaults when nothing has been saved', () => {
      expect(store.get()).toEqual(DEFAULT_SETTINGS);
    });

    it('does not write the defaults to the database just by reading them', () => {
      store.get();

      expect(readRaw()).toBeUndefined();
    });

    it('fills fields missing from an older document with defaults', () => {
      writeRaw(JSON.stringify({ maxClips: 500, shortcuts: { compare: 'Alt+Shift+D' } }));

      expect(store.get()).toEqual({
        ...DEFAULT_SETTINGS,
        maxClips: 500,
        shortcuts: { ...DEFAULT_SETTINGS.shortcuts, compare: 'Alt+Shift+D' },
      });
    });

    it('drops unknown fields from a stored document', () => {
      writeRaw(JSON.stringify({ captureEnabled: false, fontSize: 'huge' }));

      expect(store.get()).toEqual({ ...DEFAULT_SETTINGS, captureEnabled: false });
    });

    it('gives documents saved before the appearance settings the default theme and accent', () => {
      writeRaw(JSON.stringify({ captureEnabled: false, maxClips: 500 }));

      expect(store.get()).toMatchObject({
        captureEnabled: false,
        theme: 'system',
        accentColor: '#0078d4',
      });
    });

    it('resets only an invalid theme or accent and keeps the rest of the document', () => {
      writeRaw(JSON.stringify({ maxClips: 500, theme: 'neon', accentColor: 'red' }));

      expect(store.get()).toEqual({ ...DEFAULT_SETTINGS, maxClips: 500 });
    });

    it('reads back a stored theme and accent', () => {
      writeRaw(JSON.stringify({ theme: 'light', accentColor: '#8957e5' }));

      expect(store.get()).toMatchObject({ theme: 'light', accentColor: '#8957e5' });
    });

    it.each([
      ['malformed JSON', '{"maxClips": 500'],
      ['JSON null', 'null'],
      ['a value that fails validation', JSON.stringify({ maxClips: 3 })],
      ['a field of the wrong type', JSON.stringify({ excludedApps: 'KeePass.exe' })],
    ])('falls back to the defaults for %s', (_label, raw) => {
      writeRaw(raw);

      expect(store.get()).toEqual(DEFAULT_SETTINGS);
    });

    it('caches the loaded settings instead of re-reading the database', () => {
      const first = store.get();
      writeRaw(JSON.stringify({ maxClips: 999 }));

      expect(store.get()).toBe(first);
    });
  });

  describe('update', () => {
    it('merges a patch into the current settings and returns the result', () => {
      const next = store.update({ maxClips: 5000, captureEnabled: false });

      expect(next).toEqual({ ...DEFAULT_SETTINGS, maxClips: 5000, captureEnabled: false });
      expect(store.get()).toEqual(next);
    });

    it('persists the merged document so a new store instance reads it back', () => {
      store.update({ launchAtLogin: true });

      expect(new SettingsStore(db).get()).toEqual({ ...DEFAULT_SETTINGS, launchAtLogin: true });
    });

    it('overwrites the stored document on each update rather than inserting duplicates', () => {
      store.update({ maxClips: 100 });
      store.update({ maxClips: 200 });

      const rows = db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number };
      expect(rows.n).toBe(1);
      expect(readRaw()).toMatchObject({ maxClips: 200 });
    });

    it('keeps the other shortcut when only one is patched', () => {
      const next = store.update({ shortcuts: { compare: 'Alt+Shift+D' } });

      expect(next.shortcuts).toEqual({
        openHistory: DEFAULT_SETTINGS.shortcuts.openHistory,
        compare: 'Alt+Shift+D',
      });
    });

    it('builds on the previous update, not on the defaults', () => {
      store.update({ shortcuts: { openHistory: 'Alt+H' } });

      const next = store.update({ shortcuts: { compare: 'Alt+C' } });

      expect(next.shortcuts).toEqual({ openHistory: 'Alt+H', compare: 'Alt+C' });
    });

    it('trims accelerators and excluded app names', () => {
      const next = store.update({
        shortcuts: { openHistory: '  Alt+H  ' },
        excludedApps: [' KeePassXC.exe '],
      });

      expect(next.shortcuts.openHistory).toBe('Alt+H');
      expect(next.excludedApps).toEqual(['KeePassXC.exe']);
    });

    it('accepts an empty patch and returns the current settings', () => {
      expect(store.update({})).toEqual(DEFAULT_SETTINGS);
    });

    it(`accepts maxClips at both bounds (${MIN_CLIPS} and ${MAX_CLIPS})`, () => {
      expect(store.update({ maxClips: MIN_CLIPS }).maxClips).toBe(MIN_CLIPS);
      expect(store.update({ maxClips: MAX_CLIPS }).maxClips).toBe(MAX_CLIPS);
    });

    it.each<[string, unknown]>([
      ['maxClips below the minimum', { maxClips: MIN_CLIPS - 1 }],
      ['maxClips above the maximum', { maxClips: MAX_CLIPS + 1 }],
      ['a fractional maxClips', { maxClips: 100.5 }],
      ['a blank accelerator', { shortcuts: { compare: '   ' } }],
      ['an overlong accelerator', { shortcuts: { compare: 'A'.repeat(65) } }],
      ['a blank excluded app', { excludedApps: [''] }],
      [
        'more than 100 excluded apps',
        { excludedApps: Array.from({ length: 101 }, (_, i) => `app${i}.exe`) },
      ],
      ['a non-boolean flag', { captureEnabled: 'yes' }],
      ['an unknown key', { fontSize: 14 }],
      ['an unknown theme', { theme: 'neon' }],
      ['an accent that is not #rrggbb', { accentColor: 'blue' }],
      ['a short-hand accent', { accentColor: '#fff' }],
    ])('rejects %s with a ZodError and keeps the previous settings', (_label, patch) => {
      store.update({ maxClips: 777 });

      expect(() => store.update(patch as SettingsPatch)).toThrow(ZodError);
      expect(store.get().maxClips).toBe(777);
      expect(readRaw()).toMatchObject({ maxClips: 777 });
    });

    it('stores theme and accent, normalising the accent to lowercase', () => {
      const next = store.update({ theme: 'dark', accentColor: '#D62681' });

      expect(next).toMatchObject({ theme: 'dark', accentColor: '#d62681' });
      expect(readRaw()).toMatchObject({ theme: 'dark', accentColor: '#d62681' });
    });

    it('silently drops an unknown shortcut name (only the top level is strict)', () => {
      const next = store.update({ shortcuts: { paste: 'Alt+P' } } as unknown as SettingsPatch);

      expect(next.shortcuts).toEqual(DEFAULT_SETTINGS.shortcuts);
      expect(readRaw()).not.toHaveProperty('shortcuts.paste');
    });
  });
});
