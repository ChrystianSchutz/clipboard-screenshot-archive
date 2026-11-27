import type {
  AppInfo,
  Clip,
  CompareState,
  CopyClipsResult,
  HistoryPage,
  HistoryQuery,
  HistoryStats,
  RegexRangesResult,
  Settings,
  SettingsUpdateResult,
} from './types';
import type { AnalysisModelState, ScreenshotDetails } from './screenshots';

/**
 * Single source of truth for every IPC channel.
 *
 * Main registers one handler per `InvokeChannels` key, the preload exposes one typed method per key,
 * and TypeScript fails the build if the three ever drift apart. The renderer never sees raw
 * `ipcRenderer`: only the narrow `ClipboardArchiveApi` facade below. Channels without a value
 * declare `result: undefined`: that is what actually arrives in the renderer.
 */
export interface InvokeChannels {
  /** Rows carry metadata and a short preview (`ClipSummary`), never the full text. */
  'history:query': { args: [query: HistoryQuery]; result: HistoryPage };
  /** The full clip, for the preview pane; `null` when it was deleted meanwhile. */
  'history:get': { args: [id: number]; result: Clip | null };
  /** Regex matches in a text (the preview pane's body), computed in the search worker. */
  'history:regex-ranges': { args: [pattern: string, text: string]; result: RegexRangesResult };
  'history:apps': { args: []; result: string[] };
  'history:restore': { args: [id: number]; result: undefined };
  /** Deletes one clip; the result is how many were removed (0 when it was already gone). */
  'history:delete': { args: [id: number]; result: number };
  /**
   * Deletes a multi-selection in one transaction: 1 to `MAX_BATCH_IDS` distinct ids. The result
   * is how many were removed (ids that no longer exist are skipped).
   */
  'history:delete-many': { args: [ids: number[]]; result: number };
  /**
   * Copies the text clips among `ids` as one text, joined in the given order (images skipped),
   * without recording it as a new clip. Same id rules as `history:delete-many`.
   */
  'history:copy-many': { args: [ids: number[]]; result: CopyClipsResult };
  'history:clear': { args: [options: { keepPinned: boolean }]; result: number };
  'history:set-pinned': { args: [id: number, pinned: boolean]; result: undefined };
  /** Pins or unpins a multi-selection in one transaction; same id rules as `history:delete-many`. */
  'history:set-pinned-many': { args: [ids: number[], pinned: boolean]; result: number };
  'stats:get': { args: []; result: HistoryStats };
  'settings:get': { args: []; result: Settings };
  'settings:update': { args: [patch: SettingsPatch]; result: SettingsUpdateResult };
  'compare:open-clips': { args: [leftId: number, rightId: number]; result: undefined };
  'compare:get-state': { args: []; result: CompareState | null };
  'compare:reset': { args: []; result: undefined };
  'window:hide': { args: []; result: undefined };
  'app:info': { args: []; result: AppInfo };
  'diagnostics:report-error': { args: [report: ClientErrorReport]; result: undefined };
  /** Size, recognised text and analysis of an image clip; `null` when it is not one. */
  'screenshot:details': { args: [clipId: number]; result: ScreenshotDetails | null };
  /**
   * Puts text on the clipboard without recording it: a line or all text read from a screenshot,
   * or the joined text of a multi-selection. Up to `MAX_COPY_TEXT_CHARS` characters.
   */
  'screenshot:copy-text': { args: [text: string]; result: undefined };
  /** The "Analyze" button; `false` when analysis is off or the model is not downloaded. */
  'screenshot:analyze': { args: [clipId: number]; result: boolean };
  /** "Retry" on a screenshot whose text could not be read; `false` when recognition is off. */
  'screenshot:retry-text': { args: [clipId: number]; result: boolean };
  'screenshot:model-state': { args: []; result: AnalysisModelState };
  /** Starts the one-time model download (progress arrives as `screenshot:model-state` events). */
  'screenshot:download-model': { args: []; result: AnalysisModelState };
  'screenshot:cancel-download': { args: []; result: undefined };
}

/** Main → renderer push messages. */
export interface EventChannels {
  'history:changed': undefined;
  'compare:state': CompareState | null;
  'view:show': View;
  /** Sent to every window after any settings change, so all windows share theme and accent. */
  'settings:changed': Settings;
  /** Text recognition or analysis of this image clip finished (or failed). */
  'screenshot:updated': number;
  'screenshot:model-state': AnalysisModelState;
}

export type InvokeChannel = keyof InvokeChannels;
export type EventChannel = keyof EventChannels;
export type InvokeArgs<C extends InvokeChannel> = InvokeChannels[C]['args'];
export type InvokeResult<C extends InvokeChannel> = InvokeChannels[C]['result'];

export type View = 'history' | 'screenshots' | 'stats' | 'settings';

export interface SettingsPatch {
  readonly captureEnabled?: boolean;
  readonly importScreenshotFolder?: boolean;
  readonly launchAtLogin?: boolean;
  readonly maxClips?: number;
  readonly excludedApps?: readonly string[];
  readonly shortcuts?: Partial<Settings['shortcuts']>;
  readonly theme?: Settings['theme'];
  readonly accentColor?: string;
  readonly textRecognition?: boolean;
  readonly imageAnalysis?: Settings['imageAnalysis'];
  readonly analysisLanguage?: Settings['analysisLanguage'];
}

/** What the renderer reports about its own crashes. Never contains clipboard content. */
export interface ClientErrorReport {
  readonly message: string;
  readonly stack?: string;
  readonly where: string;
}

type Unsubscribe = () => void;

/** The API the preload exposes on `window.clipboardArchive`. */
export interface ClipboardArchiveApi {
  readonly history: {
    query(query: HistoryQuery): Promise<HistoryPage>;
    get(id: number): Promise<Clip | null>;
    regexRanges(pattern: string, text: string): Promise<RegexRangesResult>;
    apps(): Promise<string[]>;
    restore(id: number): Promise<void>;
    remove(id: number): Promise<number>;
    removeMany(ids: number[]): Promise<number>;
    copyMany(ids: number[]): Promise<CopyClipsResult>;
    clear(options: { keepPinned: boolean }): Promise<number>;
    setPinned(id: number, pinned: boolean): Promise<void>;
    setPinnedMany(ids: number[], pinned: boolean): Promise<number>;
    onChanged(listener: () => void): Unsubscribe;
  };
  readonly stats: {
    get(): Promise<HistoryStats>;
  };
  readonly settings: {
    get(): Promise<Settings>;
    update(patch: SettingsPatch): Promise<SettingsUpdateResult>;
    onChanged(listener: (settings: Settings) => void): Unsubscribe;
  };
  readonly compare: {
    openClips(leftId: number, rightId: number): Promise<void>;
    getState(): Promise<CompareState | null>;
    reset(): Promise<void>;
    onState(listener: (state: CompareState | null) => void): Unsubscribe;
  };
  readonly window: {
    hide(): Promise<void>;
    onShowView(listener: (view: View) => void): Unsubscribe;
  };
  readonly app: {
    info(): Promise<AppInfo>;
    reportError(report: ClientErrorReport): Promise<void>;
  };
  /** Image clips: text layer, analysis and the optional analysis model. */
  readonly screenshots: {
    details(clipId: number): Promise<ScreenshotDetails | null>;
    copyText(text: string): Promise<void>;
    analyze(clipId: number): Promise<boolean>;
    retryText(clipId: number): Promise<boolean>;
    modelState(): Promise<AnalysisModelState>;
    downloadModel(): Promise<AnalysisModelState>;
    cancelDownload(): Promise<void>;
    onUpdated(listener: (clipId: number) => void): Unsubscribe;
    onModelState(listener: (state: AnalysisModelState) => void): Unsubscribe;
  };
}
