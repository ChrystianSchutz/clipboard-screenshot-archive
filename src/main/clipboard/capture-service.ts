import { randomBytes } from 'node:crypto';
import { detectCategories } from '@shared/categories';
import { detectClipKind } from '@shared/clip-kind';
import type { Clip, ClipSource, Settings } from '@shared/types';
import { hashContent, type RecordInput, type RecordResult } from '../storage/clip-repository';
import { CaptureGate } from './capture-gate';
import { friendlyAppName } from './source/app-names';
import { skipReason, type SkipReason } from './privacy';
import type { ClipboardIO, ProbeResult, SourceProbe } from './ports';

/**
 * Screenshot capture (see `Screenshots.captureClipboard`). Asked for every change that passed the
 * privacy rules but carried no text, with the owner facts of that change.
 */
export interface CaptureImages {
  captureClipboard(input: {
    source: ClipSource;
    copiedAt: number;
    /**
     * Whether the clipboard still holds the change being processed, checked before and after the
     * image is read: the probed version where the OS has one, and everywhere the app's write marker
     * seen with the text (so a restore that replaced the image meanwhile is never ingested).
     */
    isCurrent: () => boolean | Promise<boolean>;
    /**
     * Whether the capture may still commit: checked at the record boundary, right before the
     * database insert (false once capture was paused, resumed or shut down since the change).
     */
    canRecord: () => boolean;
  }): Promise<
    | { readonly status: 'recorded'; readonly clip: Clip; readonly created: boolean }
    | { readonly status: 'skipped'; readonly reason: ImageSkipReason }
  >;
}

/** Why an image change was not recorded (see `ScreenshotCaptureResult`). */
export type ImageSkipReason =
  'no-image' | 'unreadable' | 'superseded' | 'paused' | 'too-small' | 'too-large';

export interface CaptureRepository {
  record(input: RecordInput): RecordResult;
  prune(maxClips: number): number;
}

export interface CaptureDeps {
  readonly io: ClipboardIO;
  readonly probe: SourceProbe;
  readonly repository: CaptureRepository;
  readonly settings: () => Settings;
  readonly now?: () => number;
  /** Waits before another look at privacy markers that could not be read (injected by tests). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called after a clip has been stored (new or bumped). */
  readonly onRecorded?: (clip: Clip, created: boolean) => void;
  /** Screenshot capture; without it a change with no text is skipped as empty. */
  readonly images?: CaptureImages;
  /** The capture generation, shared with the screenshot-folder import (see `CaptureGate`). */
  readonly gate?: CaptureGate;
  /** A fresh random token for one app write (injected by tests). */
  readonly newToken?: () => string;
  /**
   * Called once per handled change with the clipboard sequence number it was reported at and its
   * outcome (`'error'` when processing threw). Used by the CI smoke check's acknowledgments.
   */
  readonly onHandled?: (sequence: number | null, outcome: CaptureOutcome | 'error') => void;
}

export type CaptureOutcome =
  | { readonly status: 'recorded'; readonly clip: Clip; readonly created: boolean }
  | {
      readonly status: 'skipped';
      readonly reason:
        | SkipReason
        | 'paused'
        | 'self-write'
        | 'superseded'
        | 'privacy-unknown'
        | `image-${Exclude<ImageSkipReason, 'paused'>}`;
    };

/** The owner facts of one clipboard change, tied to the clipboard version they describe. */
interface ProbedChange {
  readonly owner: ProbeResult;
  readonly sequence: number | null;
  /** The capture generation when the change was reported (see `CaptureGate`). */
  readonly generation: number;
  /** Id of the last app write that had begun when the change was reported: only those can cause it. */
  readonly writesStarted: number;
}

/**
 * A clipboard write the app made itself (a restore), identified by the random token of the write
 * marker it committed in the same clipboard write. A change is the app's own only when it carries
 * the token of a live write, so an identical copy made by another app (no marker) is recorded.
 */
interface PendingWrite {
  readonly id: number;
  readonly token: string;
  /** Infinity while the write runs; then a bounded time for its change event(s) to arrive. */
  expiresAt: number;
}

const SNAPSHOT_ATTEMPTS = 3;

/**
 * Pauses before each new look at privacy markers that could not be read because another app held
 * the clipboard open (~310 ms in all). Every look is bound to the same clipboard version.
 */
export const PRIVACY_RETRY_DELAYS_MS: readonly number[] = [10, 20, 40, 80, 160];

/**
 * How long a finished write's token stays live. Tokens are unique per write, so a longer life never
 * suppresses another app's copy; the expiry only bounds memory.
 */
export const SELF_WRITE_TTL_MS = 30_000;
const MAX_PENDING_WRITES = 16;

const randomToken = (): string => randomBytes(16).toString('hex');

const sleepFor = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The capture pipeline: clipboard change → probe owner → privacy rules → store → prune.
 *
 * - Holds no Electron or Win32 references, only ports, so every rule is unit-tested.
 * - Changes are processed strictly one at a time, in arrival order, even though reading the
 *   clipboard is async: a burst of copies can never interleave or be stored out of order.
 * - The owner (and its privacy markers) is probed at notification time, the text is read later.
 *   Both are bound to the same clipboard sequence number; if the clipboard changed in between, the
 *   change is dropped as superseded (the newer copy has its own notification). So a password
 *   copied while an older change waits in the queue can never be stored with the older,
 *   non-private metadata.
 * - Privacy fails closed: markers that could not be read are looked at again, against the same
 *   version, and a change whose privacy stays unknown is dropped.
 * - The app's own writes (restores) run one at a time, in request order. Each commits a write
 *   marker with a random token in the same clipboard write (see `WRITE_MARKER_FORMAT`); a change
 *   is ignored only when it carries the token of a live write that began before the change was
 *   reported. Equal text proves nothing: an identical copy made by another app is recorded, and a
 *   failed write leaves no token behind. Where the marker cannot be read, a restore is recorded as
 *   a bump of its own clip; there is no text-equality fallback that could swallow a real copy.
 * - Text the app composes itself (joined clips, text read from a screenshot) is not in the history
 *   yet, so a missed marker would add a clip the user never copied. Such a write
 *   (`writeComposedText`) is also recognised by its content, for as long as the clipboard holds
 *   it: until a change with other content, a private copy or an image is handled. That does not
 *   depend on reading the marker or on its token still being live.
 * - Pause, resume and shutdown move the capture generation on (`CaptureGate`): a change reported
 *   before that is dropped at the record boundary, however long its privacy retry or image save took.
 */
export class CaptureService {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly gate: CaptureGate;
  private readonly newToken: () => string;
  private queue: Promise<unknown> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  /** Ids handed out to write requests (their reserved place in the write chain). */
  private writesRequested = 0;
  /** Id of the last write that has begun running. */
  private writesStarted = 0;
  private pending: PendingWrite[] = [];
  /**
   * Hash of the last text the app composed and wrote (see `writeComposedText`), while the clipboard
   * may still hold it; `null` once a change with other content was handled.
   */
  private composedHash: string | null = null;

  constructor(private readonly deps: CaptureDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? sleepFor;
    this.gate = deps.gate ?? new CaptureGate();
    this.newToken = deps.newToken ?? randomToken;
  }

  /**
   * `generation`: the capture generation taken when the watcher's look at the clipboard began (a
   * poll that started while paused keeps the paused one); default: the current one.
   */
  handleChange(generation?: number): Promise<CaptureOutcome> {
    // Probe synchronously, at notification time: the owner can change while we wait.
    const change = this.probeChange(generation);
    const outcome = this.queue.then(() => this.process(change));
    this.queue = outcome.catch(() => undefined);
    const { onHandled } = this.deps;
    if (onHandled) {
      outcome.then(
        (result) => onHandled(change.sequence, result),
        () => onHandled(change.sequence, 'error'),
      );
    }
    return outcome;
  }

  /**
   * Writes text to the clipboard without recording that write as a new copy. Writes run one at a
   * time, in call order; a failed write rejects and leaves no suppression behind.
   */
  writeWithoutRecording(text: string): Promise<void> {
    return this.writeMarked((marker) => this.deps.io.writeText(text, marker));
  }

  /**
   * Writes text the app composed (joined clips, text read from a screenshot) without recording it.
   * Unlike a restore, recording it by mistake would add a clip the user never copied, so the change
   * is also recognised by its content (see the class comment), not only by its write marker.
   */
  writeComposedText(text: string): Promise<void> {
    return this.writeMarked(async (marker) => {
      // Set before the write starts: its change can be reported while the write still runs.
      const previous = this.composedHash;
      const hash = hashContent(text);
      this.composedHash = hash;
      try {
        await this.deps.io.writeText(text, marker);
      } catch (error) {
        if (this.composedHash === hash) this.composedHash = previous;
        throw error;
      }
    });
  }

  /**
   * Runs a clipboard write of the app's own (a text or image restore) in the one-at-a-time write
   * chain. Its place is reserved by this call, synchronously, so a restore requested later never
   * overtakes it, however long this one takes to prepare its data. `write` gets the token it must
   * commit as the write marker in the same clipboard write; the token is live from just before the
   * write starts. A failed write rejects, leaves no token and does not block the chain.
   */
  writeMarked<T>(write: (marker: string) => Promise<T>): Promise<T> {
    const id = ++this.writesRequested;
    const run = this.writes.then(async () => {
      const entry: PendingWrite = { id, token: this.newToken(), expiresAt: Infinity };
      this.pending = [...this.live(), entry].slice(-MAX_PENDING_WRITES);
      this.writesStarted = id;
      try {
        const result = await write(entry.token);
        entry.expiresAt = this.now() + SELF_WRITE_TTL_MS;
        return result;
      } catch (error) {
        this.pending = this.pending.filter((other) => other !== entry);
        throw error;
      }
    });
    this.writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Reads the clipboard as one side of a comparison (text and source from the same version). */
  async snapshot(): Promise<{ content: string; source: ClipSource }> {
    for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt++) {
      const change = this.probeChange();
      const content = await this.readAt(change.sequence);
      if (content !== null) return { content, source: toSource(change.owner) };
    }
    throw new Error('The clipboard kept changing while it was being read');
  }

  private probeChange(generation?: number): ProbedChange {
    const { probe } = this.deps;
    // Sequence first: if the clipboard changes during the probe, the version check catches it.
    const sequence = probe.sequenceNumber();
    return {
      owner: probe.probe(),
      sequence,
      generation: generation ?? this.gate.current,
      writesStarted: this.writesStarted,
    };
  }

  /** Whether a change may still be recorded: same capture generation, capture still on. */
  private canRecord(change: ProbedChange): boolean {
    return this.gate.isCurrent(change.generation) && this.deps.settings().captureEnabled;
  }

  /** Reads the text only if the clipboard is still at `sequence`; `null` when it moved on. */
  private async readAt(sequence: number | null): Promise<string | null> {
    const { io, probe } = this.deps;
    if (probe.sequenceNumber() !== sequence) return null;
    const text = await io.readText();
    return probe.sequenceNumber() === sequence ? text : null;
  }

  /**
   * The text and the write marker of one clipboard state, or `null` when the clipboard moved on
   * while they were read: bound to `sequence` where there is one, and everywhere the marker read
   * before and after the text must agree (tokens are unique per write).
   */
  private async readMarked(
    sequence: number | null,
  ): Promise<{ text: string; marker: string | null } | null> {
    const { io, probe } = this.deps;
    if (probe.sequenceNumber() !== sequence) return null;
    const before = await io.readWriteMarker();
    const text = await io.readText();
    const after = await io.readWriteMarker();
    if (before !== after || probe.sequenceNumber() !== sequence) return null;
    return { text, marker: after };
  }

  /**
   * The owner facts with readable privacy markers: the probe itself, or a later probe of the same
   * clipboard version. `unknown` when the markers stayed unreadable (the change must be dropped).
   */
  private async resolvePrivacy(
    change: ProbedChange,
  ): Promise<ProbeResult | 'unknown' | 'superseded'> {
    if (!change.owner.privacyUnreadable) return change.owner;
    const { sequence } = change;
    // Without a clipboard version, a second look could describe different content.
    if (sequence === null) return 'unknown';
    const { probe } = this.deps;
    for (const delay of PRIVACY_RETRY_DELAYS_MS) {
      await this.sleep(delay);
      if (probe.sequenceNumber() !== sequence) return 'superseded';
      const again = probe.probe();
      if (probe.sequenceNumber() !== sequence) return 'superseded';
      if (!again.privacyUnreadable) return again;
    }
    return 'unknown';
  }

  private async process(change: ProbedChange): Promise<CaptureOutcome> {
    const { repository } = this.deps;
    if (!this.canRecord(change)) return { status: 'skipped', reason: 'paused' };
    const current = this.deps.settings();

    const owner = await this.resolvePrivacy(change);
    if (owner === 'superseded') return { status: 'skipped', reason: 'superseded' };
    if (owner === 'unknown') return { status: 'skipped', reason: 'privacy-unknown' };

    // Private content is never even read (and the app's own writes are never private).
    let text = '';
    let markerAtRead: string | null = null;
    if (!owner.hasPrivateFormat) {
      const read = await this.readMarked(change.sequence);
      if (read === null) return { status: 'skipped', reason: 'superseded' };
      const own = this.ownWrite(change, read.marker);
      if (own === 'self') return { status: 'skipped', reason: 'self-write' };
      // A restore that began after this change replaced it: the copy it reported is gone.
      if (own === 'later') return { status: 'skipped', reason: 'superseded' };
      if (this.isComposed(read.text)) return { status: 'skipped', reason: 'self-write' };
      text = read.text;
      markerAtRead = read.marker;
    } else {
      this.composedHash = null;
    }

    const reason = skipReason({
      text,
      exe: owner.exe,
      hasPrivateFormat: owner.hasPrivateFormat,
      excludedApps: current.excludedApps,
    });
    if (reason === 'empty' && this.deps.images)
      return this.captureImage(owner, change, current, markerAtRead);
    if (reason) return { status: 'skipped', reason };

    // The record boundary: paused, resumed or shut down meanwhile means nothing is stored.
    if (!this.canRecord(change)) return { status: 'skipped', reason: 'paused' };
    const kind = detectClipKind(text);
    const { clip, created } = repository.record({
      content: text,
      kind,
      categories: detectCategories(text, kind),
      source: toSource(owner),
      copiedAt: this.now(),
    });
    if (created) repository.prune(current.maxClips);

    this.deps.onRecorded?.(clip, created);
    return { status: 'recorded', clip, created };
  }

  /**
   * Whether `text` is the text the app composed last and the clipboard has held nothing else since.
   * Any other content ends that, so a later identical copy from another app is recorded.
   */
  private isComposed(text: string): boolean {
    if (this.composedHash === null) return false;
    if (text !== '' && hashContent(text) === this.composedHash) return true;
    this.composedHash = null;
    return false;
  }

  /**
   * Whether the clipboard state carrying `marker` is one of the app's own writes:
   * - `self`: the token of a live write that had begun when the change was reported;
   * - `later`: the token of a write that began only after the change was reported (the change can
   *   never be that write's, and the content it reported has been replaced);
   * - `null`: no marker, or a token the app does not know (expired, or not ours): a real copy.
   * A token stays live after a match: tokens are unique per write, so a second report of the same
   * clipboard state is still the app's own, and a copy made by another app never carries it.
   */
  private ownWrite(change: ProbedChange, marker: string | null): 'self' | 'later' | null {
    if (marker === null) return null;
    const write = this.live().find((candidate) => candidate.token === marker);
    if (!write) return null;
    return write.id <= change.writesStarted ? 'self' : 'later';
  }

  private live(): PendingWrite[] {
    const now = this.now();
    this.pending = this.pending.filter((write) => write.expiresAt > now);
    return this.pending;
  }

  /** A change with no text: maybe a screenshot. Same privacy rules, same version binding. */
  private async captureImage(
    owner: ProbeResult,
    change: ProbedChange,
    current: Settings,
    markerAtRead: string | null,
  ): Promise<CaptureOutcome> {
    const { images, io, probe, repository } = this.deps;
    if (!images) return { status: 'skipped', reason: 'empty' };
    const { sequence } = change;
    const result = await images.captureClipboard({
      source: toSource(owner),
      copiedAt: this.now(),
      // Checked around the pixel read. With a clipboard version, the version decides; without one
      // (Linux), a restore that replaced the image while this capture waited is caught by its
      // write marker, which differs from the marker read with the text.
      isCurrent: async () => {
        if (probe.sequenceNumber() !== sequence) return false;
        return sequence !== null || (await io.readWriteMarker()) === markerAtRead;
      },
      canRecord: () => this.canRecord(change),
    });
    if (result.status === 'skipped') {
      if (result.reason === 'paused') return { status: 'skipped', reason: 'paused' };
      // A change with neither text nor an image is what it always was: empty.
      return {
        status: 'skipped',
        reason: result.reason === 'no-image' ? 'empty' : `image-${result.reason}`,
      };
    }
    if (result.created) repository.prune(current.maxClips);
    this.deps.onRecorded?.(result.clip, result.created);
    return result;
  }
}

function toSource(owner: ProbeResult): ClipSource {
  return {
    app: owner.exe ? friendlyAppName(owner.exe) : null,
    exe: owner.exe,
    url: owner.url,
  };
}
