import { describe, expect, it } from 'vitest';
import {
  acceleratorKey,
  chordToAccelerator,
  displayAccelerator,
  type KeyChord,
} from './accelerator';

function chord(code: string, modifiers: Partial<Omit<KeyChord, 'code'>> = {}): KeyChord {
  return {
    key: code.replace(/^Key/, '').toLowerCase(),
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...modifiers,
  };
}

describe('displayAccelerator', () => {
  it('shows CommandOrControl as Ctrl on Windows and Linux', () => {
    expect(displayAccelerator('CommandOrControl+Alt+V', 'win32')).toBe('Ctrl+Alt+V');
    expect(displayAccelerator('CommandOrControl+Alt+V', 'linux')).toBe('Ctrl+Alt+V');
  });

  it('shows CommandOrControl as ⌘ on macOS', () => {
    expect(displayAccelerator('CommandOrControl+Alt+V', 'darwin')).toBe('⌘+Alt+V');
  });

  it('understands the CmdOrCtrl alias, in any case', () => {
    expect(displayAccelerator('cmdorctrl+Shift+X', 'win32')).toBe('Ctrl+Shift+X');
  });

  it('shortens Control to Ctrl and Command to ⌘', () => {
    expect(displayAccelerator('Control+Alt+V', 'darwin')).toBe('Ctrl+Alt+V');
    expect(displayAccelerator('Command+Q', 'darwin')).toBe('⌘+Q');
  });

  it('leaves other keys untouched', () => {
    expect(displayAccelerator('Alt+Shift+F12', 'win32')).toBe('Alt+Shift+F12');
  });
});

describe('acceleratorKey', () => {
  it.each([
    ['KeyA', 'A'],
    ['KeyZ', 'Z'],
    ['Digit5', '5'],
    ['Numpad7', '7'],
    ['F1', 'F1'],
    ['F12', 'F12'],
    ['F24', 'F24'],
    ['ArrowUp', 'Up'],
    ['ArrowLeft', 'Left'],
    ['Space', 'Space'],
    ['Backquote', '`'],
    ['Backslash', '\\'],
    ['Period', '.'],
  ])('maps %s to %s', (code, expected) => {
    expect(acceleratorKey(code)).toBe(expected);
  });

  it.each(['F0', 'F25', 'ShiftLeft', 'ControlRight', 'Keya', 'IntlBackslash', 'NumpadAdd', ''])(
    'returns null for the unsupported code %j',
    (code) => {
      expect(acceleratorKey(code)).toBeNull();
    },
  );
});

describe('chordToAccelerator', () => {
  it.each(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'])(
    'keeps listening while only the %s modifier is down',
    (key) => {
      expect(
        chordToAccelerator({ ...chord('ControlLeft', { ctrlKey: true }), key }, 'win32'),
      ).toEqual({
        status: 'pending',
      });
    },
  );

  it('builds a CommandOrControl accelerator from Ctrl on Windows', () => {
    expect(chordToAccelerator(chord('KeyV', { ctrlKey: true, altKey: true }), 'win32')).toEqual({
      status: 'complete',
      accelerator: 'CommandOrControl+Alt+V',
    });
  });

  it('builds a CommandOrControl accelerator from ⌘ on macOS', () => {
    expect(chordToAccelerator(chord('KeyV', { metaKey: true, shiftKey: true }), 'darwin')).toEqual({
      status: 'complete',
      accelerator: 'CommandOrControl+Shift+V',
    });
  });

  it('accepts Alt alone as the required modifier', () => {
    expect(chordToAccelerator(chord('KeyH', { altKey: true }), 'win32')).toEqual({
      status: 'complete',
      accelerator: 'Alt+H',
    });
  });

  it('accepts ⌃ alone on macOS, as Control', () => {
    expect(chordToAccelerator(chord('KeyV', { ctrlKey: true }), 'darwin')).toEqual({
      status: 'complete',
      accelerator: 'Control+V',
    });
  });

  it('orders modifiers consistently on Windows: CommandOrControl, Super, Alt, Shift', () => {
    const all = { ctrlKey: true, metaKey: true, altKey: true, shiftKey: true };

    expect(chordToAccelerator(chord('KeyK', all), 'win32')).toEqual({
      status: 'complete',
      accelerator: 'CommandOrControl+Super+Alt+Shift+K',
    });
  });

  it('orders modifiers consistently on macOS: CommandOrControl, Control, Alt, Shift', () => {
    const all = { ctrlKey: true, metaKey: true, altKey: true, shiftKey: true };

    expect(chordToAccelerator(chord('KeyK', all), 'darwin')).toEqual({
      status: 'complete',
      accelerator: 'CommandOrControl+Control+Alt+Shift+K',
    });
  });

  it('uses the physical key, so AltGr layouts still produce the letter', () => {
    const polishAltGrS = { ...chord('KeyS', { ctrlKey: true, altKey: true }), key: 'ś' };

    expect(chordToAccelerator(polishAltGrS, 'win32')).toEqual({
      status: 'complete',
      accelerator: 'CommandOrControl+Alt+S',
    });
  });

  it.each([
    ['no modifier', {}],
    ['Shift only', { shiftKey: true }],
    ['the Windows key only', { metaKey: true }],
  ])('rejects a key with %s on Windows, since it would swallow typing', (_label, modifiers) => {
    expect(chordToAccelerator(chord('KeyV', modifiers), 'win32')).toEqual({
      status: 'invalid',
      reason: 'Add Ctrl or Alt to the shortcut',
    });
  });

  it('tells macOS users which modifiers they can add', () => {
    expect(chordToAccelerator(chord('KeyV', { shiftKey: true }), 'darwin')).toEqual({
      status: 'invalid',
      reason: 'Add ⌘, ⌃ or Alt to the shortcut',
    });
  });

  it('rejects a key that has no accelerator code, naming the key', () => {
    const lessThan = { ...chord('IntlBackslash', { ctrlKey: true }), key: '<' };

    expect(chordToAccelerator(lessThan, 'win32')).toEqual({
      status: 'invalid',
      reason: '"<" cannot be used in a shortcut',
    });
  });
});
