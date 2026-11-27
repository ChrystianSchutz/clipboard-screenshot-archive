import type { AnalysisLanguage } from '@shared/image-analysis';
import { shouldAnalyze, type ImageRecognitionSettings } from '@shared/image-settings';
import { toAnalysisImage } from '../analysis/analysis-image';
import type { AnalysisRequest } from '../analysis/remote-image-analyzer';
import { ocrUpscaleFactor } from '../ocr/ocr-scale';
import type { OcrImage } from '../ocr/ports';
import type { KeyedJob } from '../workers/keyed-queue';
import type { HashLocks } from './hash-locks';
import {
  ImageSkip,
  imageHashOffThread,
  imageSkipReason,
  pngDimensions,
  type ImageSkipReason,
} from './image-policy';
import type { ImageStore, StoredImage } from './image-store';
import type { ClipboardImageReader, ImageFileReader, ImageFileSource, ImageHandle } from './ports';

export type ImageOrigin = 'clipboard' | 'screenshot-folder';

/** Which jobs a capture queued (only a newly stored image queues any). */
export interface QueuedJobs {
  readonly text: boolean;
  readonly analysis: boolean;
}

export type ImageCaptureOutcome =
  | {
      readonly status: 'captured';
      readonly image: StoredImage;
      readonly origin: ImageOrigin;
      readonly queued: QueuedJobs;
    }
  | {
      readonly status: 'skipped';
      /** `superseded`: the clipboard changed while the image was being read. */
      readonly reason: ImageSkipReason | 'no-image' | 'unreadable' | 'superseded';
    };

/** Options of one capture. */
export interface CaptureRequest {
  /**
   * Whether the clipboard still holds the change being processed; checked right before and right
   * after the image is read, so an image is never stored with another copy's source or privacy
   * facts, nor taken from a restore that replaced it while the capture waited in the queue.
   */
  readonly isCurrent?: () => boolean | Promise<boolean>;
  /**
   * Records the history entry for the stored image. Runs synchronously before any job is queued,
   * so even an instant result finds its row. `wanted` says which jobs the settings ask for at
   * this moment (read after the file was saved, not when the capture began), so the row can start
   * in the matching states. Returns whether to queue them (true for a new clip, false for a bump
   * or an image the caller put on the clipboard itself).
   * Without it, jobs are queued for a newly stored image.
   */
  readonly record?: (image: StoredImage, origin: ImageOrigin, wanted: QueuedJobs) => boolean;
  /**
   * Jobs `record` started as pending that may no longer run when they are dispatched (the
   * feature was switched off, or the model went away, in between): the caller puts the row back
   * to "off" / "none", so nothing waits for a job that will never come.
   */
  readonly withdraw?: (image: StoredImage, jobs: QueuedJobs) => void;
}

/** Decodes PNG bytes from the store (an Electron `nativeImage` in production). */
export interface ImageDecoder {
  decode(png: Uint8Array): ImageHandle | null;
}

/** A work queue as the capture service uses it (`KeyedQueue` in production). */
export interface JobQueue<Input> {
  enqueue(job: KeyedJob<Input>): boolean;
  /** Drops the waiting jobs and the result of the running one (see `KeyedQueue.clear`). */
  clear(): string[];
  /** Drops the matching waiting jobs and the result of a matching running one. */
  withdraw(match: (key: string) => boolean): string[];
}

/** The analysis queue also says which keys are still queued or running (see `KeyedQueue.has`). */
export interface WithdrawableJobQueue<Input> extends JobQueue<Input> {
  has(key: string): boolean;
}

export interface ImageCaptureDeps {
  readonly clipboard: ClipboardImageReader;
  readonly files: ImageFileReader;
  readonly decoder: ImageDecoder;
  readonly store: Pick<ImageStore, 'save' | 'read'>;
  /** Shared with the orphan sweep: file reuse and the database commit happen under the hash's lock. */
  readonly locks: HashLocks;
  /** Text recognition queue (Tesseract). */
  readonly ocr: JobQueue<OcrImage>;
  /** Image analysis queue (Mirage). */
  readonly analysis: WithdrawableJobQueue<AnalysisRequest>;
  /** Current settings; images are stored whatever they say. */
  readonly settings: () => ImageRecognitionSettings;
  readonly analysisLanguage: () => AnalysisLanguage;
  /** Whether the analysis model is downloaded; without it nothing is queued for analysis. */
  readonly analysisAvailable: () => boolean;
  /** Called after an image was stored or found again; the caller records the history entry. */
  readonly onCaptured?: (outcome: Extract<ImageCaptureOutcome, { status: 'captured' }>) => void;
}

/**
 * Text wins over images: Excel, Word and many editors put a picture of the selection on the
 * clipboard next to the text, and the text is what the user meant to copy. An image is captured
 * only when there is no text at all (Win+Shift+S, "Copy image" in a browser, Cmd+Ctrl+Shift+4).
 */
export function shouldCaptureImage(text: string, hasImage: boolean): boolean {
  return hasImage && text.trim().length === 0;
}

/** The PNG handed to OCR: the image itself, or a 2× copy when its text is likely small. */
export function toOcrImage(image: ImageHandle): OcrImage {
  const scale = ocrUpscaleFactor(image.width, image.height);
  const source = scale === 1 ? image : image.resized(image.width * scale, image.height * scale);
  return { png: source.png(), width: image.width, height: image.height, scale };
}

/**
 * Screenshot pipeline: image source → size limits → content hash → PNG store → text recognition
 * queue, and the analysis queue when analysis is automatic.
 *
 * Holds no Electron references (only ports), so every rule is unit-tested. Captures run one at a
 * time in arrival order, like text captures in `CaptureService`.
 *
 * Main-process cost: the source refuses oversized images before decoding (`encodedSkipReason`),
 * the pixel hash runs on the thread pool, a PNG source is stored without re-encoding, and queued
 * jobs hold only the hash: each job reads its image from the store when it starts, so a burst of
 * captures never keeps decoded bitmaps alive. What stays on main (Electron has no off-thread image
 * codec) is the decode, the 320 × 200 thumbnail and the job inputs: a 2× OCR copy only for images
 * up to 2.5 MP (larger ones go to OCR as their stored PNG, not decoded at all) and the ≤ 1024 px
 * RGB copy for analysis. All of it is bounded by `IMAGE_LIMITS` and `MAX_ENCODED_BYTES`.
 */
export class ImageCaptureService {
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * Bumped each time a feature's queue is cleared (switched off, shutdown). A capture dispatches a
   * job only under the generation its row was recorded in, so work recorded before a cancel can
   * never be queued after it.
   */
  private readonly generation = { text: 0, analysis: 0 };
  /**
   * Keys in the analysis queue that only the capture asked for (automatic mode). An explicit
   * Analyze for the same key removes it, so switching to "On demand" withdraws exactly these.
   */
  private readonly automaticAnalyses = new Set<string>();

  constructor(private readonly deps: ImageCaptureDeps) {}

  /** Call on a clipboard change that carried no text (see `shouldCaptureImage`). */
  captureFromClipboard(request: CaptureRequest = {}): Promise<ImageCaptureOutcome> {
    return this.serial(async () => {
      const { isCurrent } = request;
      if (isCurrent && !(await isCurrent())) return { status: 'skipped', reason: 'superseded' };
      if (!(await this.deps.clipboard.hasImage())) return { status: 'skipped', reason: 'no-image' };
      const image = await refusable(() => this.deps.clipboard.readImage());
      if (isCurrent && !(await isCurrent())) return { status: 'skipped', reason: 'superseded' };
      if (image instanceof ImageSkip) return { status: 'skipped', reason: image.reason };
      return this.ingest(image, 'clipboard', request);
    });
  }

  /** A new file in the macOS screenshots folder, already opened by the import. */
  captureFromFile(
    file: ImageFileSource,
    request: CaptureRequest = {},
  ): Promise<ImageCaptureOutcome> {
    return this.serial(async () => {
      const image = await refusable(() => this.deps.files.read(file));
      if (image instanceof ImageSkip) return { status: 'skipped', reason: image.reason };
      return this.ingest(image, 'screenshot-folder', request);
    });
  }

  /** Queues text recognition for a stored image (after a restart, a retry, or "Read text"). */
  requeueOcr(hash: string): boolean {
    if (!this.deps.settings().textRecognition) return false;
    return this.enqueueOcr(hash);
  }

  /**
   * Queues analysis of a stored image: the "Analyze" button (`user`), or a pending automatic
   * analysis after a restart (`capture`). Returns false when settings or the model do not allow it.
   */
  analyze(hash: string, trigger: 'capture' | 'user' = 'user'): boolean {
    return this.enqueueAnalysis(hash, trigger);
  }

  /** Drops queued text recognition and the result of the running one (switched off, shutdown). */
  cancelOcr(): string[] {
    this.generation.text++;
    return this.deps.ocr.clear();
  }

  /** Drops queued analyses and the result of the running one (switched off, shutdown). */
  cancelAnalysis(): string[] {
    this.generation.analysis++;
    this.automaticAnalyses.clear();
    return this.deps.analysis.clear();
  }

  /**
   * The images were deleted (no clip uses them any more): drops their text recognition and
   * analysis, queued or running, so the workers never read a file that is about to be swept and
   * the next screenshots are not kept waiting behind work nobody can see. Returns the dropped keys.
   */
  withdrawImages(hashes: ReadonlySet<string>): { text: string[]; analysis: string[] } {
    if (hashes.size === 0) return { text: [], analysis: [] };
    for (const hash of hashes) this.automaticAnalyses.delete(hash);
    const match = (key: string): boolean => hashes.has(key);
    return { text: this.deps.ocr.withdraw(match), analysis: this.deps.analysis.withdraw(match) };
  }

  /**
   * Switched to "On demand": drops the analyses only the capture asked for (queued, or the result
   * of the running one) and keeps the ones the user asked for, in their place.
   */
  cancelAutomaticAnalysis(): string[] {
    const automatic = new Set(this.automaticAnalyses);
    this.automaticAnalyses.clear();
    return this.deps.analysis.withdraw((key) => automatic.has(key));
  }

  private async ingest(
    image: ImageHandle | null,
    origin: ImageOrigin,
    request: CaptureRequest,
  ): Promise<ImageCaptureOutcome> {
    if (!image) return { status: 'skipped', reason: 'unreadable' };
    const reason = imageSkipReason(image.width, image.height);
    if (reason) return { status: 'skipped', reason };

    const hash = await imageHashOffThread(image.width, image.height, image.bitmap());
    // From "is the file already there?" to the committed row, the sweep cannot touch this hash.
    const { stored, queue, wanted, generation } = await this.deps.locks.run(hash, async () => {
      const saved = await this.deps.store.save(hash, image);
      // Read at record time, after the waits for the lock and the save: a switch flipped during
      // them already applies to this row.
      const atRecord = this.wantedJobs();
      const recordedIn = { ...this.generation };
      return {
        stored: saved,
        wanted: atRecord,
        generation: recordedIn,
        queue: request.record ? request.record(saved, origin, atRecord) : saved.created,
      };
    });
    // Dispatch: the settings are read again, and a job is queued only in the generation its row
    // was recorded in. A cancel in between already ran `resume()`, which owns the row from then on.
    const now = this.wantedJobs();
    const dispatch: QueuedJobs = {
      text: queue && wanted.text && now.text && generation.text === this.generation.text,
      analysis:
        queue &&
        wanted.analysis &&
        now.analysis &&
        generation.analysis === this.generation.analysis,
    };
    const withdrawn: QueuedJobs = {
      text: queue && wanted.text && !now.text,
      analysis: queue && wanted.analysis && !now.analysis,
    };
    if (withdrawn.text || withdrawn.analysis) request.withdraw?.(stored, withdrawn);
    // Jobs carry only the hash and read the stored PNG when they start (see the class comment).
    const queued: QueuedJobs = {
      text: dispatch.text && this.enqueueOcr(hash),
      analysis: dispatch.analysis && this.enqueueAnalysis(hash, 'capture'),
    };
    const outcome = { status: 'captured', image: stored, origin, queued } as const;
    this.deps.onCaptured?.(outcome);
    return outcome;
  }

  /** Which jobs a new capture should get under the current settings and model state. */
  private wantedJobs(): QueuedJobs {
    const settings = this.deps.settings();
    return {
      text: settings.textRecognition,
      analysis: shouldAnalyze(settings.imageAnalysis, 'capture') && this.deps.analysisAvailable(),
    };
  }

  private enqueueOcr(hash: string): boolean {
    return this.deps.ocr.enqueue({ key: hash, load: () => this.ocrInput(hash) });
  }

  private enqueueAnalysis(hash: string, trigger: 'capture' | 'user'): boolean {
    if (
      !shouldAnalyze(this.deps.settings().imageAnalysis, trigger) ||
      !this.deps.analysisAvailable()
    )
      return false;
    const language = this.deps.analysisLanguage();
    const queued = this.deps.analysis.enqueue({
      key: hash,
      load: async () => ({ image: toAnalysisImage(await this.decodeStored(hash)), language }),
    });
    // Forget keys whose job has finished, so the set only ever holds queued or running work.
    for (const key of this.automaticAnalyses)
      if (!this.deps.analysis.has(key)) this.automaticAnalyses.delete(key);
    if (trigger === 'user') this.automaticAnalyses.delete(hash);
    else if (queued) this.automaticAnalyses.add(hash);
    return queued;
  }

  /** OCR input from the store: a large image goes as its stored PNG, without being decoded here. */
  private async ocrInput(hash: string): Promise<OcrImage> {
    const png = await this.deps.store.read(hash);
    const size = pngDimensions(png);
    if (size && ocrUpscaleFactor(size.width, size.height) === 1) return { png, ...size, scale: 1 };
    return toOcrImage(this.decode(png));
  }

  private async decodeStored(hash: string): Promise<ImageHandle> {
    return this.decode(await this.deps.store.read(hash));
  }

  private decode(png: Uint8Array): ImageHandle {
    const image = this.deps.decoder.decode(png);
    if (!image) throw new Error('Stored image cannot be decoded');
    return image;
  }

  private serial(task: () => Promise<ImageCaptureOutcome>): Promise<ImageCaptureOutcome> {
    const outcome = this.queue.then(task);
    this.queue = outcome.catch(() => undefined);
    return outcome;
  }
}

/** Runs an image source; an image it refused before decoding comes back as the `ImageSkip`. */
async function refusable(
  read: () => Promise<ImageHandle | null>,
): Promise<ImageHandle | null | ImageSkip> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ImageSkip) return error;
    throw error;
  }
}
