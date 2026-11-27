import {
  BrowserWindow,
  nativeTheme,
  screen,
  session,
  type Session,
  type WebContents,
} from 'electron';
import { join } from 'node:path';
import type { EventChannel, EventChannels, View } from '@shared/ipc-contract';
import { WINDOW_COLORS } from '@shared/theme';

export type WindowRole = 'palette' | 'compare';

/**
 * The compare window runs in its own in-memory session; the palette uses the default session.
 *
 * Window roles are enforced for IPC by `sender-policy.ts`, but protocol handlers are registered
 * per session and cannot see which window asked. With its own session the compare window simply
 * has no `clip-image:` handler that serves pixels (see `serveScreenshotProtocol`), so screenshots
 * stay with the palette, like the screenshot IPC channels.
 */
export const COMPARE_PARTITION = 'compare';

let compareSessionReady: Session | null = null;

/** The compare window's session, with the same deny-all permission policy as the default one. */
export function compareSession(): Session {
  if (compareSessionReady) return compareSessionReady;
  const compare = session.fromPartition(COMPARE_PARTITION);
  compare.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  compare.setPermissionCheckHandler(() => false);
  compareSessionReady = compare;
  return compare;
}

export interface WindowManagerOptions {
  readonly preloadPath: string;
  /** The renderer document: the dev server page, or `app://bundle/index.html` (app-protocol.ts). */
  readonly documentUrl: string;
  readonly isPackaged: boolean;
  /** The palette hides when it loses focus, like a launcher. Disabled in E2E runs. */
  readonly hideOnBlur: boolean;
  /**
   * Windows are created and rendered but never shown on screen (E2E runs). They keep painting and
   * running timers, so Playwright can drive and screenshot them without touching the desktop.
   */
  readonly headless: boolean;
}

/** Sends a typed main → renderer event. */
export function send<E extends EventChannel>(
  contents: WebContents,
  channel: E,
  payload: EventChannels[E],
): void {
  if (!contents.isDestroyed()) contents.send(channel, payload);
}

/**
 * Owns the two windows:
 * - **palette**: frameless, always-on-top history launcher. Created hidden at startup and kept
 *   alive, so the shortcut shows it instantly (and so it can host the clipboard listener HWND).
 * - **compare**: the diff window, created on first use, with a native title bar overlay.
 */
export class WindowManager {
  readonly palette: BrowserWindow;
  private compare: BrowserWindow | null = null;
  private quitting = false;

  constructor(private readonly options: WindowManagerOptions) {
    this.palette = this.createPalette();
    nativeTheme.on('updated', () => this.applyTheme());
  }

  /** Lets windows close for real (otherwise closing only hides them). */
  prepareToQuit(): void {
    this.quitting = true;
  }

  showPalette(view?: View): void {
    const win = this.palette;
    if (!this.options.headless) {
      if (!win.isVisible()) centerOnCursorDisplay(win, 0.16);
      win.show();
      win.focus();
    }
    if (view) send(win.webContents, 'view:show', view);
  }

  togglePalette(): void {
    if (this.palette.isVisible() && this.palette.isFocused()) this.palette.hide();
    else this.showPalette('history');
  }

  /** Hides the window that plays `role`, e.g. the one whose renderer pressed Escape. */
  hide(role: WindowRole): void {
    const win = role === 'palette' ? this.palette : this.compare;
    if (win && !win.isDestroyed()) win.hide();
  }

  showCompare(): BrowserWindow {
    const win = this.compare && !this.compare.isDestroyed() ? this.compare : this.createCompare();
    this.compare = win;
    if (this.options.headless) return win;
    if (!win.isVisible()) centerOnCursorDisplay(win, 0.1);
    win.showInactive();
    win.focus();
    return win;
  }

  /** Broadcasts an event to every live window. */
  broadcast<E extends EventChannel>(channel: E, payload: EventChannels[E]): void {
    for (const win of BrowserWindow.getAllWindows()) send(win.webContents, channel, payload);
  }

  roleOf(contents: WebContents): WindowRole | null {
    if (contents === this.palette.webContents) return 'palette';
    if (this.compare && !this.compare.isDestroyed() && contents === this.compare.webContents) {
      return 'compare';
    }
    return null;
  }

  private createPalette(): BrowserWindow {
    const win = new BrowserWindow({
      width: 820,
      height: 560,
      minWidth: 560,
      minHeight: 380,
      show: false,
      frame: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      fullscreenable: false,
      backgroundColor: background(),
      title: 'Clipboard & Screenshot Archive',
      webPreferences: this.webPreferences(),
    });
    win.setAlwaysOnTop(true, 'floating');
    this.preventClose(win);
    if (this.options.hideOnBlur) {
      win.on('blur', () => {
        if (!win.webContents.isDevToolsOpened()) win.hide();
      });
    }
    this.load(win, 'palette');
    return win;
  }

  private createCompare(): BrowserWindow {
    const win = new BrowserWindow({
      width: 1040,
      height: 680,
      minWidth: 640,
      minHeight: 400,
      show: false,
      alwaysOnTop: true,
      backgroundColor: background(),
      title: 'Clipboard & Screenshot Archive – Compare',
      titleBarStyle: 'hidden',
      ...(process.platform === 'darwin' ? {} : { titleBarOverlay: titleBarOverlay() }),
      webPreferences: { ...this.webPreferences(), session: compareSession() },
    });
    this.preventClose(win);
    this.load(win, 'compare');
    return win;
  }

  private webPreferences(): Electron.WebPreferences {
    return {
      preload: this.options.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !this.options.isPackaged,
      // A never-shown window would otherwise be throttled like a background tab.
      backgroundThrottling: !this.options.headless,
    };
  }

  private load(win: BrowserWindow, role: WindowRole): void {
    void win.loadURL(`${this.options.documentUrl}#${role}`);
  }

  private preventClose(win: BrowserWindow): void {
    win.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      win.hide();
    });
  }

  private applyTheme(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.setBackgroundColor(background());
      if (win === this.compare && process.platform !== 'darwin') {
        win.setTitleBarOverlay(titleBarOverlay());
      }
    }
  }
}

export function rendererDir(mainDir: string): string {
  return join(mainDir, '../renderer');
}

/** Window colours of the active theme (mirrors the CSS tokens, see shared/theme.ts). */
function colors(): (typeof WINDOW_COLORS)[keyof typeof WINDOW_COLORS] {
  return nativeTheme.shouldUseDarkColors ? WINDOW_COLORS.dark : WINDOW_COLORS.light;
}

function background(): string {
  return colors().background;
}

function titleBarOverlay(): Electron.TitleBarOverlayOptions {
  return {
    color: colors().titleBar,
    symbolColor: colors().symbol,
    // Matches `.compare__titlebar` height in compare.css.
    height: 36,
  };
}

/** Places a window horizontally centred on the display under the mouse, near the top. */
function centerOnCursorDisplay(win: BrowserWindow, topRatio: number): void {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const [width = 800, height = 560] = win.getSize();
  win.setBounds({
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + Math.max(0, workArea.height * topRatio)),
    width: Math.min(width, workArea.width),
    height: Math.min(height, workArea.height),
  });
}
