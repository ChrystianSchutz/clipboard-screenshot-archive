/**
 * Screenshot settings: their values, defaults and validation. They are part of `Settings`
 * (types.ts) and persisted by the settings store with the rest.
 */
import { z } from 'zod';
import { ANALYSIS_LANGUAGES, type AnalysisLanguage } from './image-analysis';

/**
 * - `off`: never analyse.
 * - `on-demand`: an "Analyze" button on each screenshot.
 * - `automatic`: every new screenshot is analysed after its text was read.
 */
export const IMAGE_ANALYSIS_MODES = ['off', 'on-demand', 'automatic'] as const;
export type ImageAnalysisMode = (typeof IMAGE_ANALYSIS_MODES)[number];

export interface ImageRecognitionSettings {
  /** Tesseract text recognition on every captured screenshot. */
  readonly textRecognition: boolean;
  readonly imageAnalysis: ImageAnalysisMode;
  /** `null` follows the UI language (see `analysisLanguageFor`). */
  readonly analysisLanguage: AnalysisLanguage | null;
}

/**
 * Text recognition is on by default: it is local, ~0.1–0.5 s per screenshot and makes screenshots
 * searchable. Analysis is opt-in because it needs a 22 MB model download first.
 */
export const DEFAULT_IMAGE_RECOGNITION_SETTINGS: ImageRecognitionSettings = {
  textRecognition: true,
  imageAnalysis: 'off',
  analysisLanguage: null,
};

export const imageRecognitionSettingsSchema = z.object({
  textRecognition: z.boolean(),
  imageAnalysis: z.enum(IMAGE_ANALYSIS_MODES),
  analysisLanguage: z.enum(ANALYSIS_LANGUAGES).nullable(),
});

/** The analysis language: the explicit choice, else the UI language when it is Polish, else English. */
export function analysisLanguageFor(
  settings: Pick<ImageRecognitionSettings, 'analysisLanguage'>,
  uiLocale: string,
): AnalysisLanguage {
  if (settings.analysisLanguage) return settings.analysisLanguage;
  return uiLocale.toLowerCase().startsWith('pl') ? 'pl' : 'en';
}

/** Whether a screenshot gets analysed now: automatically after capture, or because the user asked. */
export function shouldAnalyze(mode: ImageAnalysisMode, trigger: 'capture' | 'user'): boolean {
  if (mode === 'off') return false;
  return trigger === 'user' || mode === 'automatic';
}
