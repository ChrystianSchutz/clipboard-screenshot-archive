# Landing page

The project site at <https://chrystianschutz.github.io/clipboard-screenshot-archive/>.
Plain HTML, CSS and a few lines of JavaScript: no framework, no CDN, no tracking.

## Files

- `index.html`, `styles.css`: the page. The strict CSP in `index.html` allows no inline scripts or styles.
- `theme.js` (loads first, sets the saved theme) and `main.js` (theme toggle, demo video controls).
- `og-image.png`: the 1200x630 social preview. `robots.txt`, `sitemap.xml`.
- `build.mjs`: assembles the site. Screenshots and the demo video are **not** copied into `site/`;
  the build takes the ones the page references from `docs/screenshots/` and `docs/media/`, plus
  `build/icon.png`, and fails if any link, image or `#anchor` does not resolve.
- `serve.mjs`: a tiny local static server for previewing the build.
- `tools/og-image.mjs`: re-renders `og-image.png` from `docs/screenshots/history-dark.png` (headless Chromium).

## Preview

```sh
node site/build.mjs        # writes site/_dist (gitignored)
node site/serve.mjs        # http://127.0.0.1:4173
```

After changing the history screenshot or the pitch: `node site/tools/og-image.mjs`, then commit `site/og-image.png`.

## Deploy

`.github/workflows/pages.yml` runs `node site/build.mjs --out _site` and publishes the result on every
push to `master`/`main` that touches `site/`, `docs/media/`, `docs/screenshots/` or `build/icon.png`
(or by hand: Actions -> Pages -> Run workflow).

One-time setup in the repository: **Settings -> Pages -> Build and deployment -> Source = "GitHub Actions"**.

Keep the numbers on the page (test counts, benchmark) in step with the main README when they change.
