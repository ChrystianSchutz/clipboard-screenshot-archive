import { app, globalShortcut, ipcMain, nativeTheme, type IpcMainInvokeEvent } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { ImageAnalysis } from '@shared/image-analysis';
import type { InvokeChannel, SettingsPatch, View } from '@shared/ipc-contract';
import type { CaptureInfo, CompareSide, SettingsUpdateResult } from '@shared/types';
import { CaptureGate } from '../clipboard/capture-gate';
import { CaptureService, type CaptureOutcome } from '../clipboard/capture-service';
import {
  electronClipboard,
  electronClipboardFormats,
  electronImageFingerprint,
} from '../clipboard/electron-clipboard';
import { loadMacPasteboardCounter } from '../clipboard/mac/pasteboard';
import { MemoryClipboard, ScriptedSourceProbe } from '../clipboard/memory-clipboard';
import {
  nullSourceProbe,
  type ClipboardIO,
  type ClipboardWatcher,
  type ProbeResult,
  type SourceProbe,
} from '../clipboard/ports';
import {
  createMacScreenshotImport,
  type ScreenshotFolderImport,
} from '../clipboard/screenshot-folder-import';
import {
  PollingClipboardWatcher,
  Win32ClipboardWatcher,
  startWatcher,
} from '../clipboard/watchers';
import { loadWin32Clipboard } from '../clipboard/win32/user32';
import { Win32SourceProbe } from '../clipboard/win32/win32-source-probe';
import { CompareSession } from '../compare/compare-session';
import type { Errlog } from '../diagnostics/errlog';
import { createScreenshotFeature, type ScreenshotFeature } from '../images/screenshot-feature';
import { registerIpcHandlers, type InvokeHandlers } from '../ipc/register';
import { authorizeSender } from '../ipc/sender-policy';
import { RegexSearch, threadWorkerProcess } from '../search/regex-search';
import { isRegexQuery } from '../search/regex-task';
import createRegexWorker from '../search/regex-worker?nodeWorker';
import { ClipRepository } from '../storage/clip-repository';
import { openDatabase } from '../storage/database';
import { SettingsStore } from '../storage/settings-store';
import { isAppDocumentUrl } from './app-document';
import { APP_INDEX_URL, serveAppProtocol } from './app-protocol';
import { MemoryLoginItem, applyLoginItem, electronLoginItem } from './login-item';
import { installSecurityPolicies } from './security';
import { shutDown } from './shutdown';
import { ShortcutManager } from './shortcuts';
import { CaptureAcks, runOsCaptureCheck, runSmokeCheck } from './smoke';
import { AppTray } from './tray';
import { WindowManager, rendererDir } from './windows';

export interface AppOptions {
  readonly mainDir: string;
  readonly trayIconPath: string;
  readonly devServerUrl: string | undefined;
  readonly startHidden: boolean;
  /**
   * E2E sandbox: windows never appear on screen, no tray icon, no global shortcuts, and an
   * in-memory clipboard instead of the system one. A test run never disturbs the desktop.
   */
  readonly e2e: boolean;
  /**
   * Packaged-app smoke check (CI): real clipboard adapter, but hidden windows, no tray, no global
   * shortcuts and no capture (except the CI-only OS copy check); runs `runSmokeCheck`, writes its
   * report and exits.
   */
  readonly smoke: boolean;
  readonly errlog: Errlog;
}

/**
 * Composition root: builds every service once, wires them together and owns their lifetime.
 * Business rules live in the services; this class only connects them to Electron.
 */
export class ClipboardArchiveApp {
  private db: DatabaseSync | null = null;
  private regexSearch: RegexSearch | null = null;
  private watcher: ClipboardWatcher | null = null;
  private shortcuts: ShortcutManager | null = null;
  private tray: AppTray | null = null;
  private disposeIpc: (() => void) | null = null;
  private screenshotFeature: ScreenshotFeature | null = null;
  private screenshotFolder: ScreenshotFolderImport | null = null;
  /** Capture generation: bumped on pause, resume and shutdown so in-flight captures never commit. */
  private readonly captureGate = new CaptureGate();

  constructor(private readonly options: AppOptions) {}

  async start(): Promise<void> {
    const { errlog } = this.options;
    const { devServerUrl } = this.options;
    if (!devServerUrl) serveAppProtocol(rendererDir(this.options.mainDir));
    const documentUrl = devServerUrl ?? APP_INDEX_URL;
    // Nothing on screen or system-wide (tray, global shortcuts) in E2E and smoke runs.
    const quiet = this.options.e2e || this.options.smoke;

    const isAppUrl = (url: string): boolean => isAppDocumentUrl(url, documentUrl);
    installSecurityPolicies(isAppUrl);

    const dbPath = join(app.getPath('userData'), 'archive.sqlite');
    const db = openDatabase(dbPath);
    this.db = db;
    const repository = new ClipRepository(db);
    // User regexes never run on this thread: a worker with a read-only connection, under a budget.
    const regexSearch = new RegexSearch(() =>
      threadWorkerProcess(createRegexWorker({ workerData: { dbPath } }), (error) => {
        errlog.error(error, 'regex-worker');
      }),
    );
    this.regexSearch = regexSearch;
    const settingsStore = new SettingsStore(db);
    // Before any window exists, so the first paint already uses the chosen theme.
    // `prefers-color-scheme` in the renderer follows `themeSource`.
    nativeTheme.themeSource = settingsStore.get().theme;

    const windows = new WindowManager({
      preloadPath: join(this.options.mainDir, '../preload/index.cjs'),
      documentUrl,
      isPackaged: app.isPackaged,
      hideOnBlur: !quiet,
      headless: quiet,
    });

    const sandbox = this.options.e2e
      ? { io: new MemoryClipboard(), probe: new ScriptedSourceProbe() }
      : null;
    const io: ClipboardIO = sandbox?.io ?? electronClipboard;
    const platform = sandbox
      ? null
      : await this.createPlatformCapture(windows, () => io.readText());
    const probe = sandbox?.probe ?? platform?.probe ?? nullSourceProbe;
    const captureInfo = (): CaptureInfo => ({
      mode: this.watcher?.kind ?? 'sandbox',
      ...probe.capabilities,
    });

    // Screenshots: image clips with their recognised text and optional analysis.
    const screenshotFeature = createScreenshotFeature({
      db,
      clips: repository,
      settings: () => settingsStore.get(),
      mainDir: this.options.mainDir,
      sandbox: sandbox?.io ?? null,
      writeText: (text) => capture.writeWithoutRecording(text),
      writeMarked: (write) => capture.writeMarked(write),
      broadcast: {
        updated: (clipId) => windows.broadcast('screenshot:updated', clipId),
        modelState: (state) => windows.broadcast('screenshot:model-state', state),
        historyChanged: () => windows.broadcast('history:changed', undefined),
      },
      errlog,
    });
    this.screenshotFeature = screenshotFeature;
    const { screenshots } = screenshotFeature;

    const onRecorded = (_clip: unknown, created: boolean): void => {
      // A new clip may have pruned old ones, screenshots among them.
      if (created) screenshots.scheduleSweep();
      windows.broadcast('history:changed', undefined);
    };
    // CI only, opted in by scripts/smoke-packaged.mjs --capture: the smoke run captures the copies
    // the script makes on the runner's clipboard. Never on a developer's PC (CI must be set).
    const smokeCapture =
      this.options.smoke &&
      process.env.CI === 'true' &&
      process.env.CLIPBOARD_ARCHIVE_SMOKE_CAPTURE === '1';
    // The smoke check's per-change acknowledgments (outcome by clipboard sequence number).
    const acks = smokeCapture ? new CaptureAcks(app.getPath('userData')) : null;
    const capture = new CaptureService({
      io,
      probe,
      repository,
      settings: () => settingsStore.get(),
      images: screenshots,
      onRecorded,
      gate: this.captureGate,
      ...(acks
        ? {
            onHandled: (sequence: number | null, outcome: CaptureOutcome | 'error') =>
              acks.record(sequence, outcome),
          }
        : {}),
    });

    const compare = new CompareSession();
    const pressCompare = async (): Promise<void> => {
      // A or B is decided now, at press time; the read starts at once and may finish in any order.
      const press = compare.beginPress();
      const capturedAt = Date.now();
      let side: CompareSide | null = null;
      try {
        side = { ...(await capture.snapshot()), capturedAt };
      } finally {
        if (compare.completePress(press, side)) {
          windows.showCompare();
          windows.broadcast('compare:state', compare.current);
        }
      }
    };
    const runCompare = (): void => {
      pressCompare().catch((error: unknown) => errlog.error(error, 'compare:press'));
    };

    const showView = (view: View): void => windows.showPalette(view);

    // In quiet runs nothing is registered system-wide; E2E tests call the actions through hooks.
    const shortcutPort = quiet ? noopShortcutPort : globalShortcut;
    this.shortcuts = new ShortcutManager(shortcutPort, {
      openHistory: () => windows.togglePalette(),
      compare: runCompare,
    });
    // Quiet runs never touch the OS login items (E2E toggles the option on a real PC).
    const loginItem = quiet ? new MemoryLoginItem() : electronLoginItem(app, process.platform);
    // The OS registration is the truth: it can change outside the app (Task Manager, a reinstall).
    if (loginItem.supported && settingsStore.get().launchAtLogin !== loginItem.isEnabled()) {
      settingsStore.update({ launchAtLogin: loginItem.isEnabled() });
    }
    const initial = settingsStore.get();
    const registered = this.shortcuts.apply(initial.shortcuts);
    if (!registered.ok) errlog.error(new Error(registered.error), 'shortcuts:register');

    // macOS saves screenshots as files. Only when the user opts in ("Import screenshots from the
    // screenshot folder"), new ones are brought into the history; never in quiet runs.
    const syncScreenshotFolder = (): void => {
      const wanted =
        process.platform === 'darwin' && !quiet && settingsStore.get().importScreenshotFolder;
      if (!wanted) {
        this.screenshotFolder?.stop();
        this.screenshotFolder = null;
        return;
      }
      if (this.screenshotFolder) return;
      const folder = createMacScreenshotImport({
        settings: () => settingsStore.get(),
        gate: this.captureGate,
        captureFile: (file, copiedAt, canRecord) =>
          screenshots.captureFile(file, copiedAt, canRecord),
        prune: (maxClips) => repository.prune(maxClips),
        onRecorded,
        onError: (error) => errlog.error(error, 'screenshot-folder'),
      });
      this.screenshotFolder = folder;
      void folder.start();
    };

    const applySettings = (patch: SettingsPatch): SettingsUpdateResult => {
      const before = settingsStore.get();
      // The login item first: the setting is stored only once the OS has really changed.
      if (patch.launchAtLogin !== undefined) {
        const login = applyLoginItem(loginItem, patch.launchAtLogin);
        if (!login.ok) {
          this.tray?.update(before);
          windows.broadcast('settings:changed', before);
          return { ok: false, settings: before, error: login.error };
        }
      }
      let next = settingsStore.update(patch);
      // Pause or resume: a capture already in flight belongs to the old state and must not commit.
      if (patch.captureEnabled !== undefined && patch.captureEnabled !== before.captureEnabled) {
        this.captureGate.invalidate();
      }
      if (patch.importScreenshotFolder !== undefined) syncScreenshotFolder();

      if (patch.shortcuts && this.shortcuts) {
        const result = this.shortcuts.apply(next.shortcuts);
        if (!result.ok) {
          next = settingsStore.update({ shortcuts: before.shortcuts });
          this.tray?.update(next);
          windows.broadcast('settings:changed', next);
          return { ok: false, settings: next, error: result.error };
        }
      }
      if (patch.maxClips !== undefined && repository.prune(next.maxClips) > 0) {
        screenshots.scheduleSweep();
        windows.broadcast('history:changed', undefined);
      }
      if (
        patch.textRecognition !== undefined ||
        patch.imageAnalysis !== undefined ||
        patch.analysisLanguage !== undefined
      ) {
        screenshots.settingsChanged();
      }
      if (patch.theme !== undefined) nativeTheme.themeSource = next.theme;
      this.tray?.update(next);
      windows.broadcast('settings:changed', next);
      return { ok: true, settings: next };
    };

    if (!quiet) {
      this.tray = new AppTray(this.options.trayIconPath, loginItem.supported, {
        openHistory: () => showView('history'),
        openScreenshots: () => showView('screenshots'),
        openStats: () => showView('stats'),
        openSettings: () => showView('settings'),
        compare: runCompare,
        setCaptureEnabled: (enabled) => applySettings({ captureEnabled: enabled }),
        setLaunchAtLogin: (enabled) => applySettings({ launchAtLogin: enabled }),
        quit: () => app.quit(),
      });
      this.tray.update(initial);
    }

    const sideOf = (id: number): CompareSide => {
      const clip = repository.get(id);
      if (!clip) throw new Error(`Clip ${id} no longer exists`);
      return { content: clip.content, capturedAt: clip.lastCopiedAt, source: clip.source };
    };

    const handlers: InvokeHandlers = {
      'history:query': (query) =>
        isRegexQuery(query) ? regexSearch.query(query) : repository.query(query),
      'history:get': (id) => repository.get(id),
      'history:regex-ranges': (pattern, text) => regexSearch.ranges(pattern, text),
      'history:apps': () => repository.apps(),
      'history:restore': async (id) => {
        const clip = repository.get(id);
        if (!clip) return;
        if (clip.kind === 'image') {
          await screenshots.restore(id); // touches the clip and announces the change itself
          return;
        }
        await capture.writeWithoutRecording(clip.content);
        repository.touch(id);
        windows.broadcast('history:changed', undefined);
      },
      'history:delete': (ids) => {
        const removed = repository.delete(ids);
        if (removed > 0) {
          screenshots.scheduleSweep();
          windows.broadcast('history:changed', undefined);
        }
        return removed;
      },
      'history:clear': (options) => {
        const removed = repository.clear(options);
        screenshots.scheduleSweep();
        windows.broadcast('history:changed', undefined);
        return removed;
      },
      'history:set-pinned': (id, pinned) => {
        repository.setPinned(id, pinned);
        windows.broadcast('history:changed', undefined);
      },
      ...screenshotFeature.handlers,
      'stats:get': () => repository.stats(),
      'settings:get': () => settingsStore.get(),
      'settings:update': applySettings,
      'compare:open-clips': (leftId, rightId) => {
        const state = compare.set(sideOf(leftId), sideOf(rightId));
        windows.showCompare();
        windows.broadcast('compare:state', state);
      },
      'compare:get-state': () => compare.current,
      'compare:reset': () => {
        compare.reset();
        windows.broadcast('compare:state', null);
      },
      // Hides the window that asked (Escape in Compare closes Compare, not the palette).
      'window:hide': ({ role }) => {
        windows.hide(role);
      },
      'app:info': () => {
        const capture = captureInfo();
        return {
          version: app.getVersion(),
          platform: this.reportedPlatform(),
          sourceDetection: capture.sourceDetection,
          capture,
          launchAtLoginSupported: loginItem.supported,
        };
      },
      'diagnostics:report-error': (report) => {
        const error = Object.assign(new Error(report.message), { stack: report.stack });
        errlog.error(error, report.where, 'renderer');
      },
    };

    const authorize = (event: IpcMainInvokeEvent, channel: InvokeChannel) => {
      const frame = event.senderFrame;
      const sender = {
        role: windows.roleOf(event.sender),
        frameUrl: frame?.url ?? null,
        isMainFrame: frame !== null && frame === event.sender.mainFrame,
      };
      return authorizeSender(sender, channel, isAppUrl);
    };
    this.disposeIpc = registerIpcHandlers(ipcMain, handlers, authorize);

    const onClipboardChange = (generation?: number): void => {
      // The smoke check never reads the user's clipboard (unless the CI capture check asks).
      if (this.options.smoke && !smokeCapture) return;
      capture.handleChange(generation).catch((error: unknown) => {
        errlog.error(error, 'capture:handleChange');
      });
    };
    // If the Win32 listener cannot be registered, poll instead of silently recording nothing.
    this.watcher =
      platform &&
      startWatcher(platform.watcher, platform.fallback, onClipboardChange, (error) =>
        errlog.error(error, 'watcher:start'),
      );

    syncScreenshotFolder();

    if (sandbox) {
      exposeTestHooks({
        pressCompare,
        /** Simulates another app copying: write, then the change notification. */
        copy: async (text, source) => {
          sandbox.probe.setNext(source ?? {});
          await sandbox.io.writeText(text);
          await capture.handleChange();
        },
        readClipboard: () => sandbox.io.readText(),
        /** Simulates a screenshot tool copying an image (no text). */
        copyImage: async (pngBase64, source) => {
          sandbox.probe.setNext(source ?? {});
          await sandbox.io.writeImage(Buffer.from(pngBase64, 'base64'));
          await capture.handleChange();
        },
        readClipboardImage: async () => {
          const png = await sandbox.io.readImage();
          return png ? Buffer.from(png).toString('base64') : null;
        },
        injectAnalysis: (clipId, analysis) => screenshotFeature.injectAnalysis(clipId, analysis),
        injectTextFailure: (clipId) => screenshotFeature.injectTextFailure(clipId),
      });
    }

    app.on('second-instance', () => showView('history'));
    app.on('before-quit', () => windows.prepareToQuit());

    if (!this.options.startHidden) windows.palette.once('ready-to-show', () => showView('history'));

    if (this.options.smoke) {
      const report = await runSmokeCheck({
        renderer: windows.palette.webContents,
        capture: captureInfo(),
        version: app.getVersion(),
        reportPath: join(app.getPath('userData'), 'smoke-report.json'),
        recognizeText: (png) => screenshotFeature.recognizeText(png),
        osCapture: acks
          ? () =>
              runOsCaptureCheck({
                dir: app.getPath('userData'),
                hasClip: (text) =>
                  repository.query({ text, limit: 5 }).clips.some((clip) => clip.preview === text),
                acks,
              })
          : undefined,
      });
      this.stop();
      app.exit(report.ok ? 0 : 1);
    }
  }

  /**
   * The platform the renderer is told about. E2E sandbox only, `CLIPBOARD_ARCHIVE_E2E_PLATFORM`
   * can name another one, so platform-specific settings (the macOS screenshot-folder option) can
   * be rendered and tested on any machine; it changes nothing but what the renderer shows.
   */
  private reportedPlatform(): NodeJS.Platform {
    const override = process.env.CLIPBOARD_ARCHIVE_E2E_PLATFORM;
    if (
      this.options.e2e &&
      (override === 'darwin' || override === 'linux' || override === 'win32')
    ) {
      return override;
    }
    return process.platform;
  }

  stop(): void {
    // Shutdown: the gate closes for good first, so a capture still in flight (an outstanding poll,
    // a folder file still settling) never writes to the database being closed.
    shutDown(this.captureGate, [
      () => this.shortcuts?.unregisterAll(),
      () => this.watcher?.stop(),
      () => this.screenshotFolder?.stop(),
      () => this.disposeIpc?.(),
      () => this.tray?.destroy(),
      () => void this.regexSearch?.dispose(),
      () => void this.screenshotFeature?.dispose(),
      () => {
        this.db?.close();
        this.db = null;
      },
    ]);
  }

  /**
   * Event-driven capture with source detection on Windows; polling elsewhere. `fallback` is the
   * poller used when the primary watcher cannot start.
   *
   * Exact change detection (a native counter, nothing read per poll, every change counts):
   * Windows (`WM_CLIPBOARDUPDATE`, or `GetClipboardSequenceNumber` polling if the listener fails)
   * and macOS (`NSPasteboard.changeCount` polling; the same counter versions each capture, like
   * the Win32 sequence number). Fallback fingerprint (format list, write marker, text hash, and a
   * backed-off image probe; see `PollingClipboardWatcher`): Linux, other platforms, and macOS if
   * the counter cannot be loaded.
   */
  private async createPlatformCapture(
    windows: WindowManager,
    readText: () => Promise<string>,
  ): Promise<{
    probe: SourceProbe;
    watcher: ClipboardWatcher;
    fallback: () => ClipboardWatcher;
  }> {
    // Every poller takes the capture generation when a poll begins (see `PollingSignals`).
    const generation = (): number => this.captureGate.current;
    if (process.platform === 'darwin') {
      const changeCount = await loadMacPasteboardCounter();
      if (changeCount) {
        const poller = (): ClipboardWatcher =>
          new PollingClipboardWatcher(readText, undefined, {
            changeCounter: changeCount,
            generation,
          });
        // No owner facts on macOS, but every read is bound to the pasteboard version.
        const probe: SourceProbe = { ...nullSourceProbe, sequenceNumber: changeCount };
        return { probe, watcher: poller(), fallback: poller };
      }
      this.options.errlog.error(
        new Error('NSPasteboard changeCount unavailable; using the fallback fingerprint'),
        'mac:pasteboard',
      );
    }
    // Without a version counter: format list, write marker and text on every poll; the image
    // bytes only at a backed-off rate (see `PollingClipboardWatcher`).
    const portablePoller = (): ClipboardWatcher =>
      new PollingClipboardWatcher(readText, undefined, {
        formats: electronClipboardFormats,
        writeMarker: () => electronClipboard.readWriteMarker(),
        imageFingerprint: electronImageFingerprint,
        generation,
      });
    if (process.platform === 'win32') {
      try {
        const native = await loadWin32Clipboard();
        return {
          probe: new Win32SourceProbe(native),
          watcher: new Win32ClipboardWatcher(windows.palette, native),
          fallback: () =>
            new PollingClipboardWatcher(readText, undefined, {
              changeCounter: () => native.sequenceNumber(),
              generation,
            }),
        };
      } catch (error) {
        this.options.errlog.error(error, 'win32:load');
      }
    }
    return { probe: nullSourceProbe, watcher: portablePoller(), fallback: portablePoller };
  }
}

const noopShortcutPort = { register: () => true, unregister: () => undefined };

/** What Playwright can call in the main process (it cannot press system-wide shortcuts). */
interface TestHooks {
  pressCompare(): Promise<void>;
  copy(text: string, source?: Partial<ProbeResult>): Promise<void>;
  readClipboard(): Promise<string>;
  copyImage(pngBase64: string, source?: Partial<ProbeResult>): Promise<void>;
  /** The sandbox clipboard's image as base64 PNG, or null when it holds none. */
  readClipboardImage(): Promise<string | null>;
  injectAnalysis(clipId: number, analysis: ImageAnalysis): boolean;
  injectTextFailure(clipId: number): boolean;
}

function exposeTestHooks(hooks: TestHooks): void {
  (globalThis as { __clipboardArchiveTest?: typeof hooks }).__clipboardArchiveTest = hooks;
}
