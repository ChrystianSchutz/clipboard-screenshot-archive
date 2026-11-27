/**
 * macOS clipboard version: `NSPasteboard.generalPasteboard.changeCount`, the counter AppKit bumps
 * on every write to the general pasteboard (by any app, images and identical copies included).
 *
 * Read in-process through the Objective-C runtime with koffi (already used for the Win32
 * bindings): two `sel_registerName` lookups at load time, then one `objc_msgSend` per read that
 * returns an integer. No subprocess, no payload, no allocation, so it is cheap enough for the
 * 500 ms poll (an `execFile` of `osascript` per poll would cost tens of milliseconds and a
 * process each time). Electron 45 exposes no such counter itself.
 *
 * Safety: `generalPasteboard` returns a process-wide singleton (never released, so the pointer
 * stays valid), `changeCount` takes no arguments and returns `NSInteger`; both are called from
 * the main thread (Electron's main process JS runs on it). `objc_msgSend` is bound once per
 * method signature with that exact prototype, as Apple requires on arm64 (no variadic call).
 * Anything unexpected while loading (no AppKit class, a null pasteboard, a non-integer answer)
 * returns `null` and the caller falls back to the portable fingerprint.
 */

/** The slice of koffi this loader uses (faked in tests). */
export interface ObjcRuntime {
  getClass(name: string): unknown;
  selector(name: string): unknown;
  /** `objc_msgSend` bound as `id (id, SEL)`. */
  sendForObject(target: unknown, selector: unknown): unknown;
  /** `objc_msgSend` bound as `NSInteger (id, SEL)`. */
  sendForInteger(target: unknown, selector: unknown): number | bigint;
}

/** Builds the counter from a runtime, or `null` when the pasteboard cannot be reached. */
export function pasteboardCounter(runtime: ObjcRuntime): (() => number) | null {
  const pasteboardClass = runtime.getClass('NSPasteboard');
  if (!pasteboardClass) return null;
  const general = runtime.sendForObject(pasteboardClass, runtime.selector('generalPasteboard'));
  if (!general) return null;
  const changeCount = runtime.selector('changeCount');
  const read = (): number => Number(runtime.sendForInteger(general, changeCount));
  const first = read();
  return Number.isSafeInteger(first) ? read : null;
}

let loading: Promise<(() => number) | null> | null = null;

/** Loads the counter once per process; `null` off macOS or when it cannot be loaded. */
export function loadMacPasteboardCounter(
  platform: NodeJS.Platform = process.platform,
): Promise<(() => number) | null> {
  if (platform !== 'darwin') return Promise.resolve(null);
  loading ??= load().catch(() => null);
  return loading;
}

async function load(): Promise<(() => number) | null> {
  const { default: koffi } = await import('koffi');
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const getClass = objc.func('void *objc_getClass(const char *name)') as (name: string) => unknown;
  const selector = objc.func('void *sel_registerName(const char *name)') as (
    name: string,
  ) => unknown;
  const sendForObject = objc.func('objc_msgSend', 'void *', ['void *', 'void *']) as (
    target: unknown,
    selector: unknown,
  ) => unknown;
  const sendForInteger = objc.func('objc_msgSend', 'int64_t', ['void *', 'void *']) as (
    target: unknown,
    selector: unknown,
  ) => number | bigint;
  return pasteboardCounter({ getClass, selector, sendForObject, sendForInteger });
}
