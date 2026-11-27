import { expect, test } from './fixtures';

test.describe('source attribution', () => {
  test('shows the copying app and the page domain, and links the page', async ({
    clipboardArchive,
  }) => {
    const pageUrl = 'https://docs.example.com/api/limits#burst';
    await clipboardArchive.copy('rate_limit_burst = 50', { exe: 'chrome.exe', url: pageUrl });

    const { palette } = clipboardArchive;
    const row = palette.locator('.clip-row', { hasText: 'rate_limit_burst = 50' });
    await expect(row.locator('.clip-row__source')).toHaveText('Chrome');
    await expect(row.locator('.clip-row__domain')).toHaveText('docs.example.com');

    await row.click();
    await expect(palette.locator('.preview__meta a')).toHaveAttribute('href', pageUrl);
  });

  test('content marked private by its owner is never recorded', async ({ clipboardArchive }) => {
    await clipboardArchive.copy('hunter2', { exe: 'KeePassXC.exe', hasPrivateFormat: true });
    await clipboardArchive.copy('visible');
    await expect(clipboardArchive.palette.locator('.clip-row')).toHaveCount(1);
    await expect(clipboardArchive.palette.locator('.clip-row')).toContainText('visible');
  });
});
