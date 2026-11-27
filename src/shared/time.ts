import type { TimeRange } from './types';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const RANGE_MS: Record<Exclude<TimeRange, 'all'>, number> = {
  '1h': HOUR,
  '24h': DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
};

/** Lower bound (epoch ms) for a time range filter, or `null` for "all". */
export function rangeStart(range: TimeRange, now: number): number | null {
  return range === 'all' ? null : now - RANGE_MS[range];
}

export function startOfLocalDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** Local calendar day as "YYYY-MM-DD". */
export function localDayKey(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatClock(time: number): string {
  const date = new Date(time);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "just now", "4 min ago", "3 h ago", "yesterday 14:03", "12 Nov 14:03", "12 Nov 2025". */
export function formatRelative(time: number, now: number): string {
  const elapsed = now - time;
  if (elapsed < 45_000) return 'just now';
  if (elapsed < HOUR) return `${Math.max(1, Math.round(elapsed / MINUTE))} min ago`;

  const today = startOfLocalDay(now);
  if (time >= today) return `${Math.floor(elapsed / HOUR)} h ago`;
  if (time >= startOfLocalDay(today - 1)) return `yesterday ${formatClock(time)}`;

  const date = new Date(time);
  const day = `${date.getDate()} ${MONTHS[date.getMonth()] ?? ''}`;
  return date.getFullYear() === new Date(now).getFullYear()
    ? `${day} ${formatClock(time)}`
    : `${day} ${date.getFullYear()}`;
}

/** Full timestamp for tooltips and the detail pane: "2026-11-27 14:03:09". */
export function formatTimestamp(time: number): string {
  const date = new Date(time);
  return `${localDayKey(time)} ${formatClock(time)}:${pad(date.getSeconds())}`;
}
