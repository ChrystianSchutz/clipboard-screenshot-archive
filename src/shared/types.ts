/**
 * Domain types shared by the main process, the preload bridge and the renderer.
 * Everything here must stay serialisable (structured-clone safe): it crosses the IPC boundary.
 */

import type { Category } from './categories';
import type { AnalysisLanguage } from './image-analysis';
import type { ImageAnalysisMode } from './image-settings';

/**
 * What a clip looks like, decided once at capture time (see `detectClipKind`). `image` is a
 * screenshot or copied picture: its `content` is a short label, the pixels live in the image store
 * and its text and analysis come from `ScreenshotDetails` (shared/screenshots.ts).
 */
export type ClipKind = 'json' | 'url' | 'code' | 'text' | 'image';

export const CLIP_KINDS: readonly ClipKind[] = ['json', 'url', 'code', 'text', 'image'];

/** Where a copy came from, as far as the OS lets us know. */
export interface ClipSource {
  /** Friendly application name, e.g. "VS Code". `null` when the owner could not be resolved. */
  readonly app: string | null;
  /** Executable file name, e.g. "Code.exe". */
  readonly exe: string | null;
  /** Page URL, when the copying app published one (Chromium does in CF_HTML). */
  readonly url: string | null;
}

/** One unique piece of text in the history. Copying the same text again bumps it instead of duplicating it. */
export interface Clip {
  readonly id: number;
  readonly content: string;
  readonly kind: ClipKind;
  readonly charCount: number;
  readonly lineCount: number;
  /** Epoch milliseconds. */
  readonly firstCopiedAt: number;
  /** Epoch milliseconds. */
  readonly lastCopiedAt: number;
  readonly copyCount: number;
  readonly pinned: boolean;
  /** Source of the most recent copy. */
  readonly source: ClipSource;
  /** Automatic categories (see `detectCategories`), in the fixed `CATEGORIES` order. */
  readonly categories: readonly Category[];
}

/** Characters of text a history row carries; the full text is fetched with `history:get`. */
export const CLIP_PREVIEW_CHARS = 2_000;

/** Characters the preview pane renders (and highlights); the full text is one Enter away. */
export const PREVIEW_PANE_CHARS = 20_000;

/**
 * Most clip ids one batch call (`history:delete-many`, `history:set-pinned-many`) accepts: the
 * largest history page main serves. The renderer splits a larger selection into batches.
 */
export const MAX_BATCH_IDS = 500;

/**
 * Most characters one composed clipboard write (`screenshot:copy-text`, `history:copy-many`)
 * accepts: the largest clip the archive records (`MAX_CLIP_CHARS`), so joining a few ordinary
 * clips always fits.
 */
export const MAX_COPY_TEXT_CHARS = 1_000_000;

/** What `history:copy-many` did. Image clips are never part of the joined text. */
export type CopyClipsResult =
  /** The text clips were joined (in the order asked) and put on the clipboard. */
  | { readonly status: 'copied'; readonly copied: number; readonly skippedImages: number }
  /** No text clip among the ids (only images, or all deleted meanwhile): nothing was written. */
  | { readonly status: 'nothing'; readonly skippedImages: number }
  /** The joined text would exceed `MAX_COPY_TEXT_CHARS`; decided before any text was read. */
  | { readonly status: 'too-large'; readonly chars: number };

/** Where a search matches a text: `[start, end)` in UTF-16 code units. */
export type MatchRange = readonly [start: number, end: number];

/**
 * A history row: everything about a clip except its full text, which can be megabytes.
 * Lists carry this; the preview pane fetches the full `Clip` on demand.
 */
export interface ClipSummary extends Omit<Clip, 'content'> {
  /** The start of the text, at most `CLIP_PREVIEW_CHARS` characters. */
  readonly preview: string;
  /**
   * Regex search only: where the pattern matches the row title, `firstLine(preview)`. Computed
   * in the search worker under its time budget, so the renderer never runs a user regex itself.
   */
  readonly titleMatches?: readonly MatchRange[];
}

/** Regex matches in a text (`history:regex-ranges`), or why there are none to show. */
export type RegexRangesResult =
  | { readonly ok: true; readonly ranges: readonly MatchRange[] }
  | { readonly ok: false; readonly error: string };

export type TimeRange = 'all' | '1h' | '24h' | '7d' | '30d';

export const TIME_RANGES: readonly TimeRange[] = ['all', '1h', '24h', '7d', '30d'];

export interface HistoryQuery {
  /** Plain substring (case-insensitive) or a regular expression when `regex` is true. */
  readonly text?: string;
  readonly regex?: boolean;
  /** Only clips copied at least once from this app (friendly name). */
  readonly app?: string;
  readonly kind?: ClipKind;
  readonly range?: TimeRange;
  readonly pinnedOnly?: boolean;
  /** Only clips tagged with this automatic category. */
  readonly category?: Category;
  /** Keyset pagination: return clips strictly older than this cursor. */
  readonly before?: HistoryCursor;
  readonly limit?: number;
}

export interface HistoryCursor {
  readonly lastCopiedAt: number;
  readonly id: number;
}

export interface HistoryPage {
  readonly clips: readonly ClipSummary[];
  /** Pass back as `before` to fetch the next page; `null` when there is nothing more. */
  readonly nextCursor: HistoryCursor | null;
}

export interface CountBy<K extends string | number = string> {
  readonly key: K;
  readonly count: number;
}

export interface HistoryStats {
  readonly totalClips: number;
  readonly totalCopies: number;
  readonly copiesToday: number;
  readonly totalChars: number;
  readonly pinnedClips: number;
  readonly topApps: readonly CountBy[];
  readonly topDomains: readonly CountBy[];
  readonly byKind: readonly CountBy<ClipKind>[];
  /** Clips per automatic category, most common first; categories without clips are left out. */
  readonly byCategory: readonly CountBy<Category>[];
  /** 24 entries, local hour of day 0..23. */
  readonly byHour: readonly CountBy<number>[];
  /** Last 14 local days, oldest first, key = YYYY-MM-DD. */
  readonly byDay: readonly CountBy[];
}

export interface Shortcuts {
  /** Electron accelerator, e.g. "CommandOrControl+Alt+V". */
  readonly openHistory: string;
  readonly compare: string;
}

export interface Settings {
  readonly captureEnabled: boolean;
  /**
   * macOS only: also import new screenshots macOS saves to its screenshot folder (Cmd+Shift+3/4/5
   * write files, not the clipboard). Off until the user opts in; the option is hidden elsewhere.
   */
  readonly importScreenshotFolder: boolean;
  readonly launchAtLogin: boolean;
  /** Unpinned clips beyond this count are pruned, oldest first. */
  readonly maxClips: number;
  /** Executable names that are never recorded (case-insensitive), e.g. "KeePassXC.exe". */
  readonly excludedApps: readonly string[];
  readonly shortcuts: Shortcuts;
  /** Colour theme: follow the OS, or force dark / light. */
  readonly theme: 'system' | 'dark' | 'light';
  /** Accent colour as `#rrggbb` (one of the presets in shared/theme.ts, or a custom colour). */
  readonly accentColor: string;
  /** Read the text of every captured image (Tesseract, local), so screenshots are searchable. */
  readonly textRecognition: boolean;
  /** Describe images and find objects in them (Mirage, local, needs a one-time model download). */
  readonly imageAnalysis: ImageAnalysisMode;
  /** Language of the image analysis; `null` follows the UI language. */
  readonly analysisLanguage: AnalysisLanguage | null;
}

/** Result of changing a setting that touches the OS (global shortcuts can be taken by another app). */
export type SettingsUpdateResult =
  | { readonly ok: true; readonly settings: Settings }
  | { readonly ok: false; readonly settings: Settings; readonly error: string };

/** State of the two-step "copy A, press shortcut, copy B, press shortcut" comparison. */
export type CompareState =
  | { readonly phase: 'waiting-for-b'; readonly left: CompareSide }
  | { readonly phase: 'ready'; readonly left: CompareSide; readonly right: CompareSide };

export interface CompareSide {
  readonly content: string;
  readonly capturedAt: number;
  readonly source: ClipSource;
}

export interface AppInfo {
  readonly version: string;
  readonly platform: 'win32' | 'darwin' | 'linux' | (string & {});
  /** Whether the OS can tell us which app owns the clipboard. Same as `capture.sourceDetection`. */
  readonly sourceDetection: boolean;
  /** What clipboard capture really does on this machine right now. */
  readonly capture: CaptureInfo;
  /** The OS can start the app at login (Windows, macOS); the option is hidden elsewhere. */
  readonly launchAtLoginSupported: boolean;
}

/** Which protections the active clipboard adapter can deliver (they differ per OS and mode). */
export interface CaptureCapabilities {
  /** The owning app (executable) and the page URL of a copy can be detected. */
  readonly sourceDetection: boolean;
  /** "Never record from" works: it needs the owning app of each copy. */
  readonly appExclusion: boolean;
  /** Content that password managers mark as private (or "exclude from history") is recognised. */
  readonly privateFormatDetection: boolean;
}

export interface CaptureInfo extends CaptureCapabilities {
  /**
   * How clipboard changes are noticed: OS events (Windows), polling (macOS, Linux, or the Windows
   * fallback when the event listener cannot be registered), or the in-memory E2E sandbox.
   */
  readonly mode: 'event' | 'polling' | 'sandbox';
}
