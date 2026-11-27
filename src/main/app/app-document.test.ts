import { describe, expect, it } from 'vitest';
import { isAllowedNavigation, isAppDocumentUrl } from './app-document';

const BUNDLE = 'app://bundle/index.html';
const DEV = 'http://localhost:5173';

describe('isAppDocumentUrl', () => {
  describe('built renderer (app://)', () => {
    it.each(['', '#palette', '#compare', '?theme=dark#compare'])(
      'trusts the app document with suffix "%s"',
      (suffix) => {
        expect(isAppDocumentUrl(`${BUNDLE}${suffix}`, BUNDLE)).toBe(true);
      },
    );

    it.each([
      ['another file in the bundle', 'app://bundle/other.html'],
      ['a longer path that merely starts with the document path', 'app://bundle/index.html.html'],
      ['another host on the same scheme', 'app://evil/index.html'],
      ['a userinfo trick', 'app://user@bundle/index.html'],
      ['a local file', 'file:///C:/app/out/renderer/index.html'],
      ['an http page', 'https://example.com/index.html'],
      ['a data URL', 'data:text/html,<p>hi</p>'],
      ['the dev server', `${DEV}/#palette`],
      ['not a URL', 'index.html'],
    ])('rejects %s', (_label, url) => {
      expect(isAppDocumentUrl(url, BUNDLE)).toBe(false);
    });
  });

  describe('dev server', () => {
    it.each([DEV, `${DEV}/`, `${DEV}/?theme=dark#compare`])(
      'trusts the dev server page %s',
      (url) => {
        expect(isAppDocumentUrl(url, DEV)).toBe(true);
      },
    );

    it.each([
      ['a prefix-sharing port', 'http://localhost:51730/'],
      ['a userinfo trick', 'http://localhost:5173@evil.example/'],
      ['another path on the dev server', `${DEV}/other.html`],
      ['another port', 'http://localhost:5174/'],
      ['https instead of http', 'https://localhost:5173/'],
      ['the bundle', BUNDLE],
    ])('rejects %s', (_label, url) => {
      expect(isAppDocumentUrl(url, DEV)).toBe(false);
    });
  });
});

describe('isAllowedNavigation', () => {
  const isAppUrl = (url: string): boolean => isAppDocumentUrl(url, BUNDLE);

  it('allows the main frame to load the app document', () => {
    expect(isAllowedNavigation({ url: `${BUNDLE}#palette`, isMainFrame: true }, isAppUrl)).toBe(
      true,
    );
  });

  it('blocks the main frame from navigating (or being redirected) anywhere else', () => {
    expect(isAllowedNavigation({ url: 'file:///C:/evil.html', isMainFrame: true }, isAppUrl)).toBe(
      false,
    );
  });

  it('blocks subframes, even when they point at the app document', () => {
    expect(isAllowedNavigation({ url: BUNDLE, isMainFrame: false }, isAppUrl)).toBe(false);
  });
});
