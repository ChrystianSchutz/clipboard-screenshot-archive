import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImageAnalysisMode } from '@shared/image-settings';
import { screenshotUrl, type ScreenshotDetails } from '@shared/screenshots';
import { api } from '../../api';
import { entityBox } from './analysis-format';
import { AnalysisPanel } from './AnalysisPanel';
import { ScreenshotView } from './ScreenshotView';
import { useAnalysisModel } from './useAnalysisModel';
import './ocr.css';

export interface ScreenshotPreviewProps {
  readonly clipId: number;
  /** Opens Settings; offered when image analysis is off. */
  readonly onOpenSettings?: (() => void) | undefined;
}

/**
 * The preview of an image clip: the screenshot with its selectable text, and the Analysis panel
 * under it. Owns the data (details, model state, analysis mode) and keeps it current through the
 * main process's push events.
 */
export function ScreenshotPreview({ clipId, onOpenSettings }: ScreenshotPreviewProps) {
  const { details, reload } = useScreenshotDetails(clipId);
  const model = useAnalysisModel();
  const mode = useAnalysisMode();
  // Remembered per clip, so switching to another clip drops the selection without an effect.
  const [selection, setSelection] = useState<{ clipId: number; objectId: number } | null>(null);
  const [analyzeRequestedFor, setAnalyzeRequestedFor] = useState<number | null>(null);
  const [retryRequestedFor, setRetryRequestedFor] = useState<number | null>(null);

  if (details.status === 'loading') {
    return <p className="screenshot-preview__message">Loading image…</p>;
  }
  if (details.status === 'error') {
    return <p className="screenshot-preview__message">This image could not be loaded.</p>;
  }
  if (details.status === 'missing') {
    return <p className="screenshot-preview__message">This image is no longer available.</p>;
  }

  const { width, height, text, analysis } = details.value;
  const selectedObjectId = selection?.clipId === clipId ? selection.objectId : null;
  const analyzeRequested = analyzeRequestedFor === clipId;
  const retryRequested = retryRequestedFor === clipId;
  const highlight = analysis.result
    ? entityBox(analysis.result, selectedObjectId, { width, height })
    : null;

  const analyze = (): void => {
    setAnalyzeRequestedFor(clipId);
    // Show "Analyzing…" at once; the reloaded details then carry the real state.
    void api.screenshots
      .analyze(clipId)
      .then(() => reload())
      .finally(() => setAnalyzeRequestedFor((current) => (current === clipId ? null : current)));
  };

  const retryText = (): void => {
    setRetryRequestedFor(clipId);
    // Show "Reading text…" at once; the reloaded details then carry the real state.
    void api.screenshots
      .retryText(clipId)
      .then(() => reload())
      .finally(() => setRetryRequestedFor((current) => (current === clipId ? null : current)));
  };

  return (
    <div className="screenshot-preview">
      <ScreenshotView
        src={screenshotUrl(clipId, 'full')}
        alt="Screenshot"
        ocr={text.result}
        status={retryRequested && text.state === 'failed' ? 'pending' : text.state}
        imageSize={{ width, height }}
        highlight={highlight}
        onCopyText={(value) => api.screenshots.copyText(value)}
        onRetryText={retryText}
      />
      {mode && model.state ? (
        <AnalysisPanel
          mode={mode}
          state={
            analyzeRequested && (analysis.state === 'none' || analysis.state === 'failed')
              ? 'pending'
              : analysis.state
          }
          result={analysis.result}
          model={model.state}
          selectedObjectId={selectedObjectId}
          onSelectObject={(objectId) =>
            setSelection(objectId === null ? null : { clipId, objectId })
          }
          onAnalyze={analyze}
          onDownloadModel={model.download}
          onCancelDownload={model.cancel}
          {...(onOpenSettings ? { onOpenSettings } : {})}
        />
      ) : null}
    </div>
  );
}

type DetailsState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'missing' }
  | { readonly status: 'ready'; readonly value: ScreenshotDetails };

/**
 * Details of one image clip, reloaded when the main process says its text or analysis changed.
 * Answers for a previous clip, or older than one already applied, are ignored.
 */
export function useScreenshotDetails(clipId: number): {
  details: DetailsState;
  reload: () => Promise<void>;
} {
  const [loaded, setLoaded] = useState<{ clipId: number; details: DetailsState } | null>(null);
  const reloadRef = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    let active = true;
    let latestRequest = 0;
    const load = async (): Promise<void> => {
      const request = ++latestRequest;
      let next: DetailsState;
      try {
        const value = await api.screenshots.details(clipId);
        next = value ? { status: 'ready', value } : { status: 'missing' };
      } catch {
        next = { status: 'error' };
      }
      if (active && request === latestRequest) setLoaded({ clipId, details: next });
    };
    reloadRef.current = load;
    void load();
    const unsubscribe = api.screenshots.onUpdated((updatedId) => {
      if (updatedId === clipId) void load();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [clipId]);

  const reload = useCallback(() => reloadRef.current(), []);
  return { details: loaded?.clipId === clipId ? loaded.details : { status: 'loading' }, reload };
}

/** The image analysis mode from Settings, following changes made in any window. */
function useAnalysisMode(): ImageAnalysisMode | null {
  const [mode, setMode] = useState<ImageAnalysisMode | null>(null);
  useEffect(() => {
    let active = true;
    let changed = false;
    const unsubscribe = api.settings.onChanged((settings) => {
      changed = true;
      if (active) setMode(settings.imageAnalysis);
    });
    void api.settings.get().then((settings) => {
      // A pushed change is newer than this answer.
      if (active && !changed) setMode(settings.imageAnalysis);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return mode;
}
