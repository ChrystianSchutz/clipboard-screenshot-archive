import { join } from 'node:path';
import { copyAll, expect, test, type ClipboardArchiveFixture } from './fixtures';

const FOLDER_OPTION = 'Import screenshots from the screenshot folder';
/** Where the review screenshots of the option go (agent runs only; never committed). */
const SHOT_DIR = process.env.CLIPBOARD_ARCHIVE_REVIEW_SHOTS ?? null;

interface SettingsBridge {
  clipboardArchive: {
    settings: {
      update(patch: { theme?: string }): Promise<unknown>;
      get(): Promise<{ importScreenshotFolder: boolean }>;
    };
  };
}

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

test.describe('screenshot-folder import option on macOS', () => {
  test.use({ appEnv: { CLIPBOARD_ARCHIVE_E2E_PLATFORM: 'darwin' } });

  test('is shown, off by default, and can be turned on', async ({ clipboardArchive }) => {
    const { palette } = clipboardArchive;
    await palette.getByRole('tab', { name: 'Settings' }).click();

    const toggle = palette.getByRole('switch', { name: FOLDER_OPTION });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(palette.getByText(FOLDER_OPTION, { exact: true })).toBeVisible();

    if (SHOT_DIR) {
      for (const theme of ['dark', 'light'] as const) {
        await forceTheme(clipboardArchive, theme);
        await palette.locator('.settings').screenshot({
          path: join(SHOT_DIR, `folder-option-${theme}.png`),
        });
      }
    }

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect
      .poll(() =>
        palette.evaluate(() =>
          (window as unknown as SettingsBridge).clipboardArchive.settings
            .get()
            .then((settings) => settings.importScreenshotFolder),
        ),
      )
      .toBe(true);
  });
});

test.describe('screenshot-folder import option elsewhere', () => {
  test('is hidden on Windows and Linux', async ({ clipboardArchive }) => {
    const { palette } = clipboardArchive;
    await palette.getByRole('tab', { name: 'Settings' }).click();

    await expect(palette.getByRole('switch', { name: 'Record clipboard' })).toBeVisible();
    await expect(palette.getByRole('switch', { name: FOLDER_OPTION })).toHaveCount(0);
  });
});

test.describe('restore marker', () => {
  test('an identical copy made by another app after a restore is recorded', async ({
    clipboardArchive,
  }) => {
    await copyAll(clipboardArchive, ['first', 'second']);
    const { palette } = clipboardArchive;

    await palette.getByRole('searchbox', { name: 'Search history' }).press('ArrowDown');
    await expect(palette.locator('.clip-row--selected')).toContainText('first');
    await palette.keyboard.press('Enter');
    await expect.poll(() => clipboardArchive.readClipboard()).toBe('first');

    // Another app copies exactly the same text: no marker, so it is a real copy (a bump).
    await clipboardArchive.copy('first');
    await expect(palette.locator('.clip-row').filter({ hasText: 'first' })).toContainText('×2');
    await expect(palette.locator('.clip-row')).toHaveCount(2);
  });
});
