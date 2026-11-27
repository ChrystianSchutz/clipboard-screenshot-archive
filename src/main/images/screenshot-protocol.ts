import { protocol } from 'electron';
import { parseScreenshotUrl, SCREENSHOT_SCHEME, type ScreenshotVariant } from '@shared/screenshots';
import { compareSession } from '../app/windows';
import { mayReadScreenshots } from '../ipc/sender-policy';

/** Reads a screenshot's PNG by clip id; `null` when the clip is not an image (or is gone). */
export type ScreenshotReader = (
  clipId: number,
  variant: ScreenshotVariant,
) => Promise<Uint8Array | null>;

const HEADERS = {
  'content-type': 'image/png',
  'x-content-type-options': 'nosniff',
  // Clip ids can be reused after the newest clip is deleted, so nothing is cached by id.
  'cache-control': 'no-store',
} as const;

/**
 * Answers one `clip-image://clip/<clipId>/<variant>` request.
 *
 * The page names a clip, never a file: the hash and the path on disk stay in the main process,
 * and anything that is not exactly a GET of a known image clip gets an empty error response.
 */
export async function screenshotResponse(
  request: { url: string; method: string },
  read: ScreenshotReader,
): Promise<Response> {
  if (request.method !== 'GET') return new Response(null, { status: 405 });
  const target = parseScreenshotUrl(request.url);
  if (!target) return new Response(null, { status: 400 });
  let png: Uint8Array | null;
  try {
    png = await read(target.clipId, target.variant);
  } catch {
    // A file that vanished or cannot be read: the page shows its "could not be loaded" state.
    return new Response(null, { status: 404 });
  }
  if (!png) return new Response(null, { status: 404 });
  return new Response(new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }), {
    status: 200,
    headers: HEADERS,
  });
}

/** The answer every `clip-image:` request gets in a session whose window may not see screenshots. */
export function deniedScreenshotResponse(): Response {
  return new Response(null, { status: 403 });
}

/**
 * Serves screenshots to the palette only. Call once the app is ready (the scheme is registered in
 * `registerAppScheme`).
 *
 * Protocol handlers belong to a session and do not know which window asked, so the window-role
 * rule is enforced by session: the palette uses the default session and gets the images; the
 * compare window has its own session (`COMPARE_PARTITION`), where every request is refused.
 */
export function serveScreenshotProtocol(read: ScreenshotReader): void {
  protocol.handle(SCREENSHOT_SCHEME, (request) =>
    mayReadScreenshots('palette') ? screenshotResponse(request, read) : deniedScreenshotResponse(),
  );
  compareSession().protocol.handle(SCREENSHOT_SCHEME, (request) =>
    mayReadScreenshots('compare') ? screenshotResponse(request, read) : deniedScreenshotResponse(),
  );
}
