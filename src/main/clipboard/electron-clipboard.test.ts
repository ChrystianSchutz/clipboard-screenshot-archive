import { describe, expect, it, vi } from 'vitest';

// The readers under test take a port; the Electron clipboard itself is never touched here.
vi.mock('electron', () => ({ clipboard: {}, ClipboardItem: Object }));

const {
  imageFingerprintFrom,
  readWriteMarkerFrom,
  WRITE_MARKER_FORMAT,
  WRITE_MARKER_MIME,
  writeMarkerBlob,
} = await import('./electron-clipboard');

interface Item {
  types: string[];
  getType: (type: string) => Promise<unknown>;
}

function port(entries: Record<string, unknown>): {
  has: ReturnType<typeof vi.fn<(type: string) => Promise<boolean>>>;
  read: ReturnType<typeof vi.fn<() => Promise<Item[]>>>;
} {
  return {
    has: vi.fn((type: string) => Promise.resolve(type in entries)),
    read: vi.fn(() =>
      Promise.resolve([
        {
          types: Object.keys(entries),
          getType: (type: string) => Promise.resolve(entries[type]),
        },
      ]),
    ),
  };
}

const TOKEN = '0123456789abcdef0123456789abcdef';

describe('write marker', () => {
  it('is a web custom format, so other apps never paste it as content', () => {
    expect(WRITE_MARKER_FORMAT).toBe(`web ${WRITE_MARKER_MIME}`);
    expect(writeMarkerBlob(TOKEN).type).toBe(WRITE_MARKER_MIME);
  });

  it('reads back the token the app wrote', async () => {
    await expect(
      readWriteMarkerFrom(
        port({ 'text/plain': 'x', [WRITE_MARKER_FORMAT]: writeMarkerBlob(TOKEN) }),
      ),
    ).resolves.toBe(TOKEN);
  });

  it('answers null for an ordinary copy without reading the clipboard items', async () => {
    const plain = port({ 'text/plain': new Blob(['hello']) });

    await expect(readWriteMarkerFrom(plain)).resolves.toBeNull();
    expect(plain.read).not.toHaveBeenCalled();
  });

  it.each([
    ['a malformed token', new Blob(['not-a-token'])],
    ['an oversized payload', new Blob(['0'.repeat(10_000)])],
    ['a non-blob value', TOKEN],
  ])('refuses %s', async (_label, value) => {
    await expect(readWriteMarkerFrom(port({ [WRITE_MARKER_FORMAT]: value }))).resolves.toBeNull();
  });

  it('answers null when the clipboard cannot be read', async () => {
    const broken = {
      has: () => Promise.reject(new Error('OpenClipboard failed')),
      read: () => Promise.resolve([]),
    };

    await expect(readWriteMarkerFrom(broken)).resolves.toBeNull();
  });
});

describe('imageFingerprintFrom', () => {
  it('identifies an image by its size and hash', async () => {
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

    await expect(imageFingerprintFrom(port({ 'image/png': png }))).resolves.toMatch(
      /^3:[0-9a-f]{40}$/,
    );
  });

  it('never copies out an image above the encoded-size limit', async () => {
    const huge = new Blob([new Uint8Array(64)], { type: 'image/png' });
    const arrayBuffer = vi.spyOn(huge, 'arrayBuffer');

    await expect(imageFingerprintFrom(port({ 'image/png': huge }), 63)).resolves.toBe(
      'oversize:64',
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('answers null when there is no image', async () => {
    await expect(imageFingerprintFrom(port({ 'text/plain': 'x' }))).resolves.toBeNull();
  });
});
