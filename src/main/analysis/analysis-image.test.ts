import { describe, expect, it } from 'vitest';
import type { ImageHandle } from '../images/ports';
import { FakeImage } from '../test-support/image-fakes';
import { ANALYSIS_MAX_SIDE, bgraToRgb, toAnalysisImage } from './analysis-image';

describe('bgraToRgb', () => {
  it('reorders blue-green-red to red-green-blue and drops alpha', () => {
    const bgra = new Uint8Array([
      10,
      20,
      30,
      255, // pixel 1: B G R A
      40,
      50,
      60,
      0, // pixel 2, fully transparent: colour kept as it is
    ]);

    expect([...bgraToRgb(bgra, 2, 1)]).toEqual([30, 20, 10, 60, 50, 40]);
  });

  it('rejects a buffer that does not match the size', () => {
    expect(() => bgraToRgb(new Uint8Array(7), 2, 1)).toThrow('Expected 8 bytes of BGRA, got 7');
    expect(() => bgraToRgb(new Uint8Array(12), 2, 1)).toThrow('Expected 8 bytes of BGRA, got 12');
  });
});

describe('toAnalysisImage', () => {
  it('passes an image within the model limit through at its own size', () => {
    const image = new FakeImage(ANALYSIS_MAX_SIDE, 600, 9);
    const analysis = toAnalysisImage(image);

    expect(image.resizes).toEqual([]);
    expect(analysis).toMatchObject({
      width: 1024,
      height: 600,
      originalWidth: 1024,
      originalHeight: 600,
    });
    expect(analysis.rgb).toHaveLength(1024 * 600 * 3);
  });

  it('scales a larger image down to fit, keeping the aspect ratio and recording the original size', () => {
    const image = new FakeImage(2560, 1440);
    const analysis = toAnalysisImage(image);

    expect(image.resizes).toEqual([{ width: 1024, height: 576 }]);
    expect(analysis).toMatchObject({
      width: 1024,
      height: 576,
      originalWidth: 2560,
      originalHeight: 1440,
    });
    expect(analysis.rgb).toHaveLength(1024 * 576 * 3);
  });

  it('fits portrait images by their height', () => {
    const image = new FakeImage(1000, 4000);
    expect(toAnalysisImage(image)).toMatchObject({
      width: 256,
      height: 1024,
      originalWidth: 1000,
      originalHeight: 4000,
    });
  });

  it('converts the pixels of the image it actually sends', () => {
    const blue: ImageHandle = {
      width: 1,
      height: 1,
      bitmap: () => new Uint8Array([255, 0, 0, 255]),
      png: () => new Uint8Array(),
      resized: () => blue,
    };

    expect([...toAnalysisImage(blue).rgb]).toEqual([0, 0, 255]);
  });
});
