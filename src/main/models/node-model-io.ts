import { createHash, randomBytes } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import {
  isHttps,
  type DownloadResponse,
  type FileStamp,
  type ModelDownloadPorts,
  type ModelFileSystem,
} from './model-downloader';

const EMPTY: AsyncIterable<Uint8Array> = {
  [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
};

/** Hugging Face answers with one redirect to its CDN; a handful leaves room for a mirror. */
export const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * HTTP for model downloads, HTTPS only. Redirects are followed by hand (`redirect: 'manual'`), so
 * every hop's destination is checked before it is requested: a redirect to `http:` (or any other
 * scheme) fails the download instead of silently downgrading it.
 */
export function createModelFetch(fetchImpl: typeof fetch = fetch): ModelDownloadPorts['fetch'] {
  return async (url, signal): Promise<DownloadResponse> => {
    let target = url;
    for (let hop = 0; ; hop++) {
      if (!isHttps(target)) throw new Error(`refusing a non-HTTPS address (${schemeOf(target)})`);
      const response = await fetchImpl(target, { signal, redirect: 'manual' });
      if (!REDIRECT_STATUSES.has(response.status)) {
        return { ok: response.ok, status: response.status, body: response.body ?? EMPTY };
      }
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      if (!location) throw new Error(`HTTP ${response.status} without a Location header`);
      if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
      target = new URL(location, target).href;
    }
  };
}

export const nodeModelFetch: ModelDownloadPorts['fetch'] = createModelFetch();

function schemeOf(url: string): string {
  return URL.canParse(url) ? new URL(url).protocol : 'invalid URL';
}

/**
 * The stamp of a file from `stat` or `fstat` (BigInt, so the inode survives exactly). Inode and
 * device are left out where the file system reports none (0).
 */
export function fileStamp(stats: BigIntStats): FileStamp {
  return {
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeNs) / 1e6,
    ctimeMs: Number(stats.ctimeNs) / 1e6,
    ...(stats.ino !== 0n ? { ino: stats.ino.toString() } : {}),
    ...(stats.dev !== 0n ? { dev: stats.dev.toString() } : {}),
  };
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return (
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.ino === b.ino &&
    a.dev === b.dev
  );
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

const HASH_CHUNK_BYTES = 1024 * 1024;

/** `ModelFileSystem` on node:fs, with atomic writes (write a temp file, then rename over). */
export const nodeModelFileSystem: ModelFileSystem = {
  stat: async (path) => {
    try {
      return fileStamp(await stat(path, { bigint: true }));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  },
  hashFile: async (path) => {
    let handle;
    try {
      handle = await open(path, 'r');
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    try {
      const before = fileStamp(await handle.stat({ bigint: true }));
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
      for (let position = 0; ;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      // Stamped from the same descriptor: these are the bytes that were hashed.
      const stamp = fileStamp(await handle.stat({ bigint: true }));
      if (!sameStamp(before, stamp)) throw new Error(`${path} changed while it was being hashed`);
      return { sha256: hash.digest('hex'), stamp };
    } finally {
      await handle.close();
    }
  },
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  readFile: (path) => readFile(path),
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
  rename: (from, to) => rename(from, to),
  remove: (path) => rm(path, { force: true }),
};
