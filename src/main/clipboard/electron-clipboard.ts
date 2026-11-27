import { clipboard, ClipboardItem } from 'electron';
import { createHash } from 'node:crypto';
import { MAX_ENCODED_BYTES } from '../images/image-policy';
import type { ClipboardIO } from './ports';

/**
 * The app's write marker: a W3C web custom format (Chromium's "Web Custom Format" registry) that
 * the app commits in the same clipboard write as a restored text or image, carrying a random
 * per-write token. It lets the capture pipeline recognise exactly the change its own write caused.
 *
 * Other apps never see it as content: Chromium stores web custom formats under its own registered
 * formats ("Web Custom Format Map" plus "Web Custom FormatN" on Windows, the matching pasteboard
 * types on macOS and MIME targets on Linux), which no other app pastes. The standard formats of the
 * same write (`text/plain`, `image/png`) are exactly what `writeText` / an image write put there
 * before, so pasting elsewhere behaves as it always did.
 */
export const WRITE_MARKER_MIME = 'application/vnd.clipboard-screenshot-archive.write-id';
export const WRITE_MARKER_FORMAT = `web ${WRITE_MARKER_MIME}`;
/** Tokens are 32 hex characters (see `newWriteToken`); anything else is not ours. */
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/** The marker's payload, for a `ClipboardItem` entry. */
export function writeMarkerBlob(token: string): Blob {
  // A web custom format's blob carries the format's MIME type, without the `web ` prefix.
  return new Blob([token], { type: WRITE_MARKER_MIME });
}

/** The minimal slice of Electron's clipboard the readers below need (faked in tests). */
export interface ClipboardReadPort {
  has(type: string): Promise<boolean>;
  read(): Promise<{ readonly types: readonly string[]; getType(type: string): Promise<unknown> }[]>;
}

/** Reads the write marker's token through `port`; `null` when absent, malformed or unreadable. */
export async function readWriteMarkerFrom(port: ClipboardReadPort): Promise<string | null> {
  try {
    // The cheap check first: an ordinary copy never carries the marker.
    if (!(await port.has(WRITE_MARKER_FORMAT))) return null;
    const items = await port.read();
    const item = items.find((candidate) => candidate.types.includes(WRITE_MARKER_FORMAT));
    if (!item) return null;
    const blob = await item.getType(WRITE_MARKER_FORMAT);
    // A token is 32 bytes: anything much larger is not ours and is never copied out.
    if (!(blob instanceof Blob) || blob.size > 256) return null;
    const token = (await blob.text()).trim();
    return TOKEN_PATTERN.test(token) ? token : null;
  } catch {
    // Unreadable: treated as "not ours", so the change is recorded (at worst, a restore bumps
    // its own clip).
    return null;
  }
}

/** `ClipboardIO` backed by Electron 45's promise-based clipboard API. */
export const electronClipboard: ClipboardIO = {
  readText: () => clipboard.readText(),
  writeText: (text, marker) =>
    marker === undefined
      ? clipboard.writeText(text)
      : // One write: the text and the marker reach the clipboard atomically.
        clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([text], { type: 'text/plain' }),
            [WRITE_MARKER_FORMAT]: writeMarkerBlob(marker),
          }),
        ]),
  readWriteMarker: () => readWriteMarkerFrom(clipboard),
};

const PNG = 'image/png';

/**
 * Identity of the clipboard image for the polling watcher, or `null` when the clipboard holds no
 * image. The poller asks only when there is no text, so plain text copies never pay for it.
 *
 * Bounded: the blob's size is known before its bytes are copied out, and an image above the
 * capture pipeline's encoded-size limit (which capture refuses anyway) is identified by its size
 * alone, never copied into JS memory or hashed.
 *
 * Known limit (Linux fallback only; Windows and macOS poll native counters and never call this):
 * Electron has no payload-free size check. `getType()` makes Electron read the platform image and
 * encode it into the Blob natively, so an oversized image is still materialized once per probe
 * (at most every 2 s, see `IMAGE_PROBE_MAX_MS`) before the size check can refuse it.
 */
export async function imageFingerprintFrom(
  port: ClipboardReadPort,
  maxBytes: number = MAX_ENCODED_BYTES,
): Promise<string | null> {
  if (!(await port.has(PNG))) return null;
  const items = await port.read();
  const item = items.find((candidate) => candidate.types.includes(PNG));
  if (!item) return null;
  const blob = await item.getType(PNG);
  if (!(blob instanceof Blob)) return null;
  if (blob.size > maxBytes) return `oversize:${String(blob.size)}`;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `${String(bytes.byteLength)}:${createHash('sha1').update(bytes).digest('hex')}`;
}

/** `imageFingerprintFrom` over the system clipboard. */
export function electronImageFingerprint(): Promise<string | null> {
  return imageFingerprintFrom(clipboard);
}

/**
 * The MIME types on the clipboard, for the polling watcher's fallback fingerprint. Only the item
 * list is read (`ClipboardItem.types`, what the platform clipboard makes available); no payload is
 * fetched (`getType` is never called). Empty when the clipboard cannot be read.
 */
export async function formatsFrom(port: Pick<ClipboardReadPort, 'read'>): Promise<string[]> {
  try {
    const items = await port.read();
    return [...new Set(items.flatMap((item) => item.types))];
  } catch {
    return [];
  }
}

/** `formatsFrom` over the system clipboard. */
export function electronClipboardFormats(): Promise<string[]> {
  return formatsFrom(clipboard);
}
