/**
 * Hand-written test doubles for the main-process ports.
 *
 * They are deliberately small and explicit: each one records what the code under test did, and
 * exposes knobs (current clipboard text, probe result, taken shortcuts) instead of mocking libraries.
 */
import { vi } from 'vitest';
import type { ClipboardIO, ProbeResult, SourceProbe } from '../clipboard/ports';
import type { CaptureRepository } from '../clipboard/capture-service';
import type { RecordInput, RecordResult } from '../storage/clip-repository';
import type { GlobalShortcutPort } from '../app/shortcuts';
import type { Clip, ClipSource, CompareSide, Settings } from '@shared/types';
import { DEFAULT_SETTINGS } from '../storage/settings-store';

/** A promise whose outcome the test decides later. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * In-memory system clipboard. `readText` resolves with whatever `text` holds at call time.
 * Assigning `text` directly models another app copying: it replaces the whole clipboard, so the
 * app's write marker is gone. `writeText` with a marker models the app's own marked write.
 */
export class FakeClipboard implements ClipboardIO {
  private current = '';
  /** The write marker token on the clipboard (the app's own writes), or null. */
  marker: string | null = null;
  get text(): string {
    return this.current;
  }
  set text(value: string) {
    this.current = value;
    this.marker = null;
  }
  readonly readText = vi.fn<() => Promise<string>>(() => Promise.resolve(this.current));
  readonly writeText = vi.fn<(text: string, marker?: string) => Promise<void>>((text, marker) => {
    this.current = text;
    this.marker = marker ?? null;
    return Promise.resolve();
  });
  readonly readWriteMarker = vi.fn<() => Promise<string | null>>(() =>
    Promise.resolve(this.marker),
  );
}

/** Source probe that returns `result`; change it between calls to simulate another owner. */
export class FakeSourceProbe implements SourceProbe {
  readonly capabilities = {
    sourceDetection: true,
    appExclusion: true,
    privateFormatDetection: true,
  };
  result: ProbeResult = { exe: null, url: null, hasPrivateFormat: false };
  /** Clipboard version; `null` behaves like a platform without one. */
  sequence: number | null = null;
  readonly probe = vi.fn<() => ProbeResult>(() => this.result);
  readonly sequenceNumber = vi.fn<() => number | null>(() => this.sequence);
}

/**
 * Minimal repository with the real "same text bumps, new text creates" semantics, so capture
 * tests can assert on behaviour without a database.
 */
export class FakeCaptureRepository implements CaptureRepository {
  readonly records: RecordInput[] = [];
  private readonly clips = new Map<string, Clip>();
  private nextId = 1;

  readonly record = vi.fn<(input: RecordInput) => RecordResult>((input) => {
    this.records.push(input);
    const existing = this.clips.get(input.content);
    const clip: Clip = existing
      ? {
          ...existing,
          lastCopiedAt: input.copiedAt,
          copyCount: existing.copyCount + 1,
          source: input.source,
        }
      : {
          id: this.nextId++,
          content: input.content,
          kind: input.kind,
          charCount: input.content.length,
          lineCount: 1,
          firstCopiedAt: input.copiedAt,
          lastCopiedAt: input.copiedAt,
          copyCount: 1,
          pinned: false,
          source: input.source,
          categories: input.categories,
        };
    this.clips.set(input.content, clip);
    return { clip, created: existing === undefined };
  });

  readonly prune = vi.fn<(maxClips: number) => number>(() => 0);
}

/**
 * Stand-in for Electron's `globalShortcut`. Accelerators in `taken` are refused (another app owns
 * them), accelerators in `malformed` throw like Electron does for unparsable strings.
 */
export class FakeGlobalShortcut implements GlobalShortcutPort {
  readonly registered = new Map<string, () => void>();
  readonly taken = new Set<string>();
  readonly malformed = new Set<string>();

  readonly register = vi.fn<(accelerator: string, callback: () => void) => boolean>(
    (accelerator, callback) => {
      if (this.malformed.has(accelerator)) throw new TypeError(`Error processing argument`);
      if (this.taken.has(accelerator) || this.registered.has(accelerator)) return false;
      this.registered.set(accelerator, callback);
      return true;
    },
  );

  readonly unregister = vi.fn<(accelerator: string) => void>((accelerator) => {
    this.registered.delete(accelerator);
  });

  get accelerators(): string[] {
    return [...this.registered.keys()].sort();
  }
}

export function settingsWith(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

export function source(overrides: Partial<ClipSource> = {}): ClipSource {
  return { app: null, exe: null, url: null, ...overrides };
}

export function compareSide(content: string, capturedAt = 0): CompareSide {
  return { content, capturedAt, source: source() };
}
