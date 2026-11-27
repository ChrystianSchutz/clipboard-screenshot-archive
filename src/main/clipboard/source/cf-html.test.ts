import { describe, expect, it } from 'vitest';
import { parseCfHtmlSourceUrl } from './cf-html';

/** Builds a CF_HTML payload the way Chromium writes it (CRLF line endings by default). */
function cfHtml(sourceUrl: string | null, body = '<b>hi</b>', eol = '\r\n'): string {
  const header = [
    'Version:0.9',
    'StartHTML:0000000105',
    'EndHTML:0000000199',
    'StartFragment:0000000141',
    'EndFragment:0000000163',
    ...(sourceUrl === null ? [] : [`SourceURL:${sourceUrl}`]),
  ];
  return `${header.join(eol)}${eol}<html><body><!--StartFragment-->${body}<!--EndFragment--></body></html>`;
}

describe('parseCfHtmlSourceUrl', () => {
  it('reads an https SourceURL from a Chromium payload with CRLF line endings', () => {
    expect(parseCfHtmlSourceUrl(cfHtml('https://developer.mozilla.org/en-US/docs/Web/API'))).toBe(
      'https://developer.mozilla.org/en-US/docs/Web/API',
    );
  });

  it('reads the SourceURL with LF line endings', () => {
    expect(parseCfHtmlSourceUrl(cfHtml('http://localhost:3000/a?b=c', '<i>x</i>', '\n'))).toBe(
      'http://localhost:3000/a?b=c',
    );
  });

  it('trims trailing whitespace from the URL', () => {
    expect(parseCfHtmlSourceUrl('Version:0.9\r\nSourceURL:https://example.com/  \r\n<html>')).toBe(
      'https://example.com/',
    );
  });

  it('returns null when the header has no SourceURL', () => {
    expect(parseCfHtmlSourceUrl(cfHtml(null))).toBeNull();
  });

  it.each([
    'file:///C:/Users/me/page.html',
    'about:blank',
    'chrome://settings',
    'javascript:alert(1)',
  ])('returns null for the non-http source %s', (url) => {
    expect(parseCfHtmlSourceUrl(cfHtml(url))).toBeNull();
  });

  it('returns null for an unparsable SourceURL', () => {
    expect(parseCfHtmlSourceUrl(cfHtml('not a url'))).toBeNull();
  });

  it('returns null for an empty SourceURL', () => {
    expect(parseCfHtmlSourceUrl(cfHtml(''))).toBeNull();
  });

  it('ignores a SourceURL line inside the copied page markup', () => {
    const payload = cfHtml(null, '<pre>\nSourceURL:https://attacker.example/\n</pre>');

    expect(parseCfHtmlSourceUrl(payload)).toBeNull();
  });

  it('prefers the header URL over one that appears later in the markup', () => {
    const payload = cfHtml(
      'https://real.example/',
      '<pre>\nSourceURL:https://fake.example/\n</pre>',
    );

    expect(parseCfHtmlSourceUrl(payload)).toBe('https://real.example/');
  });

  it.each(['<!DOCTYPE html>', '<!--StartFragment-->', '<HTML>'])(
    'treats %s as the end of the header',
    (marker) => {
      const payload = `Version:0.9\r\n${marker}\r\nSourceURL:https://late.example/\r\n`;

      expect(parseCfHtmlSourceUrl(payload)).toBeNull();
    },
  );

  it('scans only the first 2 KB when no markup marker is present (truncated payload)', () => {
    const early = `Version:0.9\r\nSourceURL:https://early.example/\r\n${'x'.repeat(4000)}`;
    const late = `Version:0.9\r\n${'x'.repeat(2100)}\r\nSourceURL:https://late.example/\r\n`;

    expect(parseCfHtmlSourceUrl(early)).toBe('https://early.example/');
    expect(parseCfHtmlSourceUrl(late)).toBeNull();
  });

  it('returns null for an empty payload', () => {
    expect(parseCfHtmlSourceUrl('')).toBeNull();
  });
});
