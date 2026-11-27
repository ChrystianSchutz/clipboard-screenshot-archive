import { join } from 'node:path';
import { SCREENSHOT_DIR, copyAll, expect, test } from './fixtures';

const JSON_CLIP = '{"user":{"id":42,"name":"Ada"},"roles":["admin","dev"]}';
const SQL_CLIP = "SELECT id, email FROM users WHERE created_at > now() - interval '1 day'";
const URL_CLIP = 'https://github.com/electron/electron/releases';

test.describe('history', () => {
  test('records every copy, newest first, with its kind', async ({ clipboardArchive }) => {
    await copyAll(clipboardArchive, [JSON_CLIP, SQL_CLIP, URL_CLIP]);

    const rows = clipboardArchive.palette.locator('.clip-row');
    await expect(rows.nth(0)).toContainText(URL_CLIP);
    await expect(rows.nth(0).locator('.badge')).toHaveText('URL');
    await expect(rows.nth(2).locator('.badge')).toHaveText('JSON');
    await expect(clipboardArchive.palette.locator('.statusbar')).toContainText('3 clips');
  });

  test('copying the same text again bumps it instead of duplicating it', async ({
    clipboardArchive,
  }) => {
    await copyAll(clipboardArchive, ['alpha', 'beta']);
    await clipboardArchive.copy('alpha');

    const rows = clipboardArchive.palette.locator('.clip-row');
    await expect(rows.first()).toContainText('alpha');
    await expect(rows.first()).toContainText('×2');
    await expect(rows).toHaveCount(2);
  });

  test('plain search matches every word and highlights it', async ({ clipboardArchive }) => {
    await copyAll(clipboardArchive, [JSON_CLIP, SQL_CLIP, URL_CLIP]);
    const { palette } = clipboardArchive;

    await palette.getByRole('searchbox', { name: 'Search history' }).fill('users email');

    await expect(palette.locator('.clip-row')).toHaveCount(1);
    await expect(palette.locator('.clip-row mark').first()).toHaveText(/email|users/i);
  });

  test('regex search filters and reports invalid patterns inline', async ({ clipboardArchive }) => {
    await copyAll(clipboardArchive, ['order-1042', 'order-abc', 'invoice-77']);
    const { palette } = clipboardArchive;
    const search = palette.getByRole('searchbox', { name: 'Search history' });

    await palette.getByRole('button', { name: 'Regular expression' }).click();
    await search.fill('^order-\\d+$');
    await expect(palette.locator('.clip-row')).toHaveCount(1);
    await expect(palette.locator('.clip-row')).toContainText('order-1042');

    await search.fill('order-(');
    await expect(palette.locator('#search-error')).toBeVisible();
    await expect(search).toHaveAttribute('aria-invalid', 'true');
  });

  test('regex matches are highlighted in the row and the preview, computed in main', async ({
    clipboardArchive,
  }) => {
    await copyAll(clipboardArchive, ['order 1234 shipped', 'no digits']);
    const { palette } = clipboardArchive;

    await palette.getByRole('button', { name: 'Regular expression' }).click();
    await palette.getByRole('searchbox', { name: 'Search history' }).fill('\\d+');

    await expect(palette.locator('.clip-row')).toHaveCount(1);
    await expect(palette.locator('.clip-row mark')).toHaveText(['1234']);
    await expect(palette.locator('.preview__body mark')).toHaveText(['1234']);
  });

  test('a catastrophic regex is stopped and reported, and the app keeps working', async ({
    clipboardArchive,
  }) => {
    // `(a|a)*b` backtracks exponentially on a run of "a": minutes for 40 characters. Before the
    // search worker, this froze the main process (IPC, shortcuts, capture) for good.
    await copyAll(clipboardArchive, ['a'.repeat(40), 'plain text']);
    const { palette } = clipboardArchive;
    const search = palette.getByRole('searchbox', { name: 'Search history' });

    await palette.getByRole('button', { name: 'Regular expression' }).click();
    await search.fill('(a|a)*b');
    await expect(palette.locator('#search-error')).toContainText('too slow');

    await search.fill('plain');
    await expect(palette.locator('.clip-row')).toHaveCount(1);
    await expect(palette.locator('#search-error')).toHaveCount(0);
    await clipboardArchive.copy('still recording');
    await expect(search).toHaveValue('plain');
    await search.fill('');
    await expect(search).toHaveValue('');
    await expect(palette.locator('.clip-row').first()).toContainText('still recording');
  });

  test('rows carry a short preview; the preview pane loads the full text', async ({
    clipboardArchive,
  }) => {
    await clipboardArchive.copy(`start ${'x'.repeat(50_000)}`);
    const { palette } = clipboardArchive;

    await palette.locator('.clip-row').first().click();
    // 50k characters: the pane renders 20k and counts the rest, so it has the full text, not the 2k row preview.
    await expect(palette.locator('.preview__more')).toHaveText('… 30k more chars');
  });

  test('Enter puts the selected clip back on the clipboard without recording it again', async ({
    clipboardArchive,
  }) => {
    await copyAll(clipboardArchive, ['first', 'second']);
    const { palette } = clipboardArchive;

    await palette.getByRole('searchbox', { name: 'Search history' }).press('ArrowDown');
    await expect(palette.locator('.clip-row--selected')).toContainText('first');
    await palette.keyboard.press('Enter');

    await expect.poll(() => clipboardArchive.readClipboard()).toBe('first');
    // The restore is a self-write: still two clips, and "first" was not bumped by a new copy.
    await palette.waitForTimeout(400);
    await expect(palette.locator('.clip-row')).toHaveCount(2);
    await expect(palette.locator('.clip-row').filter({ hasText: 'first' })).not.toContainText('×2');
  });

  test('Delete removes the selected clip and keeps a neighbour selected', async ({
    clipboardArchive,
  }) => {
    await copyAll(clipboardArchive, ['one', 'two', 'three']);
    const { palette } = clipboardArchive;

    await expect(palette.locator('.clip-row--selected')).toContainText('three');
    await palette.getByRole('searchbox', { name: 'Search history' }).press('Delete');

    await expect(palette.locator('.clip-row')).toHaveCount(2);
    await expect(palette.locator('.clip-row--selected')).toContainText('two');
  });

  test('Delete edits the search text while there is any, and deletes a clip only from an empty box', async ({
    clipboardArchive,
  }) => {
    await copyAll(clipboardArchive, ['one', 'two', 'three']);
    const { palette } = clipboardArchive;
    const search = palette.getByRole('searchbox', { name: 'Search history' });

    await search.fill('two');
    await expect(palette.locator('.clip-row--selected')).toContainText('two');
    await search.press('Home');
    await search.press('Delete');
    await expect(search).toHaveValue('wo');
    await search.press('End');
    await search.press('Delete'); // caret at the end: still the field's key, nothing happens
    await expect(search).toHaveValue('wo');

    await search.fill(''); // select all + Delete: clears the text, keeps every clip
    await expect(palette.locator('.clip-row')).toHaveCount(3);

    await search.press('Delete');
    await expect(palette.locator('.clip-row')).toHaveCount(2);
    await expect(palette.locator('.clip-row', { hasText: 'three' })).toHaveCount(0);
  });

  test('pinned filter shows only pinned clips', async ({ clipboardArchive }) => {
    await copyAll(clipboardArchive, ['keep me', 'throwaway']);
    const { palette } = clipboardArchive;

    await palette.locator('.clip-row', { hasText: 'keep me' }).click();
    await palette.getByRole('searchbox', { name: 'Search history' }).press('Control+p');
    await expect(
      palette.locator('.clip-row', { hasText: 'keep me' }).locator('.clip-row__pin'),
    ).toBeVisible();

    await palette.getByRole('button', { name: 'Pinned' }).click();
    await expect(palette.locator('.clip-row')).toHaveCount(1);
    await expect(palette.locator('.clip-row')).toContainText('keep me');
  });

  test('screenshot: history', async ({ clipboardArchive }) => {
    test.skip(!SCREENSHOT_DIR, 'Set CLIPBOARD_ARCHIVE_SCREENSHOTS=1 to refresh README screenshots');
    await copyAll(clipboardArchive, [
      'npm run test:e2e -- --project=electron',
      URL_CLIP,
      SQL_CLIP,
      '#7c7cf8',
      JSON_CLIP,
    ]);
    await clipboardArchive.palette.waitForTimeout(300);
    await clipboardArchive.palette.screenshot({ path: join(SCREENSHOT_DIR ?? '', 'history.png') });
  });
});
