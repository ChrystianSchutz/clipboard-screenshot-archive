import {
  canonicalize,
  diffJson,
  parseJson,
  summarize,
  type DiffSummary,
  type JsonChange,
} from '@shared/json-diff';
import { sideBySide, type DiffRow, type LineDiffResult } from '@shared/text-diff';

export interface CompareOptions {
  readonly ignoreArrayOrder: boolean;
}

export type Comparison =
  | {
      readonly mode: 'json';
      readonly changes: readonly JsonChange[];
      readonly summary: DiffSummary;
      /** Line diff of both documents re-serialised with sorted keys, so key order never shows up. */
      readonly lines: LineDiffResult;
      /** The data is equal but the raw text differs (key order, whitespace, escapes). */
      readonly sameDataDifferentText: boolean;
    }
  | {
      readonly mode: 'text';
      readonly lines: LineDiffResult;
      /** Why the JSON comparison was not used, when one side did look like JSON. */
      readonly notice: string | null;
    };

const looksLikeJson = (text: string): boolean => /^\s*[[{]/.test(text);

function pretty(value: Parameters<typeof canonicalize>[0], options: CompareOptions): string {
  return JSON.stringify(canonicalize(value, options), null, 2);
}

/**
 * Decides how to compare two clipboard texts: a structural JSON diff when both sides parse,
 * otherwise a line diff with a hint about which side broke the JSON.
 */
export function compareTexts(left: string, right: string, options: CompareOptions): Comparison {
  const a = parseJson(left);
  const b = parseJson(right);

  if (a.ok && b.ok) {
    const changes = diffJson(a.value, b.value, options);
    return {
      mode: 'json',
      changes,
      summary: summarize(changes),
      lines: sideBySide(pretty(a.value, options), pretty(b.value, options)),
      sameDataDifferentText: changes.length === 0 && left.trim() !== right.trim(),
    };
  }

  let notice: string | null = null;
  if (!a.ok && looksLikeJson(left)) notice = `A is not valid JSON (${a.error}), comparing as text.`;
  else if (!b.ok && looksLikeJson(right))
    notice = `B is not valid JSON (${b.error}), comparing as text.`;
  return { mode: 'text', lines: sideBySide(left, right), notice };
}

export type DisplayRow =
  | { readonly kind: 'row'; readonly row: DiffRow }
  | { readonly kind: 'gap'; readonly start: number; readonly count: number };

/**
 * Folds long runs of unchanged lines into a single "N unchanged lines" gap, keeping `context`
 * lines around every change, like a code review tool. `expanded` holds the starts of gaps the
 * user has opened.
 */
export function foldUnchanged(
  rows: readonly DiffRow[],
  context = 3,
  expanded: ReadonlySet<number> = new Set(),
): DisplayRow[] {
  const keep = rows.map((row) => row.type !== 'same');
  const near = keep.map((_, index) => {
    for (
      let k = Math.max(0, index - context);
      k <= Math.min(rows.length - 1, index + context);
      k++
    ) {
      if (keep[k]) return true;
    }
    return false;
  });

  const result: DisplayRow[] = [];
  let index = 0;
  while (index < rows.length) {
    if (near[index]) {
      const row = rows[index];
      if (row) result.push({ kind: 'row', row });
      index++;
      continue;
    }
    const start = index;
    while (index < rows.length && !near[index]) index++;
    const count = index - start;
    // A gap of one or two lines costs more space than it saves.
    if (count <= 2 || expanded.has(start)) {
      for (let k = start; k < index; k++) {
        const row = rows[k];
        if (row) result.push({ kind: 'row', row });
      }
    } else {
      result.push({ kind: 'gap', start, count });
    }
  }
  return result;
}
