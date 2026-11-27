// Renders the social preview image (site/og-image.png, 1200x630) from a real app screenshot.
// Headless Chromium through Playwright (a devDependency); no window is shown.
//
//   node site/tools/og-image.mjs
//
// Re-run it when the history screenshot or the pitch changes, then commit site/og-image.png.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(siteDir, '..');
const dataUri = (rel) =>
  `data:image/png;base64,${readFileSync(join(repoRoot, rel)).toString('base64')}`;

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 1200px; height: 630px; overflow: hidden; }
  body {
    position: relative;
    background:
      radial-gradient(55% 70% at 8% 0%, rgb(0 120 212 / 32%), transparent 70%),
      radial-gradient(40% 50% at 100% 100%, rgb(34 181 194 / 16%), transparent 70%),
      #161616;
    font-family: 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif;
    color: #ececec;
  }
  .copy { position: absolute; left: 64px; top: 64px; width: 470px; }
  .icon { width: 76px; height: 76px; display: block; }
  h1 { margin-top: 30px; font-size: 54px; line-height: 1.04; font-weight: 750; letter-spacing: -1.6px; }
  p { margin-top: 22px; font-size: 24px; line-height: 1.38; color: #b9b9b9; }
  .meta {
    position: absolute; left: 64px; bottom: 56px;
    font-size: 19px; font-weight: 600; color: #58b0ff; letter-spacing: 0.2px;
  }
  .meta span { color: #8a8a8a; font-weight: 500; }
  .shot {
    position: absolute; left: 580px; top: 92px; width: 760px; height: auto;
    border: 1px solid #3c3c3c;
    box-shadow: 0 40px 90px -20px rgb(0 0 0 / 85%), 0 0 0 1px rgb(255 255 255 / 4%);
  }
</style></head><body>
  <div class="copy">
    <img class="icon" src="${dataUri('build/icon.png')}" alt="">
    <h1>Clipboard &amp;<br>Screenshot Archive</h1>
    <p>Every copy remembers where it came from. Every screenshot becomes text you can search.</p>
  </div>
  <div class="meta">Free &amp; open source <span>· Windows · macOS · Linux</span></div>
  <img class="shot" src="${dataUri('docs/screenshots/history-dark.png')}" alt="">
</body></html>`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(html, { waitUntil: 'load' });
  const out = join(siteDir, 'og-image.png');
  await page.screenshot({ path: out, type: 'png' });
  console.log(`Wrote ${out}`);
} finally {
  await browser.close();
}
