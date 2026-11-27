import type { TextPosition } from './text-layer-geometry';

/**
 * Maps DOM selection endpoints inside the text layer to `TextPosition`s.
 *
 * The layer marks every line with `data-line="<index>"` and every piece (word or space) with
 * `data-start="<offset in the line>"`, and each piece holds exactly one text node. Browsers report
 * a selection endpoint either inside such a text node or as "child N of some element" (when a drag
 * ends between spans); both forms are handled here.
 */
export function positionFromDom(node: Node, offset: number): TextPosition | null {
  const element = node instanceof Element ? node : node.parentElement;
  if (!element) return null;

  const piece = element.closest<HTMLElement>('[data-start]');
  if (piece) {
    const line = lineIndexOf(piece);
    if (line === null) return null;
    const start = Number(piece.dataset.start);
    const length = piece.textContent.length;
    // Inside the text node: the character offset. On the span itself: before or after its text.
    const within = node === piece ? (offset > 0 ? length : 0) : Math.min(offset, length);
    return { line, offset: start + within };
  }

  const lineElement = element.closest<HTMLElement>('[data-line]');
  if (lineElement) {
    const line = Number(lineElement.dataset.line);
    const child = lineElement.children[offset] as HTMLElement | undefined;
    return { line, offset: child ? Number(child.dataset.start) : lineElement.textContent.length };
  }

  // On the layer itself: "before line N".
  const lineElements = element.querySelectorAll<HTMLElement>(':scope > [data-line]');
  if (lineElements.length === 0) return null;
  const target = lineElements[offset];
  if (target) return { line: Number(target.dataset.line), offset: 0 };
  const last = lineElements[lineElements.length - 1];
  return last ? { line: Number(last.dataset.line), offset: Number.MAX_SAFE_INTEGER } : null;
}

function lineIndexOf(piece: HTMLElement): number | null {
  const line = piece.closest<HTMLElement>('[data-line]');
  return line ? Number(line.dataset.line) : null;
}
