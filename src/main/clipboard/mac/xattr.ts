/**
 * Extended attributes read from an open file descriptor on macOS: `fgetxattr(2)` from libSystem,
 * bound in-process with koffi (as `pasteboard.ts` binds the Objective-C runtime).
 *
 * Bound to the descriptor, never to a path: the answer always describes the file that was opened,
 * even if its path names another file for a moment while the attribute is read. That is what makes
 * the screenshot-folder provenance check (`kMDItemIsScreenCapture`) safe against a path swap.
 *
 * Signature (Apple, `sys/xattr.h`):
 * `ssize_t fgetxattr(int fd, const char *name, void *value, size_t size, u_int32_t position, int options)`.
 * Called once with no buffer to learn the length, then with a buffer of that length. The call is
 * synchronous; it only reads metadata of an already open local file.
 */

/** `fgetxattr` as bound by koffi (faked in tests): a byte count, or -1 on error / no attribute. */
export type Fgetxattr = (
  fd: number,
  name: string,
  value: Buffer | null,
  size: number,
  position: number,
  options: number,
) => number;

/** Upper bound on an attribute value read here (the screen-capture flag is a ~42-byte plist). */
export const MAX_ATTRIBUTE_BYTES = 4_096;

/**
 * The value of attribute `name` on the open descriptor `fd`, or `null` when it is absent, cannot be
 * read, is larger than `maxBytes`, or changed length between the two calls.
 */
export function readDescriptorAttribute(
  fgetxattr: Fgetxattr,
  fd: number,
  name: string,
  maxBytes: number = MAX_ATTRIBUTE_BYTES,
): Uint8Array | null {
  try {
    const length = fgetxattr(fd, name, null, 0, 0, 0);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) return null;
    if (length === 0) return new Uint8Array(0);
    const value = Buffer.alloc(length);
    const read = fgetxattr(fd, name, value, length, 0, 0);
    if (!Number.isSafeInteger(read) || read < 0 || read > length) return null;
    return new Uint8Array(value.subarray(0, read));
  } catch {
    return null;
  }
}

let loading: Promise<Fgetxattr | null> | null = null;

/** Loads `fgetxattr` once per process; `null` off macOS or when it cannot be loaded. */
export function loadFgetxattr(
  platform: NodeJS.Platform = process.platform,
): Promise<Fgetxattr | null> {
  if (platform !== 'darwin') return Promise.resolve(null);
  loading ??= load().catch(() => null);
  return loading;
}

async function load(): Promise<Fgetxattr | null> {
  const { default: koffi } = await import('koffi');
  const libSystem = koffi.load('/usr/lib/libSystem.B.dylib');
  // `ssize_t` is pointer-sized and signed on macOS: `intptr_t`.
  return libSystem.func(
    'intptr_t fgetxattr(int fd, const char *name, void *value, size_t size, uint32_t position, int options)',
  ) as Fgetxattr;
}
