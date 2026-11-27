/// <reference lib="dom" />  // page.evaluate() callbacks run in the renderer
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCREENSHOT_DIR, copyAll, expect, test } from './fixtures';

test.describe('security', () => {
  test('the renderer has no Node.js and only the narrow bridge', async ({ clipboardArchive }) => {
    const globals = await clipboardArchive.palette.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return {
        require: typeof w.require,
        process: typeof w.process,
        bridge: Object.keys(w.clipboardArchive as object).sort(),
      };
    });
    expect(globals.require).toBe('undefined');
    expect(globals.process).toBe('undefined');
    expect(globals.bridge).toEqual([
      'app',
      'compare',
      'history',
      'screenshots',
      'settings',
      'stats',
      'window',
    ]);
  });

  test('the bridge rejects malformed arguments', async ({ clipboardArchive }) => {
    const message = await clipboardArchive.palette.evaluate(async () => {
      const api = (
        window as unknown as {
          clipboardArchive: { history: { remove(id: unknown): Promise<number> } };
        }
      ).clipboardArchive;
      try {
        await api.history.remove('DROP TABLE clips');
        return 'accepted';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(message).toMatch(/invalid/i);
  });

  test('navigation away from the app is blocked', async ({ clipboardArchive }) => {
    const before = clipboardArchive.palette.url();
    await clipboardArchive.palette.evaluate(() => {
      window.location.href = 'https://example.com/';
    });
    await clipboardArchive.palette.waitForTimeout(500);
    expect(clipboardArchive.palette.url()).toBe(before);
  });

  test('navigation to another local HTML file is blocked too', async ({ clipboardArchive }) => {
    // A local page in the app window would get the preload; only the exact app document may load.
    const dir = mkdtempSync(join(tmpdir(), 'clipboard-archive-nav-'));
    const other = join(dir, 'index.html');
    writeFileSync(other, '<!doctype html><title>other</title>');
    try {
      const before = clipboardArchive.palette.url();
      await clipboardArchive.palette.evaluate((url) => {
        window.location.href = url;
      }, pathToFileURL(other).href);
      await clipboardArchive.palette.waitForTimeout(500);
      expect(clipboardArchive.palette.url()).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the compare window can only use the channels it needs', async ({ clipboardArchive }) => {
    await clipboardArchive.copy('A');
    await clipboardArchive.pressCompare();
    const compare = await clipboardArchive.compareWindow();

    const results = await compare.evaluate(async () => {
      const api = (
        window as unknown as {
          clipboardArchive: {
            app: { info(): Promise<unknown> };
            history: { clear(options: { keepPinned: boolean }): Promise<number> };
          };
        }
      ).clipboardArchive;
      const outcome = (call: Promise<unknown>): Promise<string> =>
        call.then(
          () => 'ok',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
      return {
        info: await outcome(api.app.info()),
        clear: await outcome(api.history.clear({ keepPinned: false })),
      };
    });

    expect(results.info).toBe('ok');
    expect(results.clear).toMatch(/untrusted sender/);
  });
});

test.describe('stats and settings', () => {
  test('stats count copies per kind', async ({ clipboardArchive }) => {
    await copyAll(clipboardArchive, ['{"a":1}', 'https://example.com/docs', 'plain words']);
    const { palette } = clipboardArchive;

    await palette.getByRole('tab', { name: 'Stats' }).click();
    await expect(
      palette.locator('.kpi', { hasText: 'Copies today' }).locator('.kpi__value'),
    ).toHaveText('3');
    await expect(palette.locator('.kinds__legend')).toHaveText(
      ['JSON1 · 34%', 'URL1 · 33%', 'Text1 · 33%'].join(''),
    ); // largest remainder: sums to 100

    await palette.getByRole('button', { name: 'Table' }).click();
    await expect(palette.locator('.count-table').first()).toBeVisible();
    if (SCREENSHOT_DIR) {
      await palette.getByRole('button', { name: 'Chart' }).click();
      await palette.screenshot({ path: join(SCREENSHOT_DIR, 'stats.png') });
    }
  });

  test('pausing capture stops recording', async ({ clipboardArchive }) => {
    const { palette } = clipboardArchive;
    await palette.getByRole('tab', { name: 'Settings' }).click();
    await palette.getByRole('switch', { name: 'Record clipboard' }).click();
    await expect(palette.getByRole('switch', { name: 'Record clipboard' })).toHaveAttribute(
      'aria-checked',
      'false',
    );

    await clipboardArchive.copy('secret while paused');
    await palette.waitForTimeout(800);
    await palette.getByRole('tab', { name: 'History' }).click();
    await expect(palette.locator('.clip-row')).toHaveCount(0);
    await expect(palette.locator('.statusbar')).toContainText('Paused');
  });

  test('launch at login is stored through the sandboxed login item, never the real OS', async ({
    clipboardArchive,
  }) => {
    const { palette, app } = clipboardArchive;
    // Replace the OS call with a counter: it must stay at zero, and the PC stays untouched either way.
    await app.evaluate(({ app: electronApp }) => {
      const state = globalThis as unknown as { loginItemCalls: number };
      state.loginItemCalls = 0;
      electronApp.setLoginItemSettings = () => {
        state.loginItemCalls += 1;
      };
    });
    await palette.getByRole('tab', { name: 'Settings' }).click();

    const toggle = palette.getByRole('switch', { name: 'Launch at login' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(palette.locator('.settings__capture')).toHaveText('Capture: test sandbox');
    expect(
      await app.evaluate(
        () => (globalThis as unknown as { loginItemCalls: number }).loginItemCalls,
      ),
    ).toBe(0);
  });

  test('excluded apps can be added and removed', async ({ clipboardArchive }) => {
    const { palette } = clipboardArchive;
    await palette.getByRole('tab', { name: 'Settings' }).click();

    const input = palette.getByRole('textbox', { name: 'Add excluded app' });
    await input.fill('Signal.exe');
    await input.press('Enter');
    await expect(palette.locator('.chip', { hasText: 'Signal.exe' })).toBeVisible();

    await palette.getByRole('button', { name: 'Stop excluding Signal.exe' }).click();
    await expect(palette.locator('.chip', { hasText: 'Signal.exe' })).toHaveCount(0);
  });
});
