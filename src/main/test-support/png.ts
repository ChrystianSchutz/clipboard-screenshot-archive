import { inflateSync } from 'node:zlib';

/**
 * Minimal PNG decoder for test fixtures (8-bit RGB or RGBA, not interlaced), so benchmarks can
 * feed raw pixels to engines without Electron's `nativeImage`. Not for production input.
 */
export function decodePng(file: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const view = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (view.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG file');
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  while (offset < view.length) {
    const length = view.readUInt32BE(offset);
    const type = view.toString('latin1', offset + 4, offset + 8);
    const body = view.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6))
        throw new Error('Unsupported PNG format');
      channels = colour === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const source = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? (pixels[row + x - channels] ?? 0) : 0;
      const up = y > 0 ? (pixels[row - stride + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= channels ? (pixels[row - stride + x - channels] ?? 0) : 0;
      pixels[row + x] = ((source[x] ?? 0) + predict(filter, left, up, upLeft)) & 0xff;
    }
  }

  if (channels === 4) return { width, height, rgba: pixels };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
    rgba[j] = pixels[i] ?? 0;
    rgba[j + 1] = pixels[i + 1] ?? 0;
    rgba[j + 2] = pixels[i + 2] ?? 0;
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}

function predict(filter: number, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    case 4: {
      const estimate = left + up - upLeft;
      const toLeft = Math.abs(estimate - left);
      const toUp = Math.abs(estimate - up);
      const toUpLeft = Math.abs(estimate - upLeft);
      if (toLeft <= toUp && toLeft <= toUpLeft) return left;
      return toUp <= toUpLeft ? up : upLeft;
    }
    default:
      throw new Error(`Unknown PNG filter ${filter}`);
  }
}

/**
 * The start of a PNG (signature and IHDR declaring `width` × `height`), with no pixel data: enough
 * for checks that read only the header.
 */
export function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24); // 8-bit RGBA, not interlaced
  return bytes;
}
