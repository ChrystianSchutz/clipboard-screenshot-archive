import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { normalizeHex } from '@shared/color';
import type { SettingsPatch } from '@shared/ipc-contract';
import {
  ACCENT_PRESETS,
  RESOLVED_THEMES,
  accentTokens,
  findAccentPreset,
  type ThemeSource,
} from '@shared/theme';
import type { Settings } from '@shared/types';
import { Icon } from '../../components/Icon';
import { Segmented } from '../../components/primitives';
import { applyAccent } from '../../theme/apply-accent';

interface AppearanceSettingsProps {
  readonly settings: Settings;
  readonly onUpdate: (patch: SettingsPatch) => Promise<string | null>;
}

const THEME_OPTIONS: readonly { value: ThemeSource; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

/** Dragging in the colour picker fires many events: preview at once, save when it settles. */
const SAVE_DELAY_MS = 250;

function SettingRow({
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

/** Settings → Appearance: theme (System / Dark / Light) and accent colour. */
export function AppearanceSettings({ settings, onUpdate }: AppearanceSettingsProps) {
  const saved = settings.accentColor;
  const [draft, setDraft] = useState(saved);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Follow changes made elsewhere (another window, a rejected value) unless a save is pending.
  useEffect(() => {
    if (timer.current === null) setDraft(saved);
  }, [saved]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const choose = (color: string, debounce: boolean): void => {
    const hex = normalizeHex(color);
    if (!hex) return;
    setDraft(hex);
    applyAccent(hex);
    if (timer.current !== null) clearTimeout(timer.current);
    if (!debounce) {
      timer.current = null;
      void onUpdate({ accentColor: hex });
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      void onUpdate({ accentColor: hex });
    }, SAVE_DELAY_MS);
  };

  const selectedPreset = findAccentPreset(draft);
  const adjustedIn = selectedPreset
    ? []
    : RESOLVED_THEMES.filter((theme) => accentTokens(draft, theme).adjusted);

  const onSwatchKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = selectedPreset ? ACCENT_PRESETS.indexOf(selectedPreset) : -1;
    const next = ACCENT_PRESETS[(index + step + ACCENT_PRESETS.length) % ACCENT_PRESETS.length];
    if (!next) return;
    choose(next.color, false);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-preset="${next.id}"]`)?.focus();
  };

  return (
    <section className="settings__group">
      <h2>Appearance</h2>
      <SettingRow title="Theme" description="System follows the Windows light or dark mode.">
        <Segmented
          label="Theme"
          value={settings.theme}
          options={THEME_OPTIONS}
          onChange={(theme) => void onUpdate({ theme })}
        />
      </SettingRow>
      <SettingRow
        title="Accent color"
        description={
          adjustedIn.length > 0 ? (
            <>
              Shown a little{' '}
              {adjustedIn.length === 2
                ? 'lighter or darker'
                : adjustedIn[0] === 'dark'
                  ? 'lighter in the dark theme'
                  : 'darker in the light theme'}{' '}
              so text and lines stay readable.
            </>
          ) : (
            'Buttons, focus rings, selection and charts.'
          )
        }
      >
        <div
          className="swatches"
          role="radiogroup"
          aria-label="Accent color"
          onKeyDown={onSwatchKey}
        >
          {ACCENT_PRESETS.map((preset) => {
            const checked = selectedPreset?.id === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={preset.label}
                title={preset.label}
                data-preset={preset.id}
                tabIndex={checked || (!selectedPreset && preset === ACCENT_PRESETS[0]) ? 0 : -1}
                className="swatch"
                style={
                  { '--swatch-dark': preset.color, '--swatch-light': preset.light } as CSSProperties
                }
                onClick={() => choose(preset.color, false)}
              >
                {checked && <Icon name="check" size={12} />}
              </button>
            );
          })}
          <label
            className={`swatch swatch--custom ${selectedPreset ? '' : 'swatch--checked'}`}
            title="Custom color"
            style={
              selectedPreset
                ? undefined
                : ({
                    '--swatch-dark': accentTokens(draft, 'dark').accent,
                    '--swatch-light': accentTokens(draft, 'light').accent,
                    '--swatch-ink-dark': accentTokens(draft, 'dark').onAccent,
                    '--swatch-ink-light': accentTokens(draft, 'light').onAccent,
                  } as CSSProperties)
            }
          >
            <input
              type="color"
              className="swatch__input"
              aria-label="Custom accent color"
              value={draft}
              onChange={(event) => choose(event.target.value, true)}
            />
            {!selectedPreset && <Icon name="check" size={12} />}
          </label>
          <span className={selectedPreset ? 'swatch-hex' : 'swatch-hex mono'} aria-live="polite">
            {selectedPreset ? selectedPreset.label : draft}
          </span>
        </div>
      </SettingRow>
    </section>
  );
}
