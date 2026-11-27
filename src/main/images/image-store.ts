import { join } from 'node:path';
import { fitWithin, isImageHash, isPng } from './image-policy';
import type { ImageFileSystem, ImageHandle } from './ports';

/** Thumbnails fit this box: sharp in a history row and a hover card on a 2× display. */
export const THUMBNAIL_MAX = { width: 320, height: 200 } as const;

export interface StoredImage {
  readonly hash: string;
  readonly width: number;
  readonly height: number;
  /** Size of the full PNG on disk. */
  readonly byteSize: number;
  /** False when the same image was already stored (nothing was written). */
  readonly created: boolean;
}

/**
 * Content-addressed PNG store: `<dir>/<sha256>.png` plus `<dir>/<sha256>.thumb.png`.
 *
 * - Content addressing makes saving idempotent and dedupes for free.
 * - Every public method takes the hash, never a path, and refuses anything that is not 64 hex
 *   characters, so a value coming back from the renderer can never point outside `dir`.
 * - The thumbnail is written first and the full image last: the full PNG existing is the commit
 *   marker, so an interrupted save is simply redone next time. What an interrupted save leaves
 *   behind (a thumbnail without its full PNG, a `*.tmp` from an atomic write) is listed by `files`
 *   and removed by the orphan sweep.
 * - Callers serialise `save` and `remove` of one hash with `HashLocks`; the store itself does not.
 */
export class ImageStore {
  constructor(
    private readonly dir: string,
    private readonly fs: ImageFileSystem,
  ) {}

  async save(hash: string, image: ImageHandle): Promise<StoredImage> {
    const full = this.pathOf(hash, 'full');
    const size = { width: image.width, height: image.height };
    if (await this.fs.exists(full)) return { hash, ...size, byteSize: 0, created: false };

    await this.fs.mkdir(this.dir);
    const thumb = fitWithin(image.width, image.height, THUMBNAIL_MAX.width, THUMBNAIL_MAX.height);
    const thumbnail =
      thumb.width === image.width && thumb.height === image.height
        ? image
        : image.resized(thumb.width, thumb.height);
    await this.fs.writeFile(this.pathOf(hash, 'thumb'), thumbnail.png());
    // A PNG from the clipboard or a file is kept as it is: no second encode of a large image.
    const png = image.encoded && isPng(image.encoded) ? image.encoded : image.png();
    await this.fs.writeFile(full, png);
    return { hash, ...size, byteSize: png.byteLength, created: true };
  }

  read(hash: string, variant: 'full' | 'thumb' = 'full'): Promise<Uint8Array> {
    return this.fs.readFile(this.pathOf(hash, variant));
  }

  /** Removes an image: its full PNG, its thumbnail and the `leftovers` named (see `removeLeftovers`). */
  async remove(hash: string, leftovers: readonly string[] = []): Promise<void> {
    await this.fs.remove(this.pathOf(hash, 'full'));
    await this.fs.remove(this.pathOf(hash, 'thumb'));
    await this.removeLeftovers(hash, leftovers);
  }

  /**
   * Removes files of `hash` by name (names from `files`, e.g. temp files of an interrupted write).
   * A name that does not belong to `hash` is refused, so nothing outside the image can be deleted.
   */
  async removeLeftovers(hash: string, names: readonly string[]): Promise<void> {
    for (const name of names) {
      if (hashOfFileName(name) !== hash) throw new Error('Invalid image file name');
      await this.fs.remove(join(this.dir, name));
    }
  }

  /**
   * Every file in the folder that belongs to an image, grouped by hash: complete images, lone
   * thumbnails and temp files of interrupted writes alike. Unrelated names are ignored.
   */
  async files(): Promise<Map<string, string[]>> {
    const byHash = new Map<string, string[]>();
    for (const name of await this.fs.list(this.dir)) {
      const hash = hashOfFileName(name);
      if (hash === null) continue;
      const names = byHash.get(hash);
      if (names) names.push(name);
      else byHash.set(hash, [name]);
    }
    return byHash;
  }

  /** Hashes of every complete image on disk (the full PNG is the commit marker, see `save`). */
  async hashes(): Promise<string[]> {
    const names = await this.fs.list(this.dir);
    return names.flatMap((name) => {
      const match = /^([0-9a-f]{64})\.png$/.exec(name);
      return match?.[1] ? [match[1]] : [];
    });
  }

  /** Absolute path of an image file. Throws for anything that is not a sha256 hex digest. */
  pathOf(hash: string, variant: 'full' | 'thumb'): string {
    if (!isImageHash(hash)) throw new Error('Invalid image id');
    return join(this.dir, variant === 'full' ? `${hash}.png` : `${hash}.thumb.png`);
  }
}

/**
 * The image a file name belongs to: `<hash>.png`, `<hash>.thumb.png`, or a temp file of an atomic
 * write of either (`<hash>.png.<hex>.tmp`, see `nodeImageFileSystem.writeFile`); `null` otherwise.
 */
export function hashOfFileName(name: string): string | null {
  const match = /^([0-9a-f]{64})(?:\.thumb)?\.png(?:\.[0-9a-f]{1,32}\.tmp)?$/.exec(name);
  return match?.[1] ?? null;
}

/** A temp file of an interrupted atomic write (never a complete image or thumbnail). */
export function isTempFileName(name: string): boolean {
  return hashOfFileName(name) !== null && name.endsWith('.tmp');
}
