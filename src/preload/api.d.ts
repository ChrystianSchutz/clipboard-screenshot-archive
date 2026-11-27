import type { ClipboardArchiveApi } from '../shared/ipc-contract';

declare global {
  interface Window {
    /** Exposed by the preload script through `contextBridge`. */
    readonly clipboardArchive: ClipboardArchiveApi;
  }
}

export {};
