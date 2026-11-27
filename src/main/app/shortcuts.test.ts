import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Shortcuts } from '@shared/types';
import { FakeGlobalShortcut } from '../test-support/fakes';
import { ShortcutManager, type ShortcutActions } from './shortcuts';

const FIRST: Shortcuts = {
  openHistory: 'CommandOrControl+Alt+V',
  compare: 'CommandOrControl+Alt+D',
};
const SECOND: Shortcuts = { openHistory: 'Alt+Shift+H', compare: 'Alt+Shift+C' };

describe('ShortcutManager', () => {
  let port: FakeGlobalShortcut;
  let actions: { openHistory: Mock<() => void>; compare: Mock<() => void> };
  let manager: ShortcutManager;

  beforeEach(() => {
    port = new FakeGlobalShortcut();
    actions = { openHistory: vi.fn<() => void>(), compare: vi.fn<() => void>() };
    manager = new ShortcutManager(port, actions satisfies ShortcutActions);
  });

  it('has no active shortcuts before the first apply', () => {
    expect(manager.current).toBeNull();
  });

  describe('apply', () => {
    it('registers both shortcuts and makes them current', () => {
      expect(manager.apply(FIRST)).toEqual({ ok: true });

      expect(port.accelerators).toEqual([FIRST.compare, FIRST.openHistory].sort());
      expect(manager.current).toEqual(FIRST);
    });

    it('wires each accelerator to its own action', () => {
      manager.apply(FIRST);

      port.registered.get(FIRST.compare)?.();

      expect(actions.compare).toHaveBeenCalledTimes(1);
      expect(actions.openHistory).not.toHaveBeenCalled();
    });

    it('replaces the previous shortcuts on a successful re-apply', () => {
      manager.apply(FIRST);

      expect(manager.apply(SECOND)).toEqual({ ok: true });

      expect(port.accelerators).toEqual([SECOND.compare, SECOND.openHistory].sort());
      expect(manager.current).toEqual(SECOND);
    });

    it('can re-apply the same shortcuts', () => {
      manager.apply(FIRST);

      expect(manager.apply(FIRST)).toEqual({ ok: true });
      expect(port.accelerators).toHaveLength(2);
    });

    it('rejects identical accelerators (ignoring case) without touching the OS', () => {
      manager.apply(FIRST);
      port.register.mockClear();
      port.unregister.mockClear();

      const result = manager.apply({ openHistory: 'Alt+X', compare: 'alt+x' });

      expect(result).toEqual({ ok: false, error: 'Both actions cannot use the same shortcut' });
      expect(port.register).not.toHaveBeenCalled();
      expect(port.unregister).not.toHaveBeenCalled();
      expect(manager.current).toEqual(FIRST);
    });

    it('restores the previous shortcuts when a new one is taken by another app', () => {
      manager.apply(FIRST);
      port.taken.add(SECOND.compare);

      const result = manager.apply(SECOND);

      expect(result).toEqual({
        ok: false,
        error: `Compare: "${SECOND.compare}" is invalid or already used by another app`,
      });
      expect(port.accelerators).toEqual([FIRST.compare, FIRST.openHistory].sort());
      expect(manager.current).toEqual(FIRST);
    });

    it('does not leave the half-registered new shortcut behind after a conflict', () => {
      manager.apply(FIRST);
      port.taken.add(SECOND.compare);

      manager.apply(SECOND);

      expect(port.registered.has(SECOND.openHistory)).toBe(false);
    });

    it('treats a malformed accelerator that throws like a failed registration', () => {
      manager.apply(FIRST);
      port.malformed.add('Ctrl+Nope');

      const result = manager.apply({ openHistory: 'Ctrl+Nope', compare: 'Alt+C' });

      expect(result).toEqual({
        ok: false,
        error: 'Open history: "Ctrl+Nope" is invalid or already used by another app',
      });
      expect(manager.current).toEqual(FIRST);
      expect(port.registered.has('Alt+C')).toBe(false);
    });

    it('ends with nothing registered when the very first apply fails', () => {
      port.taken.add(FIRST.openHistory);

      expect(manager.apply(FIRST).ok).toBe(false);

      expect(port.accelerators).toEqual([]);
      expect(manager.current).toBeNull();
    });

    it('ends with nothing active when the previous shortcuts were taken in the meantime', () => {
      manager.apply(FIRST);
      port.taken.add(SECOND.openHistory);
      port.taken.add(FIRST.compare); // another app grabbed it while we were re-registering

      const result = manager.apply(SECOND);

      expect(result.ok).toBe(false);
      expect(manager.current).toBeNull();
      expect(port.accelerators).toEqual([]);
    });
  });

  describe('unregisterAll', () => {
    it('unregisters every active accelerator', () => {
      manager.apply(FIRST);

      manager.unregisterAll();

      expect(port.accelerators).toEqual([]);
      expect(port.unregister).toHaveBeenCalledWith(FIRST.openHistory);
      expect(port.unregister).toHaveBeenCalledWith(FIRST.compare);
    });

    it('does nothing when no shortcuts are active', () => {
      manager.unregisterAll();

      expect(port.unregister).not.toHaveBeenCalled();
    });
  });
});
