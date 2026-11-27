import { useMemo, useRef, type ClipboardEvent, type MouseEvent } from 'react';
import type { OcrResult } from '@shared/ocr';
import {
  approximateMeasure,
  layoutTextLayer,
  textBetween,
  type MeasureText,
  type TextPosition,
} from './text-layer-geometry';
import { positionFromDom } from './text-layer-selection';

export interface TextLayerProps {
  readonly result: Pick<OcrResult, 'width' | 'height' | 'lines'>;
  /** Displayed size of the image in CSS pixels (the layer covers exactly that box). */
  readonly width: number;
  readonly height: number;
  /** Called when a line is clicked; the parent writes `text` to the clipboard. */
  readonly onCopyLine?: (text: string) => void;
  /** Called after Ctrl+C on a selection, with the text that was put on the clipboard. */
  readonly onCopied?: (text: string) => void;
  /** Text measurement; defaults to a canvas in the layer's font. */
  readonly measure?: MeasureText;
}

/** Font of the layer; the canvas measurer must use the same family. */
const LAYER_FONT = 'sans-serif';

/**
 * Transparent, selectable text over a screenshot (PDF.js-style text layer).
 *
 * - Every word is a span on its OCR box, horizontally stretched to the box width, so the native
 *   selection highlight lands on the right pixels of the image underneath.
 * - Copying builds the text from the OCR model, not from the DOM: lines come out in reading order
 *   with one `\n` between them, whatever order absolutely positioned spans would serialise in.
 * - A click (without dragging) on a line copies that whole line.
 */
export function TextLayer({
  result,
  width,
  height,
  onCopyLine,
  onCopied,
  measure,
}: TextLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const measureText = useMemo(() => measure ?? canvasMeasure(), [measure]);
  const lines = useMemo(
    () => layoutTextLayer(result, width, height, measureText),
    [result, width, height, measureText],
  );

  const selectedText = (): string | null => {
    const layer = layerRef.current;
    const selection = window.getSelection();
    if (!layer || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const start = endpoint(layer, range.startContainer, range.startOffset, lines.length);
    const end = endpoint(layer, range.endContainer, range.endOffset, lines.length);
    return start && end ? textBetween(lines, start, end) : null;
  };

  const onCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    const text = selectedText();
    if (text === null) return; // let the browser handle it
    event.preventDefault();
    event.clipboardData.setData('text/plain', text);
    onCopied?.(text);
  };

  const onLineClick = (event: MouseEvent<HTMLDivElement>, text: string) => {
    // A drag that selected text also ends in a click; only a plain click copies the line.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    event.stopPropagation();
    onCopyLine?.(text);
  };

  return (
    <div
      ref={layerRef}
      className="ocr-text-layer"
      style={{ width, height, fontFamily: LAYER_FONT }}
      onCopy={onCopy}
      data-testid="ocr-text-layer"
    >
      {lines.map((line) => (
        <div
          key={line.index}
          className="ocr-text-layer__line"
          data-line={line.index}
          title={onCopyLine ? 'Click to copy this line' : undefined}
          onClick={(event) => onLineClick(event, line.text)}
        >
          {line.pieces.map((piece) => (
            <span
              key={piece.start}
              data-start={piece.start}
              className={piece.kind === 'space' ? 'ocr-text-layer__space' : 'ocr-text-layer__word'}
              style={{
                left: piece.left,
                top: piece.top,
                height: piece.height,
                fontSize: piece.fontSize,
                lineHeight: `${piece.height}px`,
                transform: `scaleX(${piece.scaleX})`,
              }}
            >
              {piece.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Selection endpoint → position; endpoints outside the layer snap to its start or end. */
function endpoint(
  layer: HTMLElement,
  node: Node,
  offset: number,
  lineCount: number,
): TextPosition | null {
  if (layer.contains(node)) return positionFromDom(node, offset);
  if (lineCount === 0) return null;
  const before = (layer.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
  return before ? { line: 0, offset: 0 } : { line: lineCount - 1, offset: Number.MAX_SAFE_INTEGER };
}

/** Measures with a 2D canvas in the layer font; falls back to an estimate without canvas (tests). */
function canvasMeasure(): MeasureText {
  const context =
    typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!context) return approximateMeasure;
  return (text, fontSize) => {
    context.font = `${fontSize}px ${LAYER_FONT}`;
    return context.measureText(text).width;
  };
}
