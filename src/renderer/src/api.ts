import type { ClipboardArchiveApi } from '@shared/ipc-contract';

/**
 * The preload bridge. Components import `api` instead of touching `window` directly, which keeps
 * them easy to test: component tests assign a fake to `window.clipboardArchive` before rendering.
 */
export const api: ClipboardArchiveApi = new Proxy({} as ClipboardArchiveApi, {
  get: (_target, key: keyof ClipboardArchiveApi) => window.clipboardArchive[key],
});

/**
 * The message of an error thrown by a main-process handler. Electron wraps it as
 * "Error invoking remote method 'channel': Error: <message>"; only `<message>` is for people.
 */
export function ipcErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
}
