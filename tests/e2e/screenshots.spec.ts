/// <reference lib="dom" />  // page.evaluate() callbacks run in the renderer
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { SCREENSHOT_DIR, expect, test, type ClipboardArchiveFixture } from './fixtures';

/** A terminal screenshot with a real error in it (also used by the OCR benchmark). */
const TERMINAL_PNG = readFileSync(join('tests', 'fixtures', 'ocr', 'terminal.png'));
const SNIPPING_TOOL = { exe: 'SnippingTool.exe' } as const;
/** Text recognition runs in a utility process; the first run also loads the language data. */
const OCR_TIMEOUT_MS = 20_000;

/**
 * Where the visual check of the screenshot UI goes: README screenshots when
 * `CLIPBOARD_ARCHIVE_SCREENSHOTS=1`, a review folder when `CLIPBOARD_ARCHIVE_REVIEW_DIR` is set.
 */
const CAPTURE_DIR = SCREENSHOT_DIR ?? process.env.CLIPBOARD_ARCHIVE_REVIEW_DIR ?? null;

/** What the analyzer would return for the terminal screenshot (boxes in its 900x216 pixels). */
const TERMINAL_ANALYSIS = {
  engine: 'e2e-injected',
  language: 'en',
  width: 900,
  height: 216,
  description: [
    'A terminal window showing a failed npm script.',
    'The error is a reset network connection.',
  ],
  scene: { style: 'screenshot', setting: 'terminal' },
  objects: [
    {
      id: 1,
      label: 'terminal window',
      box: { x0: 0, y0: 0, x1: 900, y1: 216 },
      score: 0.92,
      attributes: {},
    },
    {
      id: 2,
      label: 'error message',
      box: { x0: 8, y0: 106, x1: 260, y1: 132 },
      score: 0.81,
      attributes: { colour: 'white' },
    },
  ],
  text: [],
  durationMs: 1,
} as const;

interface SettingsBridge {
  clipboardArchive: { settings: { update(patch: Record<string, unknown>): Promise<unknown> } };
}

async function updateSettings(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    (value) => (window as unknown as SettingsBridge).clipboardArchive.settings.update(value),
    patch,
  );
}

/** Copies the terminal screenshot and returns its clip id once its row is in the history. */
async function copyScreenshot(clipboardArchive: ClipboardArchiveFixture): Promise<number> {
  await clipboardArchive.copyImage(TERMINAL_PNG, SNIPPING_TOOL);
  const row = clipboardArchive.palette.locator('.clip-row').first();
  await expect(row).toContainText('Image 900×216');
  const id = Number((await row.getAttribute('id'))?.replace('clip-', ''));
  expect(Number.isInteger(id)).toBe(true);
  return id;
}

async function capture(page: Page, name: string): Promise<void> {
  if (!CAPTURE_DIR) return;
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(CAPTURE_DIR, name) });
}

test.describe('screenshots', () => {
  test('a copied screenshot gets a row, a thumbnail and a text layer, and is found by the words in it', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    await copyScreenshot(clipboardArchive);

    const row = palette.locator('.clip-row').first();
    await expect(row.locator('.badge--image')).toBeVisible();
    await expect(row).toContainText('SnippingTool');
    const thumbnail = row.getByTestId('clip-thumbnail');
    await expect(thumbnail).toBeVisible();
    // The thumbnail really loaded through the clip-image: protocol (no broken image).
    await expect
      .poll(() => thumbnail.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);

    // Selecting the row shows the image with Tesseract's text layer over it.
    await row.click();
    const layer = palette.getByTestId('ocr-text-layer');
    await expect(layer).toContainText('ECONNRESET', { timeout: OCR_TIMEOUT_MS });
    await expect(palette.locator('.preview')).not.toContainText('chars');

    // The recognised words are searchable like text clips.
    const search = palette.getByRole('searchbox', { name: 'Search history' });
    await search.fill('ECONNRESET');
    await expect(palette.locator('.clip-row')).toHaveCount(1);
    await search.fill('ECONNREFUSED');
    await expect(palette.locator('.clip-row')).toHaveCount(0);
    await search.press('Escape');
    await expect(search).toHaveValue('');
    await expect(palette.locator('.clip-row')).toHaveCount(1);
  });

  test('Enter puts the screenshot back on the clipboard without recording it again', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    await clipboardArchive.copy('some text copied later');
    await expect(palette.locator('.clip-row')).toHaveCount(1);
    await copyScreenshot(clipboardArchive);
    await clipboardArchive.copy('newest text');
    await expect(palette.locator('.clip-row')).toHaveCount(3);

    await palette.locator('.clip-row', { hasText: 'Image 900×216' }).click();
    await palette.keyboard.press('Enter');

    await expect
      .poll(async () => (await clipboardArchive.readClipboardImage())?.length ?? 0)
      .toBeGreaterThan(0);
    const restored = await clipboardArchive.readClipboardImage();
    expect(restored?.subarray(0, 8)).toEqual(TERMINAL_PNG.subarray(0, 8));
    // Restoring moves it to the top instead of adding a duplicate.
    await expect(palette.locator('.clip-row').first()).toContainText('Image 900×216');
    await palette.waitForTimeout(500);
    await expect(palette.locator('.clip-row')).toHaveCount(3);
  });

  test('the analysis panel lists objects, highlights a clicked one and makes the description searchable', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    await updateSettings(palette, { imageAnalysis: 'on-demand' });
    const clipId = await copyScreenshot(clipboardArchive);
    await palette.locator('.clip-row').first().click();
    const panel = palette.getByRole('region', { name: 'Image analysis' });
    // Without the model, the panel offers the one-time download instead of an Analyze button.
    await expect(panel.getByRole('button', { name: 'Download model' })).toBeVisible();

    expect(await clipboardArchive.injectAnalysis(clipId, TERMINAL_ANALYSIS)).toBe(true);
    await expect(panel).toContainText('A terminal window showing a failed npm script.');
    const objects = panel.getByRole('list', { name: 'Objects' });
    await expect(objects).toContainText('error message');

    await objects.getByText('error message').click();
    await expect(palette.getByTestId('screenshot-highlight')).toBeVisible();

    const search = palette.getByRole('searchbox', { name: 'Search history' });
    await search.fill('npm script');
    await expect(palette.locator('.clip-row')).toHaveCount(1);
    await search.press('Escape');
  });

  test('settings have an Images section with the recognition options', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    await palette.getByRole('tab', { name: 'Settings' }).click();
    const section = palette.locator('section', {
      has: palette.getByRole('heading', { name: 'Images' }),
    });
    await expect(section).toBeVisible();
    await expect(section.getByRole('switch', { name: 'Text recognition' })).toBeChecked();
    await expect(section.getByLabel('Analysis language')).toBeVisible();
  });

  test('visual check: screenshot row, text layer, analysis panel and settings in both themes', async ({
    clipboardArchive,
  }) => {
    test.skip(
      !CAPTURE_DIR,
      'Set CLIPBOARD_ARCHIVE_REVIEW_DIR (or CLIPBOARD_ARCHIVE_SCREENSHOTS=1) to capture',
    );
    const { palette } = clipboardArchive;
    await clipboardArchive.copy('npm run sync -- --region eu-west-1');
    await expect(palette.locator('.clip-row')).toHaveCount(1);
    const clipId = await copyScreenshot(clipboardArchive);
    await palette.locator('.clip-row').first().click();
    await expect(palette.getByTestId('ocr-text-layer')).toContainText('ECONNRESET', {
      timeout: OCR_TIMEOUT_MS,
    });

    const openScreenshot = async (): Promise<void> => {
      await palette.getByRole('tab', { name: 'History' }).click();
      await palette.locator('.clip-row', { hasText: 'Image 900×216' }).click();
      await expect(palette.getByTestId('ocr-text-layer')).toBeVisible();
    };

    // Before any analysis: the text layer alone, then the panel offering the model download.
    for (const theme of ['dark', 'light'] as const) {
      await updateSettings(palette, { theme, imageAnalysis: 'off' });
      await openScreenshot();
      await capture(palette, `screenshot-preview-${theme}.png`);
      await updateSettings(palette, { imageAnalysis: 'on-demand' });
      await expect(palette.getByRole('button', { name: 'Download model' })).toBeVisible();
      await capture(palette, `screenshot-model-download-${theme}.png`);
    }

    expect(await clipboardArchive.injectAnalysis(clipId, TERMINAL_ANALYSIS)).toBe(true);
    for (const theme of ['dark', 'light'] as const) {
      await updateSettings(palette, { theme });
      await openScreenshot();
      await palette.getByRole('list', { name: 'Objects' }).getByText('error message').click();
      await expect(palette.getByTestId('screenshot-highlight')).toBeVisible();
      await capture(palette, `screenshot-analysis-${theme}.png`);

      await palette.getByRole('tab', { name: 'Settings' }).click();
      await palette.getByLabel('Analysis language').scrollIntoViewIfNeeded();
      await capture(palette, `settings-images-${theme}.png`);
    }
  });
});
