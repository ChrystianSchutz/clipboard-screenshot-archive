import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormatRead, Win32Clipboard } from './user32';
import { Win32SourceProbe } from './win32-source-probe';

/** Fake native layer with the facts a probe asks about, all switchable per test. */
class FakeNative implements Win32Clipboard {
  formats = new Set<string>();
  /** Formats whose names could not be registered (presence unknown). */
  unknownFormats = new Set<string>();
  /** DWORD formats that are there but could not be read (clipboard held open by another app). */
  unreadable = new Set<string>();
  owner: { pid: number; via: 'owner' | 'foreground' } | null = { pid: 1234, via: 'owner' };
  imagePath: string | null = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  htmlHeader: string | null = 'Version:0.9\r\nSourceURL:https://example.com/docs\r\n<html>';

  readonly addListener = vi.fn(() => true);
  readonly removeListener = vi.fn(() => true);
  readonly sequenceNumber = vi.fn(() => 1);
  readonly formatPresence = vi.fn<Win32Clipboard['formatPresence']>((name) => {
    if (this.unknownFormats.has(name)) return 'unknown';
    return this.formats.has(name) ? 'present' : 'absent';
  });
  readonly ownerProcess = vi.fn(() => this.owner);
  readonly processImagePath = vi.fn<Win32Clipboard['processImagePath']>(() => this.imagePath);
  readonly readHtmlHeader = vi.fn(() => this.htmlHeader);
  /** Values of DWORD formats on the clipboard, by name (absent = not on the clipboard). */
  dwords = new Map<string, number>();
  readonly readDwordFormat = vi.fn((name: string): FormatRead<number> => {
    if (this.unreadable.has(name)) return { state: 'unreadable' };
    const value = this.dwords.get(name);
    return value === undefined ? { state: 'absent' } : { state: 'present', value };
  });
}

/** Clipboard & Screenshot Archive's own process id in these tests (never the owner pid 1234 used by the fake). */
const OWN_PID = 999;

describe('Win32SourceProbe', () => {
  let native: FakeNative;
  let probe: Win32SourceProbe;

  beforeEach(() => {
    native = new FakeNative();
    probe = new Win32SourceProbe(native, OWN_PID);
  });

  it('resolves the owner executable name and the page URL', () => {
    expect(probe.probe()).toEqual({
      exe: 'chrome.exe',
      url: 'https://example.com/docs',
      hasPrivateFormat: false,
    });
    expect(native.processImagePath).toHaveBeenCalledWith(1234);
  });

  it.each(['ExcludeClipboardContentFromMonitorProcessing', 'Clipboard Viewer Ignore'])(
    'reports private content marked with %s and reads nothing else',
    (format) => {
      native.formats.add(format);

      expect(probe.probe()).toEqual({ exe: null, url: null, hasPrivateFormat: true });
      expect(native.ownerProcess).not.toHaveBeenCalled();
      expect(native.processImagePath).not.toHaveBeenCalled();
      expect(native.readHtmlHeader).not.toHaveBeenCalled();
    },
  );

  it('treats CanIncludeInClipboardHistory = 0 as private and reads nothing else', () => {
    native.dwords.set('CanIncludeInClipboardHistory', 0);

    expect(probe.probe()).toEqual({ exe: null, url: null, hasPrivateFormat: true });
    expect(native.ownerProcess).not.toHaveBeenCalled();
    expect(native.readHtmlHeader).not.toHaveBeenCalled();
  });

  describe('privacy markers that cannot be read fail closed', () => {
    const UNREADABLE = { exe: null, url: null, hasPrivateFormat: true, privacyUnreadable: true };

    it('reports an unreadable CanIncludeInClipboardHistory as possibly private, not absent', () => {
      native.unreadable.add('CanIncludeInClipboardHistory');

      expect(probe.probe()).toEqual(UNREADABLE);
      expect(native.ownerProcess).not.toHaveBeenCalled();
      expect(native.readHtmlHeader).not.toHaveBeenCalled();
    });

    it.each(['ExcludeClipboardContentFromMonitorProcessing', 'Clipboard Viewer Ignore'])(
      'reports %s whose presence is unknown as possibly private',
      (format) => {
        native.unknownFormats.add(format);

        expect(probe.probe()).toEqual(UNREADABLE);
      },
    );

    it('a marker that is surely there wins over one that cannot be read', () => {
      native.formats.add('Clipboard Viewer Ignore');
      native.unreadable.add('CanIncludeInClipboardHistory');

      expect(probe.probe()).toEqual({ exe: null, url: null, hasPrivateFormat: true });
    });

    it('an unreadable marker is not outweighed by others that are surely absent', () => {
      native.dwords.set('CanIncludeInClipboardHistory', 1);
      native.unknownFormats.add('ExcludeClipboardContentFromMonitorProcessing');

      expect(probe.probe()).toEqual(UNREADABLE);
    });
  });

  it('records content that explicitly allows history (CanIncludeInClipboardHistory = 1)', () => {
    native.dwords.set('CanIncludeInClipboardHistory', 1);

    expect(probe.probe()).toMatchObject({ exe: 'chrome.exe', hasPrivateFormat: false });
  });

  it('reports the native clipboard sequence number', () => {
    native.sequenceNumber.mockReturnValue(314);

    expect(probe.sequenceNumber()).toBe(314);
  });

  it('declares every capture capability', () => {
    expect(probe.capabilities).toEqual({
      sourceDetection: true,
      appExclusion: true,
      privateFormatDetection: true,
    });
  });

  it('leaves exe null and skips the path lookup when no owner process is found', () => {
    native.owner = null;

    expect(probe.probe().exe).toBeNull();
    expect(native.processImagePath).not.toHaveBeenCalled();
  });

  it('leaves exe null when the image path cannot be read (e.g. an elevated process)', () => {
    native.imagePath = null;

    expect(probe.probe().exe).toBeNull();
  });

  it('uses the foreground fallback process like the real owner', () => {
    native.owner = { pid: 77, via: 'foreground' };

    expect(probe.probe().exe).toBe('chrome.exe');
    expect(native.processImagePath).toHaveBeenCalledWith(77);
  });

  it('never attributes a copy to Clipboard & Screenshot Archive itself when the owner is its own process', () => {
    native.owner = { pid: OWN_PID, via: 'foreground' };

    expect(probe.probe().exe).toBeNull();
    expect(native.processImagePath).not.toHaveBeenCalled();
  });

  it('still reads the page URL when the owner is Clipboard & Screenshot Archive itself', () => {
    native.owner = { pid: OWN_PID, via: 'owner' };

    expect(probe.probe().url).toBe('https://example.com/docs');
  });

  it('uses the current process id as its own pid by default', () => {
    native.owner = { pid: process.pid, via: 'foreground' };

    expect(new Win32SourceProbe(native).probe().exe).toBeNull();
  });

  it('leaves url null when there is no HTML on the clipboard', () => {
    native.htmlHeader = null;

    expect(probe.probe().url).toBeNull();
  });

  it('leaves url null when the HTML header has no usable SourceURL', () => {
    native.htmlHeader = 'Version:0.9\r\nSourceURL:file:///C:/page.html\r\n<html>';

    expect(probe.probe().url).toBeNull();
  });
});
