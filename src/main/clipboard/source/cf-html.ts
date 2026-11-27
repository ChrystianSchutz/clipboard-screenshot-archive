/**
 * Reads the page URL from Windows' "HTML Format" (CF_HTML) clipboard payload.
 *
 * When you copy a selection in a Chromium browser, the payload starts with a header like:
 *
 *   Version:0.9
 *   StartHTML:0000000105
 *   EndHTML:0000000199
 *   StartFragment:0000000141
 *   EndFragment:0000000163
 *   SourceURL:https://developer.mozilla.org/en-US/docs/Web/API
 *   <html>...
 *
 * Only http(s) URLs are returned: `file:` or `about:` sources are not useful as provenance.
 * @see https://learn.microsoft.com/windows/win32/dataxchg/html-clipboard-format
 */
export function parseCfHtmlSourceUrl(payload: string): string | null {
  // The header always precedes the markup; never scan into page content.
  const headerEnd = payload.search(/<html|<!--StartFragment|<!DOCTYPE/i);
  const header = headerEnd === -1 ? payload.slice(0, 2048) : payload.slice(0, headerEnd);

  const match = /^SourceURL:(.+)$/m.exec(header);
  const url = match?.[1]?.trim();
  if (!url || !URL.canParse(url)) return null;

  const { protocol } = new URL(url);
  return protocol === 'http:' || protocol === 'https:' ? url : null;
}
