/// <reference lib="dom" />  // page.evaluate() callbacks run in the renderer
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { SCREENSHOT_DIR, expect, test } from './fixtures';

const TERMINAL_PNG = readFileSync(join('tests', 'fixtures', 'ocr', 'terminal.png'));
const SNIPPING_TOOL = { exe: 'SnippingTool.exe' } as const;
const OCR_TIMEOUT_MS = 20_000;
const CAPTURE_DIR = SCREENSHOT_DIR ?? process.env.CLIPBOARD_ARCHIVE_REVIEW_DIR ?? null;

interface SettingsBridge {
  clipboardArchive: { settings: { update(patch: Record<string, unknown>): Promise<unknown> } };
}

async function updateSettings(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    (value) => (window as unknown as SettingsBridge).clipboardArchive.settings.update(value),
    patch,
  );
}

test.describe('screenshots tab', () => {
  test('shows how to fill it, then a tile per screenshot with the detail panel and its text', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    await palette.getByRole('tab', { name: 'Screenshots' }).click();
    await expect(palette.getByRole('heading', { name: 'No screenshots yet' })).toBeVisible();
    await expect(palette.locator('.empty')).toContainText(
      process.platform === 'darwin'
        ? 'Cmd+Shift+4'
        : process.platform === 'win32'
          ? 'Win+Shift+S'
          : 'PrtSc',
    );

    // Text clips never show up here, screenshots do.
    await clipboardArchive.copy('plain text is not a screenshot');
    await clipboardArchive.copyImage(TERMINAL_PNG, SNIPPING_TOOL);
    const grid = palette.getByRole('listbox', { name: 'Screenshots' });
    const tile = grid.getByRole('option');
    await expect(tile).toHaveCount(1);
    await expect(tile).toContainText('900×216');
    await expect(tile).toContainText('SnippingTool');
    await expect
      .poll(() =>
        tile.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth),
      )
      .toBeGreaterThan(0);
    // The OCR status badge follows the recognition.
    await expect(tile.locator('.shot-status')).toHaveText('Text', { timeout: OCR_TIMEOUT_MS });

    await tile.click();
    await expect(tile).toHaveAttribute('aria-selected', 'true');
    const preview = palette.getByRole('region', { name: 'Selected clip' });
    await expect(preview).toBeVisible();
    await expect(palette.getByTestId('ocr-text-layer')).toContainText('ECONNRESET');
    await expect(preview.getByRole('button', { name: /Copy all text/ })).toBeVisible();
    await expect(preview.getByRole('button', { name: /^Pin/ })).toBeVisible();

    // Search finds it by the words in it; other words find nothing.
    const search = palette.getByRole('searchbox', { name: 'Search screenshots' });
    await search.fill('ECONNRESET');
    await expect(tile).toHaveCount(1);
    await search.fill('ECONNREFUSED');
    await expect(palette.getByRole('heading', { name: 'No screenshots match' })).toBeVisible();
    // Delete in the search box edits the text and never deletes the clip.
    await search.fill('x');
    await search.press('End');
    await search.press('Backspace');
    await search.press('Delete');
    await expect(tile).toHaveCount(1);

    // Down from the search box focuses the tile; Delete there removes the screenshot.
    await search.press('ArrowDown');
    await expect(tile).toBeFocused();
    await palette.keyboard.press('Delete');
    await expect(palette.getByRole('heading', { name: 'No screenshots yet' })).toBeVisible();
  });

  test('arrow keys move through the grid', async ({ clipboardArchive }) => {
    const { palette } = clipboardArchive;
    await clipboardArchive.copyImage(TERMINAL_PNG, SNIPPING_TOOL);
    await palette.getByRole('tab', { name: 'Screenshots' }).click();
    await expect(palette.getByRole('option')).toHaveCount(1);
    // A second, different image (the same one would only be bumped).
    await clipboardArchive.copyImage(await flipColors(palette, TERMINAL_PNG), SNIPPING_TOOL);
    const tiles = palette.getByRole('listbox', { name: 'Screenshots' }).getByRole('option');
    await expect(tiles).toHaveCount(2);

    await tiles.nth(0).click();
    await expect(tiles.nth(0)).toBeFocused();
    await palette.keyboard.press('ArrowRight');
    await expect(tiles.nth(1)).toBeFocused();
    await expect(tiles.nth(1)).toHaveAttribute('aria-selected', 'true');
    await palette.keyboard.press('ArrowLeft');
    await expect(tiles.nth(0)).toHaveAttribute('aria-selected', 'true');
  });

  test('visual check: the Screenshots tab in both themes', async ({ clipboardArchive }) => {
    test.skip(!CAPTURE_DIR, 'Set CLIPBOARD_ARCHIVE_REVIEW_DIR to capture');
    const { palette } = clipboardArchive;
    await palette.getByRole('tab', { name: 'Screenshots' }).click();
    for (const theme of ['dark', 'light'] as const) {
      await updateSettings(palette, { theme });
      await palette.waitForTimeout(200);
      await palette.screenshot({
        path: join(CAPTURE_DIR ?? '', `screenshots-tab-empty-${theme}.png`),
      });
    }
    await clipboardArchive.copyImage(TERMINAL_PNG, SNIPPING_TOOL);
    await clipboardArchive.copyImage(await flipColors(palette, TERMINAL_PNG), SNIPPING_TOOL);
    const tiles = palette.getByRole('option');
    await expect(tiles).toHaveCount(2);
    await tiles.first().click();
    await expect(palette.getByTestId('ocr-text-layer')).toContainText('ECONNRESET', {
      timeout: OCR_TIMEOUT_MS,
    });
    for (const theme of ['dark', 'light'] as const) {
      await updateSettings(palette, { theme });
      await palette.waitForTimeout(300);
      await palette.screenshot({ path: join(CAPTURE_DIR ?? '', `screenshots-tab-${theme}.png`) });
    }
  });
});

/** A colour-inverted copy of a PNG, drawn in the renderer (a second, distinct screenshot). */
async function flipColors(page: Page, png: Buffer): Promise<Buffer> {
  const base64 = await page.evaluate(async (source) => {
    const image = new Image();
    image.src = `data:image/png;base64,${source}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context');
    context.filter = 'invert(1)';
    context.drawImage(image, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1] ?? '';
  }, png.toString('base64'));
  return Buffer.from(base64, 'base64');
}
