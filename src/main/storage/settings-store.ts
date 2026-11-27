import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { SettingsPatch } from '@shared/ipc-contract';
import type { Settings } from '@shared/types';
import { HEX_COLOR_PATTERN } from '@shared/color';
import { DEFAULT_ACCENT, DEFAULT_THEME, THEME_SOURCES } from '@shared/theme';
import {
  DEFAULT_IMAGE_RECOGNITION_SETTINGS,
  imageRecognitionSettingsSchema,
} from '@shared/image-settings';

export const MIN_CLIPS = 50;
export const MAX_CLIPS = 50_000;

export const DEFAULT_SETTINGS: Settings = {
  captureEnabled: true,
  // The screenshot folder is usually the Desktop: importing from it is the user's choice.
  importScreenshotFolder: false,
  launchAtLogin: false,
  maxClips: 2000,
  // Password managers mark their clipboard writes as private (see privacy.ts); this list is a
  // second line of defence for apps that do not.
  excludedApps: ['KeePass.exe', 'KeePassXC.exe', '1Password.exe', 'Bitwarden.exe'],
  shortcuts: {
    openHistory: 'CommandOrControl+Alt+V',
    compare: 'CommandOrControl+Alt+D',
  },
  theme: DEFAULT_THEME,
  accentColor: DEFAULT_ACCENT,
  ...DEFAULT_IMAGE_RECOGNITION_SETTINGS,
};

const accelerator = z.string().trim().min(1).max(64);

export const settingsSchema = z.object({
  captureEnabled: z.boolean(),
  importScreenshotFolder: z.boolean(),
  launchAtLogin: z.boolean(),
  maxClips: z.number().int().min(MIN_CLIPS).max(MAX_CLIPS),
  excludedApps: z.array(z.string().trim().min(1).max(260)).max(100),
  shortcuts: z.object({ openHistory: accelerator, compare: accelerator }),
  theme: z.enum(THEME_SOURCES),
  accentColor: z.string().regex(HEX_COLOR_PATTERN).toLowerCase(),
  ...imageRecognitionSettingsSchema.shape,
});

/** Cosmetic fields: an invalid stored value resets just that field instead of the whole document. */
const APPEARANCE_KEYS = ['theme', 'accentColor'] as const;
/** Screenshot settings reset the same way: a bad value must not cost the user their shortcuts. */
const IMAGE_RECOGNITION_KEYS = ['textRecognition', 'imageAnalysis', 'analysisLanguage'] as const;

export const settingsPatchSchema = settingsSchema
  .extend({ shortcuts: settingsSchema.shape.shortcuts.partial() })
  .partial()
  .strict();

const KEY = 'settings';

/**
 * Settings persisted as one validated JSON document in the same SQLite file as the history.
 * A corrupt or outdated document never crashes the app: unknown values fall back to defaults.
 */
export class SettingsStore {
  private cached: Settings | null = null;

  constructor(private readonly db: DatabaseSync) {}

  get(): Settings {
    this.cached ??= this.load();
    return this.cached;
  }

  /** Validates, merges and persists a patch. Throws a `ZodError` for invalid input. */
  update(patch: SettingsPatch): Settings {
    const parsed = settingsPatchSchema.parse(patch);
    const current = this.get();
    const next = settingsSchema.parse({
      ...current,
      ...parsed,
      shortcuts: { ...current.shortcuts, ...parsed.shortcuts },
    });
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      )
      .run(KEY, JSON.stringify(next));
    this.cached = next;
    return next;
  }

  private load(): Settings {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as
      { value: string } | undefined;
    if (!row) return DEFAULT_SETTINGS;
    try {
      const stored = JSON.parse(row.value) as Partial<Settings>;
      const merged: Record<string, unknown> = {
        ...DEFAULT_SETTINGS,
        ...stored,
        shortcuts: { ...DEFAULT_SETTINGS.shortcuts, ...stored.shortcuts },
      };
      for (const key of [...APPEARANCE_KEYS, ...IMAGE_RECOGNITION_KEYS]) {
        if (!settingsSchema.shape[key].safeParse(merged[key]).success)
          merged[key] = DEFAULT_SETTINGS[key];
      }
      const result = settingsSchema.safeParse(merged);
      return result.success ? result.data : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  }
}
