import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { decodeFakePng, FakeImage, MemoryImageFs } from '../test-support/image-fakes';
import { hashOfFileName, ImageStore, isTempFileName, THUMBNAIL_MAX } from './image-store';
import type { ImageHandle } from './ports';

const DIR = join('data', 'images');
const HASH = '0123456789abcdef'.repeat(4);
const OTHER = 'f'.repeat(64);

/** The 8-byte PNG signature followed by some made-up chunk bytes. */
const REAL_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** A fake image that also carries the encoded bytes it was decoded from. */
class EncodedImage extends FakeImage implements ImageHandle {
  constructor(
    width: number,
    height: number,
    readonly encoded: Uint8Array,
  ) {
    super(width, height);
  }
}

describe('ImageStore', () => {
  let fs: MemoryImageFs;
  let store: ImageStore;

  beforeEach(() => {
    fs = new MemoryImageFs();
    store = new ImageStore(DIR, fs);
  });

  it('writes the thumbnail first and the full PNG last, named after the hash', async () => {
    const stored = await store.save(HASH, new FakeImage(1600, 900, 5));

    expect(fs.dirs.has(DIR)).toBe(true);
    expect(fs.writes).toEqual([join(DIR, `${HASH}.thumb.png`), join(DIR, `${HASH}.png`)]);
    expect(decodeFakePng(fs.files.get(join(DIR, `${HASH}.png`))!)).toBe('png:1600x900:5');
    expect(stored).toEqual({
      hash: HASH,
      width: 1600,
      height: 900,
      byteSize: new FakeImage(1600, 900, 5).png().byteLength,
      created: true,
    });
  });

  it('shrinks the thumbnail to fit the thumbnail box, keeping the aspect ratio', async () => {
    const image = new FakeImage(1600, 900);
    await store.save(HASH, image);

    expect(image.resizes).toEqual([{ width: THUMBNAIL_MAX.width, height: 180 }]);
    expect(decodeFakePng(fs.files.get(join(DIR, `${HASH}.thumb.png`))!)).toBe('png:320x180:1');
  });

  it('uses a small image as its own thumbnail instead of enlarging it', async () => {
    const image = new FakeImage(120, 80);
    await store.save(HASH, image);

    expect(image.resizes).toEqual([]);
    expect(decodeFakePng(fs.files.get(join(DIR, `${HASH}.thumb.png`))!)).toBe('png:120x80:1');
  });

  it('does not write anything when the same image is saved again', async () => {
    await store.save(HASH, new FakeImage(400, 300));
    fs.writes.length = 0;

    const again = await store.save(HASH, new FakeImage(400, 300));

    expect(again).toEqual({ hash: HASH, width: 400, height: 300, byteSize: 0, created: false });
    expect(fs.writes).toEqual([]);
  });

  it('reads the full image by default, or the thumbnail', async () => {
    await store.save(HASH, new FakeImage(1600, 900));

    expect(decodeFakePng(await store.read(HASH))).toBe('png:1600x900:1');
    expect(decodeFakePng(await store.read(HASH, 'full'))).toBe('png:1600x900:1');
    expect(decodeFakePng(await store.read(HASH, 'thumb'))).toBe('png:320x180:1');
  });

  it('removes both files of an image', async () => {
    await store.save(HASH, new FakeImage(400, 300));
    await store.remove(HASH);

    expect(fs.files.size).toBe(0);
    await expect(store.read(HASH)).rejects.toThrow('ENOENT');
  });

  it('refuses ids that are not a sha256 digest, so no path can escape the folder', async () => {
    expect(() => store.pathOf('../../etc/passwd', 'full')).toThrow('Invalid image id');
    expect(() => store.pathOf(HASH.toUpperCase(), 'thumb')).toThrow('Invalid image id');
    await expect(store.save('../../etc/passwd', new FakeImage(400, 300))).rejects.toThrow(
      'Invalid image id',
    );
    expect(() => store.read('../../etc/passwd')).toThrow('Invalid image id');
    await expect(store.remove('../../etc/passwd')).rejects.toThrow('Invalid image id');
    expect(fs.writes).toEqual([]);
  });

  describe('full PNG source', () => {
    it('stores the encoded bytes unchanged when they are a real PNG', async () => {
      const stored = await store.save(HASH, new EncodedImage(1600, 900, REAL_PNG));

      expect(fs.files.get(join(DIR, `${HASH}.png`))).toBe(REAL_PNG);
      expect(stored.byteSize).toBe(REAL_PNG.byteLength);
      // The thumbnail is still made from the decoded image.
      expect(decodeFakePng(fs.files.get(join(DIR, `${HASH}.thumb.png`))!)).toBe('png:320x180:1');
    });

    it('re-encodes the image when the encoded bytes are not a PNG', async () => {
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]);
      const stored = await store.save(HASH, new EncodedImage(400, 300, jpeg));

      const full = fs.files.get(join(DIR, `${HASH}.png`))!;
      expect(decodeFakePng(full)).toBe('png:400x300:1');
      expect(stored.byteSize).toBe(full.byteLength);
    });

    it('re-encodes the image when the encoded bytes are empty', async () => {
      await store.save(HASH, new EncodedImage(400, 300, new Uint8Array()));

      expect(decodeFakePng(fs.files.get(join(DIR, `${HASH}.png`))!)).toBe('png:400x300:1');
    });
  });

  describe('files', () => {
    it('groups full images, thumbnails and temp files by hash and ignores other names', async () => {
      const put = (name: string): Promise<void> =>
        fs.writeFile(join(DIR, name), new Uint8Array([1]));
      await put(`${HASH}.png`);
      await put(`${HASH}.thumb.png`);
      await put(`${HASH}.png.0a1b2c.tmp`);
      await put(`${HASH}.thumb.png.ff.tmp`);
      await put(`${OTHER}.thumb.png`);
      await put('notes.txt');
      await put(`${HASH}.jpg`);
      await put(`${HASH}.png.tmp`);
      await put(`${HASH.toUpperCase()}.png`);
      await put(`x${HASH}.png`);
      await fs.writeFile(join('elsewhere', `${'e'.repeat(64)}.png`), new Uint8Array([1]));

      const files = await store.files();

      expect([...files.keys()].sort()).toEqual([HASH, OTHER].sort());
      expect(files.get(HASH)?.sort()).toEqual(
        [
          `${HASH}.png`,
          `${HASH}.thumb.png`,
          `${HASH}.png.0a1b2c.tmp`,
          `${HASH}.thumb.png.ff.tmp`,
        ].sort(),
      );
      expect(files.get(OTHER)).toEqual([`${OTHER}.thumb.png`]);
    });

    it('returns an empty map for an empty folder', async () => {
      expect(await store.files()).toEqual(new Map());
    });
  });

  describe('remove with leftovers', () => {
    it('deletes the full image, the thumbnail and the named leftovers, nothing else', async () => {
      await store.save(HASH, new FakeImage(400, 300));
      const temp = `${HASH}.png.abc123.tmp`;
      const thumbTemp = `${HASH}.thumb.png.9.tmp`;
      await fs.writeFile(join(DIR, temp), new Uint8Array([1]));
      await fs.writeFile(join(DIR, thumbTemp), new Uint8Array([1]));
      await fs.writeFile(join(DIR, `${OTHER}.png`), new Uint8Array([1]));

      await store.remove(HASH, [temp, thumbTemp]);

      expect([...fs.files.keys()]).toEqual([join(DIR, `${OTHER}.png`)]);
    });

    it('removes leftovers of an image whose full PNG was never written', async () => {
      const thumb = `${HASH}.thumb.png`;
      await fs.writeFile(join(DIR, thumb), new Uint8Array([1]));

      await store.removeLeftovers(HASH, [thumb]);

      expect(fs.files.size).toBe(0);
    });

    it('refuses a name of another hash and deletes nothing for it', async () => {
      const foreign = `${OTHER}.png`;
      await fs.writeFile(join(DIR, foreign), new Uint8Array([1]));

      await expect(store.removeLeftovers(HASH, [foreign])).rejects.toThrow(
        'Invalid image file name',
      );
      expect(fs.files.has(join(DIR, foreign))).toBe(true);
    });

    it('refuses path-like names, so nothing outside the folder can be deleted', async () => {
      const outside = join('data', `${HASH}.png`);
      await fs.writeFile(outside, new Uint8Array([1]));
      await fs.writeFile(join(DIR, `${HASH}.png`), new Uint8Array([1]));

      for (const name of [
        `../${HASH}.png`,
        `..\\${HASH}.png`,
        `sub/${HASH}.png`,
        join('..', `${HASH}.png`),
        '',
      ]) {
        await expect(store.removeLeftovers(HASH, [name]), name).rejects.toThrow(
          'Invalid image file name',
        );
      }
      expect(fs.files.has(outside)).toBe(true);
      expect(fs.files.has(join(DIR, `${HASH}.png`))).toBe(true);
    });

    it('stops at the first invalid name; valid names before it are already deleted', async () => {
      const before = `${HASH}.png.1.tmp`;
      const after = `${HASH}.png.2.tmp`;
      await fs.writeFile(join(DIR, before), new Uint8Array([1]));
      await fs.writeFile(join(DIR, after), new Uint8Array([1]));

      await expect(store.removeLeftovers(HASH, [before, `${OTHER}.png`, after])).rejects.toThrow(
        'Invalid image file name',
      );
      expect(fs.files.has(join(DIR, before))).toBe(false);
      expect(fs.files.has(join(DIR, after))).toBe(true);
    });

    it('refuses an invalid hash in remove before deleting anything', async () => {
      const temp = `${HASH}.png.1.tmp`;
      await fs.writeFile(join(DIR, temp), new Uint8Array([1]));

      await expect(store.remove('../x', [temp])).rejects.toThrow('Invalid image id');
      expect(fs.files.has(join(DIR, temp))).toBe(true);
    });
  });
});

describe('hashOfFileName', () => {
  it('returns the hash of a full image, a thumbnail and their temp files', () => {
    expect(hashOfFileName(`${HASH}.png`)).toBe(HASH);
    expect(hashOfFileName(`${HASH}.thumb.png`)).toBe(HASH);
    expect(hashOfFileName(`${HASH}.png.0.tmp`)).toBe(HASH);
    expect(hashOfFileName(`${HASH}.thumb.png.${'f'.repeat(32)}.tmp`)).toBe(HASH);
  });

  it('returns null for every other name', () => {
    for (const name of [
      '',
      'notes.txt',
      HASH,
      `${HASH}.jpg`,
      `${HASH}.thumb`,
      `${HASH}.png.tmp`,
      `${HASH}.png.${'f'.repeat(33)}.tmp`,
      `${HASH}.png.xyz.tmp`,
      `${HASH}.png.AB.tmp`,
      `${HASH}.png.ab.tmp.bak`,
      `${HASH}.thumb.thumb.png`,
      `${HASH.slice(1)}.png`,
      `${HASH}0.png`,
      `${HASH.toUpperCase()}.png`,
      `../${HASH}.png`,
      `${HASH}.png\n`,
    ]) {
      expect(hashOfFileName(name), JSON.stringify(name)).toBeNull();
    }
  });
});

describe('isTempFileName', () => {
  it('is true only for temp files of an image', () => {
    expect(isTempFileName(`${HASH}.png.0a.tmp`)).toBe(true);
    expect(isTempFileName(`${HASH}.thumb.png.0a.tmp`)).toBe(true);
    expect(isTempFileName(`${HASH}.png`)).toBe(false);
    expect(isTempFileName(`${HASH}.thumb.png`)).toBe(false);
    expect(isTempFileName('random.tmp')).toBe(false);
    expect(isTempFileName(`${HASH}.png.tmp`)).toBe(false);
  });
});
