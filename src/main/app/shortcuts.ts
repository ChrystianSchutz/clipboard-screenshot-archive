import type { Shortcuts } from '@shared/types';

/** The subset of Electron's `globalShortcut` we use; a fake implements it in tests. */
export interface GlobalShortcutPort {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export interface ShortcutActions {
  readonly openHistory: () => void;
  readonly compare: () => void;
}

export type ApplyResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

const LABELS: Record<keyof Shortcuts, string> = {
  openHistory: 'Open history',
  compare: 'Compare',
};
const KEYS = Object.keys(LABELS) as (keyof Shortcuts)[];

/**
 * Registers the global shortcuts transactionally: if any accelerator is invalid or taken by
 * another app, the previous set is restored and the caller gets a readable error.
 */
export class ShortcutManager {
  private active: Shortcuts | null = null;

  constructor(
    private readonly port: GlobalShortcutPort,
    private readonly actions: ShortcutActions,
  ) {}

  get current(): Shortcuts | null {
    return this.active;
  }

  apply(next: Shortcuts): ApplyResult {
    if (next.openHistory.toLowerCase() === next.compare.toLowerCase()) {
      return { ok: false, error: 'Both actions cannot use the same shortcut' };
    }

    const previous = this.active;
    this.unregisterAll();

    const failure = this.tryRegister(next);
    if (failure === null) {
      this.active = next;
      return { ok: true };
    }

    // tryRegister already undid its partial work; bring the previous set back.
    this.active = previous && this.tryRegister(previous) === null ? previous : null;
    return { ok: false, error: failure };
  }

  unregisterAll(): void {
    if (!this.active) return;
    for (const key of KEYS) this.port.unregister(this.active[key]);
  }

  /** Returns an error message, or `null` when every shortcut was registered. */
  private tryRegister(shortcuts: Shortcuts): string | null {
    const registered: string[] = [];
    for (const key of KEYS) {
      const accelerator = shortcuts[key];
      let ok: boolean;
      try {
        ok = this.port.register(accelerator, this.actions[key]);
      } catch {
        ok = false; // Electron throws for malformed accelerators.
      }
      if (!ok) {
        for (const done of registered) this.port.unregister(done);
        return `${LABELS[key]}: "${accelerator}" is invalid or already used by another app`;
      }
      registered.push(accelerator);
    }
    return null;
  }
}
