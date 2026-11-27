import { useCallback, useEffect, useState } from 'react';
import type { SettingsPatch } from '@shared/ipc-contract';
import type { Settings, SettingsUpdateResult } from '@shared/types';
import { api } from '../api';
import { applyAccent } from '../theme/apply-accent';
import { applyTheme } from '../theme/apply-theme';

export interface SettingsState {
  readonly settings: Settings | null;
  /** Applies a patch; resolves with the error message when the OS refused it (e.g. a taken shortcut). */
  readonly update: (patch: SettingsPatch) => Promise<string | null>;
}

/**
 * Settings live in the main process; this hook mirrors them and applies patches. Every window
 * listens for `settings:changed`, so a change made in one window (or from the tray) shows up in
 * all of them, and the theme and accent colour are applied to the document whenever they change.
 */
export function useSettings(): SettingsState {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    let active = true;
    api.settings.get().then(
      (value) => {
        if (active) setSettings(value);
      },
      () => undefined,
    );
    const unsubscribe = api.settings.onChanged((value) => {
      if (active) setSettings(value);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const accentColor = settings?.accentColor;
  useEffect(() => {
    if (accentColor) applyAccent(accentColor);
  }, [accentColor]);

  const theme = settings?.theme;
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);

  const update = useCallback(async (patch: SettingsPatch) => {
    const result: SettingsUpdateResult = await api.settings.update(patch);
    setSettings(result.settings);
    return result.ok ? null : result.error;
  }, []);

  return { settings, update };
}
