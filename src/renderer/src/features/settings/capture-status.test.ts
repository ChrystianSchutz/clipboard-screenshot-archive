import { describe, expect, it } from 'vitest';
import type { AppInfo, CaptureInfo } from '@shared/types';
import { captureStatus } from './capture-status';

const ALL = { sourceDetection: true, appExclusion: true, privateFormatDetection: true };
const NONE = { sourceDetection: false, appExclusion: false, privateFormatDetection: false };

function info(platform: string, capture: CaptureInfo): AppInfo {
  return {
    version: '1.0.0',
    platform,
    sourceDetection: capture.sourceDetection,
    capture,
    launchAtLoginSupported: true,
  };
}

describe('captureStatus', () => {
  it('says nothing before the app info arrives', () => {
    expect(captureStatus(null)).toBe('');
  });

  it('does not claim lost detection when the Windows poller still has the native probe', () => {
    expect(captureStatus(info('win32', { mode: 'polling', ...ALL }))).toBe(
      'Capture: polling fallback (source app, exclusions and private-copy detection still on)',
    );
  });

  it('names what the Windows poller lacks when the native probe is missing', () => {
    expect(captureStatus(info('win32', { mode: 'polling', ...NONE }))).toBe(
      'Capture: polling fallback (no source app, exclusions or private-copy detection)',
    );
    expect(
      captureStatus(info('win32', { mode: 'polling', ...ALL, privateFormatDetection: false })),
    ).toBe('Capture: polling fallback (no private-copy detection)');
  });

  it('describes event capture and the other platforms by their capabilities', () => {
    expect(captureStatus(info('win32', { mode: 'event', ...ALL }))).toBe(
      'Source app and page detection: on',
    );
    expect(captureStatus(info('darwin', { mode: 'polling', ...NONE }))).toBe(
      'Source app detection is available on Windows',
    );
    expect(captureStatus(info('win32', { mode: 'sandbox', ...NONE }))).toBe(
      'Capture: test sandbox',
    );
  });
});
