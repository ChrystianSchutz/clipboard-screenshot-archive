import { describe, expect, it } from 'vitest';
import {
  DAY,
  formatClock,
  formatRelative,
  formatTimestamp,
  HOUR,
  localDayKey,
  MINUTE,
  rangeStart,
  startOfLocalDay,
} from './time';

/**
 * Every date is built with the local-time `Date` constructor, so the tests hold in any time zone.
 * Month is 0-based: `at(2026, 10, 27)` is 27 Nov 2026.
 */
function at(year: number, month: number, day: number, hours = 0, minutes = 0, seconds = 0): number {
  return new Date(year, month, day, hours, minutes, seconds).getTime();
}

describe('rangeStart', () => {
  const now = at(2026, 10, 27, 12);

  it('returns null for "all"', () => {
    expect(rangeStart('all', now)).toBeNull();
  });

  it.each([
    ['1h', HOUR],
    ['24h', DAY],
    ['7d', 7 * DAY],
    ['30d', 30 * DAY],
  ] as const)('subtracts the length of %s from now', (range, length) => {
    expect(rangeStart(range, now)).toBe(now - length);
  });
});

describe('startOfLocalDay', () => {
  it('returns local midnight of the same day', () => {
    expect(startOfLocalDay(at(2026, 10, 27, 23, 59, 59))).toBe(at(2026, 10, 27));
  });

  it('is idempotent at midnight', () => {
    expect(startOfLocalDay(at(2026, 10, 27))).toBe(at(2026, 10, 27));
  });
});

describe('localDayKey', () => {
  it('formats the local calendar day with zero padding', () => {
    expect(localDayKey(at(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });

  it('separates the last millisecond of a day from the next midnight', () => {
    expect(localDayKey(at(2026, 11, 31) + DAY - 1)).toBe('2026-12-31');
    expect(localDayKey(at(2027, 0, 1))).toBe('2027-01-01');
  });
});

describe('formatClock and formatTimestamp', () => {
  it('formats a zero-padded 24-hour clock', () => {
    expect(formatClock(at(2026, 10, 27, 7, 5))).toBe('07:05');
  });

  it('formats a full local timestamp with seconds', () => {
    expect(formatTimestamp(at(2026, 10, 27, 14, 3, 9))).toBe('2026-11-27 14:03:09');
  });
});

describe('formatRelative', () => {
  const now = at(2026, 10, 27, 14, 0);

  it.each([
    ['the same instant', 0],
    ['44.999 s ago', 44_999],
  ])('says "just now" for %s', (_label, elapsed) => {
    expect(formatRelative(now - elapsed, now)).toBe('just now');
  });

  it('says "just now" for a timestamp slightly in the future (clock skew)', () => {
    expect(formatRelative(now + 5_000, now)).toBe('just now');
  });

  it('switches to minutes at exactly 45 s, never showing "0 min"', () => {
    expect(formatRelative(now - 45_000, now)).toBe('1 min ago');
  });

  it('rounds minutes to the nearest whole minute', () => {
    expect(formatRelative(now - 89_999, now)).toBe('1 min ago');
    expect(formatRelative(now - 90_000, now)).toBe('2 min ago');
    expect(formatRelative(now - 4 * MINUTE, now)).toBe('4 min ago');
  });

  it('switches to hours at exactly one hour', () => {
    expect(formatRelative(now - HOUR, now)).toBe('1 h ago');
  });

  it('floors hours for earlier today', () => {
    expect(formatRelative(now - (3 * HOUR + 59 * MINUTE), now)).toBe('3 h ago');
  });

  it('counts hours back to local midnight of today', () => {
    expect(formatRelative(at(2026, 10, 27, 0, 0), now)).toBe('14 h ago');
  });

  it('says "yesterday" with the clock for one minute before midnight', () => {
    expect(formatRelative(at(2026, 10, 26, 23, 59), now)).toBe('yesterday 23:59');
  });

  it('says "yesterday" for yesterday at midnight', () => {
    expect(formatRelative(at(2026, 10, 26, 0, 0), now)).toBe('yesterday 00:00');
  });

  it('says "yesterday" shortly after midnight even when less than a day has passed', () => {
    const justAfterMidnight = at(2026, 10, 27, 0, 30);

    expect(formatRelative(at(2026, 10, 26, 23, 20), justAfterMidnight)).toBe('yesterday 23:20');
  });

  it('shows day, month and clock for older dates in the same year', () => {
    expect(formatRelative(at(2026, 10, 25, 23, 59), now)).toBe('25 Nov 23:59');
    expect(formatRelative(at(2026, 0, 3, 8, 15), now)).toBe('3 Jan 08:15');
  });

  it('shows day, month and year (no clock) for previous years', () => {
    expect(formatRelative(at(2025, 10, 12, 14, 3), now)).toBe('12 Nov 2025');
  });

  describe('across a year boundary', () => {
    const newYear = at(2027, 0, 1, 10, 0);

    it('still says "yesterday" for New Year’s Eve', () => {
      expect(formatRelative(at(2026, 11, 31, 22, 0), newYear)).toBe('yesterday 22:00');
    });

    it('uses the year form for a date two days back in the previous year', () => {
      expect(formatRelative(at(2026, 11, 30, 10, 0), newYear)).toBe('30 Dec 2026');
    });
  });
});
