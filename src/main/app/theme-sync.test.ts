import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCENT, SURFACES, WINDOW_COLORS, accentCssVariables } from '@shared/theme';

/**
 * The native window colours (background before first paint, compare title bar overlay) come from
 * shared/theme.ts while the page colours come from global.css. A mismatch shows as a flash or a
 * visible seam around the window controls, so the two are compared here.
 */
describe('global.css stays in sync with the theme constants', () => {
  const css = readFileSync(
    resolve(import.meta.dirname, '../../renderer/src/styles/global.css'),
    'utf8',
  );
  const lightStart = css.indexOf(":root[data-theme='light'] {");
  const darkBlock = css.slice(0, lightStart);
  const lightBlock = css.slice(lightStart);
  it('has a light block to compare', () => {
    expect(lightStart).toBeGreaterThan(0);
  });

  const token = (block: string, name: string): string | undefined =>
    new RegExp(`${name}:\\s*(#[0-9a-f]{6})\\s*;`, 'i').exec(block)?.[1]?.toLowerCase();

  it.each([
    ['dark', darkBlock],
    ['light', lightBlock],
  ] as const)('%s surfaces match', (theme, block) => {
    expect(token(block, '--bg')).toBe(SURFACES[theme].bg);
    expect(token(block, '--bg-chrome')).toBe(SURFACES[theme].chrome);
    expect(token(block, '--bg-raised')).toBe(SURFACES[theme].raised);
    expect(WINDOW_COLORS[theme].background).toBe(SURFACES[theme].bg);
    expect(WINDOW_COLORS[theme].titleBar).toBe(SURFACES[theme].chrome);
  });

  it('the CSS fallbacks equal the tokens derived from the default accent', () => {
    for (const [name, value] of Object.entries(accentCssVariables(DEFAULT_ACCENT))) {
      expect(css).toContain(`var(${name}, ${value})`);
    }
  });
});
