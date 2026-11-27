/**
 * Whether `url` is the app's renderer document, given `documentUrl`: the dev-server page in
 * development, `app://bundle/index.html` otherwise (see app-protocol.ts). Scheme, host (with
 * port) and path must match exactly; hash and query (window role, startup parameters) do not
 * change which document is loaded, so they may vary. Not a prefix match: a sibling path, another
 * port or a `file://` page is a different document and gets no trust.
 */
export function isAppDocumentUrl(url: string, documentUrl: string): boolean {
  if (!URL.canParse(url)) return false;
  const actual = new URL(url);
  const expected = new URL(documentUrl);
  return (
    actual.protocol === expected.protocol &&
    actual.host === expected.host &&
    normalPath(actual.pathname) === normalPath(expected.pathname) &&
    actual.username === '' &&
    actual.password === ''
  );
}

/**
 * Navigation and redirect policy: only the main frame may (re)load, and only the app document.
 * Electron does not report programmatic loads (`loadURL`) here, so they are unaffected.
 */
export function isAllowedNavigation(
  target: { readonly url: string; readonly isMainFrame: boolean },
  isAppUrl: (url: string) => boolean,
): boolean {
  return target.isMainFrame && isAppUrl(target.url);
}

/** `http://host:5173` and `http://host:5173/` are the same page. */
function normalPath(pathname: string): string {
  return pathname === '' ? '/' : pathname;
}
