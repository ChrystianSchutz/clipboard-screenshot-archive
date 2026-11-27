import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** A model file pinned by URL (immutable revision), exact size and SHA-256. */
export interface ModelFile {
  readonly name: string;
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
}

export interface DownloadResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: AsyncIterable<Uint8Array>;
}

/**
 * Identity of a file's current contents, or `null` from `stat` when it does not exist: size and
 * modification time, plus (where the file system has them) the change time, which no API can set
 * back, and the file's inode and device, which change when another file is renamed over it.
 */
export interface FileStamp {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs?: number;
  readonly ino?: string;
  readonly dev?: string;
}

/** What `hashFile` read: the SHA-256 of the bytes and the stamp of that same open file. */
export interface HashedFile {
  readonly sha256: string;
  readonly stamp: FileStamp;
}

/** The file operations the downloader needs (`nodeModelFileSystem` in production). */
export interface ModelFileSystem {
  stat(path: string): Promise<FileStamp | null>;
  /**
   * Hashes a file through one open descriptor and stamps it with `fstat` of that descriptor, so
   * the stamp describes the bytes that were hashed even if the path is replaced meanwhile.
   * `null` when the file does not exist; rejects when the file changed while it was read.
   */
  hashFile(path: string): Promise<HashedFile | null>;
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  /** Atomic: readers see the old file or the complete new one, never a partial write. */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Same-directory rename that replaces `to` (atomic on every desktop file system). */
  rename(from: string, to: string): Promise<void>;
  /** Removes a file; no error when it is already gone. */
  remove(path: string): Promise<void>;
}

export interface ModelDownloadPorts {
  /** Must refuse anything but HTTPS, on the first request and on every redirect hop. */
  readonly fetch: (url: string, signal: AbortSignal) => Promise<DownloadResponse>;
  readonly fs: ModelFileSystem;
}

export interface ModelDownloaderOptions {
  /** The whole download (connect, body, publication) must finish within this time. */
  readonly deadlineMs?: number;
}

export interface DownloadProgress {
  readonly received: number;
  readonly total: number;
}

/**
 * - `ready`: the file is there and matches its pinned size and SHA-256.
 * - `corrupt`: a file is there but does not match (truncated, damaged, replaced); a new
 *   `download()` replaces it.
 */
export type ModelStatus = 'missing' | 'downloading' | 'ready' | 'corrupt';

/** 21.6 MB takes seconds on any working connection; a transfer stalled for this long is dead. */
export const MODEL_DOWNLOAD_DEADLINE_MS = 10 * 60_000;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** What `<model>.verified` records: the file that was hashed, so an unchanged file is not hashed again. */
interface VerifiedMarker extends FileStamp {
  readonly sha256: string;
}

const STAMP_IDENTITY = ['ctimeMs', 'ino', 'dev'] as const;

/** Whether two stamps describe the same file contents (see `FileStamp`). */
function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return (
    a.size === b.size && a.mtimeMs === b.mtimeMs && STAMP_IDENTITY.every((key) => a[key] === b[key])
  );
}

/** How often `status()` hashes again when the path was replaced while it was being hashed. */
const STATUS_HASH_ATTEMPTS = 2;

/**
 * Fetches an optional model into `userData/models` when the user asks for it.
 *
 * - Nothing is downloaded until `download()` is called (the user clicks "Download model").
 * - The file must match its pinned size and SHA-256 before it is published; a mismatch (truncated
 *   download, tampered mirror, captive portal page) is rejected and nothing is stored.
 * - A response larger than the pinned size is cut off at once, so a hostile server cannot fill
 *   the disk or memory. The whole download has a deadline (`deadlineMs`), so a stalled transfer
 *   ends on its own.
 * - `status()` reports `ready` only for a file that matches: it trusts a `<name>.verified` marker
 *   only while the file's stamp (size, modification and change time, inode and device) is the one
 *   it recorded, and hashes the file again otherwise. The marker is written from the stamp of the
 *   descriptor that was hashed, never from a second look at the path. A damaged file is `corrupt`,
 *   and `download()` replaces it; `invalidate()` drops the marker when the worker that loads the
 *   weights finds them damaged anyway (a change no stamp shows).
 * - One download at a time: a second call while one runs joins it.
 *
 * Cancellation (`cancel()`, `remove()` or the deadline): until the verified bytes are renamed into
 * place, the download stops, its temporary file is removed and nothing is published. The deadline
 * also bounds the file-system work before the rename (a write stuck on a slow disk). The rename is
 * the commit point: once it has started, the download completes and a cancel is a no-op.
 *
 * Each attempt writes its own temporary file (`<name>.download-<n>`) and removes it in the
 * background once its own write has settled. A cancel therefore returns at once even while a disk
 * write hangs, and a retry never waits for (or collides with) an earlier attempt's cleanup. The
 * `.verified` marker after the rename is best effort and written in the background as well: the
 * download resolves as soon as the file is in place.
 */
export class ModelDownloader {
  readonly path: string;
  private readonly markerPath: string;
  private readonly deadlineMs: number;
  private running: { promise: Promise<string>; controller: AbortController } | null = null;
  /** Numbers the attempts, so each one writes its own temp file. */
  private attempts = 0;
  /**
   * Bumped by `invalidate()` and `remove()`: a background marker write that began before either
   * must not vouch for the file afterwards.
   */
  private markerEpoch = 0;
  /** Background work (temp cleanups, marker writes) still running; see `settled()`. */
  private readonly background = new Set<Promise<void>>();
  /** The latest background marker write (after a commit); `remove()` lets it finish first. */
  private marking: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly file: ModelFile,
    private readonly ports: ModelDownloadPorts,
    options: ModelDownloaderOptions = {},
  ) {
    this.path = join(dir, file.name);
    this.markerPath = `${this.path}.verified`;
    this.deadlineMs = options.deadlineMs ?? MODEL_DOWNLOAD_DEADLINE_MS;
  }

  async status(): Promise<ModelStatus> {
    if (this.running) return 'downloading';
    const stamp = await this.ports.fs.stat(this.path);
    if (!stamp) return 'missing';
    if (stamp.size !== this.file.size) return 'corrupt';
    if (await this.markerMatches(stamp)) {
      // The weights may have been replaced while the marker was read: the verdict holds only if
      // the path still names the file the marker vouched for. Otherwise hash what is there now.
      const now = await this.ports.fs.stat(this.path);
      if (now && sameStamp(now, stamp)) return 'ready';
    }
    // No marker, or the file changed since it was verified: hash it.
    for (let attempt = 0; attempt < STATUS_HASH_ATTEMPTS; attempt++) {
      let hashed: HashedFile | null;
      try {
        hashed = await this.ports.fs.hashFile(this.path);
      } catch {
        return 'corrupt';
      }
      if (!hashed) return 'missing';
      if (!this.matches(hashed)) return 'corrupt';
      // The verdict holds for the descriptor that was hashed: `ready` only while the path still
      // names that same file. A replacement during the hash is hashed again (bounded).
      const now = await this.ports.fs.stat(this.path);
      if (now && sameStamp(now, hashed.stamp)) {
        // Nothing is awaited between the final stat and the verdict: the marker (best effort) is
        // written in the background, after it.
        void this.inBackground(this.writeMarker(hashed.stamp, this.markerEpoch));
        return 'ready';
      }
    }
    return 'corrupt';
  }

  /**
   * The worker that loads the weights found them damaged: the marker no longer vouches for the
   * file, so the next `status()` hashes it again (and `download()` replaces it).
   */
  async invalidate(): Promise<void> {
    this.markerEpoch++;
    await this.ports.fs.remove(this.markerPath);
  }

  /** Resolves when the background work started so far (temp cleanups, marker writes) has ended. */
  async settled(): Promise<void> {
    while (this.background.size > 0) await Promise.all([...this.background]);
  }

  download(onProgress?: (progress: DownloadProgress) => void): Promise<string> {
    if (this.running) return this.running.promise;
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort(
        new DeadlineError(
          `${this.file.name} download timed out after ${Math.round(this.deadlineMs / 1000)} s`,
        ),
      );
    }, this.deadlineMs);
    const promise = this.fetchVerified(controller.signal, onProgress).finally(() => {
      clearTimeout(deadline);
      this.running = null;
    });
    this.running = { promise, controller };
    return promise;
  }

  /** Stops a running download; its promise rejects with "Download cancelled" (see the class notes). */
  cancel(): void {
    this.running?.controller.abort();
  }

  /** Deletes the model (a "Remove model" button, or turning analysis off for good). */
  async remove(): Promise<void> {
    const running = this.running;
    this.cancel();
    // Let a download that is already publishing finish first, so it cannot bring the file back.
    if (running) await running.promise.catch(() => undefined);
    // A cancelled attempt's temp file is never renamed, so its cleanup (which may wait for a hung
    // write) need not finish first.
    this.markerEpoch++;
    await this.marking;
    await this.ports.fs.remove(this.markerPath);
    await this.ports.fs.remove(this.path);
  }

  private async fetchVerified(
    signal: AbortSignal,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<string> {
    const { size, url, sha256, name } = this.file;
    if (!isHttps(url)) throw new Error(`Could not download ${name}: only HTTPS is allowed`);
    let response: DownloadResponse;
    try {
      response = await untilAborted(this.ports.fetch(url, signal), signal);
    } catch (error) {
      throw signal.aborted
        ? abortError(signal)
        : new Error(`Could not download ${name}: ${describe(error)}`);
    }
    if (!response.ok) throw new Error(`Could not download ${name}: HTTP ${response.status}`);

    const bytes = new Uint8Array(size);
    let received = 0;
    const chunks = response.body[Symbol.asyncIterator]();
    try {
      for (;;) {
        // Raced against the signal: a body that stalls (and ignores the signal) still ends.
        const next = await untilAborted(chunks.next(), signal);
        if (next.done) break;
        const chunk = next.value;
        if (received + chunk.length > size) throw new Error(`${name} is larger than expected`);
        bytes.set(chunk, received);
        received += chunk.length;
        onProgress?.({ received, total: size });
      }
    } catch (error) {
      void chunks.return?.().catch(() => undefined);
      throw signal.aborted ? abortError(signal) : error;
    }
    throwIfAborted(signal);
    if (received !== size)
      throw new Error(`${name} download was incomplete (${received} of ${size} bytes)`);
    if (sha256Hex(bytes) !== sha256)
      throw new Error(`${name} failed its checksum; nothing was saved`);

    await this.publish(bytes, signal);
    return this.path;
  }

  /**
   * Writes the verified bytes to this attempt's own temp file, then renames them into place (the
   * commit point). Everything before the rename is raced against the signal (cancel and deadline).
   * After any failure up to and including the rename, the temp file is removed in the background
   * once this attempt's write has settled: neither the cancel nor the next attempt waits for it.
   */
  private async publish(bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    const { fs } = this.ports;
    const tempPath = `${this.path}.download-${String(++this.attempts)}`;
    const prepared = (async () => {
      await fs.mkdir(this.dir);
      throwIfAborted(signal);
      await fs.writeFile(tempPath, bytes);
      throwIfAborted(signal);
      await fs.remove(this.markerPath);
    })();
    try {
      await untilAborted(prepared, signal);
      // Checked right before the rename: a cancel during the marker removal still wins.
      throwIfAborted(signal);
      await fs.rename(tempPath, this.path);
    } catch (error) {
      // A cancel does not stop a disk write: the temp file goes once the write has settled, so a
      // late write cannot leave it behind.
      void this.inBackground(prepared.catch(() => undefined).then(() => fs.remove(tempPath)));
      throw signal.aborted ? abortError(signal) : error;
    }
    // Committed: from here a cancel no longer undoes the download, and the marker is best effort.
    this.marking = this.inBackground(this.markVerified(this.markerEpoch));
  }

  /** Tracks background work; its failure is ignored (it is best effort by design). */
  private inBackground(work: Promise<void>): Promise<void> {
    const tracked: Promise<void> = work
      .catch(() => undefined)
      .finally(() => this.background.delete(tracked));
    this.background.add(tracked);
    return tracked;
  }

  private matches(hashed: HashedFile): boolean {
    return hashed.stamp.size === this.file.size && hashed.sha256 === this.file.sha256;
  }

  /** Hashes the published file and records the stamp of exactly the bytes that were hashed. */
  private async markVerified(epoch: number): Promise<void> {
    try {
      const hashed = await this.ports.fs.hashFile(this.path);
      if (hashed && this.matches(hashed)) await this.writeMarker(hashed.stamp, epoch);
    } catch {
      // No marker: the next status() hashes again.
    }
  }

  private async markerMatches(stamp: FileStamp): Promise<boolean> {
    try {
      const marker = JSON.parse(
        new TextDecoder().decode(await this.ports.fs.readFile(this.markerPath)),
      ) as Partial<VerifiedMarker>;
      return (
        marker.size === stamp.size &&
        marker.mtimeMs === stamp.mtimeMs &&
        STAMP_IDENTITY.every((key) => marker[key] === stamp[key]) &&
        marker.sha256 === this.file.sha256
      );
    } catch {
      return false;
    }
  }

  /**
   * Records `stamp` (taken from the descriptor whose bytes were hashed) as verified, unless the
   * marker was invalidated since `epoch`. Best effort: without a marker the next check hashes again.
   */
  private async writeMarker(stamp: FileStamp, epoch: number): Promise<void> {
    if (epoch !== this.markerEpoch) return;
    try {
      const marker: VerifiedMarker = { ...stamp, sha256: this.file.sha256 };
      await this.ports.fs.writeFile(
        this.markerPath,
        new TextEncoder().encode(JSON.stringify(marker)),
      );
    } catch {
      // ignored on purpose, see above
    }
  }
}

class DeadlineError extends Error {}

export function isHttps(url: string): boolean {
  return URL.canParse(url) && new URL(url).protocol === 'https:';
}

function cancelled(): Error {
  return new Error('Download cancelled');
}

/** The error a download ends with when its signal fired: the deadline, or a user cancel. */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof DeadlineError ? signal.reason : cancelled();
}

/** Settles with `work`, or rejects as soon as `signal` aborts (even if `work` ignores the signal). */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** A function, not an inline check: the signal can flip during any `await` above it. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
