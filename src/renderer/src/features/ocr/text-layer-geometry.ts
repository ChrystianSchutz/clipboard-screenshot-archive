import type { OcrBox, OcrLine, OcrResult } from '@shared/ocr';

/**
 * Geometry of the selectable text layer over a screenshot, the way PDF.js lays text over a page:
 * every word becomes a transparent span placed on the word's box and stretched horizontally
 * (`scaleX`) so the browser's own glyphs cover exactly the pixels Tesseract read. Selecting with
 * the mouse then highlights the right part of the image, and copying yields real text.
 *
 * Pure functions only; the component measures text and reads the displayed size, nothing else.
 */

/** Width of `text` in CSS pixels at `fontSize` in the layer's font (a canvas `measureText`). */
export type MeasureText = (text: string, fontSize: number) => number;

/** One positioned run of text: a word, or the space between two words. */
export interface LayoutPiece {
  readonly kind: 'word' | 'space';
  readonly text: string;
  /** Character offset of this piece within its line's text. */
  readonly start: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly fontSize: number;
  /** Horizontal stretch so the rendered text spans exactly `width`. */
  readonly scaleX: number;
}

export interface LayoutLine {
  readonly index: number;
  /** Equal to the concatenated piece texts (words joined by single spaces). */
  readonly text: string;
  readonly box: ScaledBox;
  readonly pieces: readonly LayoutPiece[];
}

export interface ScaledBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Font size as a share of the line box height. Tesseract's line box spans ascenders to
 * descenders, which is roughly the em box of a UI font; 0.9 keeps highlights inside the line.
 */
export const FONT_SIZE_RATIO = 0.9;

/** Scale factors from image pixels to displayed CSS pixels. */
export function displayScale(
  result: Pick<OcrResult, 'width' | 'height'>,
  displayWidth: number,
  displayHeight: number,
) {
  return { x: displayWidth / result.width, y: displayHeight / result.height };
}

export function scaleBox(box: OcrBox, scale: { x: number; y: number }): ScaledBox {
  return {
    left: box.x0 * scale.x,
    top: box.y0 * scale.y,
    width: Math.max(0, (box.x1 - box.x0) * scale.x),
    height: Math.max(0, (box.y1 - box.y0) * scale.y),
  };
}

/** Lays out every line of `result` for an image displayed at `displayWidth` × `displayHeight`. */
export function layoutTextLayer(
  result: Pick<OcrResult, 'width' | 'height' | 'lines'>,
  displayWidth: number,
  displayHeight: number,
  measure: MeasureText,
): LayoutLine[] {
  if (displayWidth <= 0 || displayHeight <= 0) return [];
  const scale = displayScale(result, displayWidth, displayHeight);
  return result.lines.map((line, index) => layoutLine(line, index, scale, measure));
}

function layoutLine(
  line: OcrLine,
  index: number,
  scale: { x: number; y: number },
  measure: MeasureText,
): LayoutLine {
  const box = scaleBox(line.box, scale);
  const fontSize = Math.max(1, box.height * FONT_SIZE_RATIO);
  const pieces: LayoutPiece[] = [];
  // Engines that only box whole lines get one piece per line; selection is then per line.
  const words = line.words.length > 0 ? line.words : [{ text: line.text, box: line.box }];
  let offset = 0;
  words.forEach((word, wordIndex) => {
    const wordBox = scaleBox(word.box, scale);
    if (wordIndex > 0) {
      const previous = pieces[pieces.length - 1];
      const gapLeft = previous ? previous.left + previous.width : wordBox.left;
      pieces.push(
        piece(
          'space',
          ' ',
          offset,
          gapLeft,
          box,
          Math.max(0, wordBox.left - gapLeft),
          fontSize,
          measure,
        ),
      );
      offset += 1;
    }
    pieces.push(
      piece('word', word.text, offset, wordBox.left, box, wordBox.width, fontSize, measure),
    );
    offset += word.text.length;
  });
  return { index, text: words.map((word) => word.text).join(' '), box, pieces };
}

function piece(
  kind: LayoutPiece['kind'],
  text: string,
  start: number,
  left: number,
  lineBox: ScaledBox,
  width: number,
  fontSize: number,
  measure: MeasureText,
): LayoutPiece {
  const natural = measure(text, fontSize);
  return {
    kind,
    text,
    start,
    left,
    top: lineBox.top,
    width,
    height: lineBox.height,
    fontSize,
    scaleX: natural > 0 && width > 0 ? width / natural : 1,
  };
}

/** A caret position in the layer: line index and character offset in that line's text. */
export interface TextPosition {
  readonly line: number;
  readonly offset: number;
}

function compare(a: TextPosition, b: TextPosition): number {
  return a.line - b.line || a.offset - b.offset;
}

/**
 * The text between two positions, in line order, one `\n` between lines; the order of the two
 * positions does not matter (selections can be made backwards). Offsets are clamped, so a
 * position "after the last character" is fine.
 */
export function textBetween(
  lines: readonly Pick<LayoutLine, 'text'>[],
  a: TextPosition,
  b: TextPosition,
): string {
  const [from, to] = compare(a, b) <= 0 ? [a, b] : [b, a];
  const parts: string[] = [];
  for (let index = Math.max(0, from.line); index <= Math.min(to.line, lines.length - 1); index++) {
    const text = lines[index]?.text ?? '';
    const start = index === from.line ? clamp(from.offset, text.length) : 0;
    const end = index === to.line ? clamp(to.offset, text.length) : text.length;
    parts.push(text.slice(start, Math.max(start, end)));
  }
  return parts.join('\n');
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}

/**
 * A rough text measurer for environments without canvas (jsdom, first paint): an average glyph
 * is about 0.55 em wide in UI and monospace fonts. Only `scaleX` depends on it.
 */
export const approximateMeasure: MeasureText = (text, fontSize) => text.length * fontSize * 0.55;
