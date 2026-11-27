/** Small text helpers for list rendering and stats. */

export function countLines(content: string): number {
  if (content === '') return 0;
  return content.split(/\r\n|\r|\n/).length;
}

/** First non-blank line with whitespace collapsed, for one-line list rows. */
export function firstLine(content: string, maxLength = 160): string {
  const line = content.split(/\r?\n/).find((candidate) => candidate.trim() !== '') ?? '';
  const collapsed = line.replace(/\s+/g, ' ').trim();
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength - 1)}…`;
}

/** "842", "1.2k", "48k", "1.3M". */
export function compactNumber(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Host name without "www.", or `null` when the string is not an http(s) URL. */
export function domainOf(url: string): string | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.hostname.replace(/^www\./, '');
}
