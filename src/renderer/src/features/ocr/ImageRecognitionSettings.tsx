import type { ReactNode } from 'react';
import type { AnalysisLanguage } from '@shared/image-analysis';
import type { ImageAnalysisMode } from '@shared/image-settings';
import type { SettingsPatch } from '@shared/ipc-contract';
import type { AnalysisModelState } from '@shared/screenshots';
import type { Settings } from '@shared/types';
import { Segmented, Toggle } from '../../components/primitives';
import { downloadPercent, formatMegabytes } from './analysis-format';
import { useAnalysisModel } from './useAnalysisModel';
import './ocr.css';

export interface ImageRecognitionSettingsProps {
  readonly settings: Settings;
  /** Saves a change; a returned promise (e.g. SettingsView's `onUpdate`) is not awaited. */
  readonly onChange: (patch: SettingsPatch) => unknown;
}

const MODE_OPTIONS: readonly { value: ImageAnalysisMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'on-demand', label: 'On demand' },
  { value: 'automatic', label: 'Automatic' },
];

const MODE_DESCRIPTIONS: Record<ImageAnalysisMode, string> = {
  off: 'Describes images and finds the objects in them, on this computer.',
  'on-demand': 'An "Analyze" button on each image. Runs on this computer.',
  automatic: 'Every new screenshot is analyzed after its text is read. Runs on this computer.',
};

/** `<select>` values: the empty string stands for "follow the app language" (`null`). */
const FOLLOW_APP = '';
const LANGUAGE_OPTIONS: readonly { value: AnalysisLanguage | typeof FOLLOW_APP; label: string }[] =
  [
    { value: FOLLOW_APP, label: 'Follow app language' },
    { value: 'en', label: 'English' },
    { value: 'pl', label: 'Polish' },
  ];

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
        {description ? <div className="setting__description">{description}</div> : null}
      </div>
      <div className="setting__control">{children}</div>
    </div>
  );
}

/**
 * Settings → Images: text recognition, image analysis and the analysis model. Uses the settings
 * editor's row classes (settings.css, loaded by SettingsView).
 */
export function ImageRecognitionSettings({ settings, onChange }: ImageRecognitionSettingsProps) {
  const analysisOff = settings.imageAnalysis === 'off';

  return (
    <section className="settings__group">
      <h2>Images</h2>
      <SettingRow
        title="Text recognition"
        description="Reads text in screenshots on this computer so you can search and copy it."
      >
        <Toggle
          label="Text recognition"
          checked={settings.textRecognition}
          onChange={(textRecognition) => void onChange({ textRecognition })}
        />
      </SettingRow>
      <SettingRow title="Image analysis" description={MODE_DESCRIPTIONS[settings.imageAnalysis]}>
        <Segmented
          label="Image analysis"
          value={settings.imageAnalysis}
          options={MODE_OPTIONS}
          onChange={(imageAnalysis) => void onChange({ imageAnalysis })}
        />
      </SettingRow>
      <SettingRow
        title="Analysis language"
        description="Language of descriptions and object names."
      >
        <select
          className="select"
          aria-label="Analysis language"
          disabled={analysisOff}
          value={settings.analysisLanguage ?? FOLLOW_APP}
          onChange={(event) => {
            const value = event.target.value;
            void onChange({ analysisLanguage: value === 'en' || value === 'pl' ? value : null });
          }}
        >
          {LANGUAGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </SettingRow>
      {analysisOff ? null : <AnalysisModelRow />}
    </section>
  );
}

function AnalysisModelRow() {
  const model = useAnalysisModel();
  return (
    <SettingRow
      title="Analysis model"
      description="Downloaded once from its official source, checksum-verified and stored on this computer."
    >
      <div className="model-status">
        <span className="model-status__text" role="status">
          {model.state ? modelStatusText(model.state) : 'Checking…'}
        </span>
        {model.state?.state === 'missing' || model.state?.state === 'failed' ? (
          <button type="button" className="button button--primary" onClick={model.download}>
            Download
          </button>
        ) : null}
        {model.state?.state === 'downloading' ? (
          <button type="button" className="button" onClick={model.cancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </SettingRow>
  );
}

function modelStatusText(model: AnalysisModelState): string {
  switch (model.state) {
    case 'missing':
      return `Not downloaded · ${formatMegabytes(model.size)}`;
    case 'downloading': {
      const percent = downloadPercent(model);
      return percent === null ? 'Downloading…' : `Downloading ${percent}%`;
    }
    case 'ready':
      return 'Ready';
    case 'failed':
      return `Failed: ${model.error}`;
  }
}
