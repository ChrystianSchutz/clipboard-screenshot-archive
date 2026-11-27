// Assembles the GitHub Pages site: the files in site/ plus the screenshots and demo media the
// pages reference, copied from docs/ at build time so the big media files live in git only once.
//
//   node site/build.mjs                 -> site/_dist (local preview: node site/serve.mjs)
//   node site/build.mjs --out _site     -> _site (used by .github/workflows/pages.yml)
//
// Every page is scanned for local references (src, href, poster, srcset, og:image). A reference
// that starts with media/ or screenshots/ is copied from docs/media/ or docs/screenshots/. The build
// then fails if any local reference or #anchor does not resolve, so a broken link never deploys.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_URL = 'https://chrystianschutz.github.io/clipboard-screenshot-archive/';

const siteDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(siteDir, '..');

const outArg = process.argv.indexOf('--out');
const outDir = resolve(outArg > -1 ? process.argv[outArg + 1] : join(siteDir, '_dist'));

// Refuse to wipe anything outside the repository, or the repository itself.
const outRel = relative(repoRoot, outDir);
if (!outRel || outRel.startsWith('..') || outRel.split(sep).includes('..')) {
  console.error(`Refusing to build into ${outDir}: it must be a folder inside ${repoRoot}.`);
  process.exit(1);
}

// Top-level files of site/ that are published. Scripts, README and subfolders are not.
const PUBLISHED_EXT = new Set([
  '.html',
  '.css',
  '.js',
  '.png',
  '.svg',
  '.txt',
  '.xml',
  '.webmanifest',
]);

// Folders the pages may reference, mapped to where the files really live.
const MAPPED_DIRS = {
  'media/': 'docs/media/',
  'screenshots/': 'docs/screenshots/',
};

// Single files copied from elsewhere in the repository.
const EXTRA_FILES = { 'icon.png': 'build/icon.png' };

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const copied = [];
function copy(from, to) {
  const target = join(outDir, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(from, target);
  copied.push(to);
}

for (const name of readdirSync(siteDir)) {
  const full = join(siteDir, name);
  if (!statSync(full).isFile() || !PUBLISHED_EXT.has(extname(name))) continue;
  copy(full, name);
}
for (const [to, from] of Object.entries(EXTRA_FILES)) copy(join(repoRoot, from), to);

const pages = copied.filter((f) => f.endsWith('.html'));
const problems = [];

/** Local references in a page: [{ ref, attr }]. Absolute URLs into SITE_URL count as local. */
function collectRefs(html) {
  const refs = [];
  const attrRe = /\s(src|href|poster|srcset|content)\s*=\s*"([^"]*)"/g;
  for (const m of html.matchAll(attrRe)) {
    const [, attr, raw] = m;
    const values = attr === 'srcset' ? raw.split(',').map((s) => s.trim().split(/\s+/)[0]) : [raw];
    for (let value of values) {
      if (!value) continue;
      if (value.startsWith(SITE_URL)) value = value.slice(SITE_URL.length) || './';
      else if (attr === 'content')
        continue; // meta content that is not a site URL
      else if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) continue; // external
      refs.push({ ref: value, attr });
    }
  }
  return refs;
}

for (const page of pages) {
  const html = readFileSync(join(outDir, page), 'utf8');
  const ids = new Set([...html.matchAll(/\sid\s*=\s*"([^"]+)"/g)].map((m) => m[1]));

  for (const { ref } of collectRefs(html)) {
    const [pathPart, hash] = ref.split('#');
    const path = decodeURIComponent(pathPart.split('?')[0]);

    if (!path) {
      if (hash && !ids.has(hash)) problems.push(`${page}: anchor #${hash} has no matching id`);
      continue;
    }

    const local = path === './' || path.endsWith('/') ? `${path}index.html` : path;
    const normalized = local.replace(/^\.\//, '');
    const target = join(outDir, normalized);

    if (!existsSync(target)) {
      const mapped = Object.entries(MAPPED_DIRS).find(([prefix]) => normalized.startsWith(prefix));
      const source = mapped && join(repoRoot, mapped[1], normalized.slice(mapped[0].length));
      if (source && existsSync(source)) copy(source, normalized);
      else problems.push(`${page}: ${ref} does not resolve`);
    }
  }
}

if (problems.length > 0) {
  console.error(`Site build failed, ${problems.length} broken reference(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

let total = 0;
for (const f of copied) total += statSync(join(outDir, f)).size;
console.log(
  `Built ${relative(repoRoot, outDir) || '.'}: ${copied.length} files, ${(total / 1024 / 1024).toFixed(2)} MB; all references resolve.`,
);
