/**
 * What the renderer knows about an image clip (kind `'image'`): its size, the text Tesseract read
 * from it and, when the user asked for it, Mirage's analysis. Crosses the IPC boundary, so it stays
 * plain data.
 */
import type { ImageAnalysis } from './image-analysis';
import type { OcrResult } from './ocr';

/** `off`: text recognition was switched off when the image was captured. */
export const TEXT_RECOGNITION_STATES = ['pending', 'done', 'failed', 'off'] as const;
export type TextRecognitionState = (typeof TEXT_RECOGNITION_STATES)[number];

/** `none`: nobody asked for an analysis yet (on-demand mode, or analysis off). */
export const IMAGE_ANALYSIS_STATES = ['none', 'pending', 'done', 'failed'] as const;
export type ImageAnalysisState = (typeof IMAGE_ANALYSIS_STATES)[number];

export interface ScreenshotDetails {
  readonly clipId: number;
  readonly width: number;
  readonly height: number;
  /** Size of the stored PNG. */
  readonly byteSize: number;
  readonly text: { readonly state: TextRecognitionState; readonly result: OcrResult | null };
  readonly analysis: { readonly state: ImageAnalysisState; readonly result: ImageAnalysis | null };
}

/** The optional analysis model (Mirage weights) in `userData/models`. */
export type AnalysisModelState =
  | { readonly state: 'missing'; readonly size: number }
  | { readonly state: 'downloading'; readonly received: number; readonly total: number }
  | { readonly state: 'ready' }
  | { readonly state: 'failed'; readonly size: number; readonly error: string };

/** Image bytes reach the page only through this protocol (see `screenshot-protocol.ts`), never `file://`. */
export const SCREENSHOT_SCHEME = 'clip-image';
const SCREENSHOT_HOST = 'clip';

export type ScreenshotVariant = 'full' | 'thumb';

/** `clip-image://clip/<clipId>/<variant>`: addressed by clip id, so no hash or path leaves main. */
export function screenshotUrl(clipId: number, variant: ScreenshotVariant): string {
  return `${SCREENSHOT_SCHEME}://${SCREENSHOT_HOST}/${clipId}/${variant}`;
}

/** The clip and variant a screenshot URL names, or `null` for anything else. */
export function parseScreenshotUrl(
  url: string,
): { clipId: number; variant: ScreenshotVariant } | null {
  if (!URL.canParse(url)) return null;
  const { protocol, host, pathname, search, hash } = new URL(url);
  if (
    protocol !== `${SCREENSHOT_SCHEME}:` ||
    host !== SCREENSHOT_HOST ||
    search !== '' ||
    hash !== ''
  )
    return null;
  const match = /^\/([1-9]\d{0,15})\/(full|thumb)$/.exec(pathname);
  if (!match) return null;
  const clipId = Number(match[1]);
  if (!Number.isSafeInteger(clipId)) return null;
  return { clipId, variant: match[2] as ScreenshotVariant };
}
