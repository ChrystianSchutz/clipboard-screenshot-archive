/**
 * Privacy rules applied before anything is written to disk.
 *
 * Password managers (KeePass, 1Password, Bitwarden, ...) mark secrets they copy with special
 * clipboard formats. Windows' own clipboard history honours these; so do we.
 * @see https://learn.microsoft.com/windows/win32/dataxchg/clipboard-formats#cloud-clipboard-and-clipboard-history-formats
 */
export const PRIVATE_CLIPBOARD_FORMATS = [
  'ExcludeClipboardContentFromMonitorProcessing',
  'Clipboard Viewer Ignore',
] as const;

/**
 * DWORD format an app sets to say whether the content may enter clipboard history:
 * 0 = private (never record it), 1 = allowed. Its mere presence means nothing.
 */
export const HISTORY_OPT_OUT_FORMAT = 'CanIncludeInClipboardHistory';

/** Text larger than this is skipped: a clipboard history is not a file store. */
export const MAX_CLIP_CHARS = 1_000_000;

export type SkipReason = 'empty' | 'too-large' | 'private-format' | 'excluded-app';

export interface PrivacyInput {
  readonly text: string;
  readonly exe: string | null;
  readonly hasPrivateFormat: boolean;
  readonly excludedApps: readonly string[];
}

/** Returns why a clipboard change must not be recorded, or `null` when it may be. */
export function skipReason(input: PrivacyInput): SkipReason | null {
  if (input.hasPrivateFormat) return 'private-format';
  const exe = input.exe?.toLowerCase();
  if (exe && input.excludedApps.some((app) => app.toLowerCase() === exe)) return 'excluded-app';
  if (input.text.trim() === '') return 'empty';
  if (input.text.length > MAX_CLIP_CHARS) return 'too-large';
  return null;
}
