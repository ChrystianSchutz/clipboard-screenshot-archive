/// <reference lib="dom" />  // page.evaluate() callbacks run in the renderer
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { SCREENSHOT_DIR, copyAll, expect, test, type ClipboardArchiveFixture } from './fixtures';

const SHOTS = {
  terminal: readFileSync(join('tests', 'fixtures', 'ocr', 'terminal.png')),
  code: readFileSync(join('tests', 'fixtures', 'ocr', 'code.png')),
  polish: readFileSync(join('tests', 'fixtures', 'ocr', 'polish.png')),
};
const SNIPPING_TOOL = { exe: 'SnippingTool.exe' } as const;
const OCR_TIMEOUT_MS = 20_000;
/** Where the visual check goes (see screenshots.spec.ts). */
const CAPTURE_DIR = SCREENSHOT_DIR ?? process.env.CLIPBOARD_ARCHIVE_REVIEW_DIR ?? null;
/** Ctrl on Windows and Linux, Cmd on macOS: the selection toggle key. */
const MOD = 'ControlOrMeta';

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

const row = (page: Page, text: string) => page.locator('.clip-row', { hasText: text });
const list = (page: Page) => page.getByRole('listbox', { name: 'Clipboard history' });
const summaryPane = (page: Page) => page.getByRole('region', { name: 'Selected clips' });
const selectionCount = (page: Page) => page.locator('.statusbar__selection');
const selectionMenu = (page: Page, name: string) => page.getByRole('menu', { name });

/** The texts of the selected rows, top to bottom. */
async function selectedRows(page: Page): Promise<string[]> {
  return page
    .locator('.clip-row[aria-selected="true"] .clip-row__title')
    .allInnerTexts()
    .then((titles) => titles.map((title) => title.trim()));
}

async function expectSelected(page: Page, texts: readonly string[]): Promise<void> {
  await expect.poll(() => selectedRows(page)).toEqual(texts);
}

test.describe('multi-selection in History', () => {
  test('Ctrl+click toggles, Shift+click selects a range, Ctrl+Shift+click adds one', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    // Newest first: five, four, three, two, one.
    await copyAll(clipboardArchive, ['one', 'two', 'three', 'four', 'five']);
    await expect(list(palette)).toHaveAttribute('aria-multiselectable', 'true');

    await row(palette, 'five').click();
    await row(palette, 'three').click({ modifiers: [MOD] });
    await expectSelected(palette, ['five', 'three']);
    await expect(summaryPane(palette).getByRole('heading')).toHaveText('2 clips selected');
    await expect(selectionCount(palette)).toHaveText(/2 selected/);
    await expect(selectionCount(palette)).toHaveAttribute('role', 'status');

    // Shift+click replaces the selection with the range from the anchor (three).
    await row(palette, 'one').click({ modifiers: ['Shift'] });
    await expectSelected(palette, ['three', 'two', 'one']);

    // Ctrl+Shift+click adds the range from the anchor to the clicked row.
    await row(palette, 'five').click({ modifiers: [MOD, 'Shift'] });
    await expectSelected(palette, ['five', 'four', 'three', 'two', 'one']);
    await expect(selectionCount(palette)).toHaveText(/5 selected/);

    // Ctrl+click takes one out again; a plain click goes back to one row and the preview.
    await row(palette, 'four').click({ modifiers: [MOD] });
    await expectSelected(palette, ['five', 'three', 'two', 'one']);
    await row(palette, 'two').click();
    await expectSelected(palette, ['two']);
    await expect(summaryPane(palette)).toHaveCount(0);
    await expect(palette.getByRole('region', { name: 'Selected clip' })).toBeVisible();
    await expect(selectionCount(palette)).toHaveText('');
  });

  test('Shift+arrows extend, plain arrows collapse, Esc collapses before it clears the search', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    await copyAll(clipboardArchive, ['alpha 1', 'alpha 2', 'alpha 3', 'alpha 4', 'beta']);
    const search = palette.getByRole('searchbox', { name: 'Search history' });
    await search.fill('alpha');
    await expect(palette.locator('.clip-row')).toHaveCount(4);

    await row(palette, 'alpha 4').click();
    await palette.keyboard.press('Shift+ArrowDown');
    await palette.keyboard.press('Shift+ArrowDown');
    await expectSelected(palette, ['alpha 4', 'alpha 3', 'alpha 2']);
    await palette.keyboard.press('Shift+ArrowUp');
    await expectSelected(palette, ['alpha 4', 'alpha 3']);

    // A plain arrow moves on and selects only the next row.
    await palette.keyboard.press('ArrowDown');
    await expectSelected(palette, ['alpha 2']);

    await palette.keyboard.press('Shift+ArrowDown');
    await palette.keyboard.press('Shift+ArrowDown');
    await expectSelected(palette, ['alpha 2', 'alpha 1']);
    // Esc: first back to the focused row, then the search text goes.
    await palette.keyboard.press('Escape');
    await expectSelected(palette, ['alpha 1']);
    await expect(search).toHaveValue('alpha');
    await palette.keyboard.press('Escape');
    await expect(search).toHaveValue('');
    await expect(palette.locator('.clip-row')).toHaveCount(5);
    await expectSelected(palette, ['alpha 1']);
  });

  test('Ctrl+A selects every row from the list or the empty search box; filters drop hidden rows', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    await copyAll(clipboardArchive, ['red apple', 'green apple', 'red cherry', 'blue berry']);
    const search = palette.getByRole('searchbox', { name: 'Search history' });

    // In the search box, Ctrl+A is the text box's own select-all.
    await search.fill('apple');
    await search.press('ControlOrMeta+a');
    await expect(summaryPane(palette)).toHaveCount(0);
    await expect
      .poll(() => search.evaluate((input: HTMLInputElement) => input.selectionEnd))
      .toBe(5);
    await search.fill('');
    await expect(palette.locator('.clip-row')).toHaveCount(4);

    // In the empty box there is no text to select: Ctrl+A selects every row, and typing goes on.
    await search.press('ControlOrMeta+a');
    await expect(summaryPane(palette).getByRole('heading')).toHaveText('4 clips selected');
    await expect(search).toBeFocused();
    await palette.keyboard.press('Escape');
    await expect(summaryPane(palette)).toHaveCount(0);

    // The list is one Tab stop, so the keyboard alone reaches it from the search box.
    await expect(list(palette)).toHaveAttribute('tabindex', '0');
    for (let tabs = 0; tabs < 12; tabs++) {
      if (await list(palette).evaluate((element) => element === document.activeElement)) break;
      await palette.keyboard.press('Tab');
    }
    await expect(list(palette)).toBeFocused();

    await row(palette, 'red cherry').click();
    await expect(list(palette)).toBeFocused();
    await palette.keyboard.press('ControlOrMeta+a');
    await expect(summaryPane(palette).getByRole('heading')).toHaveText('4 clips selected');

    // Searching hides two rows: they leave the selection, and do not come back afterwards.
    await search.fill('red');
    await expect(palette.locator('.clip-row')).toHaveCount(2);
    await expect(summaryPane(palette).getByRole('heading')).toHaveText('2 clips selected');
    await search.fill('');
    await expect(palette.locator('.clip-row')).toHaveCount(4);
    await expectSelected(palette, ['red cherry', 'red apple']);
  });

  test('Enter copies the selected texts joined in list order, skipping images', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    await copyAll(clipboardArchive, ['first line', 'second line', 'third line']);
    await clipboardArchive.copyImage(SHOTS.terminal, SNIPPING_TOOL);
    await expect(palette.locator('.clip-row')).toHaveCount(4);

    await row(palette, 'third line').click();
    await palette.keyboard.press('ControlOrMeta+a');
    await expect(summaryPane(palette).getByRole('heading')).toHaveText('4 clips selected');
    const copy = summaryPane(palette).getByRole('button', { name: /^Copy 3 clips/ });
    await expect(copy).toHaveAttribute('title', '1 image will be skipped');

    await palette.keyboard.press('Enter');
    await expect
      .poll(() => clipboardArchive.readClipboard())
      .toBe('third line\nsecond line\nfirst line');
    await expect(palette.locator('.toast')).toContainText('Copied 3 clips, 1 image skipped');
    // The joined text is not recorded as a new clip, and nothing moved.
    await palette.waitForTimeout(300);
    await expect(palette.locator('.clip-row')).toHaveCount(4);
    await expect(palette.locator('.clip-row').nth(1)).toContainText('third line');
  });

  test('right-click keeps a selection it lands in, with counts in the menu, and pins all', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    await copyAll(clipboardArchive, ['one', 'two', 'three', 'four']);
    await row(palette, 'four').click();
    await row(palette, 'two').click({ modifiers: ['Shift'] });

    await row(palette, 'three').click({ button: 'right' });
    const menu = selectionMenu(palette, 'Actions for 3 clips');
    await expect(menu).toBeVisible();
    await expectSelected(palette, ['four', 'three', 'two']);
    await expect(menu.getByRole('menuitem')).toHaveText([
      /^Copy 3 clips/,
      /^Pin 3 clips/,
      /^Delete 3 clips/,
    ]);

    await menu.getByRole('menuitem', { name: /^Pin 3 clips/ }).click();
    await expect(palette.locator('.toast')).toContainText('Pinned 3 clips');
    await expect(palette.locator('.clip-row .clip-row__pin')).toHaveCount(3);
    await expectSelected(palette, ['four', 'three', 'two']);

    // All pinned now: the same key unpins them all.
    await palette.keyboard.press('ControlOrMeta+p');
    await expect(palette.locator('.toast')).toContainText('Unpinned 3 clips');
    await expect(palette.locator('.clip-row .clip-row__pin')).toHaveCount(0);

    // A right-click outside the selection selects just that row.
    await row(palette, 'one').click({ button: 'right' });
    await expect(palette.getByRole('menu', { name: 'Clip actions' })).toBeVisible();
    await expectSelected(palette, ['one']);
    await palette.keyboard.press('Escape');
  });

  test('Delete asks first, a second Delete removes them all and focus moves on', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    await copyAll(clipboardArchive, ['one', 'two', 'three', 'four', 'five']);
    await row(palette, 'four').click();
    await row(palette, 'two').click({ modifiers: ['Shift'] });

    // Esc cancels the confirmation and keeps the selection.
    await palette.keyboard.press('Delete');
    const confirm = summaryPane(palette).getByRole('alert');
    await expect(confirm).toContainText('Delete 3 clips?');
    await palette.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expectSelected(palette, ['four', 'three', 'two']);
    await expect(palette.locator('.clip-row')).toHaveCount(5);

    // Changing the selection cancels it too.
    await palette.keyboard.press('Delete');
    await expect(confirm).toBeVisible();
    await row(palette, 'five').click({ modifiers: [MOD] });
    await expect(confirm).toHaveCount(0);
    await row(palette, 'five').click({ modifiers: [MOD] });

    await palette.keyboard.press('Delete');
    await expect(confirm).toBeVisible();
    await palette.keyboard.press('Delete');
    await expect(palette.locator('.clip-row')).toHaveCount(2);
    await expect(palette.locator('.toast')).toContainText('Deleted 3 clips');
    // The row below the deleted ones takes the focus.
    await expectSelected(palette, ['one']);
    await expect(row(palette, 'five')).toBeVisible();
  });

  test('the Delete button in the confirmation deletes; the menu asks first as well', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    await copyAll(clipboardArchive, ['one', 'two', 'three']);
    await row(palette, 'three').click();
    await row(palette, 'two').click({ modifiers: ['Shift'] });

    await row(palette, 'two').click({ button: 'right' });
    await selectionMenu(palette, 'Actions for 2 clips')
      .getByRole('menuitem', { name: /^Delete 2 clips/ })
      .click();
    const confirm = summaryPane(palette).getByRole('alert');
    await expect(confirm).toContainText('Delete 2 clips?');
    await expect(palette.locator('.clip-row')).toHaveCount(3);
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(palette.locator('.clip-row')).toHaveCount(1);
    await expectSelected(palette, ['one']);
  });

  test('Enter on the confirmation buttons presses them, and the keys stay on the list', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    await copyAll(clipboardArchive, ['one', 'two', 'three', 'four', 'five', 'six']);
    await row(palette, 'five').click();
    await row(palette, 'three').click({ modifiers: ['Shift'] });
    const confirm = summaryPane(palette).getByRole('alert');

    // Enter on a focused Cancel cancels. It used to reach the list and copy the selection.
    await palette.keyboard.press('Delete');
    await confirm.getByRole('button', { name: 'Cancel' }).focus();
    await palette.keyboard.press('Enter');
    await expect(confirm).toHaveCount(0);
    await expectSelected(palette, ['five', 'four', 'three']);
    await expect(list(palette)).toBeFocused();
    await expect(palette.locator('.toast')).toHaveCount(0);
    expect(await clipboardArchive.readClipboard()).toBe('six');

    // Space on a focused Cancel as well.
    await palette.keyboard.press('Delete');
    await confirm.getByRole('button', { name: 'Cancel' }).focus();
    await palette.keyboard.press('Space');
    await expect(confirm).toHaveCount(0);
    await expect(list(palette)).toBeFocused();

    // Enter on a focused Delete deletes; focus returns to the list and the arrows work.
    await palette.keyboard.press('Delete');
    await confirm.getByRole('button', { name: 'Delete' }).focus();
    await palette.keyboard.press('Enter');
    await expect(palette.locator('.clip-row')).toHaveCount(3);
    await expect(palette.locator('.toast')).toContainText('Deleted 3 clips');
    await expectSelected(palette, ['two']);
    await expect(list(palette)).toBeFocused();
    await palette.keyboard.press('ArrowUp');
    await expectSelected(palette, ['six']);

    // A mouse click on Delete leaves the keyboard on the list too (it used to land on the page).
    await palette.keyboard.press('Shift+ArrowDown');
    await expectSelected(palette, ['six', 'two']);
    await palette.keyboard.press('Delete');
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(palette.locator('.clip-row')).toHaveCount(1);
    await expect(list(palette)).toBeFocused();
    expect(await palette.evaluate(() => document.activeElement === document.body)).toBe(false);
    expect(await clipboardArchive.readClipboard()).toBe('six');
  });

  test('a new copy from a new app keeps all 60 selected rows and the pending delete', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    // 60 rows: exactly the first page.
    const texts = Array.from(
      { length: 60 },
      (_, index) => `item-${String(index + 1).padStart(2, '0')}`,
    );
    await copyAll(clipboardArchive, texts);
    await row(palette, 'item-60').click();
    await palette.keyboard.press('ControlOrMeta+a');
    await expect(summaryPane(palette).getByRole('heading')).toHaveText('60 clips selected');
    await palette.keyboard.press('Delete');
    const confirm = summaryPane(palette).getByRole('alert');
    await expect(confirm).toContainText('Delete 60 clips?');

    // From an app not in the history yet: the app filter's list changes too.
    await clipboardArchive.copy('new arrival', { exe: 'Obsidian.exe' });
    await expect(palette.locator('.clip-row')).toHaveCount(61);
    await expect(palette.locator('.clip-row').first()).toContainText('new arrival');
    // The refresh used to reload 60 rows: the oldest fell off, and with it the selection on it.
    await expect(summaryPane(palette).getByRole('heading')).toHaveText('60 clips selected');
    await expect(row(palette, 'item-01')).toHaveAttribute('aria-selected', 'true');
    await expect(row(palette, 'new arrival')).toHaveAttribute('aria-selected', 'false');
    await expect(confirm).toContainText('Delete 60 clips?');

    await palette.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
  });

  test('deleting every row leaves the keyboard in the view, on the search box', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    await copyAll(clipboardArchive, ['one', 'two', 'three']);
    await row(palette, 'three').click();
    await palette.keyboard.press('ControlOrMeta+a');
    await palette.keyboard.press('Delete');
    await summaryPane(palette).getByRole('alert').getByRole('button', { name: 'Delete' }).click();

    await expect(palette.locator('.clip-row')).toHaveCount(0);
    const search = palette.getByRole('searchbox', { name: 'Search history' });
    // It used to be left on the page body, where Esc missed the view's handler.
    await expect(search).toBeFocused();
    await palette.keyboard.type('gone');
    await expect(search).toHaveValue('gone');
  });

  test('Ctrl+D compares two selected text clips, the older one as A', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    await copyAll(clipboardArchive, ['older text', 'middle text', 'newer text']);

    // Three selected: Compare is not offered.
    await row(palette, 'newer text').click();
    await palette.keyboard.press('ControlOrMeta+a');
    await palette.keyboard.press('ControlOrMeta+d');
    await expect(palette.locator('.toast')).toContainText(
      'Select exactly two text clips to compare',
    );

    // The newer one first, the older one Ctrl+clicked: A is still the older.
    await row(palette, 'newer text').click();
    await row(palette, 'older text').click({ modifiers: [MOD] });
    await row(palette, 'older text').click({ button: 'right' });
    await expect(
      selectionMenu(palette, 'Actions for 2 clips').getByRole('menuitem', { name: /^Compare/ }),
    ).toBeVisible();
    await palette.keyboard.press('Escape');
    await palette.keyboard.press('ControlOrMeta+d');

    const compare = await clipboardArchive.compareWindow();
    await expect(
      compare.locator('.side-card', { has: compare.locator('.side-card__label--a') }),
    ).toContainText('older text');
    await expect(
      compare.locator('.side-card', { has: compare.locator('.side-card__label--b') }),
    ).toContainText('newer text');
  });
});

test.describe('multi-selection in the Screenshots gallery', () => {
  test.setTimeout(90_000);

  async function addShots(clipboardArchive: ClipboardArchiveFixture): Promise<Locator> {
    const { palette } = clipboardArchive;
    await palette.getByRole('tab', { name: 'Screenshots' }).click();
    // Newest first: polish, code, terminal.
    await clipboardArchive.copyImage(SHOTS.terminal, SNIPPING_TOOL);
    await clipboardArchive.copyImage(SHOTS.code, SNIPPING_TOOL);
    await clipboardArchive.copyImage(SHOTS.polish, SNIPPING_TOOL);
    const tiles = palette.getByRole('listbox', { name: 'Screenshots' }).getByRole('option');
    await expect(tiles).toHaveCount(3);
    return tiles;
  }

  const selectedTiles = (tiles: Locator) =>
    tiles.evaluateAll((elements) =>
      elements.flatMap((element, index) =>
        element.getAttribute('aria-selected') === 'true' ? [index] : [],
      ),
    );

  test('clicks, Shift+arrows, Ctrl+A and Esc select tiles; Copy is off, Copy text joins', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    const tiles = await addShots(clipboardArchive);
    const grid = palette.getByRole('listbox', { name: 'Screenshots' });
    await expect(grid).toHaveAttribute('aria-multiselectable', 'true');

    await tiles.nth(0).click();
    await tiles.nth(2).click({ modifiers: [MOD] });
    await expect.poll(() => selectedTiles(tiles)).toEqual([0, 2]);
    await expect(tiles.nth(2)).toBeFocused();
    await expect(summaryPane(palette).getByRole('heading')).toHaveText('2 screenshots selected');
    await expect(selectionCount(palette)).toHaveText(/2 selected/);

    await tiles.nth(0).click({ modifiers: ['Shift'] });
    await expect.poll(() => selectedTiles(tiles)).toEqual([0, 1, 2]);

    // A plain arrow collapses to the next tile; Shift+arrow extends again.
    await palette.keyboard.press('ArrowRight');
    await expect.poll(() => selectedTiles(tiles)).toEqual([1]);
    await palette.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => selectedTiles(tiles)).toEqual([1, 2]);
    await expect(tiles.nth(2)).toBeFocused();
    await palette.keyboard.press('Escape');
    await expect.poll(() => selectedTiles(tiles)).toEqual([2]);

    await palette.keyboard.press('ControlOrMeta+a');
    await expect.poll(() => selectedTiles(tiles)).toEqual([0, 1, 2]);
    const pane = summaryPane(palette);
    const copy = pane.getByRole('button', { name: 'Copy', exact: true });
    await expect(copy).toHaveAttribute('aria-disabled', 'true');
    await expect(copy).toHaveAttribute(
      'title',
      'Several images cannot be copied at once. Use Copy text.',
    );

    // Copy text joins the recognised text of the screenshots, in grid order.
    for (const index of [0, 1, 2]) {
      await expect(tiles.nth(index).locator('.shot-status')).toHaveText('Text', {
        timeout: OCR_TIMEOUT_MS,
      });
    }
    await pane.getByRole('button', { name: 'Copy text' }).click();
    await expect(palette.locator('.toast')).toContainText('Copied the text of 3 screenshots');
    const text = await clipboardArchive.readClipboard();
    expect(text.indexOf('fetchInvoices')).toBeGreaterThan(-1);
    expect(text.indexOf('fetchInvoices')).toBeLessThan(text.indexOf('ECONNRESET'));
    // Written without recording: no text clip turned up in History.
    await palette.getByRole('tab', { name: 'History' }).click();
    await expect(palette.locator('.clip-row')).toHaveCount(3);
  });

  test('right-click keeps the selection; Delete asks first, then removes the tiles', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    const tiles = await addShots(clipboardArchive);
    await tiles.nth(0).click();
    await tiles.nth(1).click({ modifiers: ['Shift'] });

    await tiles.nth(1).click({ button: 'right' });
    const menu = selectionMenu(palette, 'Actions for 2 screenshots');
    await expect(menu.getByRole('menuitem')).toHaveText([
      /^Copy/,
      /^Copy text of 2 screenshots/,
      /^Pin 2 screenshots/,
      /^Delete 2 screenshots/,
    ]);
    await expect(menu.getByRole('menuitem', { name: 'Copy', exact: true })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await palette.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect.poll(() => selectedTiles(tiles)).toEqual([0, 1]);

    await palette.keyboard.press('Delete');
    const confirm = summaryPane(palette).getByRole('alert');
    await expect(confirm).toContainText('Delete 2 screenshots?');
    // Clicking Cancel puts the focus back on the focused tile, so the keys keep working.
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(tiles.nth(1)).toBeFocused();
    await expect.poll(() => selectedTiles(tiles)).toEqual([0, 1]);

    // Ctrl+A in the empty search box selects every tile, as in History.
    const search = palette.getByRole('searchbox', { name: 'Search screenshots' });
    await search.focus();
    await search.press('ControlOrMeta+a');
    await expect.poll(() => selectedTiles(tiles)).toEqual([0, 1, 2]);
    await tiles.nth(1).click({ modifiers: [MOD] });
    await expect.poll(() => selectedTiles(tiles)).toEqual([0, 2]);

    await palette.keyboard.press('Delete');
    await expect(confirm).toContainText('Delete 2 screenshots?');
    await palette.keyboard.press('Delete');
    await expect(tiles).toHaveCount(1);
    await expect(palette.locator('.toast')).toContainText('Deleted 2 screenshots');
    await expect(tiles.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(tiles.nth(0)).toBeFocused();

    // Deleting the last tile moves focus to the search box (no tile is left to take it).
    await palette.keyboard.press('Delete');
    await expect(tiles).toHaveCount(0);
    await expect(search).toBeFocused();
  });
});

test.describe('multi-selection visual check', () => {
  test.setTimeout(90_000);

  test('History, the menu, the confirmation and the gallery', async ({ clipboardArchive }) => {
    test.skip(!CAPTURE_DIR, 'Set CLIPBOARD_ARCHIVE_REVIEW_DIR to capture');
    const dir = CAPTURE_DIR ?? '';
    const { palette } = clipboardArchive;
    await clipboardArchive.copy('{"user":{"id":42,"name":"Ada"},"roles":["admin","dev"]}', {
      exe: 'Code.exe',
    });
    await clipboardArchive.copy('https://github.com/electron/electron/releases', {
      exe: 'chrome.exe',
      url: 'https://github.com/electron/electron/releases',
    });
    await clipboardArchive.copy(
      "SELECT id, email FROM users WHERE created_at > now() - interval '1 day'",
      {
        exe: 'Code.exe',
      },
    );
    await clipboardArchive.copy('Meeting moved to Wednesday, 14:30', { exe: 'slack.exe' });
    await clipboardArchive.copyImage(SHOTS.terminal, SNIPPING_TOOL);
    await expect(palette.locator('.clip-row')).toHaveCount(5);

    await setTheme(clipboardArchive, 'dark');
    await palette.locator('.clip-row').nth(1).click();
    await palette
      .locator('.clip-row')
      .nth(3)
      .click({ modifiers: ['Shift'] });
    await expect(summaryPane(palette).getByRole('heading')).toHaveText('3 clips selected');
    await palette.waitForTimeout(300);
    await palette.screenshot({ path: join(dir, 'multi-select-history-dark.png') });
    await summaryPane(palette).screenshot({ path: join(dir, 'multi-select-summary-dark.png') });

    await palette.locator('.clip-row').nth(2).click({ button: 'right' });
    await expect(selectionMenu(palette, 'Actions for 3 clips')).toBeVisible();
    await palette.waitForTimeout(200);
    await palette.screenshot({ path: join(dir, 'multi-select-menu-dark.png') });
    await palette.keyboard.press('Escape');

    await palette.keyboard.press('Delete');
    await expect(summaryPane(palette).getByRole('alert')).toBeVisible();
    await palette.waitForTimeout(200);
    await palette.screenshot({ path: join(dir, 'multi-select-confirm-dark.png') });
    await setTheme(clipboardArchive, 'light');
    await palette.waitForTimeout(200);
    await palette.screenshot({ path: join(dir, 'multi-select-confirm-light.png') });
    await palette.keyboard.press('Escape');

    await palette.getByRole('tab', { name: 'Screenshots' }).click();
    await clipboardArchive.copyImage(SHOTS.code, SNIPPING_TOOL);
    await clipboardArchive.copyImage(SHOTS.polish, SNIPPING_TOOL);
    const tiles = palette.getByRole('listbox', { name: 'Screenshots' }).getByRole('option');
    await expect(tiles).toHaveCount(3);
    await tiles.nth(0).click();
    await tiles.nth(2).click({ modifiers: [MOD] });
    await expect(summaryPane(palette).getByRole('heading')).toHaveText('2 screenshots selected');
    await palette.waitForTimeout(400);
    await palette.screenshot({ path: join(dir, 'multi-select-gallery-light.png') });
    await setTheme(clipboardArchive, 'dark');
    await palette.waitForTimeout(300);
    await palette.screenshot({ path: join(dir, 'multi-select-gallery-dark.png') });
  });
});
