/** Pure helpers behind the stats charts. Kept free of React so they are trivial to unit test. */

/** Rounds a maximum up to a "nice" axis value: 1, 2, 2.5, 5 or 10 × 10ⁿ. Never below 1. */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 1) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  const nice = [1, 2, 2.5, 5, 10].find((step) => fraction <= step) ?? 10;
  return nice * base;
}

/**
 * Integer percentages that always add up to exactly 100 (largest remainder method),
 * so a legend never reads "33% + 33% + 33%".
 */
export function percentages(counts: readonly number[]): number[] {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return counts.map(() => 0);
  const raw = counts.map((count) => (count / total) * 100);
  const floored = raw.map(Math.floor);
  let remaining = 100 - floored.reduce((sum, value) => sum + value, 0);
  const byRemainder = raw
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of byRemainder) {
    if (remaining <= 0) break;
    floored[index] = (floored[index] ?? 0) + 1;
    remaining -= 1;
  }
  return floored;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Parses a `YYYY-MM-DD` key as a local date (never as UTC midnight). */
function parseDayKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** "Mon" for the axis. */
export function weekdayShort(key: string): string {
  const date = parseDayKey(key);
  return date ? (WEEKDAYS[date.getDay()] ?? key) : key;
}

/** "Mon, 23 Nov" for tooltips and the table view. */
export function dayLong(key: string): string {
  const date = parseDayKey(key);
  if (!date) return key;
  return `${WEEKDAYS[date.getDay()] ?? ''}, ${String(date.getDate())} ${MONTHS[date.getMonth()] ?? ''}`;
}

/** "09:00–10:00" */
export function hourRange(hour: number): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(hour)}:00–${pad((hour + 1) % 24)}:00`;
}

/** The busiest entry, or `null` when everything is zero. Ties go to the earliest entry. */
export function peak<T extends { readonly count: number }>(entries: readonly T[]): T | null {
  let best: T | null = null;
  for (const entry of entries) if (entry.count > (best?.count ?? 0)) best = entry;
  return best;
}
