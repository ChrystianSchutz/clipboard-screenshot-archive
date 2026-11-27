import { join } from 'node:path';
import { SCREENSHOT_DIR, copyAll, expect, test } from './fixtures';

const STAGING = JSON.stringify({
  status: 'ok',
  user: { id: 42, name: 'Ada', roles: ['admin', 'dev'] },
  limits: { requests: 1000, burst: 50 },
  region: 'eu-west-1',
});

// Same data in a different key order, plus three real differences.
const PRODUCTION = JSON.stringify({
  region: 'eu-central-1',
  limits: { burst: 50, requests: 5000 },
  user: { roles: ['admin', 'dev'], name: 'Ada', id: 42, plan: 'pro' },
  status: 'ok',
});

test.describe('compare', () => {
  test('shortcut twice opens a diff that ignores key order', async ({ clipboardArchive }) => {
    await clipboardArchive.copy(STAGING);
    await clipboardArchive.pressCompare();
    const window = await clipboardArchive.compareWindow();
    await expect(window.getByText('Now copy')).toBeVisible();

    await clipboardArchive.copy(PRODUCTION);
    await clipboardArchive.pressCompare();

    await expect(window.locator('.pill--added')).toHaveText('+1 added');
    await expect(window.locator('.pill--changed')).toHaveText('~2 changed');
    await expect(window.locator('.pill--removed')).toHaveCount(0);
    const paths = await window.locator('.change__path').allInnerTexts();
    expect(paths).toEqual(['$.limits.requests', '$.region', '$.user.plan']);

    if (SCREENSHOT_DIR) await window.screenshot({ path: join(SCREENSHOT_DIR, 'compare.png') });

    await window.getByRole('button', { name: 'Side by side' }).click();
    await expect(window.locator('.sbs__word--added').first()).toBeVisible();
    if (SCREENSHOT_DIR)
      await window.screenshot({ path: join(SCREENSHOT_DIR, 'compare-lines.png') });
  });

  test('reordered keys only: reports identical data', async ({ clipboardArchive }) => {
    await clipboardArchive.copy('{"a":1,"b":{"c":2,"d":3}}');
    await clipboardArchive.pressCompare();
    await clipboardArchive.copy('{"b":{"d":3,"c":2},"a":1}');
    await clipboardArchive.pressCompare();

    const window = await clipboardArchive.compareWindow();
    await expect(window.locator('.pill--same')).toHaveText('Identical data');
    await expect(window.getByText('differs only in key order')).toBeVisible();
  });

  test('"Ignore array order" turns a reordered array into no difference', async ({
    clipboardArchive,
  }) => {
    await clipboardArchive.copy('{"tags":["a","b","c"]}');
    await clipboardArchive.pressCompare();
    await clipboardArchive.copy('{"tags":["c","a","b"]}');
    await clipboardArchive.pressCompare();

    const window = await clipboardArchive.compareWindow();
    await expect(window.locator('.pill--changed')).toBeVisible();
    await window.getByLabel('Ignore array order').check();
    await expect(window.locator('.pill--same')).toHaveText('Identical data');
  });

  test('plain text falls back to a line diff', async ({ clipboardArchive }) => {
    await clipboardArchive.copy('alpha\nbeta\ngamma');
    await clipboardArchive.pressCompare();
    await clipboardArchive.copy('alpha\nBETA\ngamma');
    await clipboardArchive.pressCompare();

    const window = await clipboardArchive.compareWindow();
    await expect(window.locator('.pill--added')).toHaveText('+1 line');
    await expect(window.locator('.sbs__word--removed')).toHaveText('beta');
    await expect(window.locator('.sbs__word--added')).toHaveText('BETA');
  });

  test('Escape hides the compare window, not the palette', async ({ clipboardArchive }) => {
    const { app } = clipboardArchive;
    await clipboardArchive.copy('A');
    await clipboardArchive.pressCompare();
    const window = await clipboardArchive.compareWindow();

    // Sandbox windows are never on screen, so record which window main is asked to hide.
    await app.evaluate(({ BrowserWindow }) => {
      const hidden: string[] = [];
      (globalThis as unknown as { hiddenWindows: string[] }).hiddenWindows = hidden;
      for (const win of BrowserWindow.getAllWindows()) {
        const hide = win.hide.bind(win);
        win.hide = () => {
          hidden.push(new URL(win.webContents.getURL()).hash);
          hide();
        };
      }
    });
    await window.keyboard.press('Escape');

    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as unknown as { hiddenWindows: string[] }).hiddenWindows),
      )
      .toEqual(['#compare']);
  });

  test('two clips picked in the history open the same diff', async ({ clipboardArchive }) => {
    await copyAll(clipboardArchive, ['{"v":1}', '{"v":2}']);
    const { palette } = clipboardArchive;

    await palette.locator('.clip-row', { hasText: '{"v":1}' }).click();
    await palette.getByRole('searchbox', { name: 'Search history' }).press('Control+d');
    await palette.locator('.clip-row', { hasText: '{"v":2}' }).click();
    await palette.getByRole('searchbox', { name: 'Search history' }).press('Control+d');

    const window = await clipboardArchive.compareWindow();
    await expect(window.locator('.pill--changed')).toHaveText('~1 changed');
    await expect(window.locator('.change__path')).toHaveText('$.v');
  });
});
