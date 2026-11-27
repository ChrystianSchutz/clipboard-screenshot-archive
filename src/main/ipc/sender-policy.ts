import type { InvokeChannel } from '@shared/ipc-contract';
import type { WindowRole } from '../app/windows';

/** What main knows about the origin of one IPC call. */
export interface IpcSender {
  /** Role of the window whose web contents sent the call; `null` when it is not one of ours. */
  readonly role: WindowRole | null;
  /** URL of the sending frame; `null` when the frame is already gone. */
  readonly frameUrl: string | null;
  readonly isMainFrame: boolean;
}

/** A sender that passed every check; handlers use its verified role. */
export interface TrustedSender {
  readonly role: WindowRole;
}

/**
 * The compare window only shows a diff: it reads the compare state and settings, resets, hides
 * itself and reports errors. History, deletion and settings changes stay with the palette.
 */
const COMPARE_CHANNELS: ReadonlySet<InvokeChannel> = new Set<InvokeChannel>([
  'compare:get-state',
  'compare:reset',
  'settings:get',
  'window:hide',
  'app:info',
  'diagnostics:report-error',
]);

/**
 * IPC trust decision, kept pure so the real policy is unit-tested:
 * 1. the call comes from one of our windows,
 * 2. from its main frame (not an embedded frame),
 * 3. while that frame shows exactly the app document,
 * 4. on a channel that the window's role may use.
 */
export function authorizeSender(
  sender: IpcSender,
  channel: InvokeChannel,
  isAppUrl: (url: string) => boolean,
): TrustedSender | null {
  const { role, frameUrl, isMainFrame } = sender;
  if (role === null || !isMainFrame || frameUrl === null || !isAppUrl(frameUrl)) return null;
  if (role === 'compare' && !COMPARE_CHANNELS.has(channel)) return null;
  return { role };
}

/**
 * Whether a window role may read screenshot pixels (`clip-image:`). Same rule as the
 * `screenshot:*` channels, which the compare window cannot call either. Enforced per session in
 * `serveScreenshotProtocol`, since protocol handlers cannot see the requesting window.
 */
export function mayReadScreenshots(role: WindowRole | null): boolean {
  return role === 'palette';
}
