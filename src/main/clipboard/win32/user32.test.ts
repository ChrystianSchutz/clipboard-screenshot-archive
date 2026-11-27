import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createWin32Clipboard, type Win32Bindings } from './user32';

const HTML_FORMAT_ID = 49_400;
const OWNER_HWND = 0x1001n;
const FOREGROUND_HWND = 0x2002n;
const PROCESS_HANDLE = 0x77n;
const MEMORY_HANDLE = 0x5000n;
const POINTER = 0x6000n;
/**
 * Win32 `BOOL` results. TRUE is any non-zero int; this one has a zero low byte, so a binding that
 * read `BOOL` as a one-byte `bool` would see success as failure.
 */
const TRUE = 0x100;
const FALSE = 0;

/**
 * Fake user32/kernel32: a tiny simulated Windows. Tests change the public fields to set up the
 * scenario, and inspect the `vi.fn` spies to check which calls were made.
 */
class FakeWin32 {
  windowPids = new Map<bigint, number>([
    [OWNER_HWND, 1234],
    [FOREGROUND_HWND, 5678],
  ]);
  owner: bigint | null = OWNER_HWND;
  foreground: bigint | null = FOREGROUND_HWND;
  imagePaths = new Map<number, string>([[1234, 'C:\\Program Files\\Microsoft VS Code\\Code.exe']]);
  formats = new Map<string, number>([['HTML Format', HTML_FORMAT_ID]]);
  available = new Set<number>([HTML_FORMAT_ID]);
  /** Number of OpenClipboard calls that fail before one succeeds (another app holds it). */
  busyOpens = 0;
  html: Buffer = Buffer.from('Version:0.9\r\nSourceURL:https://example.com/\r\n<html>', 'utf8');
  htmlSize: number | bigint | null = null;
  /** Payloads of formats other than HTML, by format id. */
  payloads = new Map<number, Buffer>();
  /** Format asked for by the last GetClipboardData call; the fake memory holds its payload. */
  private requested: number | null = null;
  clipboardData: bigint | null = MEMORY_HANDLE;
  lockResult: bigint | null = POINTER;

  /** PID passed to the last OpenProcess call; the fake process handle refers to it. */
  private openedPid: number | null = null;

  readonly bindings: { [K in keyof Win32Bindings]: Mock<Win32Bindings[K]> };

  constructor() {
    this.bindings = {
      AddClipboardFormatListener: vi.fn<Win32Bindings['AddClipboardFormatListener']>(() => TRUE),
      RemoveClipboardFormatListener: vi.fn<Win32Bindings['RemoveClipboardFormatListener']>(
        () => TRUE,
      ),
      GetClipboardSequenceNumber: vi.fn<Win32Bindings['GetClipboardSequenceNumber']>(() => 42),
      GetClipboardOwner: vi.fn<Win32Bindings['GetClipboardOwner']>(() => this.owner),
      GetForegroundWindow: vi.fn<Win32Bindings['GetForegroundWindow']>(() => this.foreground),
      GetWindowThreadProcessId: vi.fn<Win32Bindings['GetWindowThreadProcessId']>(
        (hwnd: bigint, out: [number | null]) => {
          const pid = this.windowPids.get(hwnd);
          if (pid === undefined) return 0;
          out[0] = pid;
          return 99; // thread id
        },
      ),
      RegisterClipboardFormatW: vi.fn<Win32Bindings['RegisterClipboardFormatW']>(
        (name: string) => this.formats.get(name) ?? 0,
      ),
      IsClipboardFormatAvailable: vi.fn<Win32Bindings['IsClipboardFormatAvailable']>(
        (format: number) => (this.available.has(format) ? TRUE : FALSE),
      ),
      OpenClipboard: vi.fn<Win32Bindings['OpenClipboard']>(() => {
        if (this.busyOpens > 0) {
          this.busyOpens--;
          return FALSE;
        }
        return TRUE;
      }),
      CloseClipboard: vi.fn<Win32Bindings['CloseClipboard']>(() => TRUE),
      GetClipboardData: vi.fn<Win32Bindings['GetClipboardData']>((format: number) => {
        this.requested = format;
        return this.clipboardData;
      }),
      GlobalLock: vi.fn<Win32Bindings['GlobalLock']>(() => this.lockResult),
      GlobalUnlock: vi.fn<Win32Bindings['GlobalUnlock']>(() => TRUE),
      GlobalSize: vi.fn<Win32Bindings['GlobalSize']>(
        () => this.extraPayload()?.length ?? this.htmlSize ?? this.html.length,
      ),
      OpenProcess: vi.fn<Win32Bindings['OpenProcess']>((_access, _inherit, pid) => {
        if (!this.imagePaths.has(pid)) return null;
        this.openedPid = pid;
        return PROCESS_HANDLE;
      }),
      QueryFullProcessImageNameW: vi.fn<Win32Bindings['QueryFullProcessImageNameW']>(
        (_process: bigint, _flags: number, name: Buffer, size: [number]) => {
          const path = this.openedPid === null ? undefined : this.imagePaths.get(this.openedPid);
          if (path === undefined) return FALSE;
          const written = name.write(path, 'utf16le');
          size[0] = written / 2;
          return TRUE;
        },
      ),
      CloseHandle: vi.fn<Win32Bindings['CloseHandle']>(() => TRUE),
      readMemory: vi.fn<Win32Bindings['readMemory']>((_pointer: bigint, length: number) =>
        (this.extraPayload() ?? this.html).subarray(0, length),
      ),
    };
  }

  private extraPayload(): Buffer | undefined {
    return this.requested === null ? undefined : this.payloads.get(this.requested);
  }
}

describe('createWin32Clipboard', () => {
  let win: FakeWin32;

  beforeEach(() => {
    win = new FakeWin32();
  });

  const create = (): ReturnType<typeof createWin32Clipboard> => createWin32Clipboard(win.bindings);

  describe('listener and sequence passthrough', () => {
    it('forwards add/remove listener calls with the window handle', () => {
      const clipboard = create();

      expect(clipboard.addListener(0xabcn)).toBe(true);
      expect(clipboard.removeListener(0xabcn)).toBe(true);
      expect(win.bindings.AddClipboardFormatListener).toHaveBeenCalledWith(0xabcn);
      expect(win.bindings.RemoveClipboardFormatListener).toHaveBeenCalledWith(0xabcn);
    });

    it('returns the clipboard sequence number', () => {
      expect(create().sequenceNumber()).toBe(42);
    });

    it('reads BOOL as a 32-bit int: only zero is failure', () => {
      win.bindings.AddClipboardFormatListener.mockReturnValueOnce(FALSE);

      expect(create().addListener(0xabcn)).toBe(false);
      expect(create().addListener(0xabcn)).toBe(true); // TRUE = 0x100, zero low byte
    });
  });

  describe('ownerProcess', () => {
    it('returns the process of the clipboard owner window', () => {
      expect(create().ownerProcess()).toEqual({ pid: 1234, via: 'owner' });
      expect(win.bindings.GetForegroundWindow).not.toHaveBeenCalled();
    });

    it('falls back to the foreground window when there is no owner', () => {
      win.owner = null;

      expect(create().ownerProcess()).toEqual({ pid: 5678, via: 'foreground' });
    });

    it('falls back to the foreground window when the owner window is gone', () => {
      win.owner = 0xdeadn; // GetWindowThreadProcessId returns 0 for it

      expect(create().ownerProcess()).toEqual({ pid: 5678, via: 'foreground' });
    });

    it('treats a zero handle as no window', () => {
      win.owner = 0n;

      expect(create().ownerProcess()).toEqual({ pid: 5678, via: 'foreground' });
      expect(win.bindings.GetWindowThreadProcessId).not.toHaveBeenCalledWith(0n, expect.anything());
    });

    it('treats a zero process id as unknown', () => {
      win.windowPids.set(OWNER_HWND, 0);

      expect(create().ownerProcess()).toEqual({ pid: 5678, via: 'foreground' });
    });

    it('returns null when neither window resolves to a process', () => {
      win.owner = null;
      win.foreground = null;

      expect(create().ownerProcess()).toBeNull();
    });
  });

  describe('processImagePath', () => {
    it('decodes the UTF-16 image path using the returned character count', () => {
      win.imagePaths.set(1234, 'D:\\Narzędzia\\Zażółć\\tool.exe');

      expect(create().processImagePath(1234)).toBe('D:\\Narzędzia\\Zażółć\\tool.exe');
    });

    it('opens the process with limited query rights only', () => {
      create().processImagePath(1234);

      expect(win.bindings.OpenProcess).toHaveBeenCalledWith(0x1000, FALSE, 1234);
    });

    it('always closes the process handle after a successful query', () => {
      create().processImagePath(1234);

      expect(win.bindings.CloseHandle).toHaveBeenCalledExactlyOnceWith(PROCESS_HANDLE);
    });

    it('returns null and still closes the handle when the query fails', () => {
      win.bindings.QueryFullProcessImageNameW.mockReturnValueOnce(FALSE);

      expect(create().processImagePath(1234)).toBeNull();
      expect(win.bindings.CloseHandle).toHaveBeenCalledExactlyOnceWith(PROCESS_HANDLE);
    });

    it('closes the handle even when the query throws', () => {
      win.bindings.QueryFullProcessImageNameW.mockImplementationOnce(() => {
        throw new Error('ffi failure');
      });

      expect(() => create().processImagePath(1234)).toThrow('ffi failure');
      expect(win.bindings.CloseHandle).toHaveBeenCalledExactlyOnceWith(PROCESS_HANDLE);
    });

    it('returns null without closing anything when the process cannot be opened', () => {
      expect(create().processImagePath(4321)).toBeNull();
      expect(win.bindings.CloseHandle).not.toHaveBeenCalled();
    });
  });

  describe('formatPresence', () => {
    it('reports a registered format that is on the clipboard as present', () => {
      win.formats.set('Clipboard Viewer Ignore', 50_001);
      win.available.add(50_001);

      expect(create().formatPresence('Clipboard Viewer Ignore')).toBe('present');
    });

    it('reports a registered format that is not on the clipboard as absent', () => {
      win.formats.set('Clipboard Viewer Ignore', 50_001);

      expect(create().formatPresence('Clipboard Viewer Ignore')).toBe('absent');
    });

    it('needs no open clipboard, so a lock held by another app cannot hide a marker', () => {
      win.formats.set('Clipboard Viewer Ignore', 50_001);
      win.available.add(50_001);
      win.busyOpens = 99;

      expect(create().formatPresence('Clipboard Viewer Ignore')).toBe('present');
      expect(win.bindings.OpenClipboard).not.toHaveBeenCalled();
    });

    it('reports unknown, never absent, when registration fails (id 0)', () => {
      expect(create().formatPresence('Unknown Format')).toBe('unknown');
      expect(win.bindings.IsClipboardFormatAvailable).not.toHaveBeenCalled();
    });

    it('registers each format name only once per instance', () => {
      const clipboard = create();

      clipboard.formatPresence('HTML Format');
      clipboard.formatPresence('HTML Format');
      clipboard.readHtmlHeader();

      expect(win.bindings.RegisterClipboardFormatW).toHaveBeenCalledExactlyOnceWith('HTML Format');
    });

    it('caches a failed registration too, instead of retrying it on every probe', () => {
      const clipboard = create();

      clipboard.formatPresence('Unknown Format');
      clipboard.formatPresence('Unknown Format');

      expect(win.bindings.RegisterClipboardFormatW).toHaveBeenCalledTimes(1);
    });
  });

  describe('readHtmlHeader', () => {
    it('returns the start of the CF_HTML payload as UTF-8', () => {
      win.html = Buffer.from('Version:0.9\r\nSourceURL:https://łódź.example/\r\n', 'utf8');

      expect(create().readHtmlHeader()).toBe('Version:0.9\r\nSourceURL:https://łódź.example/\r\n');
    });

    it('returns null without opening the clipboard when there is no HTML format', () => {
      win.available.clear();

      expect(create().readHtmlHeader()).toBeNull();
      expect(win.bindings.OpenClipboard).not.toHaveBeenCalled();
    });

    it('returns null when the HTML format cannot be registered', () => {
      win.formats.clear();

      expect(create().readHtmlHeader()).toBeNull();
      expect(win.bindings.OpenClipboard).not.toHaveBeenCalled();
    });

    it('retries OpenClipboard while another app holds the clipboard, then reads', () => {
      win.busyOpens = 2;

      expect(create().readHtmlHeader()).toContain('SourceURL:https://example.com/');
      expect(win.bindings.OpenClipboard).toHaveBeenCalledTimes(3);
      expect(win.bindings.CloseClipboard).toHaveBeenCalledTimes(1);
    });

    it('gives up after three failed attempts and never closes a clipboard it did not open', () => {
      win.busyOpens = 3;

      expect(create().readHtmlHeader()).toBeNull();
      expect(win.bindings.OpenClipboard).toHaveBeenCalledTimes(3);
      expect(win.bindings.CloseClipboard).not.toHaveBeenCalled();
    });

    it('opens the clipboard without an owner window', () => {
      create().readHtmlHeader();

      expect(win.bindings.OpenClipboard).toHaveBeenCalledWith(null);
    });

    it('unlocks the memory and closes the clipboard after reading', () => {
      create().readHtmlHeader();

      expect(win.bindings.GlobalUnlock).toHaveBeenCalledExactlyOnceWith(MEMORY_HANDLE);
      expect(win.bindings.CloseClipboard).toHaveBeenCalledTimes(1);
    });

    it('unlocks and closes even when reading the memory throws', () => {
      win.bindings.readMemory.mockImplementationOnce(() => {
        throw new Error('access violation');
      });

      expect(() => create().readHtmlHeader()).toThrow('access violation');
      expect(win.bindings.GlobalUnlock).toHaveBeenCalledTimes(1);
      expect(win.bindings.CloseClipboard).toHaveBeenCalledTimes(1);
    });

    it('returns null and closes the clipboard when there is no data handle', () => {
      win.clipboardData = null;

      expect(create().readHtmlHeader()).toBeNull();
      expect(win.bindings.GlobalLock).not.toHaveBeenCalled();
      expect(win.bindings.CloseClipboard).toHaveBeenCalledTimes(1);
    });

    it('returns null without unlocking when the memory cannot be locked', () => {
      win.lockResult = null;

      expect(create().readHtmlHeader()).toBeNull();
      expect(win.bindings.GlobalUnlock).not.toHaveBeenCalled();
      expect(win.bindings.CloseClipboard).toHaveBeenCalledTimes(1);
    });

    it('reads at most 4096 bytes of a large payload', () => {
      win.html = Buffer.alloc(10_000, 'a');

      const header = create().readHtmlHeader();

      expect(win.bindings.readMemory).toHaveBeenCalledWith(POINTER, 4096);
      expect(header).toHaveLength(4096);
    });

    it('reads the whole payload when it is smaller than the cap', () => {
      win.htmlSize = 120;

      create().readHtmlHeader();

      expect(win.bindings.readMemory).toHaveBeenCalledWith(POINTER, 120);
    });

    it('accepts a 64-bit (bigint) size from GlobalSize', () => {
      win.htmlSize = 5_000_000_000n;

      create().readHtmlHeader();

      expect(win.bindings.readMemory).toHaveBeenCalledWith(POINTER, 4096);
    });
  });

  describe('readDwordFormat', () => {
    const HISTORY_FORMAT_ID = 50_100;
    const dword = (value: number): Buffer => {
      const buffer = Buffer.alloc(4);
      buffer.writeUInt32LE(value, 0);
      return buffer;
    };

    beforeEach(() => {
      win.formats.set('CanIncludeInClipboardHistory', HISTORY_FORMAT_ID);
    });

    it.each([0, 1])('returns the little-endian DWORD value %i', (value) => {
      win.available.add(HISTORY_FORMAT_ID);
      win.payloads.set(HISTORY_FORMAT_ID, dword(value));

      expect(create().readDwordFormat('CanIncludeInClipboardHistory')).toEqual({
        state: 'present',
        value,
      });
      expect(win.bindings.GetClipboardData).toHaveBeenCalledWith(HISTORY_FORMAT_ID);
      expect(win.bindings.CloseClipboard).toHaveBeenCalledTimes(1);
    });

    it('reports absent without opening the clipboard when the format is not there', () => {
      expect(create().readDwordFormat('CanIncludeInClipboardHistory')).toEqual({
        state: 'absent',
      });
      expect(win.bindings.OpenClipboard).not.toHaveBeenCalled();
    });

    describe('a marker that is there but cannot be read is unreadable, never absent', () => {
      beforeEach(() => {
        win.available.add(HISTORY_FORMAT_ID);
        win.payloads.set(HISTORY_FORMAT_ID, dword(0));
      });

      it('when another app holds the clipboard open through every attempt', () => {
        win.busyOpens = 3;

        expect(create().readDwordFormat('CanIncludeInClipboardHistory')).toEqual({
          state: 'unreadable',
        });
        expect(win.bindings.OpenClipboard).toHaveBeenCalledTimes(3);
        expect(win.bindings.CloseClipboard).not.toHaveBeenCalled();
      });

      it('but reads the value once the lock clears within the attempts', () => {
        win.busyOpens = 2;

        expect(create().readDwordFormat('CanIncludeInClipboardHistory')).toEqual({
          state: 'present',
          value: 0,
        });
      });

      it('when there is no data handle', () => {
        win.clipboardData = null;

        expect(create().readDwordFormat('CanIncludeInClipboardHistory')).toEqual({
          state: 'unreadable',
        });
        expect(win.bindings.CloseClipboard).toHaveBeenCalledTimes(1);
      });

      it('when the memory cannot be locked', () => {
        win.lockResult = null;

        expect(create().readDwordFormat('CanIncludeInClipboardHistory')).toEqual({
          state: 'unreadable',
        });
      });

      it('when the payload is too short to hold a DWORD', () => {
        win.payloads.set(HISTORY_FORMAT_ID, Buffer.from([0, 0]));

        expect(create().readDwordFormat('CanIncludeInClipboardHistory')).toEqual({
          state: 'unreadable',
        });
      });

      it('when the format name cannot be registered', () => {
        win.formats.delete('CanIncludeInClipboardHistory');

        expect(create().readDwordFormat('CanIncludeInClipboardHistory')).toEqual({
          state: 'unreadable',
        });
        expect(win.bindings.OpenClipboard).not.toHaveBeenCalled();
      });
    });
  });
});
