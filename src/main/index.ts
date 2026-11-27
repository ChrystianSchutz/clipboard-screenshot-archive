import { app } from 'electron';
import { join } from 'node:path';
import trayIcon from '../../resources/tray.png?asset';
import { registerAppScheme } from './app/app-protocol';
import { ClipboardArchiveApp } from './app/clipboard-archive-app';
import { createErrlog } from './diagnostics/errlog';

/**
 * Entry point. Kept deliberately small: process-level concerns only
 * (single instance, user data location, lifecycle). Everything else is in `ClipboardArchiveApp`.
 */

const e2e = process.env.CLIPBOARD_ARCHIVE_E2E === '1';
// Packaged-app smoke check for CI (see src/main/app/smoke.ts): checks startup, then exits.
const smoke = process.env.CLIPBOARD_ARCHIVE_SMOKE === '1';

// Tests get an isolated profile. Must happen before the single-instance lock, which is per profile.
if (process.env.CLIPBOARD_ARCHIVE_USER_DATA)
  app.setPath('userData', process.env.CLIPBOARD_ARCHIVE_USER_DATA);

// The built renderer is served from app://bundle/ (see app-protocol.ts); schemes register before ready.
registerAppScheme();

const errlog = createErrlog({
  dir: join(app.getPath('userData'), 'logs'),
  app: 'clipboard-archive',
});
errlog.installProcessHandlers();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (process.platform === 'win32')
    app.setAppUserModelId('io.github.chrystianschutz.clipboard-screenshot-archive');

  const clipboardArchive = new ClipboardArchiveApp({
    mainDir: import.meta.dirname,
    trayIconPath: trayIcon,
    devServerUrl: app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL,
    startHidden: process.argv.includes('--hidden'),
    e2e,
    smoke,
    errlog,
  });

  app.on('render-process-gone', (_event, _contents, details) => {
    errlog.error(new Error(`Renderer gone: ${details.reason}`), 'renderer', 'process-gone');
  });
  app.on('child-process-gone', (_event, details) => {
    errlog.error(new Error(`${details.type} gone: ${details.reason}`), 'child', 'process-gone');
  });

  // A tray app keeps running with no visible window.
  app.on('window-all-closed', () => undefined);
  app.on('will-quit', () => clipboardArchive.stop());

  void app.whenReady().then(async () => {
    app.dock?.hide();
    try {
      await clipboardArchive.start();
    } catch (error) {
      errlog.error(error, 'app:start');
      app.exit(1);
    }
  });
}
