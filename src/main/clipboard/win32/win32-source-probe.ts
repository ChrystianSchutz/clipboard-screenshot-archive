import { exeFromPath } from '../source/app-names';
import { parseCfHtmlSourceUrl } from '../source/cf-html';
import { HISTORY_OPT_OUT_FORMAT, PRIVATE_CLIPBOARD_FORMATS } from '../privacy';
import type { ProbeResult, SourceProbe } from '../ports';
import type { Win32Clipboard } from './user32';

/**
 * Resolves the clipboard owner's executable, the page URL (if the app published one) and the
 * password-manager privacy markers. When content is private, nothing else is read.
 */
export class Win32SourceProbe implements SourceProbe {
  readonly capabilities = {
    sourceDetection: true,
    appExclusion: true,
    privateFormatDetection: true,
  };

  /**
   * @param ownPid Clipboard & Screenshot Archive's own (browser) process. When the real owner is already gone and the
   *   focused window is ours, attributing the copy to Clipboard & Screenshot Archive would be wrong: report it unknown.
   */
  constructor(
    private readonly native: Win32Clipboard,
    private readonly ownPid: number = process.pid,
  ) {}

  sequenceNumber(): number {
    return this.native.sequenceNumber();
  }

  probe(): ProbeResult {
    const privacy = this.privacy();
    if (privacy === 'private') return { exe: null, url: null, hasPrivateFormat: true };
    // Fail closed: "could not tell" is reported as private, plus the flag that allows a retry.
    if (privacy === 'unknown') {
      return { exe: null, url: null, hasPrivateFormat: true, privacyUnreadable: true };
    }

    const owner = this.native.ownerProcess();
    const path =
      owner && owner.pid !== this.ownPid ? this.native.processImagePath(owner.pid) : null;
    const header = this.native.readHtmlHeader();
    return {
      exe: path ? exeFromPath(path) : null,
      url: header ? parseCfHtmlSourceUrl(header) : null,
      hasPrivateFormat: false,
    };
  }

  /**
   * Every privacy marker, with three outcomes. A marker that is surely there wins over one that
   * could not be read; content counts as public only when every marker is surely absent (or the
   * DWORD surely allows history).
   */
  private privacy(): 'private' | 'public' | 'unknown' {
    let unknown = false;
    for (const format of PRIVATE_CLIPBOARD_FORMATS) {
      const presence = this.native.formatPresence(format);
      if (presence === 'present') return 'private';
      if (presence === 'unknown') unknown = true;
    }
    // Value 0 means "keep this out of clipboard history"; 1 (or no format at all) allows it.
    const optOut = this.native.readDwordFormat(HISTORY_OPT_OUT_FORMAT);
    if (optOut.state === 'present' && optOut.value === 0) return 'private';
    if (optOut.state === 'unreadable') unknown = true;
    return unknown ? 'unknown' : 'public';
  }
}
