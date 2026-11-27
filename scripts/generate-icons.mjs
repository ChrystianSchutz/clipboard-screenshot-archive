// Renders the app and tray icons from signed distance functions into PNG files.
// No image tooling or design files needed: `node scripts/generate-icons.mjs`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';

const root = join(import.meta.dirname, '..');

/** Signed distance to a rounded rectangle centred at (cx, cy). Negative inside. */
function roundedRect(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

const mix = (a, b, t) => a + (b - a) * t;

/** Colour of one sample in a 0..1 unit square, as premultiplied [r, g, b, a] in 0..1. */
function sample(u, v) {
  const out = [0, 0, 0, 0];
  const over = (color, alpha) => {
    for (let i = 0; i < 3; i++) out[i] = color[i] * alpha + out[i] * (1 - alpha);
    out[3] = alpha + out[3] * (1 - alpha);
  };

  // Tile: indigo → teal diagonal gradient.
  if (roundedRect(u, v, 0.5, 0.5, 0.47, 0.47, 0.11) < 0) {
    const t = (u + v) / 2;
    over([mix(0.36, 0.13, t), mix(0.35, 0.72, t), mix(0.95, 0.75, t)], 1);
  }

  // Clipboard board.
  if (roundedRect(u, v, 0.5, 0.55, 0.25, 0.3, 0.05) < 0) over([1, 1, 1], 0.96);
  // Clip on top.
  if (roundedRect(u, v, 0.5, 0.27, 0.11, 0.055, 0.025) < 0) over([0.12, 0.13, 0.2], 1);

  // The "trail": three lines that fade out, oldest last.
  const lines = [
    [0.44, 0.17, 1],
    [0.56, 0.13, 0.6],
    [0.68, 0.09, 0.3],
  ];
  for (const [y, half, alpha] of lines) {
    if (roundedRect(u, v, 0.5 - 0.15 + half, y, half, 0.028, 0.028) < 0) {
      over([0.27, 0.32, 0.86], alpha);
    }
  }
  return out;
}

function render(size) {
  const ss = 4; // 4x4 supersampling for anti-aliased edges
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const s = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          for (let i = 0; i < 4; i++) acc[i] += s[i];
        }
      }
      const n = ss * ss;
      const alpha = acc[3] / n;
      const offset = (y * size + x) * 4;
      for (let i = 0; i < 3; i++) {
        pixels[offset + i] = alpha > 0 ? Math.round((acc[i] / n / alpha) * 255) : 0;
      }
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, size, pixels);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outputs = [
  ['build/icon.png', 512],
  ['resources/icon.png', 256],
  ['resources/tray.png', 32],
];

for (const [file, size] of outputs) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, render(size));
  console.log(`wrote ${file} (${size}x${size})`);
}
