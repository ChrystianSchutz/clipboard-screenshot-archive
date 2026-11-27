import type { CaptureCapabilities } from '@shared/types';

/**
 * Ports between the capture logic and the outside world (Electron, Win32).
 * The capture service depends only on these interfaces, so tests drive it with plain fakes.
 */

/** Text access to the system clipboard (Electron 45's async, W3C-style clipboard API). */
export interface ClipboardIO {
  readText(): Promise<string>;
  /**
   * Writes text. With `marker`, the app's write marker (see `WRITE_MARKER_FORMAT`) carrying that
   * token is committed in the same write, so the change it causes can be recognised as the app's.
   */
  writeText(text: string, marker?: string): Promise<void>;
  /**
   * The token of the app's write marker on the clipboard, or `null` when there is none (any copy
   * made by another app) or it cannot be read. Never rejects.
   */
  readWriteMarker(): Promise<string | null>;
}

/**
 * Facts about who put the current content on the clipboard. Synchronous on purpose: it must run
 * right after the change notification, before another app can take the clipboard over.
 */
export interface SourceProbe {
  readonly capabilities: CaptureCapabilities;
  probe(): ProbeResult;
  /**
   * The OS clipboard version (Win32 `GetClipboardSequenceNumber`), or `null` where the OS has none.
   * Lets the capture service prove that the text it read belongs to the probed owner.
   */
  sequenceNumber(): number | null;
}

export interface ProbeResult {
  /** Executable name of the owning process, e.g. "Code.exe". */
  readonly exe: string | null;
  /** Page URL the copying app attached (Chromium writes it into CF_HTML). */
  readonly url: string | null;
  /**
   * The owner marked the content as private (password managers do). Also `true` when the markers
   * could not be read (`privacyUnreadable`), so code that only looks at this flag fails closed.
   */
  readonly hasPrivateFormat: boolean;
  /**
   * The privacy markers could not be read (e.g. another app held the clipboard open), so the
   * content may or may not be private. The capture service probes again, against the same
   * clipboard version, and drops the change if the answer stays unknown.
   */
  readonly privacyUnreadable?: boolean;
}

/** Tells us when the clipboard changes. */
export interface ClipboardWatcher {
  readonly kind: 'event' | 'polling';
  /**
   * `onChange` may get the capture generation (`CaptureGate.current`) taken when the look that
   * found the change began (the polling watcher); without it the generation at report time counts.
   */
  start(onChange: (generation?: number) => void): void;
  stop(): void;
}

/** Used where the OS cannot tell us who owns the clipboard (macOS, Linux). */
export const nullSourceProbe: SourceProbe = {
  capabilities: { sourceDetection: false, appExclusion: false, privateFormatDetection: false },
  probe: () => ({ exe: null, url: null, hasPrivateFormat: false }),
  sequenceNumber: () => null,
};
