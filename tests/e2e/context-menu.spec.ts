/// <reference lib="dom" />  // page.evaluate() callbacks run in the renderer
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { SCREENSHOT_DIR, copyAll, expect, test, type ClipboardArchiveFixture } from './fixtures';

const TERMINAL_PNG = readFileSync(join('tests', 'fixtures', 'ocr', 'terminal.png'));
const SNIPPING_TOOL = { exe: 'SnippingTool.exe' } as const;
const OCR_TIMEOUT_MS = 20_000;
/** Where the visual check of the menu goes (see screenshots.spec.ts). */
const CAPTURE_DIR = SCREENSHOT_DIR ?? process.env.CLIPBOARD_ARCHIVE_REVIEW_DIR ?? null;

const JSON_CLIP = '{"user":{"id":42,"name":"Ada"},"roles":["admin","dev"]}';
const SQL_CLIP = "SELECT id, email FROM users WHERE created_at > now() - interval '1 day'";
const URL_CLIP = 'https://github.com/electron/electron/releases';

interface SettingsBridge {
  clipboardArchive: { settings: { update(patch: Record<string, unknown>): Promise<unknown> } };
}

async function setTheme(clipboardArchive: ClipboardArchiveFixture, theme: 'dark' | 'light') {
  const { palette } = clipboardArchive;
  await palette.evaluate(
    (value) =>
      (window as unknown as SettingsBridge).clipboardArchive.settings.update({ theme: value }),
    theme,
  );
  await expect(palette.locator(`html[data-theme="${theme}"]`)).toHaveCount(1);
}

async function capture(page: Page, name: string): Promise<void> {
  if (!CAPTURE_DIR) return;
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(CAPTURE_DIR, name) });
}

const menu = (page: Page) => page.getByRole('menu', { name: 'Clip actions' });
const row = (page: Page, text: string) => page.locator('.clip-row', { hasText: text });

test.describe('context menu', () => {
  test('right-click on a history row selects it and Delete removes it', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    await copyAll(clipboardArchive, ['alpha', 'beta', 'gamma']);

    await row(palette, 'beta').click({ button: 'right' });
    await expect(menu(palette)).toBeVisible();
    await expect(row(palette, 'beta')).toHaveAttribute('aria-selected', 'true');
    // Text clips: copy, pin, compare, then delete after a separator. Focus is in the menu.
    await expect(menu(palette).getByRole('menuitem')).toHaveText([
      /^Copy/,
      /^Pin/,
      /^Compare/,
      /^Delete/,
    ]);
    await expect(menu(palette).getByRole('menuitem', { name: 'Copy' })).toBeFocused();

    await menu(palette).getByRole('menuitem', { name: 'Delete' }).click();
    await expect(menu(palette)).toHaveCount(0);
    await expect(row(palette, 'beta')).toHaveCount(0);
    await expect(palette.locator('.clip-row')).toHaveCount(2);
  });

  test('Copy puts the clip back on the (sandboxed) clipboard', async ({ clipboardArchive }) => {
    const { palette } = clipboardArchive;
    await copyAll(clipboardArchive, ['first copy', 'second copy']);
    expect(await clipboardArchive.readClipboard()).toBe('second copy');

    await row(palette, 'first copy').click({ button: 'right' });
    await menu(palette).getByRole('menuitem', { name: 'Copy' }).click();
    await expect.poll(() => clipboardArchive.readClipboard()).toBe('first copy');
    await expect(menu(palette)).toHaveCount(0);
  });

  test('Shift+F10 opens the menu on the selected row; arrows and Enter pick Pin', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    await copyAll(clipboardArchive, ['keep me', 'other']);
    await row(palette, 'keep me').click();
    const list = palette.getByRole('listbox', { name: 'Clipboard history' });
    await expect(list).toBeFocused();

    await palette.keyboard.press('Shift+F10');
    await expect(menu(palette)).toBeVisible();
    await palette.keyboard.press('ArrowDown');
    await expect(menu(palette).getByRole('menuitem', { name: 'Pin' })).toBeFocused();
    await palette.keyboard.press('Enter');
    await expect(menu(palette)).toHaveCount(0);
    await expect(row(palette, 'keep me').locator('.clip-row__pin')).toBeVisible();
    // Focus is back on the list, with the row still selected.
    await expect(list).toBeFocused();
    await expect(row(palette, 'keep me')).toHaveAttribute('aria-selected', 'true');

    // Next time it offers Unpin.
    await palette.keyboard.press('ContextMenu');
    await expect(menu(palette).getByRole('menuitem', { name: 'Unpin' })).toBeVisible();
  });

  test('Escape closes only the menu, an outside click closes it too', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    await copyAll(clipboardArchive, ['needle one', 'needle two', 'hay']);
    const search = palette.getByRole('searchbox', { name: 'Search history' });
    await search.fill('needle');
    await expect(palette.locator('.clip-row')).toHaveCount(2);

    await row(palette, 'needle two').click({ button: 'right' });
    await expect(menu(palette)).toBeVisible();
    await palette.keyboard.press('Escape');
    await expect(menu(palette)).toHaveCount(0);
    // Escape in History would otherwise clear the search: the menu kept it.
    await expect(search).toHaveValue('needle');
    await expect(palette.locator('.clip-row')).toHaveCount(2);

    await row(palette, 'needle one').click({ button: 'right' });
    await expect(menu(palette)).toBeVisible();
    await palette.locator('.statusbar').click();
    await expect(menu(palette)).toHaveCount(0);
    await expect(palette.locator('.clip-row')).toHaveCount(2);
  });

  test('the menu stays inside the window near its edges', async ({ clipboardArchive }) => {
    const { palette } = clipboardArchive;
    await copyAll(clipboardArchive, ['edge']);
    const box = await row(palette, 'edge').boundingBox();
    const viewport = await palette.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    expect(box).not.toBeNull();
    // Right-click at the row's far right edge.
    await row(palette, 'edge').click({
      button: 'right',
      position: { x: box!.width - 2, y: box!.height / 2 },
    });
    const placed = await menu(palette).boundingBox();
    expect(placed).not.toBeNull();
    expect(placed!.x + placed!.width).toBeLessThanOrEqual(viewport.width);
    expect(placed!.y + placed!.height).toBeLessThanOrEqual(viewport.height);
  });

  test('a screenshot tile offers Copy text, which copies the recognised text', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    await clipboardArchive.copyImage(TERMINAL_PNG, SNIPPING_TOOL);
    await palette.getByRole('tab', { name: 'Screenshots' }).click();
    const tile = palette.getByRole('listbox', { name: 'Screenshots' }).getByRole('option');
    await expect(tile.locator('.shot-status')).toHaveText('Text', { timeout: OCR_TIMEOUT_MS });

    await tile.click({ button: 'right' });
    await expect(tile).toHaveAttribute('aria-selected', 'true');
    // Image clips: copy, copy text, pin, delete; never compare.
    await expect(menu(palette).getByRole('menuitem')).toHaveText([
      /^Copy/,
      /^Copy text/,
      /^Pin/,
      /^Delete/,
    ]);
    await menu(palette).getByRole('menuitem', { name: 'Copy text' }).click();
    await expect.poll(() => clipboardArchive.readClipboard()).toContain('ECONNRESET');
    await expect(palette.locator('.toast')).toContainText('Copied all text');

    // Escape closes it and gives focus back to the tile.
    await tile.click({ button: 'right' });
    await expect(menu(palette)).toBeVisible();
    await palette.keyboard.press('Escape');
    await expect(menu(palette)).toHaveCount(0);
    await expect(tile).toBeFocused();

    // The ContextMenu key opens it on the focused tile; Delete removes the screenshot.
    await palette.keyboard.press('ContextMenu');
    await menu(palette).getByRole('menuitem', { name: 'Delete' }).click();
    await expect(palette.getByRole('heading', { name: 'No screenshots yet' })).toBeVisible();
  });

  test('looks right in both themes', async ({ clipboardArchive }) => {
    test.skip(!CAPTURE_DIR, 'Only when capturing screenshots for review');
    const { palette } = clipboardArchive;
    await clipboardArchive.copyImage(TERMINAL_PNG, SNIPPING_TOOL);
    for (const text of [JSON_CLIP, SQL_CLIP, URL_CLIP]) await clipboardArchive.copy(text);
    await expect(palette.locator('.clip-row')).toHaveCount(4);
    await row(palette, 'Image 900×216').click();
    await expect(palette.getByTestId('ocr-text-layer')).toContainText('ECONNRESET', {
      timeout: OCR_TIMEOUT_MS,
    });

    for (const theme of ['dark', 'light'] as const) {
      await setTheme(clipboardArchive, theme);
      await palette.getByRole('tab', { name: 'History' }).click();
      const target = row(palette, 'SELECT id');
      const box = await target.boundingBox();
      await target.click({ button: 'right', position: { x: 160, y: box!.height / 2 } });
      await palette.keyboard.press('ArrowDown');
      await capture(palette, `context-menu-history-${theme}.png`);
      await palette.keyboard.press('Escape');

      await palette.getByRole('tab', { name: 'Screenshots' }).click();
      const tile = palette.getByRole('listbox', { name: 'Screenshots' }).getByRole('option');
      await tile.click({ button: 'right', position: { x: 60, y: 40 } });
      await expect(menu(palette).getByRole('menuitem', { name: 'Copy text' })).toBeVisible();
      await menu(palette).getByRole('menuitem', { name: 'Delete' }).hover();
      await capture(palette, `context-menu-screenshots-${theme}.png`);
      await palette.keyboard.press('Escape');
    }
  });
});
