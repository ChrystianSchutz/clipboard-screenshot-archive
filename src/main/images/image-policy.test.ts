import { describe, expect, it } from 'vitest';
import {
  encodedSkipReason,
  fitWithin,
  IMAGE_LIMITS,
  imageHash,
  imageHashOffThread,
  ImageSkip,
  imageSkipReason,
  isImageHash,
  isPng,
  jpegDimensions,
  MAX_ENCODED_BYTES,
  pngDimensions,
} from './image-policy';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The first 24 bytes of a PNG (signature + IHDR length, type, width, height), plus `extra` bytes. */
function pngHeader(
  width: number,
  height: number,
  { chunkLength = 13, chunkType = 'IHDR', extra = 9 } = {},
): Uint8Array {
  const bytes = new Uint8Array(24 + extra);
  bytes.set(PNG_SIGNATURE, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, chunkLength);
  bytes.set(new TextEncoder().encode(chunkType), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** A segment: FF, marker, 16-bit length (including itself), payload. */
function segment(marker: number, payload: number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

/** A JPEG up to its first scan: SOI, an APP0 and a DQT segment, a frame header, then SOS. */
function jpegHeader(
  width: number,
  height: number,
  { sof = 0xc0, before = [] as number[] } = {},
): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xdb, new Array<number>(65).fill(1)),
    ...before,
    ...segment(sof, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]),
    ...segment(0xda, [1, 1, 0, 0, 0x3f, 0]),
    0x12,
    0x34,
    0xff,
    0xd9,
  ]);
}

describe('imageSkipReason', () => {
  it('keeps ordinary screenshots', () => {
    expect(imageSkipReason(1920, 1080)).toBeNull();
    expect(imageSkipReason(400, 120)).toBeNull();
  });

  it('skips images whose shorter side is below the minimum, however many pixels they have', () => {
    expect(imageSkipReason(IMAGE_LIMITS.minSide - 1, 4000)).toBe('too-small');
    expect(imageSkipReason(4000, IMAGE_LIMITS.minSide - 1)).toBe('too-small');
    expect(imageSkipReason(IMAGE_LIMITS.minSide, 4000)).toBeNull();
  });

  it('skips icon-sized images with too few pixels even when both sides are long enough', () => {
    // 63 × 64 has sides above minSide but one pixel row short of 64 × 64.
    expect(imageSkipReason(63, 64)).toBe('too-small');
    expect(imageSkipReason(64, 64)).toBeNull();
  });

  it('accepts exactly the maximum pixel count and skips one more', () => {
    expect(imageSkipReason(7680, 4320)).toBeNull();
    // Same area plus one pixel row, with the long side still far below maxSide.
    expect(imageSkipReason(7680, 4321)).toBe('too-large');
  });

  it('skips panoramas whose longer side exceeds the maximum, even with few pixels', () => {
    expect(imageSkipReason(IMAGE_LIMITS.maxSide, 100)).toBeNull();
    expect(imageSkipReason(IMAGE_LIMITS.maxSide + 1, 100)).toBe('too-large');
    expect(imageSkipReason(100, IMAGE_LIMITS.maxSide + 1)).toBe('too-large');
  });
});

describe('imageHash', () => {
  const pixels = new Uint8Array(400 * 4).fill(7);

  it('is a deterministic 64-character lowercase hex digest', () => {
    const hash = imageHash(20, 20, pixels);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(imageHash(20, 20, pixels)).toBe(hash);
  });

  it('includes the size, so the same bytes in another shape do not collide', () => {
    expect(imageHash(20, 20, pixels)).not.toBe(imageHash(40, 10, pixels));
    expect(imageHash(100, 4, pixels)).not.toBe(imageHash(4, 100, pixels));
  });

  it('differs when a single pixel differs', () => {
    const changed = pixels.slice();
    changed[123] = 8;
    expect(imageHash(20, 20, changed)).not.toBe(imageHash(20, 20, pixels));
  });
});

describe('isImageHash', () => {
  const hash = 'a'.repeat(32) + '0123456789abcdef'.repeat(2);

  it('accepts a lowercase sha256 hex digest', () => {
    expect(isImageHash(hash)).toBe(true);
    expect(isImageHash(imageHash(1, 1, new Uint8Array(4)))).toBe(true);
  });

  it('rejects anything that could escape the image folder or is not a digest', () => {
    expect(isImageHash('../../etc/passwd')).toBe(false);
    expect(isImageHash(`../${hash.slice(3)}`)).toBe(false);
    expect(isImageHash(hash.toUpperCase())).toBe(false);
    expect(isImageHash(hash.slice(1))).toBe(false);
    expect(isImageHash(`${hash}0`)).toBe(false);
    expect(isImageHash(`${hash}\n`)).toBe(false);
    expect(isImageHash('')).toBe(false);
  });
});

describe('fitWithin', () => {
  it('never enlarges an image that already fits', () => {
    expect(fitWithin(100, 50, 320, 200)).toEqual({ width: 100, height: 50 });
  });

  it('scales down by the tighter side and keeps the aspect ratio', () => {
    expect(fitWithin(1920, 1080, 320, 200)).toEqual({ width: 320, height: 180 });
    expect(fitWithin(1000, 2000, 320, 200)).toEqual({ width: 100, height: 200 });
  });

  it('never returns a side shorter than one pixel', () => {
    expect(fitWithin(10_000, 1, 320, 200)).toEqual({ width: 320, height: 1 });
    expect(fitWithin(1, 10_000, 320, 200)).toEqual({ width: 1, height: 200 });
  });
});

describe('isPng', () => {
  it('recognises the PNG signature', () => {
    expect(isPng(new Uint8Array(PNG_SIGNATURE))).toBe(true);
    expect(isPng(pngHeader(100, 100))).toBe(true);
  });

  it('rejects other bytes, a damaged signature and input shorter than the signature', () => {
    expect(isPng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBe(false); // JPEG
    const damaged = pngHeader(100, 100);
    damaged[7] = 0;
    expect(isPng(damaged)).toBe(false);
    expect(isPng(new Uint8Array(PNG_SIGNATURE.slice(0, 7)))).toBe(false);
    expect(isPng(new Uint8Array())).toBe(false);
  });
});

describe('pngDimensions', () => {
  it('reads width and height from the IHDR chunk, big-endian', () => {
    expect(pngDimensions(pngHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(pngDimensions(pngHeader(0x01020304, 7))).toEqual({ width: 0x01020304, height: 7 });
  });

  it('works on exactly 24 bytes and on a view into a larger buffer', () => {
    expect(pngDimensions(pngHeader(40, 50, { extra: 0 }))).toEqual({ width: 40, height: 50 });
    const backing = new Uint8Array(100);
    backing.set(pngHeader(300, 200), 10);
    expect(pngDimensions(backing.subarray(10, 43))).toEqual({ width: 300, height: 200 });
  });

  it('returns null for a wrong signature', () => {
    const bytes = pngHeader(100, 100);
    bytes[0] = 0x88;
    expect(pngDimensions(bytes)).toBeNull();
  });

  it('returns null when the first chunk is not a 13-byte IHDR', () => {
    expect(pngDimensions(pngHeader(100, 100, { chunkLength: 12 }))).toBeNull();
    expect(pngDimensions(pngHeader(100, 100, { chunkType: 'IDAT' }))).toBeNull();
    expect(pngDimensions(pngHeader(100, 100, { chunkType: 'ihdr' }))).toBeNull();
  });

  it('returns null for input too short to hold the size', () => {
    expect(pngDimensions(pngHeader(100, 100, { extra: 0 }).subarray(0, 23))).toBeNull();
    expect(pngDimensions(new Uint8Array(PNG_SIGNATURE))).toBeNull();
  });

  it('returns null for a zero width or height', () => {
    expect(pngDimensions(pngHeader(0, 100))).toBeNull();
    expect(pngDimensions(pngHeader(100, 0))).toBeNull();
  });
});

describe('encodedSkipReason', () => {
  /** Bytes that claim a huge size without allocating it. */
  class HugeBytes extends Uint8Array {
    override get byteLength(): number {
      return MAX_ENCODED_BYTES + 1;
    }
  }

  it('skips encoded bytes larger than the limit before looking inside them', () => {
    expect(encodedSkipReason(new HugeBytes(16))).toBe('too-large');
    // Even a small, valid PNG header is refused when the file around it is too big.
    const huge = new HugeBytes(33);
    huge.set(pngHeader(800, 600));
    expect(encodedSkipReason(huge)).toBe('too-large');
  });

  it('skips a PNG whose header declares too many pixels', () => {
    expect(encodedSkipReason(pngHeader(20_000, 20_000))).toBe('too-large');
  });

  it('skips a PNG whose header declares an icon-sized image', () => {
    expect(encodedSkipReason(pngHeader(16, 16))).toBe('too-small');
  });

  it('keeps a PNG of an ordinary size', () => {
    expect(encodedSkipReason(pngHeader(1920, 1080))).toBeNull();
  });

  it('skips a JPEG whose frame header declares too many pixels or an icon, before decoding', () => {
    expect(encodedSkipReason(jpegHeader(20_000, 20_000))).toBe('too-large');
    expect(encodedSkipReason(jpegHeader(65_535, 2_000, { sof: 0xc2 }))).toBe('too-large');
    expect(encodedSkipReason(jpegHeader(16, 16))).toBe('too-small');
    expect(encodedSkipReason(jpegHeader(1920, 1080))).toBeNull();
  });

  it('refuses a JPEG whose frame header cannot be found, instead of letting the decoder guess', () => {
    expect(encodedSkipReason(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]))).toBe(
      'unreadable',
    );
    expect(encodedSkipReason(jpegHeader(0, 0))).toBe('unreadable');
  });

  it('leaves formats other than PNG and JPEG to the check after decoding', () => {
    expect(encodedSkipReason(new TextEncoder().encode('GIF89a and more'))).toBeNull();
    expect(encodedSkipReason(new Uint8Array())).toBeNull();
    // A PNG with a malformed header is not judged by its declared size either.
    expect(encodedSkipReason(pngHeader(16, 16, { chunkType: 'IDAT' }))).toBeNull();
  });
});

describe('jpegDimensions', () => {
  it('reads the size from baseline and progressive frame headers', () => {
    expect(jpegDimensions(jpegHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(jpegDimensions(jpegHeader(640, 480, { sof: 0xc2 }))).toEqual({
      width: 640,
      height: 480,
    });
  });

  it('walks past fill bytes, restart-free markers and stray bytes like libjpeg does', () => {
    const before = [0xff, 0xff, 0x00, 0x13, ...segment(0xc4, [0, 1, 2, 3])];
    expect(jpegDimensions(jpegHeader(800, 600, { before }))).toEqual({ width: 800, height: 600 });
  });

  it('does not take a DHT, JPG or DAC segment for a frame header', () => {
    for (const marker of [0xc4, 0xc8, 0xcc]) {
      const decoy = segment(marker, [8, 0xff, 0xff, 0xff, 0xff, 1, 1, 0x11, 0]);
      expect(jpegDimensions(jpegHeader(800, 600, { before: decoy }))).toEqual({
        width: 800,
        height: 600,
      });
    }
  });

  it('returns null for non-JPEG bytes, a scan before any frame, a zero height or truncation', () => {
    expect(jpegDimensions(pngHeader(800, 600))).toBeNull();
    expect(
      jpegDimensions(new Uint8Array([0xff, 0xd8, ...segment(0xda, [1, 1, 0, 0, 0x3f, 0])])),
    ).toBeNull();
    expect(jpegDimensions(jpegHeader(800, 0))).toBeNull();
    expect(jpegDimensions(jpegHeader(800, 600).subarray(0, 30))).toBeNull();
  });
});

describe('imageHashOffThread', () => {
  it('returns exactly the same digest as imageHash', async () => {
    const pixels = new Uint8Array(30 * 20 * 4).map((_, index) => (index * 31) & 0xff);

    await expect(imageHashOffThread(30, 20, pixels)).resolves.toBe(imageHash(30, 20, pixels));
    await expect(imageHashOffThread(20, 30, pixels)).resolves.toBe(imageHash(20, 30, pixels));
  });

  it('hashes only the viewed pixels of a subarray', async () => {
    const backing = new Uint8Array(64).fill(9);
    const pixels = backing.subarray(8, 24);

    await expect(imageHashOffThread(2, 2, pixels)).resolves.toBe(imageHash(2, 2, pixels));
  });
});

describe('ImageSkip', () => {
  it('carries the reason and names it in the message', () => {
    const skip = new ImageSkip('too-small');

    expect(skip).toBeInstanceOf(Error);
    expect(skip.reason).toBe('too-small');
    expect(skip.name).toBe('ImageSkip');
    expect(skip.message).toBe('Image skipped: too-small');
    expect(new ImageSkip('too-large').reason).toBe('too-large');
  });
});
