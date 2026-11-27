import type { AnalysisLanguage, ImageAnalysis } from '@shared/image-analysis';

/**
 * The image-analysis port (Cactus Mirage today): describes a screenshot, finds objects and reads
 * text on its own. Independent of `TextRecognizer`: either can be swapped or switched off alone.
 */
export interface ImageAnalyzer {
  /** Stable id stored with every analysis, e.g. "mirage.cact@3d03cee/cactus@4.1.4". */
  readonly id: string;
  analyze(image: AnalysisImage, language: AnalysisLanguage): Promise<ImageAnalysis>;
  /** Frees the model (WASM memory). The next `analyze` loads it again. */
  dispose(): Promise<void>;
}

export interface AnalysisImage {
  /** Packed 8-bit RGB pixels, row by row, `width * height * 3` bytes. */
  readonly rgb: Uint8Array;
  /** Size of `rgb`: the original, scaled down to fit the model's input limit. */
  readonly width: number;
  readonly height: number;
  /** Size of the original screenshot; result boxes refer to it. */
  readonly originalWidth: number;
  readonly originalHeight: number;
}
