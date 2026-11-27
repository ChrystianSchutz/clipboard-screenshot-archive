import type { AppInfo } from '@shared/types';

/**
 * What capture really does right now, said plainly when it is degraded. Built from the
 * capabilities the source probe reports, not from how changes are noticed: on Windows the polling
 * fallback still has the native probe (source app, exclusions, private copies) when only the event
 * listener failed.
 */
export function captureStatus(info: AppInfo | null): string {
  if (!info) return '';
  const { capture, platform } = info;
  if (capture.mode === 'sandbox') return 'Capture: test sandbox';
  if (capture.mode === 'polling' && platform === 'win32') {
    const missing = [
      capture.sourceDetection ? null : 'source app',
      capture.appExclusion ? null : 'exclusions',
      capture.privateFormatDetection ? null : 'private-copy detection',
    ].filter((name): name is string => name !== null);
    return missing.length === 0
      ? 'Capture: polling fallback (source app, exclusions and private-copy detection still on)'
      : `Capture: polling fallback (no ${joinNames(missing)})`;
  }
  return capture.sourceDetection
    ? 'Source app and page detection: on'
    : 'Source app detection is available on Windows';
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1) ?? ''}`;
}
