import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  ClipboardArchiveApi,
  EventChannel,
  EventChannels,
  InvokeArgs,
  InvokeChannel,
  InvokeResult,
} from '@shared/ipc-contract';

/**
 * The only bridge between the sandboxed renderer and the main process.
 *
 * Exposes a narrow, typed facade instead of `ipcRenderer` itself, so a compromised renderer can
 * call only the functions below. Listener wrappers never leak the `IpcRendererEvent`
 * (which carries `sender`) into page code.
 */

function invoke<C extends InvokeChannel>(
  channel: C,
  ...args: InvokeArgs<C>
): Promise<InvokeResult<C>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<InvokeResult<C>>;
}

function subscribe<E extends EventChannel>(
  channel: E,
  listener: (payload: EventChannels[E]) => void,
): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: EventChannels[E]): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const api: ClipboardArchiveApi = {
  history: {
    query: (query) => invoke('history:query', query),
    get: (id) => invoke('history:get', id),
    regexRanges: (pattern, text) => invoke('history:regex-ranges', pattern, text),
    apps: () => invoke('history:apps'),
    restore: (id) => invoke('history:restore', id),
    remove: (ids) => invoke('history:delete', ids),
    clear: (options) => invoke('history:clear', options),
    setPinned: (id, pinned) => invoke('history:set-pinned', id, pinned),
    onChanged: (listener) => subscribe('history:changed', () => listener()),
  },
  stats: {
    get: () => invoke('stats:get'),
  },
  settings: {
    get: () => invoke('settings:get'),
    update: (patch) => invoke('settings:update', patch),
    onChanged: (listener) => subscribe('settings:changed', listener),
  },
  compare: {
    openClips: (leftId, rightId) => invoke('compare:open-clips', leftId, rightId),
    getState: () => invoke('compare:get-state'),
    reset: () => invoke('compare:reset'),
    onState: (listener) => subscribe('compare:state', listener),
  },
  window: {
    hide: () => invoke('window:hide'),
    onShowView: (listener) => subscribe('view:show', listener),
  },
  app: {
    info: () => invoke('app:info'),
    reportError: (report) => invoke('diagnostics:report-error', report),
  },
  screenshots: {
    details: (clipId) => invoke('screenshot:details', clipId),
    copyText: (text) => invoke('screenshot:copy-text', text),
    analyze: (clipId) => invoke('screenshot:analyze', clipId),
    retryText: (clipId) => invoke('screenshot:retry-text', clipId),
    modelState: () => invoke('screenshot:model-state'),
    downloadModel: () => invoke('screenshot:download-model'),
    cancelDownload: () => invoke('screenshot:cancel-download'),
    onUpdated: (listener) => subscribe('screenshot:updated', listener),
    onModelState: (listener) => subscribe('screenshot:model-state', listener),
  },
};

contextBridge.exposeInMainWorld('clipboardArchive', api);
