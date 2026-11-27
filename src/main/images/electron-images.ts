import { clipboard, ClipboardItem, nativeImage, type NativeImage } from 'electron';
import { WRITE_MARKER_FORMAT, writeMarkerBlob } from '../clipboard/electron-clipboard';
import type { ImageDecoder } from './image-capture';
import { encodedSkipReason, ImageSkip, MAX_ENCODED_BYTES } from './image-policy';
import type { ClipboardImageReader, ImageFileReader, ImageHandle } from './ports';

/** `ImageHandle` over Electron's `NativeImage` (Skia: native decode, resize and PNG encode). */
export function wrapNativeImage(image: NativeImage, encoded?: Uint8Array): ImageHandle | null {
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  return {
    width,
    height,
    ...(encoded ? { encoded } : {}),
    bitmap: () => image.toBitmap(),
    png: () => image.toPNG(),
    resized: (w, h) => {
      const resized = wrapNativeImage(image.resize({ width: w, height: h, quality: 'best' }));
      if (!resized) throw new Error('Image resize failed');
      return resized;
    },
  };
}

const PNG = 'image/png';

/**
 * Decodes encoded image bytes after the checks that need no decoding (byte size, the size a PNG
 * or JPEG header declares), so an oversized image never reaches the native decoder. Decoding itself runs
 * on the main process (Electron has no off-thread image decoder); these limits bound its cost.
 */
export function decodeChecked(bytes: Uint8Array): ImageHandle | null {
  const reason = encodedSkipReason(bytes);
  if (reason) throw new ImageSkip(reason);
  return wrapNativeImage(nativeImage.createFromBuffer(Buffer.from(bytes)), bytes);
}

/**
 * Clipboard images through Electron 45's async, W3C-style clipboard API.
 *
 * Chromium exposes every bitmap format the OS clipboard holds (CF_DIB/CF_DIBV5 from Win+Shift+S,
 * `public.png`/TIFF on macOS) as `image/png`, so one MIME type covers all screenshot tools.
 */
export const electronClipboardImages: ClipboardImageReader = {
  hasImage: () => clipboard.has(PNG),
  readImage: async () => {
    const items = await clipboard.read();
    const item = items.find((candidate) => candidate.types.includes(PNG));
    if (!item) return null;
    const blob = await item.getType(PNG);
    if (!(blob instanceof Blob)) return null;
    // The size is known before the bytes are copied out of the blob.
    if (blob.size > MAX_ENCODED_BYTES) throw new ImageSkip('too-large');
    return decodeChecked(new Uint8Array(await blob.arrayBuffer()));
  },
};

/** Image files are read asynchronously (no blocking disk read on main) and size-checked first. */
export const electronImageFiles: ImageFileReader = {
  read: async (file) => {
    // From the descriptor the import opened (never through a symbolic link, never a fresh lookup):
    // the bytes are those of the file whose provenance was checked.
    const bytes = await file.readBytes(MAX_ENCODED_BYTES);
    if (bytes === 'too-large') throw new ImageSkip('too-large');
    if (bytes === 'not-a-regular-file') return null;
    return decodeChecked(bytes);
  },
};

export const electronImageDecoder: ImageDecoder = {
  decode: (png) => wrapNativeImage(nativeImage.createFromBuffer(Buffer.from(png)), png),
};

/** Puts a PNG on the system clipboard (restoring a screenshot from the history). */
export function electronWriteImage(png: Uint8Array, marker?: string): Promise<void> {
  const image = new Blob([png as Uint8Array<ArrayBuffer>], { type: PNG });
  // With a marker, the image and the app's write marker reach the clipboard in one write.
  return clipboard.write([
    new ClipboardItem(
      marker === undefined
        ? { [PNG]: image }
        : { [PNG]: image, [WRITE_MARKER_FORMAT]: writeMarkerBlob(marker) },
    ),
  ]);
}

/** `ClipboardImageReader` over a source of PNG bytes (the E2E sandbox's in-memory clipboard). */
export function pngClipboardImages(read: () => Promise<Uint8Array | null>): ClipboardImageReader {
  return {
    hasImage: async () => (await read()) !== null,
    readImage: async () => {
      const png = await read();
      return png ? decodeChecked(png) : null;
    },
  };
}
