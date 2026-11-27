import { app, session, shell, type WebContents } from 'electron';
import { isAllowedNavigation } from './app-document';

/**
 * App-wide hardening, following Electron's security checklist:
 * https://www.electronjs.org/docs/latest/tutorial/security
 *
 * Per-window settings (contextIsolation, sandbox, no nodeIntegration) live in `windows.ts`.
 * This module covers what applies to every web contents: navigation, new windows, permissions.
 */
export function installSecurityPolicies(isAppUrl: (url: string) => boolean): void {
  // The UI needs no camera, microphone, notifications-from-web or geolocation.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents, isAppUrl));
}

export function hardenWebContents(contents: WebContents, isAppUrl: (url: string) => boolean): void {
  // Links (e.g. a clip's source URL) open in the user's browser, never inside the app.
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Same rule as IPC trust: only the main frame, only the exact app document. A page that could
  // navigate elsewhere (or be redirected) would run with our preload in a trusted window.
  contents.on('will-frame-navigate', (event) => {
    if (!isAllowedNavigation(event, isAppUrl)) event.preventDefault();
  });
  contents.on('will-redirect', (event) => {
    if (!isAllowedNavigation(event, isAppUrl)) event.preventDefault();
  });

  contents.on('will-attach-webview', (event) => event.preventDefault());
}

export function isExternalHttpUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const { protocol } = new URL(url);
  return protocol === 'https:' || protocol === 'http:';
}
