/// <reference lib="dom" />  // page.evaluate() callbacks run in the renderer
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const TERMINAL_PNG = readFileSync(join('tests', 'fixtures', 'ocr', 'terminal.png'));

/** Loads an image URL in the page; resolves with its natural width, or -1 when loading fails. */
function loadImage(page: Page, url: string): Promise<number> {
  return page.evaluate(
    (src) =>
      new Promise<number>((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image.naturalWidth);
        image.onerror = () => resolve(-1);
        image.src = src;
      }),
    url,
  );
}

test.describe('screenshot isolation', () => {
  test('the palette loads screenshot pixels, the compare window is refused', async ({
    clipboardArchive,
  }) => {
    await clipboardArchive.copyImage(TERMINAL_PNG, { exe: 'SnippingTool.exe' });
    const row = clipboardArchive.palette.locator('.clip-row').first();
    await expect(row).toContainText('Image 900×216');
    const clipId = Number((await row.getAttribute('id'))?.replace('clip-', ''));
    expect(Number.isInteger(clipId)).toBe(true);

    await clipboardArchive.copy('{"a":1}');
    await clipboardArchive.pressCompare();
    const compare = await clipboardArchive.compareWindow();

    for (const variant of ['full', 'thumb'] as const) {
      const url = `clip-image://clip/${clipId}/${variant}`;
      expect(await loadImage(clipboardArchive.palette, url)).toBeGreaterThan(0);
      expect(await loadImage(compare, url)).toBe(-1);
    }
  });
});
