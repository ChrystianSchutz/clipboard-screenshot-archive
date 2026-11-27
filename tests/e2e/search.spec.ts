import { join } from 'node:path';
import { expect, test, type ClipboardArchiveFixture, type CopySource } from './fixtures';

/** Set to a folder to save screenshots of search, chips, operators and Top categories. */
const SHOTS_DIR = process.env.CLIPBOARD_ARCHIVE_SEARCH_SHOTS ?? null;

const SQL = "SELECT id, email FROM users WHERE created_at > now() - interval '1 day'";
const SQL_2 = 'UPDATE orders SET status = "shipped" WHERE id = 1042';
const EMAIL = 'ada.lovelace@example.com';
const ERROR =
  "TypeError: Cannot read properties of undefined (reading 'email')\n    at render (app.js:12:5)";
const COLOR = '#7c7cf8';
const TEXT = 'Remember to email the weekly users report';
const COMMAND = 'npm run test:e2e -- --project=electron';
const UUID = 'Request failed, trace id 3f2b8c1e-9d4a-4c7e-8b21-5a6f0e9d1c34';

const CHROME: CopySource = {
  exe: 'chrome.exe',
  url: 'https://github.com/electron/electron/issues',
};
const CODE: CopySource = { exe: 'Code.exe' };
const SLACK: CopySource = { exe: 'slack.exe' };
const TERMINAL: CopySource = { exe: 'WindowsTerminal.exe' };
const DBEAVER: CopySource = { exe: 'dbeaver.exe' };

/** Copies each `[text, source]` pair and waits for it to appear, so captures never race. */
async function copyFrom(
  clipboardArchive: ClipboardArchiveFixture,
  copies: readonly (readonly [string, CopySource])[],
): Promise<void> {
  for (const [index, [text, source]] of copies.entries()) {
    await clipboardArchive.copy(text, source);
    await expect(clipboardArchive.palette.locator('.clip-row')).toHaveCount(index + 1);
  }
}

const SEED: readonly (readonly [string, CopySource])[] = [
  [TEXT, SLACK],
  [SQL, DBEAVER],
  [EMAIL, CHROME],
  [ERROR, CHROME],
  [COLOR, CODE],
  [SQL_2, CODE],
  [COMMAND, TERMINAL],
  [UUID, SLACK],
];

test.describe('search and categories', () => {
  test('shows category chips on rows and in the preview', async ({ clipboardArchive }) => {
    await copyFrom(clipboardArchive, [
      [SQL, DBEAVER],
      [EMAIL, CHROME],
      [TEXT, SLACK],
    ]);
    const { palette } = clipboardArchive;
    const row = (text: string) => palette.locator('.clip-row', { hasText: text });

    await expect(row(SQL).locator('.category-chip')).toHaveText(['SQL']);
    await expect(row(EMAIL).locator('.category-chip')).toHaveText(['Email']);
    await expect(row(TEXT).locator('.category-chip')).toHaveCount(0);

    await row(SQL).click();
    await expect(palette.locator('.preview__header .category-chip')).toHaveText(['SQL']);
  });

  test('typing #sql filters by category and shows the active operator', async ({
    clipboardArchive,
  }) => {
    await copyFrom(clipboardArchive, SEED);
    const { palette } = clipboardArchive;

    await palette.getByRole('searchbox', { name: 'Search history' }).fill('#sql');

    await expect(palette.locator('.clip-row')).toHaveCount(2);
    await expect(palette.locator('.clip-row').nth(0)).toContainText('UPDATE orders');
    await expect(palette.locator('.clip-row').nth(1)).toContainText('SELECT id, email');
    const operators = palette.getByRole('list', { name: 'Active search operators' });
    await expect(operators.getByRole('listitem')).toHaveText(['#SQL']);
    await expect(palette.getByRole('combobox', { name: 'Category' })).toBeDisabled();
  });

  test('combines #sql with free text, which is still highlighted', async ({ clipboardArchive }) => {
    await copyFrom(clipboardArchive, SEED);
    const { palette } = clipboardArchive;

    await palette.getByRole('searchbox', { name: 'Search history' }).fill('email #sql');

    await expect(palette.locator('.clip-row')).toHaveCount(1);
    await expect(palette.locator('.clip-row')).toContainText('SELECT id, email');
    await expect(palette.locator('.clip-row mark')).toHaveText(['email']);
  });

  test('app: and is:pinned operators resolve and combine', async ({ clipboardArchive }) => {
    await copyFrom(clipboardArchive, SEED);
    const { palette } = clipboardArchive;
    const search = palette.getByRole('searchbox', { name: 'Search history' });

    await search.fill('app:chrome');
    await expect(palette.locator('.clip-row')).toHaveCount(2);
    await expect(palette.getByRole('list', { name: 'Active search operators' })).toContainText(
      'Chrome',
    );

    await palette.locator('.clip-row', { hasText: EMAIL }).click();
    await search.press('Control+p');
    await search.fill('app:chrome is:pinned');
    await expect(palette.locator('.clip-row')).toHaveCount(1);
    await expect(palette.locator('.clip-row')).toContainText(EMAIL);
  });

  test('an unknown app: is flagged and matches nothing', async ({ clipboardArchive }) => {
    await copyFrom(clipboardArchive, SEED.slice(0, 3));
    const { palette } = clipboardArchive;

    await palette.getByRole('searchbox', { name: 'Search history' }).fill('app:photoshop');

    await expect(palette.locator('.operator--unresolved')).toContainText('photoshop');
    await expect(palette.getByText('No clips match')).toBeVisible();
  });

  test('removing an operator chip takes it out of the search text', async ({
    clipboardArchive,
  }) => {
    await copyFrom(clipboardArchive, SEED);
    const { palette } = clipboardArchive;
    const search = palette.getByRole('searchbox', { name: 'Search history' });

    await search.fill('email #sql');
    await expect(palette.locator('.clip-row')).toHaveCount(1);

    await palette.getByRole('button', { name: 'Remove Category: SQL' }).click();

    await expect(search).toHaveValue('email');
    // The SQL query, the error and the note all mention "email".
    await expect(palette.locator('.clip-row')).toHaveCount(3);
    await expect(palette.getByRole('list', { name: 'Active search operators' })).toHaveCount(0);
  });

  test('the category filter narrows the list and combines with text search', async ({
    clipboardArchive,
  }) => {
    await copyFrom(clipboardArchive, SEED);
    const { palette } = clipboardArchive;
    const category = palette.getByRole('combobox', { name: 'Category' });

    await category.selectOption({ label: 'Email' });
    await expect(palette.locator('.clip-row')).toHaveCount(1);
    await expect(palette.locator('.clip-row')).toContainText(EMAIL);

    await category.selectOption({ label: 'SQL' });
    await palette.getByRole('searchbox', { name: 'Search history' }).fill('orders');
    await expect(palette.locator('.clip-row')).toHaveCount(1);
    await expect(palette.locator('.clip-row')).toContainText('UPDATE orders');

    await category.selectOption({ label: 'Any category' });
    await expect(palette.locator('.clip-row')).toHaveCount(1); // still "orders"
  });

  test('clicking a chip in the preview filters by that category', async ({ clipboardArchive }) => {
    await copyFrom(clipboardArchive, SEED);
    const { palette } = clipboardArchive;

    await palette.locator('.clip-row', { hasText: 'SELECT id, email' }).click();
    await palette.locator('.preview__header').getByRole('button', { name: 'SQL' }).click();

    await expect(palette.getByRole('combobox', { name: 'Category' })).toHaveValue('sql');
    await expect(palette.locator('.clip-row')).toHaveCount(2);
  });

  test('stats rank the top categories, with a table view', async ({ clipboardArchive }) => {
    await copyFrom(clipboardArchive, SEED);
    const { palette } = clipboardArchive;

    await palette.getByRole('tab', { name: 'Stats' }).click();
    const card = palette.getByRole('region', { name: 'Top categories' });
    await expect(card.locator('.ranked__label').first()).toHaveText('SQL');
    await expect(card.locator('.ranked__row').first()).toContainText('2');

    await palette
      .getByRole('group', { name: 'Display' })
      .getByRole('button', { name: 'Table' })
      .click();
    await expect(card.locator('thead')).toContainText('Clips');
    await expect(card.locator('tbody tr').first()).toContainText('SQL');
  });

  test('screenshots: history with chips and operators, stats with top categories', async ({
    clipboardArchive,
  }) => {
    test.skip(!SHOTS_DIR, 'Set CLIPBOARD_ARCHIVE_SEARCH_SHOTS=<folder> to save screenshots');
    const dir = SHOTS_DIR ?? '';
    await copyFrom(clipboardArchive, SEED);
    const { palette } = clipboardArchive;
    await palette.setViewportSize({ width: 1000, height: 640 });
    await palette.waitForTimeout(300);
    await palette.screenshot({ path: join(dir, 'history-chips.png') });

    await palette.getByRole('searchbox', { name: 'Search history' }).fill('email #sql app:dbeaver');
    await expect(palette.locator('.clip-row')).toHaveCount(1);
    await palette.waitForTimeout(200);
    await palette.screenshot({ path: join(dir, 'history-operators.png') });

    // Escape clears the search box.
    await palette.getByRole('searchbox', { name: 'Search history' }).press('Escape');
    await palette.getByRole('combobox', { name: 'Category' }).selectOption({ label: 'SQL' });
    await expect(palette.locator('.clip-row')).toHaveCount(2);
    await palette.waitForTimeout(200);
    await palette.screenshot({ path: join(dir, 'history-category-filter.png') });

    await palette.getByRole('tab', { name: 'Stats' }).click();
    const card = palette.getByRole('region', { name: 'Top categories' });
    await expect(card).toBeVisible();
    // The stats view scrolls inside the window, so bring the card into view first.
    await card.scrollIntoViewIfNeeded();
    await palette.waitForTimeout(300);
    await palette.screenshot({ path: join(dir, 'stats-top-categories.png') });

    await palette
      .getByRole('group', { name: 'Display' })
      .getByRole('button', { name: 'Table' })
      .click();
    await card.scrollIntoViewIfNeeded();
    await palette.waitForTimeout(200);
    await palette.screenshot({ path: join(dir, 'stats-top-categories-table.png') });
  });
});
