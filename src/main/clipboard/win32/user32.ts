/**
 * Minimal Win32 bindings for clipboard monitoring, via koffi (a prebuilt FFI, no compiler needed).
 *
 * Electron 45's async clipboard API covers reading and writing text, but not what a clipboard
 * history needs on top: change notifications, the owning process, private-content markers and
 * the raw CF_HTML header (Electron strips it, and with it the page's SourceURL).
 *
 * Loaded lazily and only on Windows. Every helper degrades to `null`/`false` instead of throwing,
 * except the privacy reads: they tell "absent" apart from "could not be read", so a clipboard that
 * another app holds open can never make a private copy look like an ordinary one.
 */

/** Window message sent to listeners registered with `AddClipboardFormatListener`. */
export const WM_CLIPBOARDUPDATE = 0x031d;

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const MAX_PATH_CHARS = 32_767;
/** The CF_HTML header (with SourceURL) sits at the very start of the payload. */
const HTML_HEADER_BYTES = 4096;
const OPEN_CLIPBOARD_ATTEMPTS = 3;
/** Win32 `BOOL` is a 32-bit int; koffi's `bool` is one byte, so the bindings return the raw int. */
type BOOL = number;
const isTrue = (value: BOOL): boolean => value !== 0;

/** Whether a clipboard format is there. `unknown`: the format name could not be registered. */
export type FormatPresence = 'present' | 'absent' | 'unknown';

/**
 * A format's value, read with the clipboard open. `unreadable` means the format is (or may be)
 * there but its payload could not be read: another app held the clipboard open, the data handle
 * or memory lock failed, or the payload is malformed. Callers that guard privacy must treat it as
 * "maybe private", never as absent.
 */
export type FormatRead<T> =
  | { readonly state: 'absent' }
  | { readonly state: 'present'; readonly value: T }
  | { readonly state: 'unreadable' };

export interface Win32Clipboard {
  addListener(hwnd: bigint): boolean;
  removeListener(hwnd: bigint): boolean;
  /** Increments on every clipboard change; lets us drop duplicate notifications. */
  sequenceNumber(): number;
  /** Process that owns the clipboard, falling back to the foreground window's process. */
  ownerProcess(): { pid: number; via: 'owner' | 'foreground' } | null;
  processImagePath(pid: number): string | null;
  /**
   * Whether a registered clipboard format (by name) is currently on the clipboard. Needs no open
   * clipboard (`IsClipboardFormatAvailable`), so a lock held by another app cannot hide it.
   */
  formatPresence(name: string): FormatPresence;
  /** First bytes of the "HTML Format" payload as UTF-8, or `null` when there is none. */
  readHtmlHeader(): string | null;
  /** A registered format holding a DWORD (e.g. "CanIncludeInClipboardHistory"). */
  readDwordFormat(name: string): FormatRead<number>;
}

type Fn<A extends unknown[], R> = (...args: A) => R;

export interface Win32Bindings {
  AddClipboardFormatListener: Fn<[bigint], BOOL>;
  RemoveClipboardFormatListener: Fn<[bigint], BOOL>;
  GetClipboardSequenceNumber: Fn<[], number>;
  GetClipboardOwner: Fn<[], bigint | null>;
  GetForegroundWindow: Fn<[], bigint | null>;
  GetWindowThreadProcessId: Fn<[bigint, [number | null]], number>;
  RegisterClipboardFormatW: Fn<[string], number>;
  IsClipboardFormatAvailable: Fn<[number], BOOL>;
  OpenClipboard: Fn<[bigint | null], BOOL>;
  CloseClipboard: Fn<[], BOOL>;
  GetClipboardData: Fn<[number], bigint | null>;
  GlobalLock: Fn<[bigint], bigint | null>;
  GlobalUnlock: Fn<[bigint], BOOL>;
  GlobalSize: Fn<[bigint], number | bigint>;
  OpenProcess: Fn<[number, BOOL, number], bigint | null>;
  QueryFullProcessImageNameW: Fn<[bigint, number, Buffer, [number]], BOOL>;
  CloseHandle: Fn<[bigint], BOOL>;
  /** Copies `length` bytes of unmanaged memory into a Buffer. */
  readMemory: Fn<[bigint, number], Buffer>;
}

let loading: Promise<Win32Clipboard> | null = null;

/** Loads user32/kernel32 once per process (koffi type names are global and cannot be redefined). */
export function loadWin32Clipboard(): Promise<Win32Clipboard> {
  loading ??= load();
  return loading;
}

async function load(): Promise<Win32Clipboard> {
  const { default: koffi } = await import('koffi');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');

  koffi.alias('DWORD', 'uint32_t');
  koffi.alias('UINT', 'uint32_t');
  koffi.alias('BOOL', 'int32_t');
  koffi.pointer('HANDLE', koffi.opaque());
  koffi.alias('HWND', 'HANDLE');

  const fn = (lib: typeof user32, signature: string): never => lib.func(signature) as never;

  return createWin32Clipboard({
    AddClipboardFormatListener: fn(user32, 'BOOL __stdcall AddClipboardFormatListener(HWND hwnd)'),
    RemoveClipboardFormatListener: fn(
      user32,
      'BOOL __stdcall RemoveClipboardFormatListener(HWND hwnd)',
    ),
    GetClipboardSequenceNumber: fn(user32, 'DWORD __stdcall GetClipboardSequenceNumber()'),
    GetClipboardOwner: fn(user32, 'HWND __stdcall GetClipboardOwner()'),
    GetForegroundWindow: fn(user32, 'HWND __stdcall GetForegroundWindow()'),
    GetWindowThreadProcessId: fn(
      user32,
      'DWORD __stdcall GetWindowThreadProcessId(HWND hwnd, _Out_ DWORD *pid)',
    ),
    RegisterClipboardFormatW: fn(
      user32,
      'UINT __stdcall RegisterClipboardFormatW(const char16_t *name)',
    ),
    IsClipboardFormatAvailable: fn(
      user32,
      'BOOL __stdcall IsClipboardFormatAvailable(UINT format)',
    ),
    OpenClipboard: fn(user32, 'BOOL __stdcall OpenClipboard(HWND owner)'),
    CloseClipboard: fn(user32, 'BOOL __stdcall CloseClipboard()'),
    GetClipboardData: fn(user32, 'HANDLE __stdcall GetClipboardData(UINT format)'),
    GlobalLock: fn(kernel32, 'HANDLE __stdcall GlobalLock(HANDLE memory)'),
    GlobalUnlock: fn(kernel32, 'BOOL __stdcall GlobalUnlock(HANDLE memory)'),
    GlobalSize: fn(kernel32, 'size_t __stdcall GlobalSize(HANDLE memory)'),
    OpenProcess: fn(
      kernel32,
      'HANDLE __stdcall OpenProcess(DWORD access, BOOL inherit, DWORD pid)',
    ),
    QueryFullProcessImageNameW: fn(
      kernel32,
      'BOOL __stdcall QueryFullProcessImageNameW(HANDLE process, DWORD flags, _Out_ uint8_t *name, _Inout_ DWORD *size)',
    ),
    CloseHandle: fn(kernel32, 'BOOL __stdcall CloseHandle(HANDLE handle)'),
    // Copies the bytes into JS memory. `koffi.view()` would wrap native memory in an external
    // ArrayBuffer, which Electron's V8 memory cage forbids: the process aborts on first use.
    readMemory: (pointer, length) =>
      Buffer.from(koffi.decode(pointer, 'uint8_t', length) as number[] | Uint8Array),
  });
}

/** Separated from loading so the logic can be unit-tested with fake bindings. */
export function createWin32Clipboard(api: Win32Bindings): Win32Clipboard {
  const formatIds = new Map<string, number>();

  const formatId = (name: string): number => {
    let id = formatIds.get(name);
    if (id === undefined) {
      id = api.RegisterClipboardFormatW(name);
      formatIds.set(name, id);
    }
    return id;
  };

  const pidOf = (hwnd: bigint | null): number | null => {
    if (!hwnd) return null;
    const out: [number | null] = [null];
    const thread = api.GetWindowThreadProcessId(hwnd, out);
    return thread !== 0 && out[0] ? out[0] : null;
  };

  /**
   * Another app may hold the clipboard open for a moment; retry a few times (synchronously: the
   * caller decides whether to try again later). `opened: false` when every attempt failed.
   */
  const withOpenClipboard = <T>(work: () => T): { opened: true; value: T } | { opened: false } => {
    for (let attempt = 0; attempt < OPEN_CLIPBOARD_ATTEMPTS; attempt++) {
      if (isTrue(api.OpenClipboard(null))) {
        try {
          return { opened: true, value: work() };
        } finally {
          api.CloseClipboard();
        }
      }
    }
    return { opened: false };
  };

  const isAvailable = (id: number): boolean =>
    id !== 0 && isTrue(api.IsClipboardFormatAvailable(id));

  /** Up to `maxBytes` of a format's global-memory payload. */
  const readFormatBytes = (name: string, maxBytes: number): FormatRead<Buffer> => {
    const id = formatId(name);
    // Without an id we cannot even ask, which is not the same as "absent".
    if (id === 0) return { state: 'unreadable' };
    if (!isAvailable(id)) return { state: 'absent' };
    const read = withOpenClipboard((): Buffer | null => {
      const memory = api.GetClipboardData(id);
      if (!memory) return null;
      const pointer = api.GlobalLock(memory);
      if (!pointer) return null;
      try {
        const length = Math.min(Number(api.GlobalSize(memory)), maxBytes);
        return api.readMemory(pointer, length);
      } finally {
        api.GlobalUnlock(memory);
      }
    });
    return read.opened && read.value !== null
      ? { state: 'present', value: read.value }
      : { state: 'unreadable' };
  };

  return {
    addListener: (hwnd) => isTrue(api.AddClipboardFormatListener(hwnd)),
    removeListener: (hwnd) => isTrue(api.RemoveClipboardFormatListener(hwnd)),
    sequenceNumber: () => api.GetClipboardSequenceNumber(),

    ownerProcess() {
      const owner = pidOf(api.GetClipboardOwner());
      if (owner !== null) return { pid: owner, via: 'owner' };
      // Some apps empty the clipboard without taking ownership; the focused app is the best guess.
      const foreground = pidOf(api.GetForegroundWindow());
      return foreground !== null ? { pid: foreground, via: 'foreground' } : null;
    },

    processImagePath(pid) {
      const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if (!handle) return null;
      try {
        const buffer = Buffer.alloc(MAX_PATH_CHARS * 2);
        const size: [number] = [MAX_PATH_CHARS];
        if (!isTrue(api.QueryFullProcessImageNameW(handle, 0, buffer, size))) return null;
        return buffer.toString('utf16le', 0, size[0] * 2);
      } finally {
        api.CloseHandle(handle);
      }
    },

    formatPresence(name) {
      const id = formatId(name);
      if (id === 0) return 'unknown';
      return isAvailable(id) ? 'present' : 'absent';
    },

    readHtmlHeader() {
      const read = readFormatBytes('HTML Format', HTML_HEADER_BYTES);
      return read.state === 'present' ? read.value.toString('utf8') : null;
    },

    readDwordFormat(name) {
      const read = readFormatBytes(name, 4);
      if (read.state !== 'present') return read;
      // A marker too short to hold a DWORD says nothing reliable, so it is not "absent" either.
      return read.value.length === 4
        ? { state: 'present', value: read.value.readUInt32LE(0) }
        : { state: 'unreadable' };
    },
  };
}
