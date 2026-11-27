import type { ImageAnalysis } from '@shared/image-analysis';
import { shouldAnalyze, type ImageRecognitionSettings } from '@shared/image-settings';
import type { OcrResult } from '@shared/ocr';
import type { AnalysisModelState, ScreenshotDetails, ScreenshotVariant } from '@shared/screenshots';
import type { Clip, ClipSource } from '@shared/types';
import type { DownloadProgress, ModelStatus } from '../models/model-downloader';
import type { ImageRepository } from '../storage/image-repository';
import { isTransientWorkerError } from '../workers/worker-client';
import { isWeightsIntegrityError } from '../workers/worker-protocol';
import type { HashLocks } from './hash-locks';
import type { CaptureRequest, ImageCaptureOutcome } from './image-capture';
import type { ImageFileSource } from './ports';
import { isTempFileName, type ImageStore } from './image-store';

/** What a clipboard image capture ended with, as the capture service reports it. */
export type ScreenshotCaptureResult =
  | { readonly status: 'recorded'; readonly clip: Clip; readonly created: boolean }
  | {
      readonly status: 'skipped';
      readonly reason: Extract<ImageCaptureOutcome, { status: 'skipped' }>['reason'] | 'paused';
    };

export interface ScreenshotsDeps {
  readonly capture: {
    captureFromClipboard(request: CaptureRequest): Promise<ImageCaptureOutcome>;
    captureFromFile(file: ImageFileSource, request: CaptureRequest): Promise<ImageCaptureOutcome>;
    requeueOcr(hash: string): boolean;
    analyze(hash: string, trigger: 'capture' | 'user'): boolean;
    cancelOcr(): string[];
    cancelAnalysis(): string[];
    /** Drops the analyses only the capture asked for, keeps explicit ones (see `ImageCaptureService`). */
    cancelAutomaticAnalysis(): string[];
  };
  readonly repository: Pick<
    ImageRepository,
    | 'record'
    | 'details'
    | 'hashOf'
    | 'hasImage'
    | 'pendingText'
    | 'pendingAnalysis'
    | 'requestAnalysis'
    | 'requestText'
    | 'saveText'
    | 'failText'
    | 'saveAnalysis'
    | 'failAnalysis'
    | 'cancelPendingAnalysis'
    | 'withdrawText'
    | 'withdrawAnalysis'
    | 'withdrawAutomaticAnalysis'
  >;
  readonly store: Pick<ImageStore, 'read' | 'remove' | 'removeLeftovers' | 'files'>;
  /** Shared with the capture service (see `HashLocks`). */
  readonly locks: HashLocks;
  /**
   * Puts a PNG on the system clipboard, with the app's write marker carrying `marker` in the same
   * write (see `WRITE_MARKER_FORMAT`).
   */
  readonly writeImage: (png: Uint8Array, marker?: string) => Promise<void>;
  /** Marks a clip as just used (restoring it moves it to the top, like a text clip). */
  readonly touch: (clipId: number) => void;
  readonly model: {
    readonly size: number;
    status(): Promise<ModelStatus>;
    download(onProgress: (progress: DownloadProgress) => void): Promise<string>;
    cancel(): void;
    /** Forgets that the file was verified (the worker found the weights damaged). */
    invalidate(): Promise<void>;
  };
  readonly settings: () => ImageRecognitionSettings;
  /** A screenshot's details changed (text read, analysis done or failed). */
  readonly onUpdated: (clipId: number) => void;
  readonly onModelState: (state: AnalysisModelState) => void;
  readonly onError: (error: Error, context: string) => void;
  /**
   * Reserves a place in the app's single clipboard write chain (`CaptureService.writeMarked`) and
   * runs the write there with its marker token, so restores finish in request order and the
   * capture pipeline recognises the change by its token. Default: runs the write directly.
   */
  readonly writeMarked?: <T>(write: (marker?: string) => Promise<T>) => Promise<T>;
  readonly now?: () => number;
}

/** How long to wait after a deletion before looking for image files no clip uses any more. */
export const SWEEP_DELAY_MS = 2_000;

/**
 * Text recognition that failed because the worker timed out or crashed is tried again this many
 * times on a fresh worker before the screenshot is marked failed (the user can still retry).
 */
export const MAX_TEXT_RETRIES = 2;

/** Shown when the downloaded model no longer matches its checksum. */
export const DAMAGED_MODEL_ERROR = 'The downloaded model is damaged. Download it again.';

/**
 * The screenshot feature behind the IPC handlers: records image clips, stores what the text
 * recognition and analysis queues return, serves image bytes, restores an image to the clipboard
 * and runs the optional model download.
 *
 * It only connects ports (capture service, repository, store, model downloader), so the app's
 * composition root stays a list of wires and every rule here is unit-tested.
 */
export class Screenshots {
  /** Transient text recognition failures per image, for the bounded retry. */
  private readonly textAttempts = new Map<string, number>();
  private modelState: AnalysisModelState;
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private sweeping: Promise<void> | null = null;
  /** After shutdown nothing is scheduled any more (the database is about to close). */
  private disposed = false;

  constructor(private readonly deps: ScreenshotsDeps) {
    this.modelState = { state: 'missing', size: deps.model.size };
  }

  /** Reads the model state from disk and re-queues work left over from the last run. */
  async start(): Promise<void> {
    await this.refreshModel();
    this.resume();
  }

  /**
   * Called by the capture service for a clipboard change without text. The app's own restores
   * never get here: the capture service recognises them by their write marker first.
   */
  async captureClipboard(input: {
    source: ClipSource;
    copiedAt: number;
    isCurrent: () => boolean | Promise<boolean>;
    /** Whether the capture may still commit (checked right before the database insert). */
    canRecord?: () => boolean;
  }): Promise<ScreenshotCaptureResult> {
    const capture = this.recorder(input.source, input.copiedAt, input.canRecord);
    return capture.result(
      await this.deps.capture.captureFromClipboard({
        isCurrent: input.isCurrent,
        record: capture.record,
        withdraw: capture.withdraw,
      }),
    );
  }

  /** A new file in the macOS screenshots folder (the OS made it, so there is no source app). */
  async captureFile(
    file: ImageFileSource,
    copiedAt: number,
    canRecord?: () => boolean,
  ): Promise<ScreenshotCaptureResult> {
    const capture = this.recorder({ app: null, exe: null, url: null }, copiedAt, canRecord);
    return capture.result(
      await this.deps.capture.captureFromFile(file, {
        record: capture.record,
        withdraw: capture.withdraw,
      }),
    );
  }

  details(clipId: number): ScreenshotDetails | null {
    return this.deps.repository.details(clipId);
  }

  /** PNG bytes of a screenshot for the `clip-image:` protocol, or null for an unknown clip. */
  async image(clipId: number, variant: ScreenshotVariant): Promise<Uint8Array | null> {
    const hash = this.deps.repository.hashOf(clipId);
    if (hash === null) return null;
    return this.deps.store.read(hash, variant);
  }

  /**
   * Puts the screenshot back on the clipboard (Enter on an image row). The place in the write chain
   * is reserved before the PNG is read, so a text restore requested later never overtakes it; the
   * write carries the app's marker token, which is how its own change event is recognised.
   */
  async restore(clipId: number): Promise<boolean> {
    const hash = this.deps.repository.hashOf(clipId);
    if (hash === null) return false;
    const png = this.deps.store.read(hash, 'full');
    // Awaited inside the write below; this only keeps an early failure from going unhandled.
    png.catch(() => undefined);
    const writeMarked = this.deps.writeMarked ?? ((write) => write());
    await writeMarked(async (marker) => {
      await this.deps.writeImage(await png, marker);
    });
    this.deps.touch(clipId);
    return true;
  }

  /** The "Analyze" button (also its "Retry"). False when analysis is off or the model is missing. */
  analyze(clipId: number): boolean {
    const hash = this.deps.repository.hashOf(clipId);
    if (hash === null || !this.canAnalyze('user')) return false;
    this.deps.repository.requestAnalysis(hash, 'user');
    this.deps.capture.analyze(hash, 'user');
    this.deps.onUpdated(clipId);
    return true;
  }

  /**
   * The "Retry" action of a screenshot whose text could not be read (or was never read because
   * recognition was off). False when recognition is off or the clip is not an image.
   */
  retryText(clipId: number): boolean {
    const hash = this.deps.repository.hashOf(clipId);
    if (hash === null || !this.deps.settings().textRecognition) return false;
    this.textAttempts.delete(hash);
    this.deps.repository.requestText(hash);
    this.deps.capture.requeueOcr(hash);
    this.deps.onUpdated(clipId);
    return true;
  }

  /** For the capture service: whether an automatic analysis may be queued right now. */
  analysisAvailable(): boolean {
    return this.modelState.state === 'ready';
  }

  getModelState(): AnalysisModelState {
    return this.modelState;
  }

  /** Starts (or joins) the model download; progress arrives through `onModelState`. */
  async downloadModel(): Promise<AnalysisModelState> {
    if (this.modelState.state === 'ready') {
      // "Ready" may be stale (the file was damaged since): check before skipping the download.
      if ((await this.deps.model.status()) === 'ready') return this.modelState;
    }
    this.setModelState({ state: 'downloading', received: 0, total: this.deps.model.size });
    try {
      await this.deps.model.download(({ received, total }) => {
        this.setModelState({ state: 'downloading', received, total });
      });
      this.setModelState({ state: 'ready' });
      this.resume();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setModelState({ state: 'failed', size: this.deps.model.size, error: message });
    }
    return this.modelState;
  }

  cancelDownload(): void {
    this.deps.model.cancel();
  }

  /** After a settings change: start what is now allowed, drop what no longer is. */
  settingsChanged(): void {
    this.resume();
  }

  /**
   * Re-queues pending text recognition and analysis (start-up, model ready, settings change), and
   * drops queued work that is no longer allowed: a job of a switched-off feature commits nothing.
   * Each pending analysis keeps who asked for it: in "On demand" the automatic ones (queued, or the
   * one running) are withdrawn and only the user's own Analyze requests run.
   */
  resume(): void {
    if (this.deps.settings().textRecognition) {
      for (const hash of this.deps.repository.pendingText()) this.deps.capture.requeueOcr(hash);
    } else {
      // The rows stay pending and are read when recognition is switched on again.
      this.deps.capture.cancelOcr();
    }
    if (!this.canAnalyze('user')) {
      this.deps.capture.cancelAnalysis();
      // A pending analysis that cannot run would spin forever in the preview.
      for (const clipId of this.deps.repository.cancelPendingAnalysis())
        this.deps.onUpdated(clipId);
      return;
    }
    if (!this.canAnalyze('capture')) {
      this.deps.capture.cancelAutomaticAnalysis();
      for (const clipId of this.deps.repository.withdrawAutomaticAnalysis())
        this.deps.onUpdated(clipId);
    }
    for (const hash of this.deps.repository.pendingAnalysis('user'))
      this.deps.capture.analyze(hash, 'user');
    if (this.canAnalyze('capture')) {
      for (const hash of this.deps.repository.pendingAnalysis('auto'))
        this.deps.capture.analyze(hash, 'capture');
    }
  }

  // Queue callbacks (wired to the text recognition and analysis queues by the app).

  textRecognized(hash: string, result: OcrResult): void {
    this.textAttempts.delete(hash);
    this.updated(this.deps.repository.saveText(hash, result));
  }

  textFailed(hash: string, error: Error): void {
    if (isTransientWorkerError(error)) {
      const attempts = (this.textAttempts.get(hash) ?? 0) + 1;
      if (attempts <= MAX_TEXT_RETRIES && this.deps.capture.requeueOcr(hash)) {
        this.textAttempts.set(hash, attempts);
        this.deps.onError(error, `text recognition (retry ${attempts} of ${MAX_TEXT_RETRIES})`);
        return;
      }
    }
    this.textAttempts.delete(hash);
    const clipId = this.deps.repository.failText(hash);
    // A clip deleted meanwhile has nothing left to fail; its missing file is no error.
    if (clipId === null) return;
    this.deps.onError(error, 'text recognition');
    this.deps.onUpdated(clipId);
  }

  analysisDone(hash: string, analysis: ImageAnalysis): void {
    this.updated(this.deps.repository.saveAnalysis(hash, analysis));
  }

  analysisFailed(hash: string, error: Error): void {
    const clipId = this.deps.repository.failAnalysis(hash);
    if (clipId !== null) {
      this.deps.onError(error, 'image analysis');
      this.deps.onUpdated(clipId);
    }
    if (isWeightsIntegrityError(error)) {
      this.modelDamaged();
      return;
    }
    // Any other failure may still hide a damaged model: re-check it, so it shows as failed (with
    // "Download again") instead of staying "ready" for ever.
    this.recheckModel().catch((cause: unknown) => {
      this.deps.onError(cause instanceof Error ? cause : new Error(String(cause)), 'model check');
    });
  }

  /**
   * Schedules removal of image files that no clip uses any more (after delete, clear or prune).
   * Debounced: deleting many clips in a row sweeps once.
   */
  scheduleSweep(): void {
    if (this.disposed) return;
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      void this.sweep();
    }, SWEEP_DELAY_MS);
  }

  /** Removes orphaned image files now. Never runs twice at once. */
  sweep(): Promise<void> {
    this.sweeping ??= this.removeOrphans()
      .catch((error: unknown) => {
        this.deps.onError(error instanceof Error ? error : new Error(String(error)), 'image sweep');
      })
      .finally(() => {
        this.sweeping = null;
      });
    return this.sweeping;
  }

  /** Shutdown: drops queued work (and results still on their way) and stops the sweep timer. */
  dispose(): void {
    this.disposed = true;
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = null;
    this.deps.capture.cancelOcr();
    this.deps.capture.cancelAnalysis();
  }

  /**
   * Deletes the files of every image no clip uses, and what interrupted writes left behind (lone
   * thumbnails, temp files). Each hash is decided and deleted under its lock, which a capture holds
   * from reusing a file until its row is committed, so a recaptured image is never swept.
   */
  private async removeOrphans(): Promise<void> {
    // Disposal is checked after every await: a sweep still running at shutdown never asks the
    // database (closed right after `dispose()`) about another file.
    const files = await this.deps.store.files();
    for (const [hash, names] of files) {
      if (this.disposed) return;
      await this.deps.locks.run(hash, async () => {
        if (this.disposed) return;
        if (!this.deps.repository.hasImage(hash)) {
          await this.deps.store.remove(hash, names);
          return;
        }
        // In use: only temp files can go (no write of this hash runs while the lock is held).
        const temps = names.filter(isTempFileName);
        if (temps.length > 0) await this.deps.store.removeLeftovers(hash, temps);
      });
    }
  }

  /**
   * The `record` step of one capture (runs inside the capture, before jobs are queued) and the
   * translation of its outcome. `canRecord` is the capture generation check: paused, resumed or
   * shut down since the change was reported means no row (the saved file is swept later).
   */
  private recorder(
    source: ClipSource,
    copiedAt: number,
    canRecord: () => boolean = () => true,
  ): {
    record: NonNullable<CaptureRequest['record']>;
    withdraw: NonNullable<CaptureRequest['withdraw']>;
    result: (outcome: ImageCaptureOutcome) => ScreenshotCaptureResult;
  } {
    let recorded: { clip: Clip; created: boolean } | null = null;
    let paused = false;
    return {
      record: (image, _origin, wanted) => {
        if (!canRecord()) {
          paused = true;
          // The file may be new and no clip uses it: let the sweep take it.
          this.scheduleSweep();
          return false;
        }
        const entry = this.deps.repository.record({
          hash: image.hash,
          width: image.width,
          height: image.height,
          byteSize: image.byteSize,
          source,
          copiedAt,
          textState: wanted.text ? 'pending' : 'off',
        });
        if (entry.created && wanted.analysis)
          this.deps.repository.requestAnalysis(image.hash, 'auto');
        recorded = entry;
        return entry.created;
      },
      // The feature went off between the row's commit and its dispatch: nothing will read it.
      withdraw: (image, jobs) => {
        if (jobs.text) this.deps.repository.withdrawText(image.hash);
        if (jobs.analysis) this.deps.repository.withdrawAnalysis(image.hash);
      },
      result: (outcome) => {
        if (outcome.status === 'skipped') return outcome;
        if (paused) return { status: 'skipped', reason: 'paused' };
        if (!recorded) throw new Error('A captured image was not recorded');
        return { status: 'recorded', clip: recorded.clip, created: recorded.created };
      },
    };
  }

  private canAnalyze(trigger: 'capture' | 'user'): boolean {
    return shouldAnalyze(this.deps.settings().imageAnalysis, trigger) && this.analysisAvailable();
  }

  private async refreshModel(): Promise<void> {
    const status = await this.deps.model.status();
    if (status === 'ready') this.setModelState({ state: 'ready' });
    else if (status === 'missing')
      this.setModelState({ state: 'missing', size: this.deps.model.size });
    else if (status === 'corrupt')
      this.setModelState({
        state: 'failed',
        size: this.deps.model.size,
        error: DAMAGED_MODEL_ERROR,
      });
  }

  /**
   * The analysis worker found the weights damaged while loading them. It hashed the very bytes it
   * loaded, so that verdict beats the `.verified` marker (which a same-size, same-mtime change can
   * fool): the marker goes, the model shows as damaged with "Download again", and pending work
   * stops. A download already running is left alone; it writes its own marker.
   */
  private modelDamaged(): void {
    if (this.modelState.state === 'ready') {
      this.setModelState({
        state: 'failed',
        size: this.deps.model.size,
        error: DAMAGED_MODEL_ERROR,
      });
      this.resume();
    }
    this.deps.model.invalidate().catch((cause: unknown) => {
      this.deps.onError(cause instanceof Error ? cause : new Error(String(cause)), 'model check');
    });
  }

  /** After an analysis failure: if the model is no longer usable, stop what waits for it. */
  private async recheckModel(): Promise<void> {
    if (this.modelState.state !== 'ready') return;
    await this.refreshModel();
    if (!this.analysisAvailable()) this.resume();
  }

  private setModelState(state: AnalysisModelState): void {
    this.modelState = state;
    this.deps.onModelState(state);
  }

  private updated(clipId: number | null): void {
    if (clipId !== null) this.deps.onUpdated(clipId);
  }
}
