import { describe, expect, it } from 'vitest';
import { AA_TEXT, AA_UI, WHITE, contrastRatio, minContrast } from './color';
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  RESOLVED_THEMES,
  accentCssVariables,
  accentSurfaces,
  accentTokens,
  findAccentPreset,
  resolveTheme,
} from './theme';

describe('resolveTheme', () => {
  it('lets an explicit choice win over the OS', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('follows the OS for system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('accent presets', () => {
  it('has six distinct presets with VS Code blue as the default', () => {
    expect(ACCENT_PRESETS).toHaveLength(6);
    expect(new Set(ACCENT_PRESETS.map((p) => p.color)).size).toBe(6);
    expect(ACCENT_PRESETS[0]?.color).toBe(DEFAULT_ACCENT);
    expect(findAccentPreset('#0078D4')?.light).toBe('#005fb8');
  });

  it.each(ACCENT_PRESETS.map((p) => [p.label, p] as const))(
    '%s passes every check unchanged in both themes',
    (_label, preset) => {
      for (const theme of RESOLVED_THEMES) {
        const value = theme === 'light' ? preset.light : preset.color;
        const tokens = accentTokens(preset.color, theme);
        expect(tokens.adjusted).toBe(false);
        expect(tokens.accent).toBe(value);
        expect(minContrast(value, accentSurfaces(theme))).toBeGreaterThanOrEqual(AA_UI);
        expect(tokens.onAccent).toBe(WHITE);
        expect(contrastRatio(WHITE, value)).toBeGreaterThanOrEqual(AA_TEXT);
      }
    },
  );
});

describe('accentTokens', () => {
  const custom = [
    '#ffd700',
    '#001f5c',
    '#ffffff',
    '#000000',
    '#7fffd4',
    '#ff4500',
    '#3b3b3b',
    '#e0e0e0',
  ];

  it.each(custom)('keeps %s readable in both themes', (color) => {
    for (const theme of RESOLVED_THEMES) {
      const surfaces = accentSurfaces(theme);
      const t = accentTokens(color, theme);
      expect(minContrast(t.accent, surfaces)).toBeGreaterThanOrEqual(AA_UI);
      expect(minContrast(t.text, surfaces)).toBeGreaterThanOrEqual(AA_TEXT);
      // The label on a filled button: the black/white pick reaches at least the large-text bar
      // on both the fill and its hover state (mid-tones cannot always get 4.5:1 with either ink).
      expect(contrastRatio(t.onAccent, t.accent)).toBeGreaterThanOrEqual(AA_UI);
      expect(contrastRatio(t.onAccent, t.hover)).toBeGreaterThanOrEqual(AA_UI);
    }
  });

  it('leaves a passing custom colour alone and adjusts a failing one per theme', () => {
    const gold = '#ffd700';
    const darkGold = accentTokens(gold, 'dark');
    const lightGold = accentTokens(gold, 'light');
    expect(darkGold).toMatchObject({ accent: gold, adjusted: false, onAccent: '#000000' });
    expect(lightGold.adjusted).toBe(true);
    expect(lightGold.accent).not.toBe(gold);

    const navy = accentTokens('#001f5c', 'dark');
    expect(navy.adjusted).toBe(true);
    expect(accentTokens('#001f5c', 'light').adjusted).toBe(false);
  });

  it('hover moves away from the label ink', () => {
    const blue = accentTokens(DEFAULT_ACCENT, 'dark');
    expect(contrastRatio(WHITE, blue.hover)).toBeGreaterThan(contrastRatio(WHITE, blue.accent));
    const gold = accentTokens('#ffd700', 'dark');
    expect(contrastRatio('#000000', gold.hover)).toBeGreaterThan(
      contrastRatio('#000000', gold.accent),
    );
  });

  it('falls back to the default accent for garbage input', () => {
    expect(accentTokens('not a colour', 'dark').accent).toBe(DEFAULT_ACCENT);
  });

  it('emits one variable set per theme', () => {
    const vars = accentCssVariables('#8957e5');
    expect(Object.keys(vars).sort()).toEqual(
      [
        '--accent-dark',
        '--accent-fg-dark',
        '--accent-hover-dark',
        '--on-accent-dark',
        '--accent-light',
        '--accent-fg-light',
        '--accent-hover-light',
        '--on-accent-light',
      ].sort(),
    );
    expect(vars['--accent-dark']).toBe('#8957e5');
    expect(vars['--accent-light']).toBe('#6f3ad6');
  });
});
