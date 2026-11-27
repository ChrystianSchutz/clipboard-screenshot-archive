/**
 * "Launch at login" as a port: the OS registration is the truth, the stored setting only mirrors
 * it. Electron registers login items on Windows and macOS only (Linux: a silent no-op), so the
 * option is hidden elsewhere, and a setting is stored only after the OS confirms the change.
 */
export interface LoginItemPort {
  readonly supported: boolean;
  isEnabled(): boolean;
  /** Throws when the OS refuses (policy, permissions). */
  setEnabled(enabled: boolean): void;
}

export type LoginItemResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

/** The subset of Electron's `app` used here. */
export interface LoginItemApp {
  getLoginItemSettings(options?: { args?: string[] }): { openAtLogin: boolean };
  setLoginItemSettings(settings: { openAtLogin: boolean; args?: string[] }): void;
}

/** Started from a login item, the app goes straight to the tray. */
const LOGIN_ARGS = ['--hidden'];

export function isLoginItemPlatform(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

export function electronLoginItem(app: LoginItemApp, platform: NodeJS.Platform): LoginItemPort {
  return {
    supported: isLoginItemPlatform(platform),
    // Windows matches the registered entry by path and arguments, so ask with the same arguments.
    isEnabled: () => app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin,
    setEnabled: (openAtLogin) => {
      app.setLoginItemSettings({ openAtLogin, args: LOGIN_ARGS });
    },
  };
}

/** E2E and smoke runs: never touches the OS (the user's real login items). */
export class MemoryLoginItem implements LoginItemPort {
  constructor(
    readonly supported = true,
    private enabled = false,
  ) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}

/** Asks the OS for the change and reads it back; only `ok` may be persisted. */
export function applyLoginItem(port: LoginItemPort, enabled: boolean): LoginItemResult {
  if (!port.supported) {
    return { ok: false, error: 'Launch at login is not available on this system.' };
  }
  try {
    port.setEnabled(enabled);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `The system refused to change launch at login: ${reason}` };
  }
  if (port.isEnabled() !== enabled) {
    return { ok: false, error: 'The system did not accept the launch at login change.' };
  }
  return { ok: true };
}
