import { diffLines, diffWordsWithSpace } from 'diff';

/**
 * Side-by-side line diff for the compare window.
 *
 * Built on jsdiff's Myers implementation. Consecutive removed + added blocks are paired into
 * "modified" rows with word-level highlights, the way code review tools render changes.
 */

export interface Segment {
  readonly text: string;
  readonly changed: boolean;
}

export interface DiffCell {
  /** 1-based line number in its own document. */
  readonly lineNo: number;
  readonly segments: readonly Segment[];
}

export type DiffRowType = 'same' | 'removed' | 'added' | 'modified';

export interface DiffRow {
  readonly type: DiffRowType;
  readonly left: DiffCell | null;
  readonly right: DiffCell | null;
}

export interface LineDiffResult {
  readonly rows: readonly DiffRow[];
  readonly addedLines: number;
  readonly removedLines: number;
}

/** Windows clipboards use CRLF; a line ending is never a meaningful difference here. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function splitLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function whole(text: string): Segment[] {
  return [{ text, changed: false }];
}

/** Word-level highlights for a pair of lines that replaced each other. */
export function inlineSegments(left: string, right: string): { left: Segment[]; right: Segment[] } {
  const leftSegments: Segment[] = [];
  const rightSegments: Segment[] = [];
  for (const part of diffWordsWithSpace(left, right)) {
    if (part.added) rightSegments.push({ text: part.value, changed: true });
    else if (part.removed) leftSegments.push({ text: part.value, changed: true });
    else {
      leftSegments.push({ text: part.value, changed: false });
      rightSegments.push({ text: part.value, changed: false });
    }
  }
  return { left: leftSegments, right: rightSegments };
}

export function sideBySide(leftText: string, rightText: string): LineDiffResult {
  const parts = diffLines(normalizeNewlines(leftText), normalizeNewlines(rightText), {
    ignoreNewlineAtEof: true,
  });

  const rows: DiffRow[] = [];
  let leftNo = 0;
  let rightNo = 0;
  let addedLines = 0;
  let removedLines = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const lines = splitLines(part.value);

    if (!part.added && !part.removed) {
      for (const line of lines) {
        rows.push({
          type: 'same',
          left: { lineNo: ++leftNo, segments: whole(line) },
          right: { lineNo: ++rightNo, segments: whole(line) },
        });
      }
      continue;
    }

    if (part.added) {
      addedLines += lines.length;
      for (const line of lines) {
        rows.push({
          type: 'added',
          left: null,
          right: { lineNo: ++rightNo, segments: whole(line) },
        });
      }
      continue;
    }

    // A removed block, possibly followed by the block that replaced it.
    removedLines += lines.length;
    const next = parts[i + 1];
    const replacement = next?.added ? splitLines(next.value) : [];
    if (next?.added) {
      addedLines += replacement.length;
      i++;
    }

    const paired = Math.max(lines.length, replacement.length);
    for (let k = 0; k < paired; k++) {
      const before = lines[k];
      const after = replacement[k];
      if (before !== undefined && after !== undefined) {
        const inline = inlineSegments(before, after);
        rows.push({
          type: 'modified',
          left: { lineNo: ++leftNo, segments: inline.left },
          right: { lineNo: ++rightNo, segments: inline.right },
        });
      } else if (before !== undefined) {
        rows.push({
          type: 'removed',
          left: { lineNo: ++leftNo, segments: whole(before) },
          right: null,
        });
      } else if (after !== undefined) {
        rows.push({
          type: 'added',
          left: null,
          right: { lineNo: ++rightNo, segments: whole(after) },
        });
      }
    }
  }

  return { rows, addedLines, removedLines };
}
