import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnalysisModelState } from '@shared/screenshots';
import { api } from '../../api';

export interface AnalysisModel {
  /** `null` until the first answer from the main process. */
  readonly state: AnalysisModelState | null;
  readonly download: () => void;
  readonly cancel: () => void;
}

/**
 * State of the optional analysis model, kept current by the main process's progress events.
 *
 * Pushed events are always newer than an answer that was requested before them, so an answer that
 * arrives after an event is dropped instead of moving the progress bar backwards. Failed calls are
 * left to the renderer's global `unhandledrejection` reporter; the main process also pushes a
 * `failed` state for a download that goes wrong.
 */
export function useAnalysisModel(): AnalysisModel {
  const [state, setState] = useState<AnalysisModelState | null>(null);
  /** Counts pushed events, so a request can tell whether one arrived while it was in flight. */
  const eventCount = useRef(0);

  useEffect(() => {
    let active = true;
    const unsubscribe = api.screenshots.onModelState((next) => {
      eventCount.current += 1;
      if (active) setState(next);
    });
    const eventsBefore = eventCount.current;
    void api.screenshots.modelState().then((answer) => {
      if (active && eventCount.current === eventsBefore) setState(answer);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const download = useCallback(() => {
    const eventsBefore = eventCount.current;
    void api.screenshots.downloadModel().then((answer) => {
      if (eventCount.current === eventsBefore) setState(answer);
    });
  }, []);

  const cancel = useCallback(() => {
    void api.screenshots.cancelDownload();
  }, []);

  return { state, download, cancel };
}
