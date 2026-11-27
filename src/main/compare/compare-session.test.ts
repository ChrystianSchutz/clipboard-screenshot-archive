import { beforeEach, describe, expect, it } from 'vitest';
import { compareSide } from '../test-support/fakes';
import { CompareSession } from './compare-session';

describe('CompareSession', () => {
  const a = compareSide('{"a":1}', 1);
  const b = compareSide('{"a":2}', 2);
  const c = compareSide('{"a":3}', 3);

  let session: CompareSession;

  beforeEach(() => {
    session = new CompareSession();
  });

  it('starts with no state', () => {
    expect(session.current).toBeNull();
  });

  it('waits for the second side after the first press', () => {
    expect(session.press(a)).toEqual({ phase: 'waiting-for-b', left: a });
    expect(session.current).toEqual({ phase: 'waiting-for-b', left: a });
  });

  it('becomes ready with both sides after the second press', () => {
    session.press(a);

    expect(session.press(b)).toEqual({ phase: 'ready', left: a, right: b });
  });

  it('starts a new comparison with the third press, using it as the new left side', () => {
    session.press(a);
    session.press(b);

    expect(session.press(c)).toEqual({ phase: 'waiting-for-b', left: c });
  });

  it('sets both sides directly with set()', () => {
    expect(session.set(a, b)).toEqual({ phase: 'ready', left: a, right: b });
  });

  it('starts over after set() when pressed again', () => {
    session.set(a, b);

    expect(session.press(c)).toEqual({ phase: 'waiting-for-b', left: c });
  });

  it('replaces a half-finished comparison with set()', () => {
    session.press(a);

    expect(session.set(b, c)).toEqual({ phase: 'ready', left: b, right: c });
  });

  it('clears the state on reset, so the next press starts fresh', () => {
    session.press(a);
    session.reset();

    expect(session.current).toBeNull();
    expect(session.press(b)).toEqual({ phase: 'waiting-for-b', left: b });
  });

  describe('presses whose reads finish out of order', () => {
    it('keeps A as the first press even when the second read finishes first', () => {
      const first = session.beginPress();
      const second = session.beginPress();

      expect(session.completePress(second, b)).toBe(false); // waits for the first press
      expect(session.current).toBeNull();
      expect(session.completePress(first, a)).toBe(true);

      expect(session.current).toEqual({ phase: 'ready', left: a, right: b });
    });

    it('applies an in-order result immediately', () => {
      const first = session.beginPress();

      expect(session.completePress(first, a)).toBe(true);
      expect(session.current).toEqual({ phase: 'waiting-for-b', left: a });
    });

    it('does not let a failed read block the presses after it', () => {
      const failed = session.beginPress();
      const next = session.beginPress();
      session.completePress(next, b);

      expect(session.completePress(failed, null)).toBe(true);
      expect(session.current).toEqual({ phase: 'waiting-for-b', left: b });
    });

    it('drops reads that started before a reset', () => {
      const stale = session.beginPress();
      session.reset();
      const fresh = session.beginPress();

      expect(session.completePress(stale, a)).toBe(false);
      expect(session.completePress(fresh, b)).toBe(true);
      expect(session.current).toEqual({ phase: 'waiting-for-b', left: b });
    });

    it('drops reads that started before a comparison was opened from the history', () => {
      const stale = session.beginPress();
      session.set(a, b);

      expect(session.completePress(stale, c)).toBe(false);
      expect(session.current).toEqual({ phase: 'ready', left: a, right: b });
    });

    it('does not wait for a press that was outstanding at reset time', () => {
      session.beginPress(); // never completes: its read was abandoned by the reset
      session.reset();
      const fresh = session.beginPress();

      expect(session.completePress(fresh, c)).toBe(true);
    });
  });
});
