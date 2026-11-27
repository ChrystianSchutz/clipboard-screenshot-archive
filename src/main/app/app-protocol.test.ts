import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ net: {}, protocol: {}, session: {} }));

const { APP_CSP, APP_INDEX_URL, appRequestHandler, resolveAppFile } =
  await import('./app-protocol');

const root = join(
  tmpdir(),
  'Clipboard & Screenshot Archive',
  'resources',
  'app.asar',
  'out',
  'renderer',
);

describe('resolveAppFile', () => {
  it('maps the app document and its assets into the renderer folder', () => {
    expect(resolveAppFile(APP_INDEX_URL, root)).toBe(join(root, 'index.html'));
    expect(resolveAppFile('app://bundle/assets/index-abc.js', root)).toBe(
      join(root, 'assets', 'index-abc.js'),
    );
  });

  it('ignores query and hash', () => {
    expect(resolveAppFile(`${APP_INDEX_URL}?theme=dark#compare`, root)).toBe(
      join(root, 'index.html'),
    );
  });

  it('decodes percent-encoded names', () => {
    expect(resolveAppFile('app://bundle/my%20icon.png', root)).toBe(join(root, 'my icon.png'));
  });

  it.each([
    ['another host', 'app://other/index.html'],
    ['another scheme', 'file:///C:/index.html'],
    ['the folder itself', 'app://bundle/'],
    ['an encoded slash with a parent segment', 'app://bundle/..%2f..%2fsecret.txt'],
    ['an encoded backslash', 'app://bundle/..%5csecret.txt'],
    ['an encoded NUL', 'app://bundle/index.html%00.js'],
    ['malformed encoding', 'app://bundle/%E0%A4%A'],
    ['not a URL', 'index.html'],
  ])('refuses %s', (_label, url) => {
    expect(resolveAppFile(url, root)).toBeNull();
  });

  it.each(['app://bundle/../../secret.txt', 'app://bundle/%2e%2e/%2e%2e/secret.txt'])(
    'keeps %s inside the folder (the URL parser drops parent segments)',
    (url) => {
      expect(resolveAppFile(url, root)).toBe(join(root, 'secret.txt'));
    },
  );
});

describe('appRequestHandler', () => {
  let base: string;
  let bundle: string;
  /** Stands in for `net.fetch` of a file URL: reads the file from disk. */
  const fetchFile = vi.fn((url: string) =>
    Promise.resolve(new Response(readFileSync(fileURLToPath(url)), { status: 200 })),
  );

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'app-protocol-'));
    bundle = join(base, 'renderer');
    mkdirSync(join(bundle, 'assets'), { recursive: true });
    writeFileSync(join(bundle, 'index.html'), '<!doctype html><title>app</title>');
    writeFileSync(join(bundle, 'assets', 'index.js'), 'console.log(1)');
    mkdirSync(join(base, 'outside'));
    writeFileSync(join(base, 'outside', 'secret.txt'), 'secret');
    // A junction (Windows) or directory symlink inside the bundle that points outside it.
    symlinkSync(join(base, 'outside'), join(bundle, 'escape'), 'junction');
    // A file symlink needs a privilege on Windows; when it cannot be made, the junction covers it.
    try {
      symlinkSync(join(base, 'outside', 'secret.txt'), join(bundle, 'secret.txt'), 'file');
    } catch {
      // not permitted on this machine
    }
  });

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('serves the document with the production CSP as a header', async () => {
    const response = await appRequestHandler(
      bundle,
      fetchFile,
    )({ url: APP_INDEX_URL, method: 'GET' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toBe(APP_CSP);
    expect(APP_CSP).toContain("frame-ancestors 'none'");
    expect(await response.text()).toContain('<title>app</title>');
  });

  it('keeps the CSP header in step with the meta tag used by the dev server', () => {
    const html = readFileSync(join('src', 'renderer', 'index.html'), 'utf8');
    const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
    expect(meta?.[1]).toBe(APP_CSP);
  });

  it('serves assets without a CSP header and answers HEAD without a body', async () => {
    const handler = appRequestHandler(bundle, fetchFile);
    const asset = await handler({ url: 'app://bundle/assets/index.js', method: 'GET' });
    const head = await handler({ url: APP_INDEX_URL, method: 'HEAD' });

    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-security-policy')).toBeNull();
    expect(await asset.text()).toBe('console.log(1)');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-security-policy')).toBe(APP_CSP);
    expect(head.body).toBeNull();
  });

  it.each(['POST', 'PUT', 'DELETE', 'OPTIONS'])('refuses %s', async (method) => {
    fetchFile.mockClear();

    const response = await appRequestHandler(bundle, fetchFile)({ url: APP_INDEX_URL, method });

    expect(response.status).toBe(405);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it.each([
    ['a junction or symlinked folder that leads outside', 'app://bundle/escape/secret.txt'],
    ['a symlinked file that leads outside', 'app://bundle/secret.txt'],
    ['a missing file', 'app://bundle/assets/missing.js'],
    ['a path outside the bundle', 'app://bundle/../outside/secret.txt'],
  ])('answers 404 for %s', async (_label, url) => {
    fetchFile.mockClear();

    const response = await appRequestHandler(bundle, fetchFile)({ url, method: 'GET' });

    expect(response.status).toBe(404);
    expect(fetchFile).not.toHaveBeenCalled();
  });
});
