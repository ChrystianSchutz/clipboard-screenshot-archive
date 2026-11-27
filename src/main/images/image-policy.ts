import { createHash } from 'node:crypto';

/**
 * Which clipboard images are worth keeping, and the pure maths around them.
 *
 * - Tiny images are icons, emoji or 1-pixel spacers that apps put on the clipboard alongside
 *   other content; they are noise in a screenshot history.
 * - Huge images (photos from a camera, 8K renders) would cost hundreds of MB to decode and OCR,
 *   and they are not screenshots of text anyway.
 */
export const IMAGE_LIMITS = {
  /** Shorter side below this → icon-sized. */
  minSide: 32,
  /** Fewer pixels than this (e.g. 64 × 64) → icon-sized. */
  minPixels: 64 * 64,
  /** 7680 × 4320 (8K) fits; a 50 MP camera photo does not. */
  maxPixels: 7680 * 4320,
  /** Longer side above this → a panorama or a scrolling capture too long to show or OCR. */
  maxSide: 16_384,
} as const;

/**
 * Largest encoded image (PNG/JPEG bytes) that is decoded at all. An 8K screenshot is 10–40 MB as
 * PNG; anything bigger is a photo, a hostile file or a PNG with junk chunks, and is refused before
 * the native decoder sees it.
 */
export const MAX_ENCODED_BYTES = 64 * 1024 * 1024;

export type ImageSkipReason = 'too-small' | 'too-large' | 'unreadable';

/**
 * Thrown by an image source (clipboard or file reader) that refused an image before decoding it;
 * the capture reports it as skipped with this reason instead of failing.
 */
export class ImageSkip extends Error {
  override readonly name = 'ImageSkip';

  constructor(readonly reason: ImageSkipReason) {
    super(`Image skipped: ${reason}`);
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/**
 * Size of a PNG read from its IHDR chunk (the first chunk, bytes 8–32), without decoding any
 * pixels. `null` for anything that is not a well-formed PNG header.
 */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || !isPng(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Chunk length 13, type "IHDR".
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** JPEG start-of-frame markers (baseline, progressive, lossless, arithmetic; not DHT/JPG/DAC). */
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * Size of a JPEG read from its start-of-frame segment, walking the marker segments before it
 * without decoding anything. `null` when the bytes are not a JPEG, or no well-formed frame header
 * comes before the image data (a height of 0, defined later by a DNL marker, counts as none).
 */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (!isJpeg(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    // Like libjpeg, skip stray bytes between segments, so this finds the frame header it uses.
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    // Fill bytes before a marker, a stuffed zero, and markers without a length (TEM, RSTn).
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // End of image or start of scan before any frame header: nothing to read the size from.
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = view.getUint16(offset + 2);
    if (length < 2) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      // Length, sample precision (1 byte), height, width.
      if (length < 7 || offset + 9 > bytes.length) return null;
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

/**
 * The checks that can run on encoded bytes, before the native decoder allocates anything: the
 * byte size, and for a PNG or a JPEG the size its header declares. A JPEG whose frame header
 * cannot be found is refused too (the decoder would have to guess); other formats are checked
 * after decoding.
 */
export function encodedSkipReason(bytes: Uint8Array): ImageSkipReason | null {
  if (bytes.byteLength > MAX_ENCODED_BYTES) return 'too-large';
  const size = pngDimensions(bytes) ?? jpegDimensions(bytes);
  if (size) return imageSkipReason(size.width, size.height);
  return isJpeg(bytes) ? 'unreadable' : null;
}

export function imageSkipReason(width: number, height: number): ImageSkipReason | null {
  const pixels = width * height;
  if (Math.min(width, height) < IMAGE_LIMITS.minSide || pixels < IMAGE_LIMITS.minPixels)
    return 'too-small';
  if (pixels > IMAGE_LIMITS.maxPixels || Math.max(width, height) > IMAGE_LIMITS.maxSide)
    return 'too-large';
  return null;
}

/**
 * Content hash of an image: sha256 over its size and raw pixels.
 *
 * Hashing pixels, not the encoded PNG, makes the same screenshot pasted from two apps (which may
 * encode it differently) one entry. The size is part of the hash so that two images with the same
 * bytes but different shapes (100 × 4 and 4 × 100) do not collide.
 */
export function imageHash(width: number, height: number, pixels: Uint8Array): string {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  return createHash('sha256').update(header).update(pixels).digest('hex');
}

/**
 * `imageHash` computed on libuv's thread pool (WebCrypto digests run off the main thread), so
 * hashing the pixels of a large screenshot does not block the main process. Same result.
 */
export async function imageHashOffThread(
  width: number,
  height: number,
  pixels: Uint8Array,
): Promise<string> {
  const data = new Uint8Array(8 + pixels.byteLength);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data.set(pixels, 8);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Buffer.from(digest).toString('hex');
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Hashes become file names and protocol URLs, so anything else is rejected outright. */
export function isImageHash(value: string): boolean {
  return HASH_PATTERN.test(value);
}

/** Largest size with the same aspect ratio that fits in `maxWidth` × `maxHeight`; never enlarges. */
export function fitWithin(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
