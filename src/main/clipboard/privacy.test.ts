import { describe, expect, it } from 'vitest';
import {
  MAX_CLIP_CHARS,
  PRIVATE_CLIPBOARD_FORMATS,
  skipReason,
  type PrivacyInput,
} from './privacy';

function input(overrides: Partial<PrivacyInput> = {}): PrivacyInput {
  return {
    text: 'hello',
    exe: 'Code.exe',
    hasPrivateFormat: false,
    excludedApps: ['KeePassXC.exe', '1Password.exe'],
    ...overrides,
  };
}

describe('skipReason', () => {
  it('allows ordinary text from an ordinary app', () => {
    expect(skipReason(input())).toBeNull();
  });

  it('allows text when the owning app is unknown', () => {
    expect(skipReason(input({ exe: null }))).toBeNull();
  });

  it('skips content marked private', () => {
    expect(skipReason(input({ hasPrivateFormat: true }))).toBe('private-format');
  });

  it('reports private-format first, even for empty text from an excluded app', () => {
    expect(skipReason(input({ hasPrivateFormat: true, exe: 'KeePassXC.exe', text: '' }))).toBe(
      'private-format',
    );
  });

  it.each(['KeePassXC.exe', 'keepassxc.exe', 'KEEPASSXC.EXE'])(
    'skips the excluded app %s regardless of case',
    (exe) => {
      expect(skipReason(input({ exe }))).toBe('excluded-app');
    },
  );

  it('matches excluded apps by whole name, not by prefix', () => {
    expect(skipReason(input({ exe: 'KeePassXC.exe.bak' }))).toBeNull();
    expect(skipReason(input({ exe: 'KeePass.exe' }))).toBeNull();
  });

  it('reports excluded-app before empty', () => {
    expect(skipReason(input({ exe: '1Password.exe', text: '' }))).toBe('excluded-app');
  });

  it('ignores an empty exe name instead of matching it', () => {
    expect(skipReason(input({ exe: '', excludedApps: [''] }))).toBeNull();
  });

  it.each(['', ' ', '\r\n\t'])('skips blank text %j', (text) => {
    expect(skipReason(input({ text }))).toBe('empty');
  });

  it('allows text of exactly the maximum size', () => {
    expect(skipReason(input({ text: 'a'.repeat(MAX_CLIP_CHARS) }))).toBeNull();
  });

  it('skips text over the maximum size', () => {
    expect(skipReason(input({ text: 'a'.repeat(MAX_CLIP_CHARS + 1) }))).toBe('too-large');
  });
});

describe('PRIVATE_CLIPBOARD_FORMATS', () => {
  it('lists the formats Windows clipboard history honours', () => {
    expect(PRIVATE_CLIPBOARD_FORMATS).toEqual([
      'ExcludeClipboardContentFromMonitorProcessing',
      'Clipboard Viewer Ignore',
    ]);
  });
});
