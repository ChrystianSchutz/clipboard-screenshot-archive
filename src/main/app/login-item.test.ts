import { describe, expect, it, vi } from 'vitest';
import {
  MemoryLoginItem,
  applyLoginItem,
  electronLoginItem,
  isLoginItemPlatform,
  type LoginItemPort,
  type LoginItemResult,
} from './login-item';

const errorOf = (result: LoginItemResult): string | null => (result.ok ? null : result.error);

describe('applyLoginItem', () => {
  it('succeeds when the OS confirms the change', () => {
    const port = new MemoryLoginItem();

    expect(applyLoginItem(port, true)).toEqual({ ok: true });
    expect(port.isEnabled()).toBe(true);
  });

  it('refuses on a platform without login items, without calling the OS', () => {
    const port = new MemoryLoginItem(false);
    const set = vi.spyOn(port, 'setEnabled');

    expect(errorOf(applyLoginItem(port, true))).toMatch(/not available/);
    expect(set).not.toHaveBeenCalled();
  });

  it('reports an OS error', () => {
    const port: LoginItemPort = {
      supported: true,
      isEnabled: () => false,
      setEnabled: () => {
        throw new Error('Access is denied');
      },
    };

    expect(errorOf(applyLoginItem(port, true))).toMatch(/Access is denied/);
  });

  it('fails when the OS silently ignores the change (read-back differs)', () => {
    const port: LoginItemPort = {
      supported: true,
      isEnabled: () => false,
      setEnabled: () => undefined,
    };

    expect(applyLoginItem(port, true).ok).toBe(false);
  });
});

describe('electronLoginItem', () => {
  it('registers and reads back with the same --hidden arguments', () => {
    const app = {
      getLoginItemSettings: vi.fn(() => ({ openAtLogin: true })),
      setLoginItemSettings: vi.fn(),
    };
    const port = electronLoginItem(app, 'win32');

    port.setEnabled(true);

    expect(port.isEnabled()).toBe(true);
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      args: ['--hidden'],
    });
    expect(app.getLoginItemSettings).toHaveBeenCalledWith({ args: ['--hidden'] });
  });

  it.each([
    ['win32', true],
    ['darwin', true],
    ['linux', false],
  ] as const)('%s supported: %s', (platform, supported) => {
    expect(isLoginItemPlatform(platform)).toBe(supported);
  });
});
