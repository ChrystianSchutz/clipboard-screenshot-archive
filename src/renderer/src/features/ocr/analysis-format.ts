import type { AnalysisLanguage, AnalysisObject, ImageAnalysis } from '@shared/image-analysis';
import type { OcrBox } from '@shared/ocr';
import type { AnalysisModelState } from '@shared/screenshots';

/**
 * Pure helpers behind the Analysis panel: grouping the analyzer's objects into entities, the box
 * to highlight for one of them, and the small formatters for sizes, scores and durations.
 */

/** One thing the analyzer found. Several boxes can belong to one entity (they share an id). */
export interface AnalysisEntity {
  readonly id: number;
  readonly label: string;
  /** Best score among the entity's boxes, 0..1. */
  readonly score: number;
  readonly position: string | undefined;
  readonly boxCount: number;
}

/** Objects grouped by entity id, in the order the analyzer first reported each entity. */
export function analysisEntities(objects: readonly AnalysisObject[]): AnalysisEntity[] {
  const byId = new Map<number, AnalysisEntity>();
  for (const object of objects) {
    const known = byId.get(object.id);
    byId.set(
      object.id,
      known
        ? {
            ...known,
            score: Math.max(known.score, object.score),
            position: known.position ?? object.position,
            boxCount: known.boxCount + 1,
          }
        : {
            id: object.id,
            label: object.label,
            score: object.score,
            position: object.position,
            boxCount: 1,
          },
    );
  }
  return [...byId.values()];
}

/**
 * The box that covers every box of entity `id`, in pixels of an image of `imageSize` (the analysis
 * boxes are rescaled when the analyzer saw the image at another size). `null` when there is no
 * such entity.
 */
export function entityBox(
  analysis: Pick<ImageAnalysis, 'objects' | 'width' | 'height'>,
  id: number | null,
  imageSize?: { readonly width: number; readonly height: number },
): OcrBox | null {
  if (id === null) return null;
  const boxes = analysis.objects.filter((object) => object.id === id).map((object) => object.box);
  if (boxes.length === 0) return null;
  const union: OcrBox = {
    x0: Math.min(...boxes.map((box) => box.x0)),
    y0: Math.min(...boxes.map((box) => box.y0)),
    x1: Math.max(...boxes.map((box) => box.x1)),
    y1: Math.max(...boxes.map((box) => box.y1)),
  };
  if (!imageSize || analysis.width <= 0 || analysis.height <= 0) return union;
  const sx = imageSize.width / analysis.width;
  const sy = imageSize.height / analysis.height;
  if (sx === 1 && sy === 1) return union;
  return { x0: union.x0 * sx, y0: union.y0 * sy, x1: union.x1 * sx, y1: union.y1 * sy };
}

/** Bytes as whole megabytes (decimal, like download pages): 22_000_000 → "22 MB". */
export function formatMegabytes(bytes: number): string {
  return `${Math.max(0, Math.round(bytes / 1_000_000))} MB`;
}

/** Download progress in whole percent, or `null` while the total size is unknown. */
export function downloadPercent(
  state: Extract<AnalysisModelState, { state: 'downloading' }>,
): number | null {
  if (state.total <= 0) return null;
  return Math.min(100, Math.max(0, Math.floor((state.received / state.total) * 100)));
}

/** A 0..1 score as a rounded percentage: 0.876 → "88%". */
export function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/** 850 → "850 ms", 1234 → "1.2 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

const LANGUAGE_NAMES: Record<AnalysisLanguage, string> = { en: 'English', pl: 'Polish' };

export function languageName(language: AnalysisLanguage): string {
  return LANGUAGE_NAMES[language];
}
