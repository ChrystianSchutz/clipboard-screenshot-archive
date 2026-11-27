// Tiny static server for previewing the built site: node site/serve.mjs [dir] [port]
// Defaults: site/_dist on http://127.0.0.1:4173/. Supports Range requests so the demo video seeks.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] ?? join(siteDir, '_dist'));
const port = Number(process.argv[3] ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

if (!existsSync(root)) {
  console.error(`${root} does not exist. Run "node site/build.mjs" first.`);
  process.exit(1);
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let file = normalize(join(root, decodeURIComponent(url.pathname)));
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }

  const size = statSync(file).size;
  const headers = {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': end - start + 1,
    });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`Serving ${root} on http://127.0.0.1:${port}/`);
});
