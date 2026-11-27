/**
 * What an image analyzer (Cactus Mirage today) understood about a screenshot: a short description,
 * the objects it found and the text it read itself.
 *
 * This sits next to the Tesseract `OcrResult`, it does not replace it: Tesseract gives exact word
 * boxes for the selectable text layer, the analyzer gives meaning ("error dialog", "bar chart")
 * for search and the Analysis panel. All boxes are in pixels of the original image.
 */
import { ocrText, type OcrBox, type OcrResult } from './ocr';

/** Languages the analysis can be written in (Mirage also knows de/fr/es/it/nl; the app ships two). */
export const ANALYSIS_LANGUAGES = ['en', 'pl'] as const;
export type AnalysisLanguage = (typeof ANALYSIS_LANGUAGES)[number];

export interface AnalysisObject {
  /** The engine's entity id; several boxes of one entity share it. */
  readonly id: number;
  /** Open-vocabulary name in the analysis language, e.g. "dialog box", "wykres słupkowy". */
  readonly label: string;
  readonly box: OcrBox;
  /** 0..1. */
  readonly score: number;
  /** Where it is in the picture, in words ("left", "on bottle"), when the engine says. */
  readonly position?: string | undefined;
  /** Attributes such as colour or material, as the engine named them. */
  readonly attributes: Readonly<Record<string, string>>;
}

/** A line of text the analyzer read on its own (coarser than Tesseract, but independent of it). */
export interface AnalysisText {
  readonly text: string;
  readonly box: OcrBox;
  readonly score: number;
}

export interface ImageAnalysis {
  /** Engine, model and runtime, e.g. "mirage.cact@3d03cee/cactus@4.1.4". */
  readonly engine: string;
  readonly language: AnalysisLanguage;
  /** Size of the image the boxes refer to (the original screenshot). */
  readonly width: number;
  readonly height: number;
  /** Short description, one statement per entry, shown as the Analysis panel's paragraph. */
  readonly description: readonly string[];
  /** Scene attributes ("setting": "indoor", "style": "screenshot"). */
  readonly scene: Readonly<Record<string, string>>;
  readonly objects: readonly AnalysisObject[];
  readonly text: readonly AnalysisText[];
  readonly durationMs: number;
}

/** Text that makes an analysed screenshot findable: description, scene words and object labels. */
export function analysisSearchText(analysis: ImageAnalysis): string {
  const labels = [...new Set(analysis.objects.map((object) => object.label))];
  return [
    analysis.description.join('\n'),
    Object.values(analysis.scene).join(' '),
    labels.join(' '),
  ]
    .filter((part) => part.length > 0)
    .join('\n');
}

/**
 * The search document of a screenshot: Tesseract's text first (exact, what users type most), then
 * the analysis. Either may be missing (recognition off, analysis not run yet).
 */
export function screenshotSearchText(
  ocr: Pick<OcrResult, 'lines'> | null,
  analysis: ImageAnalysis | null,
): string {
  return [ocr ? ocrText(ocr) : '', analysis ? analysisSearchText(analysis) : '']
    .filter((part) => part.length > 0)
    .join('\n');
}
