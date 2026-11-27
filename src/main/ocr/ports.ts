import type { OcrResult } from '@shared/ocr';

/**
 * The text-recognition port (Tesseract today). Storage, search and the text layer only ever see
 * `OcrResult`, so the engine can be replaced without touching them. Image understanding is a
 * separate port with a separate job (`ImageAnalyzer` in src/main/analysis/ports.ts).
 */
export interface TextRecognizer {
  /** Stable id stored with every result, e.g. "tesseract.js@7.0.0/eng+pol". */
  readonly id: string;
  /**
   * Recognises the text in one image. Boxes in the result refer to `image.width` × `image.height`,
   * even when the engine was handed an upscaled copy (see `OcrImage.scale`).
   */
  recognize(image: OcrImage): Promise<OcrResult>;
  /** Frees the engine (workers, WASM memory). The next `recognize` starts it again. */
  dispose(): Promise<void>;
}

export interface OcrImage {
  /** PNG-encoded pixels the engine reads; may be an upscaled copy of the original. */
  readonly png: Uint8Array;
  /** Size of the original image. */
  readonly width: number;
  readonly height: number;
  /** How much `png` was enlarged relative to the original (1 = not at all). */
  readonly scale: number;
}
