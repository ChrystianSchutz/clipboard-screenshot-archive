import { fitWithin } from '../images/image-policy';
import type { ImageHandle } from '../images/ports';
import type { AnalysisImage } from './ports';

/** Mirage's input limit per side (its official browser worker rejects anything larger). */
export const ANALYSIS_MAX_SIDE = 1024;

/**
 * Converts a BGRA bitmap (what Electron's `nativeImage.toBitmap()` returns on Windows and macOS)
 * to packed RGB, dropping alpha. Transparent pixels keep their colour channels as they are.
 */
export function bgraToRgb(bgra: Uint8Array, width: number, height: number): Uint8Array {
  const pixels = width * height;
  if (bgra.length !== pixels * 4)
    throw new Error(`Expected ${pixels * 4} bytes of BGRA, got ${bgra.length}`);
  const rgb = new Uint8Array(pixels * 3);
  for (let source = 0, target = 0; source < bgra.length; source += 4, target += 3) {
    rgb[target] = bgra[source + 2] ?? 0;
    rgb[target + 1] = bgra[source + 1] ?? 0;
    rgb[target + 2] = bgra[source] ?? 0;
  }
  return rgb;
}

/** The analyzer's input: the screenshot scaled down to at most 1024 px per side, as RGB. */
export function toAnalysisImage(image: ImageHandle): AnalysisImage {
  const size = fitWithin(image.width, image.height, ANALYSIS_MAX_SIDE, ANALYSIS_MAX_SIDE);
  const source =
    size.width === image.width && size.height === image.height
      ? image
      : image.resized(size.width, size.height);
  return {
    rgb: bgraToRgb(source.bitmap(), source.width, source.height),
    width: source.width,
    height: source.height,
    originalWidth: image.width,
    originalHeight: image.height,
  };
}
