import type { ImageAnalysis } from '@shared/image-analysis';
import type { ImageAnalysisMode } from '@shared/image-settings';
import type { AnalysisModelState, ImageAnalysisState } from '@shared/screenshots';
import {
  analysisEntities,
  downloadPercent,
  formatDuration,
  formatMegabytes,
  formatScore,
  languageName,
} from './analysis-format';
import './ocr.css';

export interface AnalysisPanelProps {
  readonly mode: ImageAnalysisMode;
  /** Analysis state of this image. */
  readonly state: ImageAnalysisState;
  readonly result: ImageAnalysis | null;
  readonly model: AnalysisModelState;
  /** Entity id of the object outlined on the image, if any. */
  readonly selectedObjectId: number | null;
  readonly onSelectObject: (id: number | null) => void;
  readonly onAnalyze: () => void;
  readonly onDownloadModel: () => void;
  readonly onCancelDownload: () => void;
  readonly onOpenSettings?: () => void;
}

/**
 * What the image analyzer says about a screenshot, plus everything needed to get there: the
 * one-time model download and the "Analyze" button. Presentational only; the container owns the
 * data and the calls.
 *
 * A finished analysis is shown even when the model has been removed since: results are stored
 * with the image and do not need the model to be read.
 */
export function AnalysisPanel(props: AnalysisPanelProps) {
  return (
    <section className="analysis-panel" aria-label="Image analysis">
      <h3 className="analysis-panel__title">Image analysis</h3>
      <PanelBody {...props} />
    </section>
  );
}

function PanelBody(props: AnalysisPanelProps) {
  const { mode, state, result, model, onAnalyze, onOpenSettings } = props;

  if (mode === 'off') {
    return (
      <p className="analysis-panel__note">
        Image analysis is off.{' '}
        {onOpenSettings ? (
          <button type="button" className="analysis-panel__link" onClick={onOpenSettings}>
            Turn it on in Settings
          </button>
        ) : null}
      </p>
    );
  }

  if (state === 'done' && result) return <AnalysisResult {...props} result={result} />;
  if (state === 'pending') return <p className="analysis-panel__note">Analyzing…</p>;
  if (model.state !== 'ready') return <ModelSetup {...props} model={model} />;

  if (state === 'failed') {
    return (
      <div className="analysis-panel__row">
        <p className="analysis-panel__note">The image could not be analyzed.</p>
        <button type="button" className="button" onClick={onAnalyze}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="analysis-panel__row">
      <p className="analysis-panel__note">
        {mode === 'automatic'
          ? 'This image was captured before automatic analysis was on.'
          : 'Describe this image and find the objects in it.'}
      </p>
      <button type="button" className="button button--primary" onClick={onAnalyze}>
        Analyze
      </button>
    </div>
  );
}

function ModelSetup({
  model,
  onDownloadModel,
  onCancelDownload,
}: Pick<AnalysisPanelProps, 'onDownloadModel' | 'onCancelDownload'> & {
  readonly model: Exclude<AnalysisModelState, { state: 'ready' }>;
}) {
  if (model.state === 'downloading') {
    const percent = downloadPercent(model);
    return (
      <div className="analysis-panel__download">
        <div className="analysis-panel__row">
          <span className="analysis-panel__note">
            Downloading the analysis model{percent === null ? '…' : ` ${percent}%`}
          </span>
          <button type="button" className="button" onClick={onCancelDownload}>
            Cancel
          </button>
        </div>
        <progress
          className="analysis-panel__progress"
          aria-label="Model download"
          max={model.total > 0 ? model.total : undefined}
          value={model.total > 0 ? model.received : undefined}
        />
      </div>
    );
  }

  return (
    <div className="analysis-panel__download">
      <p className="analysis-panel__note">
        Analysis needs a one-time download of the {formatMegabytes(model.size)} model from its
        official source. It is checksum-verified and stored on this computer; after that, images are
        analyzed offline.
      </p>
      {model.state === 'failed' ? (
        <p className="analysis-panel__error" role="alert">
          Download failed: {model.error}
        </p>
      ) : null}
      <div>
        <button type="button" className="button button--primary" onClick={onDownloadModel}>
          Download model
        </button>
      </div>
    </div>
  );
}

function AnalysisResult({
  result,
  selectedObjectId,
  onSelectObject,
}: Pick<AnalysisPanelProps, 'selectedObjectId' | 'onSelectObject'> & {
  readonly result: ImageAnalysis;
}) {
  const scene = Object.entries(result.scene);
  const entities = analysisEntities(result.objects);

  return (
    <>
      {result.description.length > 0 ? (
        <p className="analysis-panel__description">{result.description.join(' ')}</p>
      ) : null}

      {scene.length > 0 ? (
        <dl className="analysis-panel__scene" aria-label="Scene">
          {scene.map(([key, value]) => (
            <div key={key} className="analysis-panel__scene-item">
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {entities.length > 0 ? (
        <ul className="analysis-panel__objects" aria-label="Objects">
          {entities.map((entity) => {
            const selected = entity.id === selectedObjectId;
            return (
              <li key={entity.id}>
                <button
                  type="button"
                  className="button analysis-panel__object"
                  aria-pressed={selected}
                  title={selected ? 'Hide the outline' : 'Outline it on the image'}
                  onClick={() => onSelectObject(selected ? null : entity.id)}
                >
                  <span className="analysis-panel__object-label">{entity.label}</span>
                  <span className="analysis-panel__object-meta">
                    {formatScore(entity.score)}
                    {entity.position ? ` · ${entity.position}` : ''}
                    {entity.boxCount > 1 ? ` · ×${entity.boxCount}` : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="analysis-panel__note">No objects found.</p>
      )}

      {result.text.length > 0 ? (
        <details className="analysis-panel__text">
          <summary>Text read by the analyzer ({result.text.length})</summary>
          <ul>
            {result.text.map((line, index) => (
              // Lines can repeat, so the index is part of the key.
              <li key={`${index}:${line.text}`}>{line.text}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <p className="analysis-panel__footer">
        {result.engine} · {languageName(result.language)} · {formatDuration(result.durationMs)}
      </p>
    </>
  );
}
