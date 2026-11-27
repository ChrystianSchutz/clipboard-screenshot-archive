import { net, protocol, type Session } from 'electron';
import fs from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCREENSHOT_SCHEME } from '@shared/screenshots';
import { compareSession } from './windows';

/**
 * The built renderer is served from `app://bundle/`, not `file://`.
 *
 * The packaged binary ships with the `grantFileProtocolExtraPrivileges` fuse off, so `file://`
 * pages cannot load at all (Electron's guidance for that fuse is a custom protocol). A dedicated
 * origin also keeps the app away from the rest of the disk: the handler serves only files inside
 * the renderer folder, and the CSP's `'self'` means exactly this bundle.
 */
export const APP_SCHEME = 'app';
const APP_HOST = 'bundle';
export const APP_INDEX_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

/**
 * The production Content-Security-Policy, sent as a response header with every HTML document.
 * Same policy as the `<meta>` tag in src/renderer/index.html (which stays for the dev server), but
 * as a header `frame-ancestors` is enforced too: a `<meta>` CSP ignores that directive.
 */
export const APP_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: clip-image:; " +
  "font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Methods the bundle answers; anything else (POST, PUT, …) gets 405. */
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/**
 * Must run before `app` is ready, and only once (each call replaces the previous list), so every
 * custom scheme is registered here. A standard, secure scheme behaves like https for the page.
 * `clip-image:` serves screenshots (see `screenshot-protocol.ts`); it needs no fetch support,
 * only `<img>`.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: SCREENSHOT_SCHEME, privileges: { standard: true, secure: true } },
  ]);
}

/**
 * Serves `app://bundle/<path>` from `rootDir`, in the palette's (default) session and in the
 * compare window's own session (see `COMPARE_PARTITION`). Call once the app is ready.
 */
export function serveAppProtocol(rootDir: string): void {
  const handler = appRequestHandler(rootDir);
  for (const session of [undefined, compareSession()] as (Session | undefined)[]) {
    (session?.protocol ?? protocol).handle(APP_SCHEME, handler);
  }
}

/**
 * The `app://` request handler, testable with any `fetchFile` (Electron's `net.fetch` in production).
 * Only GET and HEAD, only files whose real path (symlinks and junctions resolved) is inside the
 * renderer folder, and the CSP header on HTML documents.
 */
export function appRequestHandler(
  rootDir: string,
  fetchFile: (url: string) => Promise<Response> = (url) => net.fetch(url),
): (request: { url: string; method: string }) => Promise<Response> {
  let realRoot: string | null = null;
  return async (request) => {
    if (!READ_METHODS.has(request.method.toUpperCase())) {
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    realRoot ??= realPath(rootDir);
    const file = resolveAppFile(request.url, rootDir);
    const real = file === null || realRoot === null ? null : realPath(file);
    if (real === null || realRoot === null || !isInside(realRoot, real)) {
      return new Response('Not found', { status: 404 });
    }
    const fetched = await fetchFile(pathToFileURL(real).href);
    const headers = new Headers(fetched.headers);
    if (/\.html?$/i.test(real)) headers.set('content-security-policy', APP_CSP);
    headers.set('x-content-type-options', 'nosniff');
    const body = request.method.toUpperCase() === 'HEAD' ? null : fetched.body;
    return new Response(body, { status: fetched.status, headers });
  };
}

/**
 * The file an `app://` URL refers to, or `null` when it is not a plain file inside `rootDir`
 * (another host, `..` segments, encoded separators). Query and hash are ignored. Lexical only:
 * `appRequestHandler` also checks the real path.
 */
export function resolveAppFile(url: string, rootDir: string): string | null {
  if (!URL.canParse(url)) return null;
  const { protocol: scheme, host, pathname } = new URL(url);
  if (scheme !== `${APP_SCHEME}:` || host !== APP_HOST) return null;

  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  if (path.includes('\\') || path.includes('\0')) return null;

  const root = resolve(rootDir);
  const file = resolve(root, `.${path}`);
  return isInside(root, file) ? file : null;
}

/** True when `file` is strictly inside `root` (not the folder itself, not outside it). */
function isInside(root: string, file: string): boolean {
  const inside = relative(root, file);
  return !(inside === '' || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside));
}

/**
 * The real path (symlinks and junctions resolved), or null when the file does not exist.
 * `fs.realpathSync` is used through the module object on purpose: Electron patches it to work
 * inside `app.asar`, where the packaged renderer lives.
 */
function realPath(path: string): string | null {
  try {
    return fs.realpathSync(path);
  } catch {
    return null;
  }
}
