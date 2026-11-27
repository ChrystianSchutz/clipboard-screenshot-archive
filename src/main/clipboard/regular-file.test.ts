import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRegularFile, readBounded, readRegularFile } from './regular-file';

describe('readRegularFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'regular-file-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a regular file', async () => {
    const path = join(dir, 'shot.png');
    await writeFile(path, new Uint8Array([1, 2, 3]));

    expect(Array.from((await readRegularFile(path, 10)) as Uint8Array)).toEqual([1, 2, 3]);
  });

  it('refuses a file above the limit without reading it', async () => {
    const path = join(dir, 'big.png');
    await writeFile(path, new Uint8Array(11));

    await expect(readRegularFile(path, 10)).resolves.toBe('too-large');
  });

  it('refuses a folder and a missing file', async () => {
    await mkdir(join(dir, 'folder'));

    await expect(readRegularFile(join(dir, 'folder'), 10)).resolves.toBe('not-a-regular-file');
    await expect(readRegularFile(join(dir, 'missing.png'), 10)).resolves.toBe('not-a-regular-file');
  });

  it('never follows a symbolic link, even to a regular file', async (context) => {
    const target = join(dir, 'secret.txt');
    const link = join(dir, 'Screenshot.png');
    await writeFile(target, 'outside the folder');
    try {
      await symlink(target, link, 'file');
    } catch {
      context.skip(); // Windows without the symlink privilege (no developer mode)
    }

    await expect(readRegularFile(link, 1_000)).resolves.toBe('not-a-regular-file');
  });

  it('binds the bytes to the descriptor and notices when the path names another file', async (context) => {
    const path = join(dir, 'Screenshot.png');
    await writeFile(path, new Uint8Array([1, 2, 3]));
    const file = await openRegularFile(path);
    if (file === 'not-a-regular-file') throw new Error('not opened');
    try {
      expect(await file.stillAtPath()).toBe(true);

      const other = join(dir, 'other.png');
      await writeFile(other, new Uint8Array([9, 9, 9, 9]));
      try {
        await rename(other, path);
      } catch {
        context.skip(); // Windows cannot replace a file that is open
      }

      expect(await file.stillAtPath()).toBe(false);
      // The open descriptor still reads the original file, never the replacement.
      expect(Array.from((await file.readBytes(10)) as Uint8Array)).toEqual([1, 2, 3]);
    } finally {
      await file.close();
    }
  });
});

describe('readBounded', () => {
  /** A file that keeps growing while it is read: every read returns as much as asked. */
  const endless = () => {
    let asked = 0;
    return {
      read: (buffer: Uint8Array, offset: number, length: number) => {
        asked += length;
        buffer.fill(7, offset, offset + length);
        return Promise.resolve({ bytesRead: length, buffer });
      },
      get asked() {
        return asked;
      },
    };
  };

  it('never reads more than maxBytes + 1 from a file that grows after its size was checked', async () => {
    const handle = endless();

    await expect(readBounded(handle as never, 4, 100_000)).resolves.toBe('too-large');
    expect(handle.asked).toBe(100_001);
  });

  it('returns exactly the bytes up to end of file', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const handle = {
      read: (buffer: Uint8Array, offset: number, length: number, position: number) => {
        const chunk = data.subarray(position, position + Math.min(length, 2));
        buffer.set(chunk, offset);
        return Promise.resolve({ bytesRead: chunk.length, buffer });
      },
    };

    expect(Array.from((await readBounded(handle as never, 5, 5)) as Uint8Array)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });
});
