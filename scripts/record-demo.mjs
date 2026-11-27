// Records the README demo (docs/media/demo.mp4, demo.gif, demo-poster.png) and the README
// screenshots taken from the same session (docs/screenshots/*-dark.png, *-light.png).
//
//   npx electron-vite build && node scripts/record-demo.mjs
//
// The real app is driven through the E2E sandbox (CLIPBOARD_ARCHIVE_E2E=1): hidden windows,
// an in-memory clipboard and a scripted source probe. Nothing is shown on screen, the system
// clipboard is never read or written, and the history is seeded sample data in a temp profile.
//
// Frames are grabbed in the main process with `webContents.capturePage()` while Playwright
// drives the UI, each with its real timestamp, so typing and transitions play back at real speed.
// ffmpeg (on PATH) turns every shot into a captioned clip, crossfades the clips, adds a title
// card and writes the MP4, an optimised GIF and a poster frame.
//
// Environment:
//   CLIPBOARD_ARCHIVE_OUT_DIR  build folder to launch (default: out)
//   DEMO_FONT, DEMO_FONT_BOLD  caption fonts (default: Segoe UI on Windows, DejaVu Sans elsewhere)
//   DEMO_KEEP_FRAMES=1         keep the raw frames in the temp folder for inspection
/* global document, window -- used only inside page.evaluate() callbacks, which run in the renderer */
import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(import.meta.dirname, '..');
const OUT_DIR = process.env.CLIPBOARD_ARCHIVE_OUT_DIR ?? 'out';
const MEDIA_DIR = join(ROOT, 'docs', 'media');
const SCREENSHOT_DIR = join(ROOT, 'docs', 'screenshots');
const REPO_URL = 'github.com/ChrystianSchutz/clipboard-screenshot-archive';

// Output canvas: the window sits above a caption band.
const CANVAS = { width: 1280, height: 800 };
const STAGE_HEIGHT = 724; // window area (top margin included)
const BAND = { y: 742, height: 58 };
const FPS = 30;
const FADE = 0.35; // seconds of crossfade between shots
const BG = '0x15171c';
const DSF = 2; // forced device scale factor: frames are 2x the window's CSS size
const STAGE_ASPECT = (CANVAS.width - 80) / (STAGE_HEIGHT - 24);

// ---------------------------------------------------------------------------------------------
// Sample data. Plausible, made up, and never anyone's real history.
// ---------------------------------------------------------------------------------------------
const CHROME = (url) => ({ exe: 'chrome.exe', url });
const VSCODE = { exe: 'Code.exe' };
const TERMINAL = { exe: 'WindowsTerminal.exe' };
const SLACK = { exe: 'slack.exe' };
const DBEAVER = { exe: 'dbeaver.exe' };
const SNIP = { exe: 'SnippingTool.exe' };

const STAGING = JSON.stringify({
  status: 'ok',
  user: { id: 42, name: 'Ada', roles: ['admin', 'dev'] },
  limits: { requests: 1000, burst: 50 },
  region: 'eu-west-1',
});
// Same data, other key order, three real differences.
const PRODUCTION = JSON.stringify({
  region: 'eu-central-1',
  limits: { burst: 50, requests: 5000 },
  user: { roles: ['admin', 'dev'], name: 'Ada', id: 42, plan: 'pro' },
  status: 'ok',
});

/**
 * Oldest first: [text or screenshot, source, minutes ago]. Screenshots are named
 * (`{ image: 'terminal' }`) and drawn or loaded in `seed()`.
 */
const SEED = [
  ['ada.lovelace@example.com', SLACK, 2900],
  [
    "SELECT o.id, o.total, c.email\nFROM orders o JOIN customers c ON c.id = o.customer_id\nWHERE o.created_at > now() - interval '7 days'\nORDER BY o.total DESC;",
    DBEAVER,
    2700,
  ],
  ['docker compose logs -f api --tail 200', TERMINAL, 1500],
  [
    "TypeError: Cannot read properties of undefined (reading 'email')\n    at renderInvoice (src/invoice.ts:48:17)\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
    CHROME('https://github.com/acme/billing/issues/318'),
    1380,
  ],
  [
    "SELECT pid, state, query_start, left(query, 60)\nFROM pg_stat_activity\nWHERE state <> 'idle'\nORDER BY query_start;",
    CHROME('https://stackoverflow.com/questions/12345678/list-running-queries-postgres'),
    620,
  ],
  [{ image: 'ticket' }, SNIP, 1100],
  ['#7c3aed', VSCODE, 400],
  [{ image: 'ci-log' }, SNIP, 290],
  [{ image: 'code' }, VSCODE, 210],
  [STAGING, CHROME('https://staging.acme.dev/api/v2/me'), 180],
  ['git rebase -i origin/main --autosquash', TERMINAL, 150],
  [{ image: 'rate-limit' }, SNIP, 75],
  [{ image: 'terminal' }, SNIP, 50],
  [
    "UPDATE subscriptions\nSET plan = 'pro', renewed_at = now()\nWHERE customer_id = 1042;",
    CHROME('https://supabase.com/dashboard/project/acme/sql/new'),
    32,
  ],
  [
    'https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API',
    CHROME('https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API'),
    21,
  ],
  [PRODUCTION, CHROME('https://api.acme.dev/api/v2/me'), 9],
  ['kubectl rollout restart deployment/api -n staging', TERMINAL, 5],
  [
    'export const retry = (fn, attempts = 3) =>\n  fn().catch((err) => (attempts > 1 ? retry(fn, attempts - 1) : Promise.reject(err)));',
    VSCODE,
    2,
  ],
];

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
const hooks = (app) => ({
  copy: (text, source) =>
    app.evaluate((_e, [t, s]) => globalThis.__clipboardArchiveTest.copy(t, s), [text, source]),
  copyImage: (png, source) =>
    app.evaluate(
      (_e, [b64, s]) => globalThis.__clipboardArchiveTest.copyImage(b64, s),
      [png.toString('base64'), source],
    ),
});

async function launch(userData, extraArgs = []) {
  const app = await electron.launch({
    args: [...extraArgs, join(OUT_DIR, 'main', 'index.js')],
    cwd: ROOT,
    env: { ...process.env, CLIPBOARD_ARCHIVE_E2E: '1', CLIPBOARD_ARCHIVE_USER_DATA: userData },
  });
  const palette = await app.firstWindow();
  await palette.waitForSelector('.palette');
  return { app, palette };
}

async function waitFor(check, what, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Draws a code-editor style screenshot in the renderer (a PNG with real text for OCR). */
async function drawScreenshot(page, spec) {
  const base64 = await page.evaluate(async (s) => {
    const canvas = document.createElement('canvas');
    canvas.width = s.width;
    canvas.height = s.padding * 2 + s.lines.length * s.lineHeight;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = s.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = s.font;
    ctx.textBaseline = 'top';
    s.lines.forEach(([color, text], i) => {
      ctx.fillStyle = color;
      ctx.fillText(text, s.padding, s.padding + i * s.lineHeight);
    });
    return canvas.toDataURL('image/png').split(',')[1];
  }, spec);
  return Buffer.from(base64, 'base64');
}

const ffmpeg = (args, cwd) =>
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
const probeDuration = (file) =>
  Number(
    execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      file,
    ])
      .toString()
      .trim(),
  );

// ---------------------------------------------------------------------------------------------
// Phase 1: seed a temp profile, wait for OCR, then backdate the copies so the list reads like a
// real two-day history instead of "just now" everywhere.
// ---------------------------------------------------------------------------------------------
async function seed(userData) {
  const { app, palette } = await launch(userData);
  const { copy, copyImage } = hooks(app);
  const images = {
    terminal: readFileSync(join(ROOT, 'tests', 'fixtures', 'ocr', 'terminal.png')),
    code: readFileSync(join(ROOT, 'tests', 'fixtures', 'ocr', 'code.png')),
    'rate-limit': await drawScreenshot(palette, {
      width: 760,
      padding: 18,
      lineHeight: 24,
      bg: '#1e1e1e',
      font: '15px Consolas, "DejaVu Sans Mono", monospace',
      lines: [
        ['#9cdcfe', 'HTTP/1.1 429 Too Many Requests'],
        ['#cccccc', 'retry-after: 30'],
        ['#cccccc', '{'],
        ['#cccccc', '  "error": "rate_limited",'],
        ['#cccccc', '  "message": "Quota of 1000 requests per minute exceeded",'],
        ['#cccccc', '  "request_id": "req_8f2c1a9e"'],
        ['#cccccc', '}'],
      ],
    }),
    'ci-log': await drawScreenshot(palette, {
      width: 820,
      padding: 18,
      lineHeight: 24,
      bg: '#0d1117',
      font: '15px Consolas, "DejaVu Sans Mono", monospace',
      lines: [
        ['#8b949e', 'Run npm test -- --coverage'],
        ['#e6edf3', ' PASS  src/cart.test.ts'],
        ['#f85149', ' FAIL  src/billing/invoice.test.ts'],
        ['#e6edf3', '  > renders the invoice total'],
        ['#f85149', '    Expected: "$1,284.00"'],
        ['#f85149', '    Received: "$1,283.99"'],
        ['#8b949e', 'Tests: 1 failed, 41 passed, 42 total'],
        ['#f85149', 'Error: Process completed with exit code 1.'],
      ],
    }),
    ticket: await drawScreenshot(palette, {
      width: 720,
      padding: 22,
      lineHeight: 30,
      bg: '#ffffff',
      font: '18px "Segoe UI", "DejaVu Sans", sans-serif',
      lines: [
        ['#1f2328', 'BILL-482  Invoice totals are off by one cent'],
        ['#57606a', 'Priority: High    Status: In progress'],
        ['#1f2328', 'Totals are rounded per line instead of per invoice.'],
        ['#1f2328', 'Reproduce: 3 items at $428.33 each, total shows $1,283.99'],
      ],
    }),
  };
  for (const [index, [content, source]] of SEED.entries()) {
    if (typeof content === 'string') await copy(content, source);
    else await copyImage(images[content.image], source);
    await waitFor(
      async () => (await palette.locator('.clip-row').count()) === index + 1,
      'seed copy',
    );
  }

  // Wait until every screenshot has its text (the Screenshots tab shows a "Text" badge).
  const screenshots = SEED.filter(([content]) => typeof content !== 'string').length;
  await palette.getByRole('tab', { name: 'Screenshots' }).click();
  await waitFor(
    async () =>
      (await palette.locator('.shot-status', { hasText: 'Text' }).count()) === screenshots,
    'OCR',
    90_000,
  );
  await app.close();

  // Spread the copies over the last two days.
  const db = new DatabaseSync(join(userData, 'archive.sqlite'));
  const now = Date.now();
  const minutesAgo = SEED.map(([, , minutes]) => minutes);
  const ids = db
    .prepare('SELECT id FROM clips ORDER BY id')
    .all()
    .map((row) => row.id);
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name),
  );
  ids.forEach((id, index) => {
    const at = now - (minutesAgo[index] ?? 1) * 60_000;
    db.prepare('UPDATE clips SET first_copied_at = ?, last_copied_at = ? WHERE id = ?').run(
      at,
      at,
      id,
    );
    if (tables.has('copy_events'))
      db.prepare('UPDATE copy_events SET copied_at = ? WHERE clip_id = ?').run(at, id);
  });
  db.close();
}

// ---------------------------------------------------------------------------------------------
// Phase 2: record. A loop in the main process grabs the target window as fast as it can.
// ---------------------------------------------------------------------------------------------
async function startCapture(app, target, dir) {
  mkdirSync(dir, { recursive: true });
  await app.evaluate(
    ({ BrowserWindow }, [which, folder]) => {
      const fs = process.getBuiltinModule('node:fs');
      const path = process.getBuiltinModule('node:path');
      const win = BrowserWindow.getAllWindows().find((w) =>
        which === 'compare'
          ? w.webContents.getURL().endsWith('#compare')
          : !w.webContents.getURL().endsWith('#compare'),
      );
      const state = { running: true, frames: [], done: null };
      globalThis.__demoCapture = state;
      state.done = (async () => {
        while (state.running) {
          const started = Date.now();
          const image = await win.webContents.capturePage();
          const file = `f${String(state.frames.length).padStart(5, '0')}.png`;
          fs.writeFileSync(path.join(folder, file), image.toPNG());
          state.frames.push({ file, t: started });
          const wait = 33 - (Date.now() - started);
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        }
      })();
    },
    [target, dir],
  );
}

async function stopCapture(app) {
  return app.evaluate(async () => {
    const state = globalThis.__demoCapture;
    state.running = false;
    await state.done;
    state.frames.push({ file: state.frames.at(-1).file, t: Date.now() });
    return state.frames;
  });
}

const pause = (page, ms) => page.waitForTimeout(ms);

/** Saves one full-resolution frame of a window as a README screenshot (scaled in `publishStills`). */
async function still(app, target, file) {
  await app.evaluate(
    async ({ BrowserWindow }, [which, path]) => {
      const fs = process.getBuiltinModule('node:fs');
      const win = BrowserWindow.getAllWindows().find((w) =>
        which === 'compare'
          ? w.webContents.getURL().endsWith('#compare')
          : !w.webContents.getURL().endsWith('#compare'),
      );
      fs.writeFileSync(path, (await win.webContents.capturePage()).toPNG());
    },
    [target, file],
  );
}

async function record(userData, work) {
  const { app, palette } = await launch(userData, ['--force-device-scale-factor=2']);
  const settings = (patch) =>
    palette.evaluate((p) => window.clipboardArchive.settings.update(p), patch);
  await settings({ theme: 'dark', accentColor: '#0078d4' });
  await pause(palette, 600);

  const shots = [];
  const stills = join(work, 'stills');
  mkdirSync(stills, { recursive: true });
  const snap = (name, target = 'palette') => still(app, target, join(stills, `${name}.png`));
  /** Records `actions`; `crop` (CSS px of the window) zooms the clip onto one region. */
  async function shot(step, caption, target, actions, crop = null) {
    const dir = join(work, `shot${String(shots.length).padStart(2, '0')}`);
    await startCapture(app, target, dir);
    await actions();
    const frames = await stopCapture(app);
    shots.push({ step, caption, dir, frames, crop });
  }

  const row = (text) => palette.locator('.clip-row', { hasText: text });
  const search = palette.getByRole('searchbox', { name: 'Search history' });

  // 1. History with source apps and URLs.
  await palette.locator('.clip-row').first().click();
  await pause(palette, 300);
  await shot(1, 'Every copy remembers its app and the page it came from', 'palette', async () => {
    await pause(palette, 1100);
    for (let i = 0; i < 4; i++) {
      await palette.keyboard.press('ArrowDown');
      await pause(palette, 650);
    }
    await snap('history-dark');
    await pause(palette, 500);
  });

  // 2. Search with operators.
  await shot(
    2,
    'Search everything, with operators like #sql and app:chrome',
    'palette',
    async () => {
      await pause(palette, 400);
      await search.click();
      // Faster than the history's 120 ms search debounce, so half-typed operators ("#sq",
      // "app:chr") never run as a query and flash an empty list.
      await search.pressSequentially('#sql app:chrome', { delay: 55 });
      await pause(palette, 900);
      await palette.keyboard.press('ArrowDown');
      await pause(palette, 400);
      await snap('history-search-dark');
      await pause(palette, 900);
    },
  );

  // 3. Category chips.
  await shot(
    3,
    'Auto categories: SQL, Error, Command, Email and more, tagged locally',
    'palette',
    async () => {
      await search.fill('');
      await pause(palette, 700);
      await palette.getByRole('combobox', { name: 'Category' }).selectOption('error');
      await pause(palette, 1200);
      await palette.getByRole('combobox', { name: 'Category' }).selectOption('command');
      await pause(palette, 1200);
      await palette.getByRole('combobox', { name: 'Category' }).selectOption('');
      await pause(palette, 500);
    },
  );

  // 4. Screenshot OCR text layer, zoomed onto the preview, then "Copy all text" at full size.
  const caption4 = 'Screenshots get a selectable text layer: drag a line, or copy it all';
  await row('Image 900').click();
  const layer = palette.getByTestId('ocr-text-layer');
  await layer.waitFor();
  await pause(palette, 300);
  const pane = await palette.getByRole('region', { name: 'Selected clip' }).boundingBox();
  const image = await layer.boundingBox();
  const zoomHeight = Math.round(pane.width / STAGE_ASPECT);
  const zoom = {
    x: Math.round(pane.x),
    y: Math.round(Math.max(pane.y, image.y + image.height / 2 - zoomHeight / 2 - 18)),
    width: Math.round(pane.width),
    height: zoomHeight,
  };
  await shot(
    4,
    caption4,
    'palette',
    async () => {
      await pause(palette, 700);
      const words = layer
        .locator('.ocr-text-layer__line', { hasText: 'Error: read ECONNRESET' })
        .locator('.ocr-text-layer__word');
      const from = await words.first().boundingBox();
      const to = await words.last().boundingBox();
      // Words are absolutely positioned; stay inside the line's own boxes while dragging.
      const y = from.y + from.height * 0.6;
      const startX = from.x + 1;
      const endX = to.x + to.width - 1;
      await palette.mouse.move(startX, y);
      await palette.mouse.down();
      const steps = 16;
      for (let i = 1; i <= steps; i++) {
        await palette.mouse.move(startX + ((endX - startX) * i) / steps, y);
        await pause(palette, 40);
      }
      await palette.mouse.up();
      const selected = await palette.evaluate(() => window.getSelection()?.toString() ?? '');
      if (!selected.includes('ECONNRESET'))
        console.warn(`Unexpected text selection: ${JSON.stringify(selected)}`);
      await snap('screenshot-ocr-dark');
      await pause(palette, 1500);
    },
    zoom,
  );
  await shot(4, caption4, 'palette', async () => {
    await pause(palette, 500);
    await palette.getByRole('button', { name: /Copy all text/ }).click();
    await pause(palette, 1400);
  });

  // 5. Screenshots gallery tab.
  await shot(
    5,
    'The Screenshots tab: every capture in one searchable gallery',
    'palette',
    async () => {
      await pause(palette, 300);
      await palette.getByRole('tab', { name: 'Screenshots' }).click();
      await pause(palette, 1000);
      const tiles = palette.getByRole('listbox', { name: 'Screenshots' }).getByRole('option');
      await tiles.nth(1).click();
      await pause(palette, 1200);
      await palette.keyboard.press('ArrowRight');
      await pause(palette, 400);
      await snap('screenshots-gallery-dark');
      await pause(palette, 800);
    },
  );

  // 6. Right-click context menu.
  await palette.getByRole('tab', { name: 'History' }).click();
  await pause(palette, 400);
  await shot(6, 'Right-click any clip: Copy, Pin, Compare, Delete', 'palette', async () => {
    await pause(palette, 600);
    const target = row('UPDATE subscriptions');
    const box = await target.boundingBox();
    await target.click({ button: 'right', position: { x: 150, y: box.height / 2 } });
    await pause(palette, 800);
    await palette.keyboard.press('ArrowDown');
    await pause(palette, 300);
    await snap('context-menu-dark');
    await pause(palette, 600);
    await palette.keyboard.press('Enter');
    await pause(palette, 1300);
  });

  // 7. JSON compare: mark two clips with Ctrl+D, the compare window opens.
  await shot(
    7,
    'Compare two JSON payloads: key order ignored, only real changes',
    'palette',
    async () => {
      await pause(palette, 400);
      await row('{"status":"ok"').click();
      await pause(palette, 500);
      await palette.keyboard.press('Control+d');
      await pause(palette, 700);
      await row('"region":"eu-central-1"').click();
      await pause(palette, 400);
      await palette.keyboard.press('Control+d');
      await pause(palette, 300);
    },
  );
  await waitFor(() => app.windows().some((w) => w.url().endsWith('#compare')), 'compare window');
  const compare = app.windows().find((w) => w.url().endsWith('#compare'));
  // A shorter compare window than the default, so the diff fills the frame.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().endsWith('#compare'))
      ?.setContentSize(1040, 500);
  });
  await compare.waitForSelector('.change__path');
  await pause(compare, 300);
  await shot(
    7,
    'Compare two JSON payloads: key order ignored, only real changes',
    'compare',
    async () => {
      await pause(compare, 1900);
      await compare.getByRole('button', { name: 'Side by side' }).click();
      await pause(compare, 1000);
      await snap('compare-dark', 'compare');
      await pause(compare, 1400);
    },
  );
  await compare.keyboard.press('Escape');

  // 8. Theme and accent.
  await palette.keyboard.press('Control+4');
  await palette.locator('h2', { hasText: 'Appearance' }).scrollIntoViewIfNeeded();
  await palette.evaluate(() => {
    const heading = [...document.querySelectorAll('h2')].find(
      (h) => h.textContent === 'Appearance',
    );
    heading?.scrollIntoView({ block: 'start' });
    let parent = heading?.parentElement ?? null;
    while (parent && parent.scrollHeight <= parent.clientHeight) parent = parent.parentElement;
    parent?.scrollBy(0, -14);
  });
  await pause(palette, 400);
  await shot(8, 'Dark or light, with the accent colour you like', 'palette', async () => {
    await pause(palette, 700);
    const theme = palette.getByRole('group', { name: 'Theme' });
    await theme.getByRole('button', { name: 'Light' }).click();
    await pause(palette, 1000);
    await palette.getByRole('radio', { name: 'Purple' }).click();
    await pause(palette, 500);
    await snap('settings-appearance-light');
    await pause(palette, 500);
    await palette.keyboard.press('Control+1');
    await pause(palette, 900);
    await snap('history-light');
    await pause(palette, 600);
  });

  await app.close();
  return { shots, stills };
}

// ---------------------------------------------------------------------------------------------
// Phase 3: assemble with ffmpeg.
// ---------------------------------------------------------------------------------------------
function fonts(work) {
  const windows = process.platform === 'win32';
  const regular =
    process.env.DEMO_FONT ??
    (windows ? 'C:/Windows/Fonts/segoeui.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
  const bold =
    process.env.DEMO_FONT_BOLD ??
    (windows
      ? 'C:/Windows/Fonts/segoeuib.ttf'
      : '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf');
  // Copied next to the filter scripts so paths need no escaping (drive colons, spaces).
  copyFileSync(regular, join(work, 'font.ttf'));
  copyFileSync(bold, join(work, 'font-bold.ttf'));
}

/** Scales a window frame (or a `crop` of it) onto the canvas, with the caption band below. */
function shotFilter({ crop = null, band = true } = {}) {
  const maxW = CANVAS.width - 80;
  const maxH = STAGE_HEIGHT - 24;
  return [
    ...(crop
      ? [`crop=${crop.width * DSF}:${crop.height * DSF}:${crop.x * DSF}:${crop.y * DSF}`]
      : []),
    `scale=w=${maxW}:h=${maxH}:force_original_aspect_ratio=decrease:flags=lanczos`,
    // A thin frame around the window.
    `pad=w=iw+2:h=ih+2:x=1:y=1:color=0x3a3d45`,
    `pad=w=${CANVAS.width}:h=${CANVAS.height}:x=(ow-iw)/2:y=(${STAGE_HEIGHT}-ih)/2+6:color=${BG}`,
    ...(band
      ? [
          `drawbox=x=0:y=${BAND.y}:w=iw:h=${BAND.height}:color=black@0.55:t=fill`,
          `fps=${FPS}`,
          'format=yuv420p',
        ]
      : ['format=rgb24']),
  ].join(',');
}

/** One shot, one clip: each frame is held for as long as it was on screen while recording. */
function renderShot(shot, index, work) {
  const lines = [];
  for (let i = 0; i < shot.frames.length - 1; i++) {
    const seconds = Math.max(0.001, (shot.frames[i + 1].t - shot.frames[i].t) / 1000);
    lines.push(
      `file '${join(shot.dir, shot.frames[i].file).replaceAll('\\', '/')}'`,
      `duration ${seconds.toFixed(3)}`,
    );
  }
  // The concat demuxer ignores the last duration unless the file is listed again.
  lines.push(`file '${join(shot.dir, shot.frames.at(-2).file).replaceAll('\\', '/')}'`);
  const list = join(work, `shot${index}.txt`);
  writeFileSync(list, lines.join('\n'));
  const file = join(work, `shot${index}.mp4`);
  ffmpeg(
    [
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-vf',
      shotFilter({ crop: shot.crop }),
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '14',
      '-r',
      String(FPS),
      file,
    ],
    work,
  );
  return { file, step: shot.step, caption: shot.caption };
}

function renderTitle(work) {
  writeFileSync(join(work, 't1.txt'), 'Clipboard & Screenshot Archive');
  writeFileSync(join(work, 't2.txt'), 'Local-first. Open source.');
  writeFileSync(join(work, 't3.txt'), REPO_URL);
  copyFileSync(join(ROOT, 'resources', 'icon.png'), join(work, 'icon.png'));
  const file = join(work, 'title.mp4');
  ffmpeg(
    [
      '-f',
      'lavfi',
      '-i',
      `color=c=${BG}:s=${CANVAS.width}x${CANVAS.height}:d=3.8:r=${FPS}`,
      '-i',
      'icon.png',
      '-filter_complex',
      [
        '[1:v]scale=112:112:flags=lanczos[icon]',
        '[0:v][icon]overlay=x=(W-w)/2:y=200[bg]',
        '[bg]drawtext=fontfile=font-bold.ttf:textfile=t1.txt:fontcolor=white:fontsize=56:x=(w-text_w)/2:y=350,' +
          'drawtext=fontfile=font.ttf:textfile=t2.txt:fontcolor=0xd0d4dc:fontsize=34:x=(w-text_w)/2:y=440,' +
          'drawtext=fontfile=font.ttf:textfile=t3.txt:fontcolor=0x6cb6ff:fontsize=28:x=(w-text_w)/2:y=520,' +
          'format=yuv420p[v]',
      ].join(';'),
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '14',
      file,
    ],
    work,
  );
  return { file, step: null, caption: null };
}

/**
 * Crossfades the clips, then draws each step's caption on the result, so a caption fades in and
 * out on its own and two captions never blend during a crossfade.
 */
function assemble(clips, work) {
  const durations = clips.map((clip) => probeDuration(clip.file));
  const starts = [];
  const parts = [];
  let offset = 0;
  let last = '0:v';
  for (let i = 0; i < clips.length; i++) {
    starts.push(offset);
    if (i > 0) {
      parts.push(
        `[${last}][${i}:v]xfade=transition=fade:duration=${FADE}:offset=${offset.toFixed(3)}[x${i}]`,
      );
      last = `x${i}`;
    }
    offset += durations[i] - FADE;
  }

  // Consecutive clips of one step share one caption.
  const captions = [];
  clips.forEach((clip, i) => {
    if (!clip.caption) return;
    const end = starts[i] + durations[i] - (i < clips.length - 1 ? FADE / 2 : 0);
    const previous = captions.at(-1);
    if (previous && previous.step === clip.step) previous.end = end;
    else
      captions.push({
        step: clip.step,
        text: clip.caption,
        start: i === 0 ? 0 : starts[i] + FADE / 2,
        end,
      });
  });
  const ramp = 0.2;
  const draw = captions.map((caption, i) => {
    const file = `caption${i}.txt`;
    writeFileSync(join(work, file), caption.text);
    const a = caption.start.toFixed(3);
    const b = caption.end.toFixed(3);
    const fadeOut = `if(gt(t,${b}-${ramp}),(${b}-t)/${ramp},1)`;
    const alpha = i === 0 ? fadeOut : `if(lt(t,${a}+${ramp}),(t-${a})/${ramp},${fadeOut})`;
    return (
      `drawtext=fontfile=font-bold.ttf:textfile=${file}:fontcolor=white:fontsize=25` +
      `:x=(w-text_w)/2:y=${BAND.y}+(${BAND.height}-text_h)/2:enable='between(t,${a},${b})':alpha='${alpha}'`
    );
  });
  parts.push(`[${last}]${draw.join(',')},format=yuv420p[v]`);

  const file = join(work, 'demo-master.mp4');
  ffmpeg(
    [
      ...clips.flatMap((clip) => ['-i', clip.file]),
      '-filter_complex',
      parts.join(';'),
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '12',
      file,
    ],
    work,
  );
  return file;
}

function publish(master, posterSource, work) {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const mp4 = join(MEDIA_DIR, 'demo.mp4');
  ffmpeg(
    [
      '-i',
      master,
      '-c:v',
      'libx264',
      '-preset',
      'veryslow',
      '-crf',
      '20',
      '-tune',
      'animation',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-an',
      mp4,
    ],
    work,
  );

  const gif = join(MEDIA_DIR, 'demo.gif');
  ffmpeg(
    [
      '-i',
      master,
      '-filter_complex',
      // 10 fps, 880 px and 96 flat colours keep the GIF under 4 MB; the MP4 is the full-quality cut.
      'fps=10,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
      gif,
    ],
    work,
  );

  const poster = join(MEDIA_DIR, 'demo-poster.png');
  // Captionless: the poster is the history window alone on the canvas.
  ffmpeg(['-i', posterSource, '-vf', shotFilter({ band: false }), '-frames:v', '1', poster], work);
  return { mp4, gif, poster };
}

/** README screenshots: the stills taken while recording, at 3/4 of their 2x size (max 1280 px). */
function publishStills(stills, work) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const files = [];
  for (const name of readdirSync(stills).sort()) {
    const file = join(SCREENSHOT_DIR, name);
    ffmpeg(
      [
        '-i',
        join(stills, name),
        '-vf',
        "scale='min(1280,iw*3/4)':-2:flags=lanczos",
        '-frames:v',
        '1',
        file,
      ],
      work,
    );
    files.push(file);
  }
  return files;
}

// ---------------------------------------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'clipboard-archive-demo-'));
const userData = join(work, 'profile');
mkdirSync(userData);
try {
  if (!existsSync(join(ROOT, OUT_DIR, 'main', 'index.js'))) {
    throw new Error(`No build in ${OUT_DIR}/. Run "npx electron-vite build" first.`);
  }
  console.log('Seeding sample history...');
  await seed(userData);
  console.log('Recording...');
  const { shots, stills } = await record(userData, work);
  console.log(
    `Captured ${shots.reduce((n, s) => n + s.frames.length, 0)} frames in ${shots.length} shots. Rendering...`,
  );
  fonts(work);
  const clips = shots.map((shot, index) => renderShot(shot, index, work));
  clips.push(renderTitle(work));
  const master = assemble(clips, work);
  const first = shots[0];
  const posterSource = join(first.dir, first.frames[Math.floor(first.frames.length * 0.15)].file);
  const out = publish(master, posterSource, work);
  for (const file of [...Object.values(out), ...publishStills(stills, work)]) {
    console.log(`${file}  ${(statSync(file).size / 1024 / 1024).toFixed(2)} MB`);
  }
  console.log(`Duration ${probeDuration(out.mp4).toFixed(1)} s`);
} finally {
  if (process.env.DEMO_KEEP_FRAMES === '1') console.log(`Frames kept in ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
