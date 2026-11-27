import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _electron as electron,
  test as base,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

/** Where a simulated copy came from (what the Win32 probe reports in the real app). */
export interface CopySource {
  readonly exe?: string | null;
  readonly url?: string | null;
  readonly hasPrivateFormat?: boolean;
}

/** Mirrors `TestHooks` in src/main/app/clipboard-archive-app.ts. */
interface TestHooks {
  pressCompare(): Promise<void>;
  copy(text: string, source?: CopySource): Promise<void>;
  readClipboard(): Promise<string>;
  copyImage(pngBase64: string, source?: CopySource): Promise<void>;
  readClipboardImage(): Promise<string | null>;
  injectAnalysis(clipId: number, analysis: unknown): boolean;
  injectTextFailure(clipId: number): boolean;
}

export interface ClipboardArchiveFixture {
  readonly app: ElectronApplication;
  /** The history/stats/settings window. */
  readonly palette: Page;
  /** Puts text on the (sandboxed) clipboard, as if another app had copied it. */
  copy(text: string, source?: CopySource): Promise<void>;
  readClipboard(): Promise<string>;
  /** Puts a PNG (no text) on the sandboxed clipboard, as a screenshot tool would. */
  copyImage(png: Buffer, source?: CopySource): Promise<void>;
  /** The sandboxed clipboard's image, or null when it holds none. */
  readClipboardImage(): Promise<Buffer | null>;
  /** Stores an analysis for an image clip as if the analyzer had produced it. */
  injectAnalysis(clipId: number, analysis: unknown): Promise<boolean>;
  /** Marks an image clip's text as unreadable, as after a failed recognition. */
  injectTextFailure(clipId: number): Promise<boolean>;
  /** Same as pressing the global compare shortcut. */
  pressCompare(): Promise<void>;
  compareWindow(): Promise<Page>;
}

/** Where README screenshots go when `CLIPBOARD_ARCHIVE_SCREENSHOTS=1`. */
export const SCREENSHOT_DIR =
  process.env.CLIPBOARD_ARCHIVE_SCREENSHOTS === '1' ? 'docs/screenshots' : null;

/**
 * `electron.launch`, retried on `ETXTBSY`: on Linux, parallel workers can spawn the freshly
 * unpacked Electron binary while the kernel still counts it as open for writing. That error is
 * transient and says nothing about the app, so it is retried a few times; anything else is thrown.
 */
async function launchElectron(
  options: Parameters<typeof electron.launch>[0],
): Promise<ElectronApplication> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await electron.launch(options);
    } catch (error) {
      if (attempt >= 5 || !String(error).includes('ETXTBSY')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

export const test = base.extend<{
  /** Extra environment for the app (e.g. `CLIPBOARD_ARCHIVE_E2E_PLATFORM`), set with `test.use`. */
  appEnv: Record<string, string>;
  clipboardArchive: ClipboardArchiveFixture;
}>({
  appEnv: [{}, { option: true }],
  clipboardArchive: async ({ appEnv }, use) => {
    // Every test gets a fresh profile, so tests never see each other's history.
    const userData = mkdtempSync(join(tmpdir(), 'clipboard-archive-e2e-'));
    const app = await launchElectron({
      // Parallel agents build into their own folder (CLIPBOARD_ARCHIVE_OUT_DIR) so builds never collide.
      args: [`${process.env.CLIPBOARD_ARCHIVE_OUT_DIR ?? 'out'}/main/index.js`],
      // E2E mode = sandbox: hidden windows, no tray, no global shortcuts, in-memory clipboard.
      // The suite runs in the background without touching the desktop or the real clipboard.
      env: {
        ...process.env,
        ...appEnv,
        CLIPBOARD_ARCHIVE_E2E: '1',
        CLIPBOARD_ARCHIVE_USER_DATA: userData,
      },
    });

    const palette = await app.firstWindow();
    await palette.waitForSelector('.palette');

    const fixture: ClipboardArchiveFixture = {
      app,
      palette,
      // `evaluate` callbacks are serialised into the main process, so they cannot share helpers.
      copy: (text, source) =>
        app.evaluate(
          (_electron, [value, from]) =>
            (
              globalThis as unknown as { __clipboardArchiveTest: TestHooks }
            ).__clipboardArchiveTest.copy(value, from),
          [text, source] as const,
        ),
      readClipboard: () =>
        app.evaluate(() =>
          (
            globalThis as unknown as { __clipboardArchiveTest: TestHooks }
          ).__clipboardArchiveTest.readClipboard(),
        ),
      copyImage: (png, source) =>
        app.evaluate(
          (_electron, [value, from]) =>
            (
              globalThis as unknown as { __clipboardArchiveTest: TestHooks }
            ).__clipboardArchiveTest.copyImage(value, from),
          [png.toString('base64'), source] as const,
        ),
      readClipboardImage: async () => {
        const base64 = await app.evaluate(() =>
          (
            globalThis as unknown as { __clipboardArchiveTest: TestHooks }
          ).__clipboardArchiveTest.readClipboardImage(),
        );
        return base64 === null ? null : Buffer.from(base64, 'base64');
      },
      injectAnalysis: (clipId, analysis) =>
        app.evaluate(
          (_electron, [id, value]) =>
            (
              globalThis as unknown as { __clipboardArchiveTest: TestHooks }
            ).__clipboardArchiveTest.injectAnalysis(id, value),
          [clipId, analysis] as const,
        ),
      injectTextFailure: (clipId) =>
        app.evaluate(
          (_electron, id) =>
            (
              globalThis as unknown as { __clipboardArchiveTest: TestHooks }
            ).__clipboardArchiveTest.injectTextFailure(id),
          clipId,
        ),
      pressCompare: () =>
        app.evaluate(() =>
          (
            globalThis as unknown as { __clipboardArchiveTest: TestHooks }
          ).__clipboardArchiveTest.pressCompare(),
        ),
      compareWindow: async () => {
        await expect
          .poll(() => app.windows().some((page) => page.url().endsWith('#compare')))
          .toBe(true);
        const page = app.windows().find((candidate) => candidate.url().endsWith('#compare'));
        if (!page) throw new Error('Compare window did not open');
        await page.waitForSelector('.compare');
        return page;
      },
    };

    try {
      await use(fixture);
    } finally {
      await app.close();
      rmSync(userData, { recursive: true, force: true });
    }
  },
});

export { expect };

/** Copies each text and waits until the history shows it, so captures never race each other. */
export async function copyAll(
  clipboardArchive: ClipboardArchiveFixture,
  texts: readonly string[],
): Promise<void> {
  for (const [index, text] of texts.entries()) {
    await clipboardArchive.copy(text);
    await expect(clipboardArchive.palette.locator('.clip-row')).toHaveCount(index + 1);
  }
}
