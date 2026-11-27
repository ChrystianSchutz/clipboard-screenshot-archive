/// <reference lib="dom" />  // page.evaluate() callbacks run in the renderer
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/** A terminal screenshot with a real error in it (also used by the OCR benchmark). */
const TERMINAL_PNG = readFileSync(join('tests', 'fixtures', 'ocr', 'terminal.png'));
/** Text recognition runs in a utility process; the first run also loads the language data. */
const OCR_TIMEOUT_MS = 20_000;
/** Visual check of the "Try again" state, only when a review folder is given. */
const REVIEW_DIR = process.env.CLIPBOARD_ARCHIVE_REVIEW_DIR ?? null;

interface SettingsBridge {
  clipboardArchive: { settings: { update(patch: Record<string, unknown>): Promise<unknown> } };
}

async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.evaluate(
    (value) =>
      (window as unknown as SettingsBridge).clipboardArchive.settings.update({ theme: value }),
    theme,
  );
}

test.describe('screenshot text retry', () => {
  test('"Try again" reads the text of a screenshot whose recognition failed', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    await clipboardArchive.copyImage(TERMINAL_PNG, { exe: 'SnippingTool.exe' });
    const row = palette.locator('.clip-row').first();
    await expect(row).toContainText('Image 900×216');
    const clipId = Number((await row.getAttribute('id'))?.replace('clip-', ''));
    await row.click();
    const layer = palette.getByTestId('ocr-text-layer');
    await expect(layer).toContainText('ECONNRESET', { timeout: OCR_TIMEOUT_MS });

    // As if recognition had failed: the preview says so and offers "Try again".
    expect(await clipboardArchive.injectTextFailure(clipId)).toBe(true);
    const status = palette.locator('.screenshot-view__status');
    await expect(status).toHaveText('Text could not be read from this image.');
    await expect(layer).toHaveCount(0);
    const retry = palette.getByRole('button', { name: 'Try again' });
    await expect(retry).toBeVisible();

    if (REVIEW_DIR) {
      for (const theme of ['dark', 'light'] as const) {
        await setTheme(palette, theme);
        await palette.waitForTimeout(200);
        await palette.screenshot({ path: join(REVIEW_DIR, `screenshot-text-retry-${theme}.png`) });
      }
    }

    // The retry goes through the palette-only IPC channel and the real OCR worker.
    await retry.click();
    await expect(layer).toContainText('ECONNRESET', { timeout: OCR_TIMEOUT_MS });
    await expect(retry).toHaveCount(0);
  });
});
