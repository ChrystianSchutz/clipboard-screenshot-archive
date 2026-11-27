/// <reference lib="dom" />  // page.evaluate() callbacks run in the renderer
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { expect, test } from './fixtures';

/** A terminal screenshot whose text contains "ECONNRESET" (also used by screenshots.spec.ts). */
const TERMINAL_PNG = readFileSync(join('tests', 'fixtures', 'ocr', 'terminal.png'));
/** Text recognition runs in a utility process; the first run also loads the language data. */
const OCR_TIMEOUT_MS = 20_000;

/** Mirrors the `copy` test hook (see fixtures.ts), for copying many texts in one round trip. */
interface CopyHooks {
  __clipboardArchiveTest: { copy(text: string): Promise<void> };
}

/** The sandbox-only text recognition gate (see `exposeOcrGate` in screenshot-feature.ts). */
interface OcrGateHooks {
  __clipboardArchiveOcrGate: { hold(): void; release(): void };
}

/** One `history:query` answer: its search text, row count and the phase it was asked in. */
interface QueryAnswer {
  readonly text: string | null;
  readonly rows: number;
  /** `__historyQueryPhase` when the query arrived (before the handler ran), not when it answered. */
  readonly phase: number;
}

/** What `observeHistoryQueries` leaves in the main process. */
interface QueryProbe {
  __historyQueryAnswers: QueryAnswer[];
  __historyQueryPhase: number;
}

/**
 * Wraps the main process's `history:query` handler so the test sees every query and its answer:
 * the search text, the row count, and the phase (a counter the test moves) the query arrived in.
 * Electron keeps `ipcMain.handle` handlers in `_invokeHandlers` and looks the handler up on each
 * invoke, so replacing the entry observes every later query. Fails loudly if that changes.
 */
async function observeHistoryQueries(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    type Handler = (...args: unknown[]) => unknown;
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })
      ._invokeHandlers;
    const original = handlers?.get('history:query');
    if (!handlers || !original) throw new Error('Cannot observe history:query answers');
    const probe = globalThis as unknown as QueryProbe;
    probe.__historyQueryAnswers = [];
    probe.__historyQueryPhase = 0;
    handlers.set('history:query', async (...args: unknown[]) => {
      const phase = probe.__historyQueryPhase;
      const query = args[1] as { text?: unknown } | undefined;
      const text = typeof query?.text === 'string' ? query.text : null;
      const page = (await original(...args)) as { clips?: unknown[] };
      probe.__historyQueryAnswers.push({ text, rows: page.clips?.length ?? -1, phase });
      return page;
    });
  });
}

/** Resolves once the main process has answered a `text` search that arrived in `phase`, empty. */
async function emptyAnswerFor(app: ElectronApplication, text: string, phase: number) {
  await expect
    .poll(() =>
      app.evaluate(
        (_electron, wanted) =>
          (globalThis as unknown as QueryProbe).__historyQueryAnswers.some(
            (answer) =>
              answer.text === wanted.text && answer.rows === 0 && answer.phase === wanted.phase,
          ),
        { text, phase },
      ),
    )
    .toBe(true);
}

test.describe('history refresh', () => {
  test('a screenshot copied into an open search appears once its text is recognised', async ({
    clipboardArchive,
  }) => {
    const { palette } = clipboardArchive;
    await clipboardArchive.copy('npm ERR! something unrelated');
    await expect(palette.locator('.clip-row')).toHaveCount(1);

    const search = palette.getByRole('searchbox', { name: 'Search history' });
    await search.fill('ECONNRESET');
    await expect(palette.locator('.clip-row')).toHaveCount(0);

    // Copied while the search is open: the row has no searchable text until OCR finishes.
    await clipboardArchive.copyImage(TERMINAL_PNG, { exe: 'SnippingTool.exe' });

    // No retyping: the OCR commit invalidates the open search, which re-runs by itself.
    const row = palette.locator('.clip-row');
    await expect(row).toHaveCount(1, { timeout: OCR_TIMEOUT_MS });
    await expect(row).toContainText('Image 900×216');
    await expect(search).toHaveValue('ECONNRESET');
  });

  test('the recognition result itself brings the screenshot into an open search', async ({
    clipboardArchive,
  }) => {
    const { app, palette } = clipboardArchive;
    await observeHistoryQueries(app);
    const search = palette.getByRole('searchbox', { name: 'Search history' });
    await search.fill('ECONNRESET');
    // The list starts empty, so a zero-row assertion proves nothing: wait for the debounced
    // search itself to be answered (empty) before copying anything.
    await emptyAnswerFor(app, 'ECONNRESET', 0);
    await expect(palette.locator('.clip-row')).toHaveCount(0);

    // Hold text recognition, so the refresh the capture itself triggers can only come back empty.
    await app.evaluate(() => {
      const probe = globalThis as unknown as QueryProbe & OcrGateHooks;
      probe.__clipboardArchiveOcrGate.hold();
      probe.__historyQueryPhase = 1; // queries from here on were asked after the copy began
    });
    await clipboardArchive.copyImage(TERMINAL_PNG, { exe: 'SnippingTool.exe' });
    // The capture is recorded (copyImage waits for it). Wait for a separate answer to the same
    // search, asked after the copy, empty while recognition is still held: the refresh the capture
    // triggered can no longer see the text.
    await emptyAnswerFor(app, 'ECONNRESET', 1);
    await expect(palette.locator('.clip-row')).toHaveCount(0);

    // Nothing else changes from here: only the recognition commit can refresh the search.
    await app.evaluate(() => {
      (globalThis as unknown as OcrGateHooks).__clipboardArchiveOcrGate.release();
    });
    const row = palette.locator('.clip-row');
    await expect(row).toHaveCount(1, { timeout: OCR_TIMEOUT_MS });
    await expect(row).toContainText('Image 900×216');
  });

  test('a refresh keeps every page already scrolled through', async ({ clipboardArchive }) => {
    test.setTimeout(90_000);
    const { app, palette } = clipboardArchive;
    // 2,000-character previews: one page holds at most 128 of them (MAX_PAGE_CHARS), so a
    // refresh of more rows than that needs several pages.
    const COUNT = 200;
    await app.evaluate(async (_electron, count) => {
      const hooks = (globalThis as unknown as CopyHooks).__clipboardArchiveTest;
      for (let index = 0; index < count; index++) {
        await hooks.copy(`entry ${String(index).padStart(3, '0')} `.padEnd(2_500, 'x'));
      }
    }, COUNT);

    const rows = palette.locator('.clip-row');
    await expect(rows).toHaveCount(60);
    // Scroll to the end until three pages are loaded (infinite scroll via the sentinel).
    for (const expected of [120, 180]) {
      await rows.last().scrollIntoViewIfNeeded();
      await expect(rows).toHaveCount(expected);
    }

    // Any change re-runs the query: the list keeps every row that was loaded, the new one on
    // top (181), instead of collapsing to one budget-limited page of at most 128, or pushing the
    // oldest loaded row out at the bottom.
    await clipboardArchive.copy('one more copy');
    await expect(rows.first()).toContainText('one more copy');
    await palette.waitForTimeout(300);
    await expect(rows).toHaveCount(181);
    await expect(rows.last()).toContainText('entry 020');
  });
});
