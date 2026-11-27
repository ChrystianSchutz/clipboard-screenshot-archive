// Renders the OCR accuracy fixtures (tests/fixtures/ocr/*.png) from HTML, deterministically.
//
//   npx electron scripts/generate-ocr-fixtures.mjs
//
// Every page is rendered in a hidden, sandboxed BrowserWindow (`show: false`, no preload, no Node)
// and saved with `capturePage()`. Nothing is shown on screen and the clipboard is never touched.
// The device scale factor is forced to 1, so the PNGs have the same pixel size on every display.
// The expected text of each image is written next to it in `expected.json`, which the accuracy
// test compares OCR output against.
import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = join(import.meta.dirname, '..', 'tests', 'fixtures', 'ocr');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-lcd-text'); // greyscale antialiasing: same pixels on any monitor
app.disableHardwareAcceleration();

/** Each fixture: the visible lines (exactly what OCR should return) and how they are styled. */
const FIXTURES = [
  {
    name: 'terminal',
    width: 900,
    css: `body { background: #0c0c0c; color: #cccccc; font: 15px/1.5 Consolas, 'DejaVu Sans Mono', monospace; }
          .err { color: #f14c4c; } .dim { color: #8a8a8a; }`,
    lines: [
      ['', 'PS C:\\work\\api> npm run sync'],
      ['dim', '> sync@2.4.1 sync'],
      ['dim', '> node scripts/sync.js --region eu-west-1'],
      ['', 'Fetching 1284 records from upstream...'],
      ['err', 'Error: read ECONNRESET'],
      ['err', '    at TLSWrap.onStreamRead (node:internal/stream_base_commons:216:20)'],
      ['', "  errno: -4077, code: 'ECONNRESET', syscall: 'read'"],
      ['', 'Retrying in 5 seconds (attempt 2 of 3)'],
    ],
  },
  {
    name: 'code',
    width: 820,
    css: `body { background: #ffffff; color: #1f2328; font: 15px/1.55 Consolas, 'DejaVu Sans Mono', monospace; }`,
    lines: [
      ['', 'export async function fetchInvoices(customerId: string) {'],
      ['', '  const response = await fetch(`/api/invoices/${customerId}`);'],
      ['', '  if (!response.ok) {'],
      ['', "    throw new Error('Invoice request failed: ' + response.status);"],
      ['', '  }'],
      ['', '  return (await response.json()) as Invoice[];'],
      ['', '}'],
    ],
  },
  {
    name: 'polish',
    width: 860,
    css: `body { background: #f6f7f9; color: #15161b; font: 20px/1.6 'Segoe UI', 'DejaVu Sans', sans-serif; }`,
    lines: [
      ['', 'Zażółć gęślą jaźń.'],
      ['', 'Pchnąć w tę łódź jeża lub ośm skrzyń fig.'],
      ['', 'Spotkanie przeniesione na środę, godz. 14:30.'],
    ],
  },
];

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function html({ css, lines }) {
  const body = lines.map(([cls, text]) => `<div class="${cls}">${escape(text)}</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; } body { padding: 18px 22px; white-space: pre; } ${css}
  </style></head><body>${body}</body></html>`;
}

async function render(fixture) {
  const win = new BrowserWindow({
    show: false,
    width: fixture.width,
    height: 200,
    useContentSize: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
    },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html(fixture))}`);
  const height = await win.webContents.executeJavaScript(
    'Math.ceil(document.body.getBoundingClientRect().height)',
  );
  win.setContentSize(fixture.width, height);
  await new Promise((resolve) => setTimeout(resolve, 150)); // let the resize paint
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: fixture.width, height });
  win.destroy();
  return image;
}

// Windows are rendered one after another; closing the last one must not quit the app mid-run.
app.on('window-all-closed', () => undefined);

app
  .whenReady()
  .then(async () => {
    mkdirSync(outDir, { recursive: true });
    const expected = {};
    for (const fixture of FIXTURES) {
      const image = await render(fixture);
      writeFileSync(join(outDir, `${fixture.name}.png`), image.toPNG());
      const { width, height } = image.getSize();
      // The same 2x upscale the app applies before OCR (nativeImage, quality "best"): small UI text
      // is below the glyph size Tesseract's LSTM models were trained on.
      const upscaled = image.resize({ width: width * 2, height: height * 2, quality: 'best' });
      writeFileSync(join(outDir, `${fixture.name}.x2.png`), upscaled.toPNG());
      expected[fixture.name] = { width, height, lines: fixture.lines.map(([, text]) => text) };
      console.log(`${fixture.name}.png ${width}x${height}`);
    }
    writeFileSync(join(outDir, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
