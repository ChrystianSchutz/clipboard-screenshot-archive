/**
 * Test data for the history component and helper tests. Not a test file itself (vitest only runs
 * `*.test.ts(x)`), and nothing outside tests imports it.
 */
import type { ClipSource, ClipSummary } from '@shared/types';

export function source(app: string | null): ClipSource {
  return { app, exe: app === null ? null : `${app}.exe`, url: null };
}

/** A history row: a short text clip from "Code", copied once at `1000 + id`. */
export function clipSummary(
  overrides: Partial<ClipSummary> & Pick<ClipSummary, 'id'>,
): ClipSummary {
  return {
    preview: `clip ${String(overrides.id)}`,
    kind: 'text',
    charCount: 10,
    lineCount: 1,
    firstCopiedAt: 1_000,
    lastCopiedAt: 1_000 + overrides.id,
    copyCount: 1,
    pinned: false,
    source: source('Code'),
    categories: [],
    ...overrides,
  };
}
