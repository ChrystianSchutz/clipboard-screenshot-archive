import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { deferred } from '../test-support/fakes';
import { MemoryImageFs } from '../test-support/image-fakes';
import {
  ModelDownloader,
  sha256Hex,
  type DownloadProgress,
  type DownloadResponse,
  type FileStamp,
  type HashedFile,
  type ModelDownloaderOptions,
  type ModelDownloadPorts,
  type ModelFileSystem,
  type ModelFile,
} from './model-downloader';

const DIR = join('userData', 'models');
const BYTES = new TextEncoder().encode('tiny model weights'); // 18 bytes
const FILE: ModelFile = {
  name: 'tiny.onnx',
  url: 'https://models.example/tiny.onnx@rev1',
  sha256: sha256Hex(BYTES),
  size: BYTES.length,
};
const MODEL_PATH = join(DIR, 'tiny.onnx');
/** The first attempt's temp file (each attempt writes its own `<name>.download-<n>`). */
const TEMP_PATH = `${MODEL_PATH}.download-1`;
const isTempPath = (path: string): boolean => path.startsWith(`${MODEL_PATH}.download-`);
const hasTempFile = (files: Map<string, unknown>): boolean => [...files.keys()].some(isTempPath);
const MARKER_PATH = `${MODEL_PATH}.verified`;

/**
 * In-memory model folder: a file's mtime is a counter bumped on every write or rename, and every
 * newly created file gets a new inode (a rename keeps the inode, like a real file system).
 */
class MemoryModelFs extends MemoryImageFs implements ModelFileSystem {
  readonly mtimes = new Map<string, number>();
  readonly inodes = new Map<string, number>();
  readonly reads: string[] = [];
  /** Paths hashed through `hashFile`. */
  readonly hashed: string[] = [];
  private clock = 0;
  private nextInode = 1;

  stat(path: string): Promise<FileStamp | null> {
    return Promise.resolve(this.stampOf(path));
  }

  hashFile(path: string): Promise<HashedFile | null> {
    this.hashed.push(path);
    const data = this.files.get(path);
    const stamp = this.stampOf(path);
    return Promise.resolve(data && stamp ? { sha256: sha256Hex(data), stamp } : null);
  }

  override readFile(path: string): Promise<Uint8Array> {
    this.reads.push(path);
    return super.readFile(path);
  }

  override async writeFile(path: string, data: Uint8Array): Promise<void> {
    await super.writeFile(path, data);
    this.mtimes.set(path, ++this.clock);
    this.inodes.set(path, this.nextInode++);
  }

  rename(from: string, to: string): Promise<void> {
    const data = this.files.get(from);
    if (!data) return Promise.reject(new Error(`ENOENT: ${from}`));
    this.files.delete(from);
    this.files.set(to, data);
    this.mtimes.set(to, this.mtimes.get(from) ?? ++this.clock);
    this.inodes.set(to, this.inodes.get(from) ?? this.nextInode++);
    return Promise.resolve();
  }

  /** Puts a file in place as if an earlier run (or something else) had left it there. */
  plant(path: string, data: Uint8Array, mtimeMs = ++this.clock): void {
    this.files.set(path, data);
    this.mtimes.set(path, mtimeMs);
    this.inodes.set(path, this.nextInode++);
  }

  private stampOf(path: string): FileStamp | null {
    const data = this.files.get(path);
    if (!data) return null;
    return {
      size: data.byteLength,
      mtimeMs: this.mtimes.get(path) ?? 0,
      ino: String(this.inodes.get(path) ?? 0),
    };
  }
}

/**
 * A response body that hands out `chunks` one by one and counts how many were taken, so a test
 * can tell whether the downloader stopped reading early. A chunk may be a promise, to hold it back.
 */
function streamOf(chunks: readonly (Uint8Array | Promise<Uint8Array>)[]) {
  const stream = {
    pulled: 0,
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          stream.pulled++;
          yield await chunk;
        }
      },
    },
  };
  return stream;
}

const ok = (body: AsyncIterable<Uint8Array>): DownloadResponse => ({ ok: true, status: 200, body });

function setup(
  respond: ModelDownloadPorts['fetch'] = () => Promise.resolve(ok(streamOf([BYTES]).body)),
  options: ModelDownloaderOptions = {},
) {
  const fs = new MemoryModelFs();
  const fetch = vi.fn<ModelDownloadPorts['fetch']>(respond);
  const downloader = new ModelDownloader(DIR, FILE, { fetch, fs }, options);
  return { downloader, fetch, fs };
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`Rejected with a non-Error: ${String(error)}`, { cause: error });
  }
  throw new Error('Expected the promise to reject');
}

describe('sha256Hex', () => {
  it('matches the FIPS 180-2 test vector for "abc"', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('ModelDownloader', () => {
  it('downloads nothing until asked', async () => {
    const { downloader, fetch } = setup();
    expect(downloader.path).toBe(MODEL_PATH);
    expect(await downloader.status()).toBe('missing');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches the pinned URL and stores the verified file in the models folder', async () => {
    const { downloader, fetch, fs } = setup();

    await expect(downloader.download()).resolves.toBe(MODEL_PATH);
    await downloader.settled(); // the marker is written in the background

    expect(fetch).toHaveBeenCalledWith(FILE.url, expect.any(AbortSignal));
    expect(fs.dirs.has(DIR)).toBe(true);
    // Written next to the model, renamed into place, then recorded as verified.
    expect(fs.writes).toEqual([TEMP_PATH, MARKER_PATH]);
    expect(fs.files.get(MODEL_PATH)).toEqual(BYTES);
    expect(fs.files.has(TEMP_PATH)).toBe(false);
    // Hashed once after the rename (to stamp exactly those bytes), then the marker spares a hash.
    expect(fs.hashed).toEqual([MODEL_PATH]);
    expect(await downloader.status()).toBe('ready');
    expect(fs.hashed).toEqual([MODEL_PATH]);
    expect(fs.reads).not.toContain(MODEL_PATH);
  });

  it('reassembles a body that arrives in several chunks and reports progress for each', async () => {
    const { downloader, fs } = setup(() =>
      Promise.resolve(ok(streamOf([BYTES.slice(0, 6), BYTES.slice(6, 12), BYTES.slice(12)]).body)),
    );
    const progress: DownloadProgress[] = [];

    await downloader.download((step) => progress.push(step));

    expect(progress).toEqual([
      { received: 6, total: 18 },
      { received: 12, total: 18 },
      { received: 18, total: 18 },
    ]);
    expect(fs.files.get(MODEL_PATH)).toEqual(BYTES);
  });

  it('rejects an HTTP error', async () => {
    const { downloader, fs } = setup(() =>
      Promise.resolve({ ok: false, status: 404, body: streamOf([]).body }),
    );

    expect((await rejectionOf(downloader.download())).message).toBe(
      'Could not download tiny.onnx: HTTP 404',
    );
    expect(fs.writes).toEqual([]);
  });

  it('explains a network error', async () => {
    const { downloader } = setup(() =>
      Promise.reject(new Error('getaddrinfo ENOTFOUND models.example')),
    );

    expect((await rejectionOf(downloader.download())).message).toBe(
      'Could not download tiny.onnx: getaddrinfo ENOTFOUND models.example',
    );
  });

  it('explains a network failure that is not an Error', async () => {
    const failure = deferred<DownloadResponse>();
    failure.reject('socket hang up');
    const { downloader } = setup(() => failure.promise);

    expect((await rejectionOf(downloader.download())).message).toBe(
      'Could not download tiny.onnx: socket hang up',
    );
  });

  it('stops reading as soon as the body grows past the pinned size', async () => {
    const chunk = new Uint8Array(10);
    const stream = streamOf([chunk, chunk, chunk, chunk, chunk]);
    const { downloader, fs } = setup(() => Promise.resolve(ok(stream.body)));

    expect((await rejectionOf(downloader.download())).message).toBe(
      'tiny.onnx is larger than expected',
    );
    expect(stream.pulled).toBe(2);
    expect(fs.writes).toEqual([]);
  });

  it('rejects an incomplete download', async () => {
    const { downloader, fs } = setup(() => Promise.resolve(ok(streamOf([BYTES.slice(0, 5)]).body)));

    expect((await rejectionOf(downloader.download())).message).toBe(
      'tiny.onnx download was incomplete (5 of 18 bytes)',
    );
    expect(fs.writes).toEqual([]);
  });

  it('stores nothing when the checksum does not match', async () => {
    const tampered = new TextEncoder().encode('evil model weights'); // same length, other bytes
    const { downloader, fs } = setup(() => Promise.resolve(ok(streamOf([tampered]).body)));

    expect((await rejectionOf(downloader.download())).message).toBe(
      'tiny.onnx failed its checksum; nothing was saved',
    );
    expect(fs.writes).toEqual([]);
    expect(fs.dirs.size).toBe(0);
    expect(await downloader.status()).toBe('missing');
  });

  it('lets a second download() join the one already running', async () => {
    const response = deferred<DownloadResponse>();
    const { downloader, fetch } = setup(() => response.promise);

    const first = downloader.download();
    const second = downloader.download();
    response.resolve(ok(streamOf([BYTES]).body));

    expect(second).toBe(first);
    await expect(second).resolves.toBe(MODEL_PATH);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('starts a new download after a failed one', async () => {
    const { downloader, fetch } = setup();
    fetch.mockRejectedValueOnce(new Error('timeout'));

    await rejectionOf(downloader.download());
    await expect(downloader.download()).resolves.toBe(MODEL_PATH);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reports "downloading" while a download runs', async () => {
    const response = deferred<DownloadResponse>();
    const { downloader } = setup(() => response.promise);

    const download = downloader.download();
    expect(await downloader.status()).toBe('downloading');

    response.resolve(ok(streamOf([BYTES]).body));
    await download;
    expect(await downloader.status()).toBe('ready');
  });

  describe('cancel', () => {
    it('stops a download in the middle of the body and stores nothing', async () => {
      const rest = deferred<Uint8Array>();
      const { downloader, fs } = setup(() =>
        Promise.resolve(ok(streamOf([BYTES.slice(0, 6), rest.promise]).body)),
      );
      const firstChunk = deferred<undefined>();

      const download = rejectionOf(downloader.download(() => firstChunk.resolve(undefined)));
      await firstChunk.promise;
      downloader.cancel();
      rest.resolve(BYTES.slice(6));

      expect((await download).message).toBe('Download cancelled');
      expect(fs.writes).toEqual([]);
      expect(await downloader.status()).toBe('missing');
    });

    it('stops a download that is still waiting for the server', async () => {
      const { downloader, fs } = setup(
        (_url, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('This operation was aborted')));
          }),
      );

      const download = rejectionOf(downloader.download());
      downloader.cancel();

      expect((await download).message).toBe('Download cancelled');
      expect(fs.writes).toEqual([]);
    });

    it('does nothing when no download runs', async () => {
      const { downloader } = setup();
      downloader.cancel();
      await expect(downloader.download()).resolves.toBe(MODEL_PATH);
    });
  });

  describe('remove', () => {
    it('deletes a downloaded model', async () => {
      const { downloader, fs } = setup();
      await downloader.download();

      await downloader.remove();

      expect(fs.files.has(MODEL_PATH)).toBe(false);
      expect(await downloader.status()).toBe('missing');
    });

    it('cancels a running download', async () => {
      const response = deferred<DownloadResponse>();
      const { downloader, fs } = setup(() => response.promise);
      const download = rejectionOf(downloader.download());

      await downloader.remove();
      response.resolve(ok(streamOf([BYTES]).body));

      expect((await download).message).toBe('Download cancelled');
      expect(fs.writes).toEqual([]);
    });
  });
});

describe('ModelDownloader removal during a save', () => {
  it('leaves no file when the model is removed while the download is being saved', async () => {
    const memory = new MemoryModelFs();
    const gate = deferred<undefined>();
    let mkdirStarted = false;
    const fs: ModelFileSystem = {
      stat: (path) => memory.stat(path),
      hashFile: (path) => memory.hashFile(path),
      mkdir: async (path) => {
        mkdirStarted = true;
        await gate.promise;
        await memory.mkdir(path);
      },
      readFile: (path) => memory.readFile(path),
      writeFile: (path, data) => memory.writeFile(path, data),
      rename: (from, to) => memory.rename(from, to),
      remove: (path) => memory.remove(path),
    };
    const downloader = new ModelDownloader(DIR, FILE, {
      fetch: () => Promise.resolve(ok(streamOf([BYTES]).body)),
      fs,
    });

    const download = rejectionOf(downloader.download());
    await vi.waitFor(() => expect(mkdirStarted).toBe(true));
    const removal = downloader.remove();
    gate.resolve(undefined);
    await removal;

    expect((await download).message).toBe('Download cancelled');
    expect(await memory.exists(downloader.path)).toBe(false);
    expect(memory.files.size).toBe(0);
    expect(await downloader.status()).toBe('missing');
  });
});

describe('ModelDownloader integrity (status)', () => {
  const evil = new TextEncoder().encode('evil model weight!'); // same 18 bytes, other content

  it('reports a truncated cache file as corrupt, and a new download replaces it', async () => {
    const { downloader, fs } = setup();
    fs.plant(MODEL_PATH, BYTES.slice(0, 10));

    expect(await downloader.status()).toBe('corrupt');

    await expect(downloader.download()).resolves.toBe(MODEL_PATH);
    expect(fs.files.get(MODEL_PATH)).toEqual(BYTES);
    expect(await downloader.status()).toBe('ready');
  });

  it('reports a file of the right size but the wrong bytes as corrupt', async () => {
    const { downloader, fs } = setup();
    expect(evil.length).toBe(BYTES.length);
    fs.plant(MODEL_PATH, evil);

    expect(await downloader.status()).toBe('corrupt');
    expect(fs.files.has(MARKER_PATH)).toBe(false);
  });

  it('hashes a correct file without a marker once, then trusts the marker it wrote', async () => {
    const { downloader, fs } = setup();
    fs.plant(MODEL_PATH, BYTES); // e.g. downloaded by a version without markers
    const modelReads = () => fs.hashed.filter((path) => path === MODEL_PATH).length;

    expect(await downloader.status()).toBe('ready');
    expect(modelReads()).toBe(1);
    expect(fs.files.has(MARKER_PATH)).toBe(true);

    expect(await downloader.status()).toBe('ready');
    expect(modelReads()).toBe(1);
  });

  it('hashes again when the file changed after it was verified', async () => {
    const { downloader, fs } = setup();
    await downloader.download();
    expect(await downloader.status()).toBe('ready');

    // Same size, other bytes, new mtime: the marker no longer describes this file.
    fs.plant(MODEL_PATH, evil);

    expect(await downloader.status()).toBe('corrupt');
    expect(fs.hashed).toContain(MODEL_PATH);
  });

  it('hashes again after a same-size replacement that keeps the modification time', async () => {
    const { downloader, fs } = setup();
    await downloader.download();
    const before = await fs.stat(MODEL_PATH);
    expect(await downloader.status()).toBe('ready');

    // Another file renamed over the model, its mtime set back: only the inode tells them apart.
    fs.plant(MODEL_PATH, evil, before?.mtimeMs);
    expect((await fs.stat(MODEL_PATH))?.mtimeMs).toBe(before?.mtimeMs);

    expect(await downloader.status()).toBe('corrupt');
  });

  it('stamps the marker from the file that was hashed, not from a later look at the path', async () => {
    const memory = new MemoryModelFs();
    memory.plant(MODEL_PATH, BYTES);
    // The path is replaced right after it was hashed: the marker must describe the hashed file.
    const fs: ModelFileSystem = {
      stat: (path) => memory.stat(path),
      hashFile: async (path) => {
        const hashed = await memory.hashFile(path);
        memory.plant(MODEL_PATH, evil, hashed?.stamp.mtimeMs);
        return hashed;
      },
      mkdir: (path) => memory.mkdir(path),
      readFile: (path) => memory.readFile(path),
      writeFile: (path, data) => memory.writeFile(path, data),
      rename: (from, to) => memory.rename(from, to),
      remove: (path) => memory.remove(path),
    };
    const downloader = new ModelDownloader(DIR, FILE, { fetch: vi.fn(), fs });

    // The bytes it hashed were good, but the path no longer names that file: no `ready` for this
    // call (it hashes again and finds the replacement), and no marker for the hashed bytes.
    expect(await downloader.status()).toBe('corrupt');
    expect(memory.files.has(MARKER_PATH)).toBe(false);
    // The replacement does not inherit any verdict later either.
    fs.hashFile = (path) => memory.hashFile(path);
    expect(await downloader.status()).toBe('corrupt');
  });

  /** A file system over `memory` whose methods a test can override one by one. */
  const wrapped = (memory: MemoryModelFs): ModelFileSystem => ({
    stat: (path) => memory.stat(path),
    hashFile: (path) => memory.hashFile(path),
    mkdir: (path) => memory.mkdir(path),
    readFile: (path) => memory.readFile(path),
    writeFile: (path, data) => memory.writeFile(path, data),
    rename: (from, to) => memory.rename(from, to),
    remove: (path) => memory.remove(path),
  });

  it('gives no Ready from a marker hit when the weights are replaced while the marker is read', async () => {
    const memory = new MemoryModelFs();
    memory.plant(MODEL_PATH, BYTES);
    const fs = wrapped(memory);
    const downloader = new ModelDownloader(DIR, FILE, { fetch: vi.fn(), fs });
    expect(await downloader.status()).toBe('ready'); // hashed; the marker follows in the background
    await downloader.settled();
    expect(memory.files.has(MARKER_PATH)).toBe(true);

    // The marker read is pending while another file of the same size is renamed over the weights.
    fs.readFile = async (path) => {
      const data = await memory.readFile(path);
      if (path === MARKER_PATH) memory.plant(MODEL_PATH, evil);
      return data;
    };

    expect(await downloader.status()).toBe('corrupt');
  });

  it('returns the verdict without waiting for the marker write after the final check', async () => {
    const memory = new MemoryModelFs();
    memory.plant(MODEL_PATH, BYTES);
    const fs = wrapped(memory);
    const markerWrite = deferred<undefined>();
    fs.writeFile = async (path, data) => {
      if (path === MARKER_PATH) await markerWrite.promise;
      await memory.writeFile(path, data);
    };
    const downloader = new ModelDownloader(DIR, FILE, { fetch: vi.fn(), fs });

    let verdict: string | null = null;
    void downloader.status().then((value) => {
      verdict = value;
    });

    // Ready while the marker write is still held: nothing sits between the last stat and the verdict.
    await vi.waitFor(() => expect(verdict).toBe('ready'));
    expect(memory.files.has(MARKER_PATH)).toBe(false);
    markerWrite.resolve(undefined);
    await downloader.settled();
    expect(memory.files.has(MARKER_PATH)).toBe(true);
  });

  it('forgets the marker when the weights are reported damaged, so the file is hashed again', async () => {
    const { downloader, fs } = setup();
    await downloader.download();
    await downloader.settled();
    expect(await downloader.status()).toBe('ready');
    const hashes = fs.hashed.length;

    await downloader.invalidate();

    expect(fs.files.has(MARKER_PATH)).toBe(false);
    expect(await downloader.status()).toBe('ready');
    expect(fs.hashed.length).toBe(hashes + 1);
  });

  it('does not trust a marker written for other weights', async () => {
    const { downloader, fs } = setup();
    fs.plant(MODEL_PATH, evil);
    const stamp = await fs.stat(MODEL_PATH);
    fs.plant(
      MARKER_PATH,
      new TextEncoder().encode(JSON.stringify({ ...stamp, sha256: 'f'.repeat(64) })),
    );

    expect(await downloader.status()).toBe('corrupt');
  });

  it('removes the marker together with the model', async () => {
    const { downloader, fs } = setup();
    await downloader.download();

    await downloader.remove();

    expect(fs.files.size).toBe(0);
  });
});

describe('ModelDownloader transport limits', () => {
  it('refuses a model URL that is not HTTPS without fetching anything', async () => {
    const fs = new MemoryModelFs();
    const fetch = vi.fn<ModelDownloadPorts['fetch']>();
    const file = { ...FILE, url: 'http://models.example/tiny.onnx' };
    const downloader = new ModelDownloader(DIR, file, { fetch, fs });

    expect((await rejectionOf(downloader.download())).message).toBe(
      'Could not download tiny.onnx: only HTTPS is allowed',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ends a transfer that stalls in the body at the overall deadline', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<Uint8Array>(() => undefined);
      const { downloader, fs } = setup(
        () => Promise.resolve(ok(streamOf([BYTES.slice(0, 6), never]).body)),
        { deadlineMs: 5_000 },
      );

      const download = rejectionOf(downloader.download());
      await vi.advanceTimersByTimeAsync(5_000);

      expect((await download).message).toBe('tiny.onnx download timed out after 5 s');
      expect(fs.writes).toEqual([]);
      expect(await downloader.status()).toBe('missing');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a server that never answers at the overall deadline', async () => {
    vi.useFakeTimers();
    try {
      const { downloader } = setup(() => new Promise(() => undefined), { deadlineMs: 1_000 });

      const download = rejectionOf(downloader.download());
      await vi.advanceTimersByTimeAsync(1_000);

      expect((await download).message).toBe('tiny.onnx download timed out after 1 s');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ModelDownloader cancellation at the publication boundary', () => {
  /** A model folder whose temp write and rename wait for gates, to cancel during publication. */
  function gatedSetup() {
    const memory = new MemoryModelFs();
    const writeGate = deferred<undefined>();
    const writeStarted = deferred<undefined>();
    const renameGate = deferred<undefined>();
    const renameStarted = deferred<undefined>();
    const fs: ModelFileSystem = {
      stat: (path) => memory.stat(path),
      hashFile: (path) => memory.hashFile(path),
      mkdir: (path) => memory.mkdir(path),
      readFile: (path) => memory.readFile(path),
      writeFile: async (path, data) => {
        if (isTempPath(path)) {
          writeStarted.resolve(undefined);
          await writeGate.promise;
        }
        await memory.writeFile(path, data);
      },
      rename: async (from, to) => {
        renameStarted.resolve(undefined);
        await renameGate.promise;
        await memory.rename(from, to);
      },
      remove: (path) => memory.remove(path),
    };
    const downloader = new ModelDownloader(DIR, FILE, {
      fetch: () => Promise.resolve(ok(streamOf([BYTES]).body)),
      fs,
    });
    return { downloader, memory, writeGate, writeStarted, renameGate, renameStarted };
  }

  it('publishes nothing and leaves no temp file when cancelled while the file is written', async () => {
    const { downloader, memory, writeGate, writeStarted } = gatedSetup();

    const download = rejectionOf(downloader.download());
    await writeStarted.promise;
    downloader.cancel();
    writeGate.resolve(undefined);

    expect((await download).message).toBe('Download cancelled');
    await downloader.settled();
    expect(memory.files.size).toBe(0);
    expect(await downloader.status()).toBe('missing');
  });

  it('completes when cancelled after the rename has started (the commit point)', async () => {
    const { downloader, memory, writeGate, renameGate, renameStarted } = gatedSetup();
    writeGate.resolve(undefined);

    const download = downloader.download();
    await renameStarted.promise;
    downloader.cancel();
    renameGate.resolve(undefined);

    await expect(download).resolves.toBe(MODEL_PATH);
    expect(memory.files.get(MODEL_PATH)).toEqual(BYTES);
    expect(memory.files.has(TEMP_PATH)).toBe(false);
    expect(await downloader.status()).toBe('ready');
  });
});

describe('ModelDownloader publication failures and the deadline', () => {
  /** A model folder where single operations can be held or made to fail. */
  function controlledSetup(options: ModelDownloaderOptions = {}) {
    const memory = new MemoryModelFs();
    const hooks: {
      beforeWrite?: (path: string) => Promise<void>;
      beforeMarkerRemoval?: () => Promise<void>;
      rename?: () => Promise<void>;
    } = {};
    const renames: string[] = [];
    const fs: ModelFileSystem = {
      stat: (path) => memory.stat(path),
      hashFile: (path) => memory.hashFile(path),
      mkdir: (path) => memory.mkdir(path),
      readFile: (path) => memory.readFile(path),
      writeFile: async (path, data) => {
        if (isTempPath(path)) await hooks.beforeWrite?.(path);
        await memory.writeFile(path, data);
      },
      rename: async (from, to) => {
        renames.push(to);
        await hooks.rename?.();
        await memory.rename(from, to);
      },
      remove: async (path) => {
        if (path === MARKER_PATH) await hooks.beforeMarkerRemoval?.();
        await memory.remove(path);
      },
    };
    const downloader = new ModelDownloader(
      DIR,
      FILE,
      { fetch: () => Promise.resolve(ok(streamOf([BYTES]).body)), fs },
      options,
    );
    return { downloader, memory, hooks, renames };
  }

  it('publishes nothing when cancelled while the old marker is being removed', async () => {
    const { downloader, memory, hooks, renames } = controlledSetup();
    const gate = deferred<undefined>();
    const started = deferred<undefined>();
    hooks.beforeMarkerRemoval = async () => {
      started.resolve(undefined);
      await gate.promise;
    };

    const download = rejectionOf(downloader.download());
    await started.promise;
    downloader.cancel();
    gate.resolve(undefined);

    expect((await download).message).toBe('Download cancelled');
    await downloader.settled();
    expect(renames).toEqual([]);
    expect(memory.files.has(MODEL_PATH)).toBe(false);
    expect(hasTempFile(memory.files)).toBe(false);
  });

  it('removes the temp file when the rename fails', async () => {
    const { downloader, memory, hooks } = controlledSetup();
    hooks.rename = () => Promise.reject(new Error('EPERM: model file is locked'));

    expect((await rejectionOf(downloader.download())).message).toBe('EPERM: model file is locked');
    await downloader.settled();
    expect(hasTempFile(memory.files)).toBe(false);
    expect(memory.files.has(MODEL_PATH)).toBe(false);
  });

  it('removes the temp file when removing the old marker fails', async () => {
    const { downloader, memory, hooks, renames } = controlledSetup();
    hooks.beforeMarkerRemoval = () => Promise.reject(new Error('EACCES'));

    expect((await rejectionOf(downloader.download())).message).toBe('EACCES');
    await downloader.settled();
    expect(renames).toEqual([]);
    expect(hasTempFile(memory.files)).toBe(false);
  });

  it('returns from a cancel at once while the temp write is stalled, then cleans up', async () => {
    const { downloader, memory, hooks, renames } = controlledSetup();
    const disk = deferred<undefined>();
    const started = deferred<undefined>();
    hooks.beforeWrite = async () => {
      started.resolve(undefined);
      await disk.promise; // a disk write that hangs until the test releases it
    };

    const download = rejectionOf(downloader.download());
    await started.promise;
    downloader.cancel();

    // Settles while the write is still stuck: nothing waits for the cleanup.
    expect((await download).message).toBe('Download cancelled');
    expect(await downloader.status()).toBe('missing');

    disk.resolve(undefined);
    await downloader.settled();
    expect(hasTempFile(memory.files)).toBe(false);
    expect(renames).toEqual([]);
  });

  it('runs a retry while the cancelled attempt is still waiting for its write to clean up', async () => {
    const { downloader, memory, hooks } = controlledSetup();
    const firstDisk = deferred<undefined>();
    const firstStarted = deferred<undefined>();
    // Only the first attempt's write hangs; the retry writes its own temp file freely.
    hooks.beforeWrite = async (path) => {
      if (path !== TEMP_PATH) return;
      firstStarted.resolve(undefined);
      await firstDisk.promise;
    };

    const first = rejectionOf(downloader.download());
    await firstStarted.promise;
    downloader.cancel();
    expect((await first).message).toBe('Download cancelled');

    // The old write (and so its cleanup) is still pending: the retry must not wait for it.
    await expect(downloader.download()).resolves.toBe(MODEL_PATH);
    expect(memory.files.get(MODEL_PATH)).toEqual(BYTES);
    expect(await downloader.status()).toBe('ready');

    // The old write lands late; its own cleanup then removes its temp file, not the model.
    firstDisk.resolve(undefined);
    await downloader.settled();
    expect(hasTempFile(memory.files)).toBe(false);
    expect(memory.files.get(MODEL_PATH)).toEqual(BYTES);
    expect(await downloader.status()).toBe('ready');
  });

  it('resolves the download without waiting for the best-effort marker write', async () => {
    const { downloader, memory } = controlledSetup();
    const markerDisk = deferred<undefined>();
    const original = memory.writeFile.bind(memory);
    memory.writeFile = async (path, data) => {
      if (path === MARKER_PATH) await markerDisk.promise;
      await original(path, data);
    };

    await expect(downloader.download()).resolves.toBe(MODEL_PATH);
    expect(memory.files.has(MARKER_PATH)).toBe(false);

    markerDisk.resolve(undefined);
    await downloader.settled();
    expect(memory.files.has(MARKER_PATH)).toBe(true);
  });

  it('ends at the deadline while the temp file is still being written, then cleans it up', async () => {
    vi.useFakeTimers();
    try {
      const { downloader, memory, hooks, renames } = controlledSetup({ deadlineMs: 2_000 });
      const disk = deferred<undefined>();
      hooks.beforeWrite = () => disk.promise; // a disk write that hangs past the deadline

      const download = rejectionOf(downloader.download());
      await vi.advanceTimersByTimeAsync(2_000);

      expect((await download).message).toBe('tiny.onnx download timed out after 2 s');
      disk.resolve(undefined);
      await vi.waitFor(() => expect(hasTempFile(memory.files)).toBe(false));
      expect(renames).toEqual([]);
      expect(await downloader.status()).toBe('missing');
    } finally {
      vi.useRealTimers();
    }
  });
});
