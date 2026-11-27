import { useEffect, useState } from 'react';
import { displayAccelerator } from '@shared/accelerator';
import type { View } from '@shared/ipc-contract';
import type { AppInfo } from '@shared/types';
import { api } from '../api';
import { Icon, type IconName } from '../components/Icon';
import { HistoryView } from '../features/history/HistoryView';
import { ScreenshotsView } from '../features/screenshots/ScreenshotsView';
import { SettingsView } from '../features/settings/SettingsView';
import { StatsView } from '../features/stats/StatsView';
import { useSettings } from '../hooks/useSettings';
import { useToast } from '../hooks/useToast';
import './palette.css';

const TABS: readonly { view: View; label: string; icon: IconName }[] = [
  { view: 'history', label: 'History', icon: 'history' },
  { view: 'screenshots', label: 'Screenshots', icon: 'image' },
  { view: 'stats', label: 'Stats', icon: 'chart' },
  { view: 'settings', label: 'Settings', icon: 'settings' },
];

/** The frameless window opened by the global shortcut: history, screenshots, stats and settings. */
export function PaletteApp() {
  const [view, setView] = useState<View>('history');
  const [focusToken, setFocusToken] = useState(0);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const { settings, update } = useSettings();
  const { toast, notify } = useToast();

  useEffect(
    () =>
      api.window.onShowView((next) => {
        setView(next);
        setFocusToken((token) => token + 1);
      }),
    [],
  );

  useEffect(() => {
    api.app.info().then(setInfo, () => undefined);
  }, []);

  // Ctrl+1/2/3/4 switch tabs from anywhere in the window.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const tab = TABS[Number(event.key) - 1];
      if (!tab) return;
      event.preventDefault();
      setView(tab.view);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const platform = info?.platform ?? 'win32';
  const shortcutLabel = settings
    ? displayAccelerator(settings.shortcuts.openHistory, platform)
    : '';

  return (
    <div className="palette">
      <header className="titlebar">
        <div className="titlebar__brand">
          <img src="./icon.png" alt="" width={18} height={18} />
          Clipboard & Screenshot Archive
        </div>
        <nav className="tabs" role="tablist" aria-label="Sections">
          {TABS.map((tab, index) => (
            <button
              key={tab.view}
              type="button"
              role="tab"
              aria-selected={view === tab.view}
              title={`${tab.label} (Ctrl+${String(index + 1)})`}
              className="tabs__tab"
              onClick={() => setView(tab.view)}
            >
              <Icon name={tab.icon} size={14} />
              {tab.label}
            </button>
          ))}
        </nav>
        <span className="titlebar__drag" />
        <button
          type="button"
          className="button button--ghost button--icon titlebar__close"
          aria-label="Hide window (Esc)"
          title="Hide (Esc)"
          onClick={() => void api.window.hide()}
        >
          <Icon name="close" size={14} />
        </button>
      </header>

      <main className="palette__content" role="tabpanel" aria-label={view}>
        {view === 'history' && (
          <HistoryView
            shortcutLabel={shortcutLabel}
            captureEnabled={settings?.captureEnabled ?? true}
            focusToken={focusToken}
            onNotify={notify}
            onOpenSettings={() => setView('settings')}
          />
        )}
        {view === 'screenshots' && (
          <ScreenshotsView
            platform={platform}
            focusToken={focusToken}
            onNotify={notify}
            onOpenSettings={() => setView('settings')}
          />
        )}
        {view === 'stats' && <StatsView />}
        {view === 'settings' && settings && (
          <SettingsView settings={settings} info={info} onUpdate={update} onNotify={notify} />
        )}
      </main>

      <div className="toast-region" aria-live="polite">
        {toast && (
          <div key={toast.id} className="toast">
            <Icon name="check" size={14} />
            {toast.message}
          </div>
        )}
      </div>
    </div>
  );
}
