import {
  AA_TEXT,
  AA_UI,
  ensureContrast,
  mix,
  normalizeHex,
  readableTextOn,
  WHITE,
  BLACK,
} from './color';
import type { Settings } from './types';

/**
 * Appearance: theme choice, accent presets and the tokens derived from an accent colour.
 * The palette follows VS Code's Dark Modern and Light Modern themes; the surfaces below must stay
 * in sync with `styles/global.css` (a unit test compares them).
 */

/** `system` follows the OS; the main process maps it to `nativeTheme.themeSource`. */
export type ThemeSource = Settings['theme'];
export type ResolvedTheme = 'dark' | 'light';

export const THEME_SOURCES: readonly ThemeSource[] = ['system', 'dark', 'light'];
export const RESOLVED_THEMES: readonly ResolvedTheme[] = ['dark', 'light'];

/** Surface colours per theme. Mirrors the `--bg*` tokens in global.css. */
export const SURFACES = {
  dark: { bg: '#1f1f1f', chrome: '#181818', raised: '#252526' },
  light: { bg: '#ffffff', chrome: '#f8f8f8', raised: '#f8f8f8' },
} as const satisfies Record<ResolvedTheme, Record<string, string>>;

/** Native window colours (background before first paint, title bar overlay of the compare window). */
export const WINDOW_COLORS = {
  dark: { background: SURFACES.dark.bg, titleBar: SURFACES.dark.chrome, symbol: '#cccccc' },
  light: { background: SURFACES.light.bg, titleBar: SURFACES.light.chrome, symbol: '#3b3b3b' },
} as const satisfies Record<ResolvedTheme, Record<string, string>>;

/** Every surface the accent is drawn on (as a line, a bar or text). */
export function accentSurfaces(theme: ResolvedTheme): string[] {
  return [...new Set(Object.values(SURFACES[theme]))];
}

export interface AccentPreset {
  readonly id: string;
  readonly label: string;
  /** Canonical value, stored in settings. Also the dark-theme fill. */
  readonly color: string;
  /** Hand-tuned light-theme fill (VS Code uses a deeper blue on light, so do the others). */
  readonly light: string;
}

/**
 * Six hues spread around the wheel. Every value reaches 3:1 against all surfaces of its theme and
 * carries white text at 4.5:1, so a preset is never altered by the contrast guard.
 */
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: 'blue', label: 'Blue', color: '#0078d4', light: '#005fb8' },
  { id: 'teal', label: 'Teal', color: '#008181', light: '#00706f' },
  { id: 'green', label: 'Green', color: '#268537', light: '#1f7a33' },
  { id: 'purple', label: 'Purple', color: '#8957e5', light: '#6f3ad6' },
  { id: 'orange', label: 'Orange', color: '#b65a09', light: '#a14f08' },
  { id: 'pink', label: 'Pink', color: '#d62681', light: '#b81f6e' },
];

/** The theme actually shown: an explicit choice wins, `system` follows the OS preference. */
export function resolveTheme(source: ThemeSource, systemPrefersDark: boolean): ResolvedTheme {
  if (source === 'system') return systemPrefersDark ? 'dark' : 'light';
  return source;
}

export const DEFAULT_ACCENT = '#0078d4';
export const DEFAULT_THEME: ThemeSource = 'system';

export function findAccentPreset(color: string): AccentPreset | undefined {
  const hex = normalizeHex(color);
  return ACCENT_PRESETS.find((preset) => preset.color === hex);
}

export interface AccentTokens {
  /** Fills, bars, focus rings and 1px borders. At least 3:1 against every surface. */
  readonly accent: string;
  /** Hover state of accent fills. */
  readonly hover: string;
  /** Accent used as text or icons on surfaces. At least 4.5:1 against every surface. */
  readonly text: string;
  /** Text drawn on top of `accent` / `hover`: black or white, whichever WCAG favours. */
  readonly onAccent: string;
  /** True when the requested colour had to be changed for this theme. */
  readonly adjusted: boolean;
}

/**
 * Derives the accent tokens for one theme. Presets use their tuned per-theme value; a custom colour
 * is used as is when it passes and otherwise has its lightness moved just enough to pass.
 */
export function accentTokens(color: string, theme: ResolvedTheme): AccentTokens {
  const requested = normalizeHex(color) ?? DEFAULT_ACCENT;
  const preset = findAccentPreset(requested);
  const base = preset ? (theme === 'light' ? preset.light : preset.color) : requested;
  const surfaces = accentSurfaces(theme);

  const accent = ensureContrast(base, surfaces, AA_UI);
  const firstInk = readableTextOn(accent);
  // Hover moves away from the ink, so the label only gains contrast.
  const hover = mix(accent, firstInk === WHITE ? BLACK : WHITE, 0.88);
  const onAccent = readableTextOn([accent, hover]);
  const text = ensureContrast(accent, surfaces, AA_TEXT);

  return { accent, hover, text, onAccent, adjusted: accent !== base };
}

/** CSS custom properties for both themes; CSS picks the set that matches `prefers-color-scheme`. */
export function accentCssVariables(color: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const theme of RESOLVED_THEMES) {
    const tokens = accentTokens(color, theme);
    vars[`--accent-${theme}`] = tokens.accent;
    vars[`--accent-hover-${theme}`] = tokens.hover;
    vars[`--accent-fg-${theme}`] = tokens.text;
    vars[`--on-accent-${theme}`] = tokens.onAccent;
  }
  return vars;
}
