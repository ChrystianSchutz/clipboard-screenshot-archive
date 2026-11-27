/**
 * Electron accelerator helpers shared by the tray (main) and the shortcut recorder (renderer).
 * https://www.electronjs.org/docs/latest/api/accelerator
 */

/** Human-readable form of an accelerator: "CommandOrControl+Alt+V" → "Ctrl+Alt+V" (⌘ on macOS). */
export function displayAccelerator(accelerator: string, platform: string): string {
  const ctrl = platform === 'darwin' ? '⌘' : 'Ctrl';
  return accelerator
    .replace(/CommandOrControl|CmdOrCtrl/gi, ctrl)
    .replace(/\bControl\b/gi, 'Ctrl')
    .replace(/\bCommand\b/gi, '⌘');
}

/** The subset of a KeyboardEvent the recorder needs (keeps this testable without a DOM). */
export interface KeyChord {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

export type ChordResult =
  | { readonly status: 'complete'; readonly accelerator: string }
  /** Only modifiers held so far: keep listening. */
  | { readonly status: 'pending' }
  | { readonly status: 'invalid'; readonly reason: string };

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS']);

const NAMED_KEYS: Readonly<Record<string, string>> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

/**
 * Maps the physical key (`event.code`) to an accelerator key code. Using `code` rather than `key`
 * keeps Alt+V working on layouts where AltGr turns V into another character.
 */
export function acceleratorKey(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1] ?? null;
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(code);
  if (digit) return digit[1] ?? null;
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return NAMED_KEYS[code] ?? null;
}

/**
 * Turns a keydown into an accelerator for a *global* shortcut. A global shortcut without
 * Ctrl/Alt/Cmd would swallow normal typing in every app, so at least one of those is required.
 */
export function chordToAccelerator(chord: KeyChord, platform: string): ChordResult {
  if (MODIFIER_KEYS.has(chord.key)) return { status: 'pending' };

  const key = acceleratorKey(chord.code);
  if (key === null)
    return { status: 'invalid', reason: `"${chord.key}" cannot be used in a shortcut` };

  const isMac = platform === 'darwin';
  const primary = isMac ? chord.metaKey : chord.ctrlKey;
  const parts: string[] = [];
  if (primary) parts.push('CommandOrControl');
  if (isMac && chord.ctrlKey) parts.push('Control');
  if (!isMac && chord.metaKey) parts.push('Super');
  if (chord.altKey) parts.push('Alt');
  if (chord.shiftKey) parts.push('Shift');

  if (!primary && !chord.altKey && !(isMac && chord.ctrlKey)) {
    return { status: 'invalid', reason: `Add ${isMac ? '⌘, ⌃' : 'Ctrl'} or Alt to the shortcut` };
  }
  return { status: 'complete', accelerator: [...parts, key].join('+') };
}
