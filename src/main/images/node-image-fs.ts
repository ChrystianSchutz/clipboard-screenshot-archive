import { randomBytes } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { ImageFileSystem } from './ports';

/** `ImageFileSystem` on node:fs, with atomic writes (write a temp file, then rename over). */
export const nodeImageFileSystem: ImageFileSystem = {
  exists: (path) =>
    access(path).then(
      () => true,
      () => false,
    ),
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  writeFile: async (path, data) => {
    const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temp, data);
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  },
  readFile: (path) => readFile(path),
  remove: (path) => rm(path, { force: true }),
  list: async (dir) => {
    try {
      return await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  },
};
