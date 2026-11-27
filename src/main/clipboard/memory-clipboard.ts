import type { ClipboardIO, ProbeResult, SourceProbe } from './ports';

/**
 * In-memory stand-ins for the system clipboard, used by the E2E sandbox.
 *
 * End-to-end tests drive the real app (real windows, IPC, SQLite, React), but swap the two
 * OS-facing ports for these. Tests then never overwrite the developer's clipboard, never race
 * other apps for it, and run the same on every OS and in parallel.
 */
export class MemoryClipboard implements ClipboardIO {
  private text = '';
  /** PNG bytes; like the system clipboard, a copy holds text or an image, and replaces both. */
  private image: Uint8Array | null = null;
  /**
   * The app's write marker token (`WRITE_MARKER_FORMAT`), committed in the same write as the text
   * or image and replaced by every later write, like a custom format on the system clipboard.
   */
  private marker: string | null = null;

  readText(): Promise<string> {
    return Promise.resolve(this.text);
  }

  writeText(text: string, marker?: string): Promise<void> {
    this.text = text;
    this.image = null;
    this.marker = marker ?? null;
    return Promise.resolve();
  }

  readWriteMarker(): Promise<string | null> {
    return Promise.resolve(this.marker);
  }

  readImage(): Promise<Uint8Array | null> {
    return Promise.resolve(this.image);
  }

  writeImage(png: Uint8Array, marker?: string): Promise<void> {
    this.image = png;
    this.text = '';
    this.marker = marker ?? null;
    return Promise.resolve();
  }
}

/** Reports whatever source the test says the next copy came from. */
export class ScriptedSourceProbe implements SourceProbe {
  /** Stands in for the Windows probe, so the sandbox offers every protection. */
  readonly capabilities = {
    sourceDetection: true,
    appExclusion: true,
    privateFormatDetection: true,
  };
  private next: ProbeResult = { exe: null, url: null, hasPrivateFormat: false };

  setNext(result: Partial<ProbeResult>): void {
    this.next = { exe: null, url: null, hasPrivateFormat: false, ...result };
  }

  probe(): ProbeResult {
    return this.next;
  }

  /** The in-memory clipboard has no version counter; tests copy one change at a time. */
  sequenceNumber(): null {
    return null;
  }
}
