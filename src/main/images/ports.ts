/**
 * Ports between the screenshot capture logic and Electron / the file system.
 * Production adapters live in `electron-images.ts` and `node-adapters.ts`; tests use fakes.
 */

/** A decoded image (an Electron `NativeImage` in production). */
export interface ImageHandle {
  readonly width: number;
  readonly height: number;
  /** Raw pixels, 4 bytes per pixel (BGRA on every desktop platform Electron supports). */
  bitmap(): Uint8Array;
  png(): Uint8Array;
  /** A resized copy (high-quality resampling). */
  resized(width: number, height: number): ImageHandle;
  /**
   * The encoded bytes this image was decoded from, when the source had them. A PNG is stored as
   * it is, so the full image is never re-encoded on the main process.
   */
  readonly encoded?: Uint8Array;
}

/** Image access to the system clipboard. */
export interface ClipboardImageReader {
  /** Cheap check, done on every clipboard change before anything is decoded. */
  hasImage(): Promise<boolean>;
  /**
   * Decodes the clipboard image, or `null` when there is none (or it cannot be decoded). Rejects
   * with `ImageSkip` when the encoded image is refused before decoding (see `encodedSkipReason`).
   */
  readImage(): Promise<ImageHandle | null>;
}

/**
 * A file from the macOS screenshots folder, already opened (see `openRegularFile`): its bytes come
 * from the very descriptor whose provenance was checked, never from a fresh lookup of the path.
 */
export interface ImageFileSource {
  readonly path: string;
  /** At most `maxBytes + 1` bytes are read; a refusal says why nothing usable was read. */
  readBytes(maxBytes: number): Promise<Uint8Array | 'not-a-regular-file' | 'too-large'>;
}

/** Decodes image files (the macOS screenshots folder); may reject with `ImageSkip` like the clipboard. */
export interface ImageFileReader {
  read(file: ImageFileSource): Promise<ImageHandle | null>;
}

/** The file operations the image store needs. */
export interface ImageFileSystem {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  /** Writes atomically (temp file + rename): a crash never leaves a half-written PNG. */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  remove(path: string): Promise<void>;
  /** File names in a folder; empty when the folder does not exist. */
  list(dir: string): Promise<string[]>;
}
