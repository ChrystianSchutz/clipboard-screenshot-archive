import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageAnalysis } from '@shared/image-analysis';
import { imageAnalysis } from '../test-support/image-fakes';
import type { WorkerProcess } from '../workers/worker-client';
import type { WorkerRequest } from '../workers/worker-protocol';
import { imageAnalysisSchema } from './analysis-schema';
import type { AnalysisImage } from './ports';
import { RemoteImageAnalyzer, type AnalysisRequest } from './remote-image-analyzer';

const IMAGE: AnalysisImage = {
  rgb: new Uint8Array(2 * 2 * 3),
  width: 2,
  height: 2,
  originalWidth: 20,
  originalHeight: 20,
};

/** The analysis utility process as main sees it: records requests, answers when told to. */
class FakeAnalysisWorker implements WorkerProcess<AnalysisRequest> {
  readonly requests: WorkerRequest<AnalysisRequest>[] = [];
  readonly kill = vi.fn();
  private messageListener: ((message: unknown) => void) | null = null;

  postMessage(message: WorkerRequest<AnalysisRequest>): void {
    this.requests.push(message);
  }

  onMessage(listener: (message: unknown) => void): void {
    this.messageListener = listener;
  }

  onExit(): void {
    // The tests never let the worker crash.
  }

  reply(message: unknown): void {
    this.messageListener?.(message);
  }
}

describe('imageAnalysisSchema', () => {
  it('accepts a complete analysis', () => {
    const analysis = imageAnalysis({
      scene: { setting: 'indoor' },
      description: ['a dialog box'],
      objects: [
        {
          id: 1,
          label: 'dialog',
          box: { x0: 0, y0: 0, x1: 10, y1: 10 },
          score: 0.5,
          position: 'center',
          attributes: {},
        },
      ],
      text: [{ text: 'OK', box: { x0: 1, y0: 1, x1: 5, y1: 5 }, score: 0.9 }],
    });
    expect(imageAnalysisSchema.safeParse(analysis).success).toBe(true);
  });

  it.each<[string, Partial<Record<keyof ImageAnalysis, unknown>>]>([
    ['a language the app does not ship', { language: 'de' }],
    ['a zero width', { width: 0 }],
    ['a fractional height', { height: 1.5 }],
    ['a negative duration', { durationMs: -1 }],
    ['non-string scene values', { scene: { count: 3 } }],
    [
      'more than 100 description statements',
      { description: Array.from({ length: 101 }, () => 'x') },
    ],
    ['an object without a box', { objects: [{ id: 1, label: 'x', score: 1, attributes: {} }] }],
  ])('rejects %s', (_case, overrides) => {
    expect(imageAnalysisSchema.safeParse({ ...imageAnalysis(), ...overrides }).success).toBe(false);
  });
});

describe('RemoteImageAnalyzer', () => {
  let worker: FakeAnalysisWorker;
  let spawn: ReturnType<typeof vi.fn<() => WorkerProcess<AnalysisRequest>>>;
  let onError: ReturnType<typeof vi.fn<(error: Error) => void>>;
  let analyzer: RemoteImageAnalyzer;

  beforeEach(() => {
    worker = new FakeAnalysisWorker();
    spawn = vi.fn(() => worker);
    onError = vi.fn();
    analyzer = new RemoteImageAnalyzer({ id: 'remote-mirage', spawn, onError });
  });

  afterEach(async () => {
    await analyzer.dispose();
  });

  it('starts the worker only when the first image is analysed', () => {
    expect(analyzer.id).toBe('remote-mirage');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('sends the image and the language to the worker and resolves with its analysis', async () => {
    const pending = analyzer.analyze(IMAGE, 'pl');

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(worker.requests).toEqual([
      { type: 'run', id: 1, payload: { image: IMAGE, language: 'pl' } },
    ]);

    const result = imageAnalysis({ language: 'pl', description: ['okno dialogowe'] });
    worker.reply({ type: 'result', id: 1, result });

    await expect(pending).resolves.toEqual(result);
    expect(onError).not.toHaveBeenCalled();
  });

  it('rejects with the message of a worker error', async () => {
    const pending = analyzer.analyze(IMAGE, 'en');
    worker.reply({ type: 'error', id: 1, message: 'model archive is corrupt' });

    await expect(pending).rejects.toThrow('model archive is corrupt');
  });

  it('does not deliver a result that fails validation: it reports it and rejects the analysis', async () => {
    const pending = analyzer.analyze(IMAGE, 'en');

    worker.reply({ type: 'result', id: 1, result: { ...imageAnalysis(), width: -5 } });

    await expect(pending).rejects.toThrow('Image analysis process sent an invalid message');
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      new Error('Image analysis process sent an invalid message'),
    );
  });

  it('stops the worker on dispose', async () => {
    const pending = analyzer.analyze(IMAGE, 'en');
    await analyzer.dispose();

    await expect(pending).rejects.toThrow('Image analysis was stopped');
    expect(worker.requests.at(-1)).toEqual({ type: 'dispose' });
    expect(worker.kill).toHaveBeenCalledTimes(1);
  });
});
