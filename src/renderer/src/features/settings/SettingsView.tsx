import { useState, type ReactNode, type SubmitEvent } from 'react';
import type { SettingsPatch } from '@shared/ipc-contract';
import type { AppInfo, CaptureInfo, Settings } from '@shared/types';
import { api } from '../../api';
import { Icon } from '../../components/Icon';
import { Toggle } from '../../components/primitives';
import { ImageRecognitionSettings } from '../ocr/ImageRecognitionSettings';
import { AppearanceSettings } from './AppearanceSettings';
import { captureStatus } from './capture-status';
import { ShortcutRecorder } from './ShortcutRecorder';
import './settings.css';

interface SettingsViewProps {
  readonly settings: Settings;
  readonly info: AppInfo | null;
  readonly onUpdate: (patch: SettingsPatch) => Promise<string | null>;
  readonly onNotify: (message: string) => void;
}

const MAX_CLIPS_OPTIONS = [500, 2000, 5000, 20000, 50000];

/** "Never record from" promises only what the capture adapter on this machine can deliver. */
function exclusionDescription(capture: CaptureInfo | undefined): string {
  if (capture && !capture.appExclusion) {
    return 'Not available here: this system does not report which app copied something.';
  }
  const names = 'Executable names.';
  return capture?.privateFormatDetection
    ? `${names} Password managers that mark their copies as private are skipped automatically.`
    : names;
}

function Row({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="setting">
      <div className="setting__text">
        <div className="setting__title">{title}</div>
        {description && <div className="setting__description">{description}</div>}
      </div>
      <div className="setting__control">{children}</div>
    </div>
  );
}

export function SettingsView({ settings, info, onUpdate, onNotify }: SettingsViewProps) {
  const platform = info?.platform ?? 'win32';
  const [newApp, setNewApp] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  const addExcluded = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const name = newApp.trim();
    if (name === '') return;
    const exists = settings.excludedApps.some((app) => app.toLowerCase() === name.toLowerCase());
    if (!exists) void onUpdate({ excludedApps: [...settings.excludedApps, name] });
    setNewApp('');
  };

  const removeExcluded = (name: string): void => {
    void onUpdate({ excludedApps: settings.excludedApps.filter((app) => app !== name) });
  };

  const clearHistory = async (): Promise<void> => {
    const removed = await api.history.clear({ keepPinned: true });
    setConfirmClear(false);
    onNotify(`Cleared ${String(removed)} clips, pinned ones kept`);
  };

  return (
    <div className="settings">
      <section className="settings__group">
        <h2>Capture</h2>
        <Row
          title="Record clipboard"
          description="Pause when you copy something you would rather not keep."
        >
          <Toggle
            label="Record clipboard"
            checked={settings.captureEnabled}
            onChange={(captureEnabled) => void onUpdate({ captureEnabled })}
          />
        </Row>
        {platform === 'darwin' && (
          <Row
            title="Import screenshots from the screenshot folder"
            description="Adds new screenshots macOS saves (Cmd+Shift+3, 4 or 5) to your history. Older pictures in the folder are never imported."
          >
            <Toggle
              label="Import screenshots from the screenshot folder"
              checked={settings.importScreenshotFolder}
              onChange={(importScreenshotFolder) => void onUpdate({ importScreenshotFolder })}
            />
          </Row>
        )}
        <Row
          title="History size"
          description="Oldest unpinned clips are removed beyond this. Pinned clips are always kept."
        >
          <select
            className="select"
            aria-label="History size"
            value={settings.maxClips}
            onChange={(event) => void onUpdate({ maxClips: Number(event.target.value) })}
          >
            {[...new Set([...MAX_CLIPS_OPTIONS, settings.maxClips])]
              .sort((a, b) => a - b)
              .map((count) => (
                <option key={count} value={count}>
                  {count.toLocaleString('en-US')} clips
                </option>
              ))}
          </select>
        </Row>
        <Row title="Never record from" description={exclusionDescription(info?.capture)}>
          <div className="chips">
            {settings.excludedApps.map((app) => (
              <span key={app} className="chip">
                {app}
                <button
                  type="button"
                  aria-label={`Stop excluding ${app}`}
                  onClick={() => removeExcluded(app)}
                >
                  <Icon name="close" size={10} />
                </button>
              </span>
            ))}
            <form onSubmit={addExcluded}>
              <input
                className="chip-input"
                placeholder="Add app.exe"
                aria-label="Add excluded app"
                value={newApp}
                onChange={(event) => setNewApp(event.target.value)}
              />
            </form>
          </div>
        </Row>
      </section>

      <AppearanceSettings settings={settings} onUpdate={onUpdate} />

      <ImageRecognitionSettings settings={settings} onChange={onUpdate} />

      <section className="settings__group">
        <h2>Shortcuts</h2>
        <Row title="Open history" description="Works from any app.">
          <ShortcutRecorder
            label="Open history"
            value={settings.shortcuts.openHistory}
            platform={platform}
            onChange={(openHistory) => onUpdate({ shortcuts: { openHistory } })}
          />
        </Row>
        <Row
          title="Compare clipboard"
          description="Press once after copying A, again after copying B."
        >
          <ShortcutRecorder
            label="Compare clipboard"
            value={settings.shortcuts.compare}
            platform={platform}
            onChange={(compare) => onUpdate({ shortcuts: { compare } })}
          />
        </Row>
      </section>

      <section className="settings__group">
        <h2>System</h2>
        {info?.launchAtLoginSupported && (
          <Row title="Launch at login" description="Starts hidden in the tray.">
            <Toggle
              label="Launch at login"
              checked={settings.launchAtLogin}
              onChange={(launchAtLogin) => void onUpdate({ launchAtLogin })}
            />
          </Row>
        )}
        <Row
          title="Clear history"
          description="Deletes every clip except pinned ones. This cannot be undone."
        >
          {confirmClear ? (
            <div className="confirm">
              <button type="button" className="button" onClick={() => setConfirmClear(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="button button--danger-solid"
                onClick={() => void clearHistory()}
              >
                Delete clips
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="button button--danger"
              onClick={() => setConfirmClear(true)}
            >
              <Icon name="trash" size={14} /> Clear…
            </button>
          )}
        </Row>
      </section>

      <footer className="settings__about">
        <span>Clipboard & Screenshot Archive {info ? `v${info.version}` : ''}</span>
        <span>·</span>
        <span className="settings__capture">{captureStatus(info)}</span>
        <span>·</span>
        <span>Everything stays on this computer.</span>
      </footer>
    </div>
  );
}
