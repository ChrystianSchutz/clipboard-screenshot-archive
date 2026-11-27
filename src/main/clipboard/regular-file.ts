import { constants, type Stats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';

/** `O_NOFOLLOW` where the OS defines it (undefined on Windows, despite the typings). */
const NO_FOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/** Why a file from the screenshot folder was not read. */
export type RegularFileRefusal = 'not-a-regular-file' | 'too-large';

/** Device and inode: which file a path or a descriptor refers to. */
interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

const sameFile = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino;

/**
 * One regular file, opened once. Every later step (its facts, its provenance, its bytes) refers to
 * this descriptor, so they all describe the same file even if the path is replaced meanwhile.
 */
export interface OpenedRegularFile {
  readonly path: string;
  /** The open descriptor (for descriptor-bound metadata such as `fgetxattr`); -1 once closed. */
  readonly fd: number;
  /** Birth time from the descriptor, or `null` when the file system has none. */
  readonly birthtimeMs: number | null;
  /**
   * Whether `path` still names this open file: the descriptor is still a regular file with the
   * identity it was opened with, and `lstat(path)` (never following a link) reports that identity.
   */
  stillAtPath(): Promise<boolean>;
  /**
   * The file's bytes, read from the descriptor: at most `maxBytes + 1` are ever read, so a writer
   * that appends after the size check cannot make the read allocate past the limit.
   */
  readBytes(maxBytes: number): Promise<Uint8Array | RegularFileRefusal>;
  close(): Promise<void>;
}

/**
 * Opens `path` only if it is a regular file at `path` itself, never through a symbolic link:
 * - `lstat` first, so a link (to a file outside the folder, or anywhere) is refused unopened;
 * - opened with `O_NOFOLLOW` where the OS has it (macOS, Linux), so a link swapped in after the
 *   check fails to open instead of being followed;
 * - re-checked on the open descriptor: still a regular file, and the same file (device and inode)
 *   the `lstat` saw, so a swap on a system without `O_NOFOLLOW` is caught too.
 */
export async function openRegularFile(
  path: string,
): Promise<OpenedRegularFile | 'not-a-regular-file'> {
  let before: Stats;
  try {
    before = await lstat(path);
  } catch {
    return 'not-a-regular-file';
  }
  if (!before.isFile()) return 'not-a-regular-file';
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
  } catch {
    // ELOOP: the path became a symbolic link after the check.
    return 'not-a-regular-file';
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(opened, before)) {
      await handle.close();
      return 'not-a-regular-file';
    }
    return new DescriptorFile(path, handle, opened);
  } catch {
    await handle.close();
    return 'not-a-regular-file';
  }
}

class DescriptorFile implements OpenedRegularFile {
  readonly birthtimeMs: number | null;
  private closed = false;

  constructor(
    readonly path: string,
    private readonly handle: FileHandle,
    private readonly identity: Stats,
  ) {
    this.birthtimeMs = identity.birthtimeMs > 0 ? identity.birthtimeMs : null;
  }

  get fd(): number {
    return this.handle.fd;
  }

  async stillAtPath(): Promise<boolean> {
    try {
      const now = await this.handle.stat();
      if (!now.isFile() || !sameFile(now, this.identity)) return false;
      const atPath = await lstat(this.path);
      return atPath.isFile() && sameFile(atPath, this.identity);
    } catch {
      return false;
    }
  }

  async readBytes(maxBytes: number): Promise<Uint8Array | RegularFileRefusal> {
    const facts = await this.handle.stat();
    if (!facts.isFile() || !sameFile(facts, this.identity)) return 'not-a-regular-file';
    if (facts.size > maxBytes) return 'too-large';
    return readBounded(this.handle, facts.size, maxBytes);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }
}

/**
 * Reads from the start of `handle` until end of file, never more than `maxBytes + 1` bytes: one
 * byte past the limit proves the file grew too large. The buffer starts at the size `fstat`
 * reported (plus the probe byte) and only grows, up to the bound, if the file grew since.
 * Exported for tests.
 */
export async function readBounded(
  handle: Pick<FileHandle, 'read'>,
  expectedSize: number,
  maxBytes: number,
): Promise<Uint8Array | 'too-large'> {
  const bound = maxBytes + 1;
  let buffer = new Uint8Array(Math.min(bound, expectedSize + 1));
  let total = 0;
  for (;;) {
    if (total === buffer.length) {
      if (buffer.length >= bound) return 'too-large';
      const grown = new Uint8Array(Math.min(bound, Math.max(buffer.length * 2, 64 * 1024)));
      grown.set(buffer);
      buffer = grown;
    }
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > maxBytes) return 'too-large';
  return total === buffer.length ? buffer : buffer.slice(0, total);
}

/**
 * Reads a regular file at `path` (see `openRegularFile`), bounded by `maxBytes` (see
 * `OpenedRegularFile.readBytes`).
 */
export async function readRegularFile(
  path: string,
  maxBytes: number,
): Promise<Uint8Array | RegularFileRefusal> {
  const file = await openRegularFile(path);
  if (file === 'not-a-regular-file') return file;
  try {
    return await file.readBytes(maxBytes);
  } finally {
    await file.close();
  }
}
