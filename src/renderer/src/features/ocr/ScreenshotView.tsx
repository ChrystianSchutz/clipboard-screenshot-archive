import { useEffect, useRef, useState, type RefObject } from 'react';
import { ocrText, type OcrBox, type OcrResult } from '@shared/ocr';
import { Icon } from '../../components/Icon';
import { displayScale, scaleBox, type MeasureText } from './text-layer-geometry';
import { TextLayer } from './TextLayer';
import './ocr.css';

export type OcrStatus = 'pending' | 'done' | 'failed' | 'off';

export type CopyScope = 'line' | 'all';

/** Width and height in pixels. */
export interface PixelSize {
  readonly width: number;
  readonly height: number;
}

export interface ScreenshotViewProps {
  /** URL of the full image (served by the app's image protocol, never a raw file path). */
  readonly src: string;
  readonly alt: string;
  readonly ocr: OcrResult | null;
  readonly status: OcrStatus;
  /**
   * Writes text to the clipboard (a clicked line, or "Copy all text"). When it returns a promise,
   * the status line confirms the copy once it resolves.
   */
  readonly onCopyText: (text: string, scope: CopyScope) => unknown;
  /** Reads the text again; offered as "Try again" when reading failed. */
  readonly onRetryText?: (() => void) | undefined;
  /** A box in image pixels to outline over the picture, e.g. the selected analysis object. */
  readonly highlight?: OcrBox | null;
  /**
   * Size of the original image, the space `highlight` is given in. Defaults to the OCR result's
   * size, then to the loaded image's natural size.
   */
  readonly imageSize?: PixelSize;
  readonly measure?: MeasureText;
}

const STATUS_TEXT: Record<OcrStatus, string> = {
  pending: 'Reading text…',
  done: '',
  failed: 'Text could not be read from this image.',
  off: 'Text recognition is off.',
};

const COPY_NOTICE: Record<CopyScope, string> = {
  line: 'Copied line',
  all: 'Copied all text',
};

/** How long a copy confirmation replaces the status line. */
export const COPY_NOTICE_MS = 2000;

/**
 * A screenshot with its recognised text laid over it: select text with the mouse like in a PDF,
 * click a line to copy it, or copy everything at once. An optional highlight outlines one region
 * (an object the analysis found) without getting in the way of the selection.
 */
export function ScreenshotView({
  src,
  alt,
  ocr,
  status,
  onCopyText,
  onRetryText,
  highlight,
  imageSize,
  measure,
}: ScreenshotViewProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const displayed = useDisplayedSize(imageRef);
  const [notice, showNotice] = useTransientNotice(COPY_NOTICE_MS);
  const text = ocr ? ocrText(ocr) : '';

  const copy = (value: string, scope: CopyScope): void => {
    Promise.resolve(onCopyText(value, scope)).then(
      () => showNotice(COPY_NOTICE[scope]),
      () => showNotice('Could not copy the text'),
    );
  };

  const reference = imageSize ?? ocr ?? displayed?.natural ?? null;
  const highlightBox =
    highlight && displayed && reference && reference.width > 0 && reference.height > 0
      ? scaleBox(highlight, displayScale(reference, displayed.width, displayed.height))
      : null;

  return (
    <figure className="screenshot-view">
      <div className="screenshot-view__toolbar">
        <span className="screenshot-view__status" role="status">
          {notice ?? statusText(status, ocr)}
        </span>
        {status === 'failed' && onRetryText ? (
          <button type="button" className="button" onClick={onRetryText}>
            Try again
          </button>
        ) : null}
        <button
          type="button"
          className="button"
          disabled={text.length === 0}
          onClick={() => copy(text, 'all')}
        >
          <Icon name="copy" />
          Copy all text
        </button>
      </div>
      <div className="screenshot-view__canvas">
        <img
          ref={imageRef}
          className="screenshot-view__image"
          src={src}
          alt={alt}
          draggable={false}
        />
        {ocr && displayed ? (
          <TextLayer
            result={ocr}
            width={displayed.width}
            height={displayed.height}
            onCopyLine={(line) => copy(line, 'line')}
            {...(measure ? { measure } : {})}
          />
        ) : null}
        {highlightBox ? (
          <div
            className="screenshot-view__highlight"
            data-testid="screenshot-highlight"
            aria-hidden="true"
            style={{
              left: highlightBox.left,
              top: highlightBox.top,
              width: highlightBox.width,
              height: highlightBox.height,
            }}
          />
        ) : null}
      </div>
    </figure>
  );
}

function statusText(status: OcrStatus, ocr: OcrResult | null): string {
  if (status !== 'done') return STATUS_TEXT[status];
  const lineCount = ocr?.lines.length ?? 0;
  if (lineCount === 0) return 'No text found';
  return `${lineCount} ${lineCount === 1 ? 'line' : 'lines'} of text`;
}

/** A message that clears itself after `durationMs`; showing a new one restarts the timer. */
function useTransientNotice(durationMs: number): [string | null, (message: string) => void] {
  const [notice, setNotice] = useState<{ readonly message: string } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), durationMs);
    return () => clearTimeout(timer);
  }, [notice, durationMs]);
  // A fresh object every time, so copying twice in a row restarts the timer.
  return [notice?.message ?? null, (message) => setNotice({ message })];
}

interface DisplayedSize extends PixelSize {
  /** The image's own pixel size, once it has loaded. */
  readonly natural: PixelSize | null;
}

/** Rendered size of the image, kept current when the preview pane is resized. */
function useDisplayedSize(ref: RefObject<HTMLImageElement | null>): DisplayedSize | null {
  const [size, setSize] = useState<DisplayedSize | null>(null);
  useEffect(() => {
    const image = ref.current;
    if (!image) return;
    const update = () => {
      const { width, height } = image.getBoundingClientRect();
      const natural =
        image.naturalWidth > 0 && image.naturalHeight > 0
          ? { width: image.naturalWidth, height: image.naturalHeight }
          : null;
      setSize((previous) =>
        width > 0 &&
        height > 0 &&
        (previous?.width !== width ||
          previous.height !== height ||
          previous.natural?.width !== natural?.width)
          ? { width, height, natural }
          : previous,
      );
    };
    update();
    image.addEventListener('load', update);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(image);
    return () => {
      image.removeEventListener('load', update);
      observer?.disconnect();
    };
  }, [ref]);
  return size;
}
