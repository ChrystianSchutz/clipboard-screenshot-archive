/// <reference lib="dom" />  // page.evaluate() callbacks run in the renderer
import type { Page } from '@playwright/test';
import { parseHex } from '../../src/shared/color';
import { SURFACES, accentTokens, findAccentPreset } from '../../src/shared/theme';
import { copyAll, expect, test, type ClipboardArchiveFixture } from './fixtures';

/** `#0078d4` → `rgb(0, 120, 212)`, the format getComputedStyle uses. */
function rgb(hex: string): string {
  const c = parseHex(hex);
  if (!c) throw new Error(`bad colour ${hex}`);
  return `rgb(${String(c.r)}, ${String(c.g)}, ${String(c.b)})`;
}

const style = (page: Page, selector: string, property: string): Promise<string> =>
  page
    .locator(selector)
    .first()
    .evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop).trim(), property);

interface SettingsBridge {
  clipboardArchive: { settings: { update(patch: { theme: string }): Promise<unknown> } };
}

/** Switches the theme through the real setting (the main process broadcasts it to every window). */
async function forceTheme(
  clipboardArchive: ClipboardArchiveFixture,
  theme: 'dark' | 'light',
): Promise<void> {
  await clipboardArchive.palette.evaluate(
    (value) =>
      (window as unknown as SettingsBridge).clipboardArchive.settings.update({ theme: value }),
    theme,
  );
  await expect(clipboardArchive.palette.locator(`html[data-theme="${theme}"]`)).toHaveCount(1);
}

/**
 * Guard against a silently unstyled window (a broken CSS import, a CSP that blocks the stylesheet,
 * a renamed token): checks the computed styles, not just that the DOM exists.
 */
async function expectStyled(page: Page, theme: 'dark' | 'light'): Promise<void> {
  const sheets = await page.evaluate(() => document.styleSheets.length);
  expect(sheets).toBeGreaterThan(0);
  await expect.poll(() => style(page, 'body', 'background-color')).toBe(rgb(SURFACES[theme].bg));
  // The token itself resolves, and the body really uses it.
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    ),
  ).toBe(SURFACES[theme].bg);
  const font = await style(page, 'body', 'font-family');
  expect(font).toContain('Segoe UI');
  expect(await style(page, 'body', 'font-size')).toBe('13px');
}

/** A `.button` that still looks like the browser default means the stylesheet did not apply. */
async function expectStyledButton(page: Page, selector: string): Promise<void> {
  const button = page.locator(selector).first();
  const computed = await button.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      bg: s.backgroundColor,
      radius: s.borderRadius,
      height: s.height,
      cursor: s.cursor,
      font: s.fontFamily,
    };
  });
  expect(computed.bg).not.toBe('rgb(239, 239, 239)'); // Chromium's default ButtonFace
  expect(computed.bg).not.toBe('rgb(240, 240, 240)');
  expect(computed.radius).toBe('3px');
  expect(computed.height).toBe('26px');
  expect(computed.cursor).toBe('pointer');
  expect(computed.font).toContain('Segoe UI');
}

test.describe('styling guard', () => {
  test('the palette window is fully styled in both themes', async ({ clipboardArchive }) => {
    const { palette } = clipboardArchive;
    await copyAll(clipboardArchive, ['{"id":1}']);

    for (const theme of ['dark', 'light'] as const) {
      await forceTheme(clipboardArchive, theme);
      await expectStyled(palette, theme);
      expect(await style(palette, '.titlebar', 'background-color')).toBe(
        rgb(SURFACES[theme].chrome),
      );
      await expectStyledButton(palette, '.filters__row .button');
      // The primary action uses the accent, with readable text on it.
      const accent = accentTokens('#0078d4', theme);
      expect(await style(palette, '.button--primary', 'background-color')).toBe(rgb(accent.accent));
      expect(await style(palette, '.button--primary', 'color')).toBe(rgb(accent.onAccent));
      // Native selects are restyled, not left in their OS look.
      expect(await style(palette, '.select', 'appearance')).toBe('none');
    }
  });

  test('the compare window is fully styled', async ({ clipboardArchive }) => {
    await forceTheme(clipboardArchive, 'dark');
    await clipboardArchive.copy('{"a":1}');
    await clipboardArchive.pressCompare();
    const compare = await clipboardArchive.compareWindow();

    await expectStyled(compare, 'dark');
    expect(await style(compare, '.compare__titlebar', 'background-color')).toBe(
      rgb(SURFACES.dark.chrome),
    );
    await expectStyledButton(compare, '.waiting .button');
  });
});

test.describe('appearance settings', () => {
  test('switching the theme changes the computed colours and the native theme', async ({
    clipboardArchive,
  }) => {
    const { app, palette } = clipboardArchive;
    await palette.getByRole('tab', { name: 'Settings' }).click();
    const themeGroup = palette.getByRole('group', { name: 'Theme' });
    await expect(themeGroup.getByRole('button', { name: 'System' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await themeGroup.getByRole('button', { name: 'Light' }).click();
    await expect(themeGroup.getByRole('button', { name: 'Light' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect
      .poll(() => style(palette, 'body', 'background-color'))
      .toBe(rgb(SURFACES.light.bg));
    expect(await style(palette, 'body', 'color')).toBe(rgb('#3b3b3b'));
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light');

    await themeGroup.getByRole('button', { name: 'Dark' }).click();
    await expect.poll(() => style(palette, 'body', 'background-color')).toBe(rgb(SURFACES.dark.bg));
    expect(await style(palette, 'body', 'color')).toBe(rgb('#cccccc'));
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark');
  });

  test('a preset accent recolours both windows', async ({ clipboardArchive }) => {
    const { palette } = clipboardArchive;
    await forceTheme(clipboardArchive, 'dark');
    await clipboardArchive.copy('{"a":1}');
    await clipboardArchive.pressCompare();
    const compare = await clipboardArchive.compareWindow();

    await palette.getByRole('tab', { name: 'Settings' }).click();
    const recordSwitch = palette.getByRole('switch', { name: 'Record clipboard' });
    expect(await recordSwitch.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      rgb('#0078d4'),
    );

    await palette
      .getByRole('radiogroup', { name: 'Accent color' })
      .getByRole('radio', { name: 'Purple' })
      .click();
    await expect(palette.getByRole('radio', { name: 'Purple' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect
      .poll(() => recordSwitch.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe(rgb('#8957e5'));
    // The other window follows through the settings:changed broadcast.
    await expect.poll(() => style(compare, ':root', '--accent')).toBe('#8957e5');

    // The light theme uses the preset's tuned light value.
    await forceTheme(clipboardArchive, 'light');
    const purple = findAccentPreset('#8957e5');
    await expect
      .poll(() => recordSwitch.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe(rgb(purple?.light ?? ''));
  });

  test('a custom accent that is too faint is adjusted and gets readable text', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    await forceTheme(clipboardArchive, 'light');
    await palette.getByRole('tab', { name: 'Settings' }).click();

    await palette.getByLabel('Custom accent color').fill('#ffd700');
    const expected = accentTokens('#ffd700', 'light');
    expect(expected.adjusted).toBe(true);

    const recordSwitch = palette.getByRole('switch', { name: 'Record clipboard' });
    await expect
      .poll(() => recordSwitch.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe(rgb(expected.accent));
    // The knob is drawn in the on-accent ink: black on gold.
    expect(
      await recordSwitch.evaluate((el) => getComputedStyle(el, '::after').backgroundColor),
    ).toBe(rgb('#000000'));
    await expect(palette.locator('.setting', { hasText: 'Accent color' })).toContainText(
      'darker in the light theme',
    );

    // Saved after the debounce, so it survives a reload of the settings.
    await expect
      .poll(() =>
        palette.evaluate(() =>
          (
            window as unknown as {
              clipboardArchive: { settings: { get(): Promise<{ accentColor: string }> } };
            }
          ).clipboardArchive.settings
            .get()
            .then((s) => s.accentColor),
        ),
      )
      .toBe('#ffd700');

    // In the dark theme the same gold passes as is.
    await forceTheme(clipboardArchive, 'dark');
    await expect
      .poll(() => recordSwitch.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe(rgb('#ffd700'));
  });
});
