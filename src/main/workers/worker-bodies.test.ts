import { describe, expect, it } from 'vitest';
import type { ImageAnalysis } from '@shared/image-analysis';
import type { OcrResult } from '@shared/ocr';
import { ANALYSIS_BUDGET, analysisTextChars } from '../analysis/analysis-schema';
import { analysisWorkerBody } from '../analysis/analysis-worker-body';
import { OCR_BUDGET, ocrTotals } from '../ocr/ocr-schema';
import { ocrWorkerBody } from '../ocr/ocr-worker-body';
import {
  FakeImageAnalyzer,
  FakeTextRecognizer,
  imageAnalysis,
  ocrResult,
} from '../test-support/image-fakes';
import { pngHeader } from '../test-support/png';
import { runWorkerHost, type WorkerChannel } from './worker-host';
import { WorkerTaskError, type WorkerResponse } from './worker-protocol';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const box = { x0: 0, y0: 0, x1: 1, y1: 1 };

function channelOf<Result>() {
  const posted: WorkerResponse<Result>[] = [];
  let listener: ((message: unknown) => void) | null = null;
  const channel: WorkerChannel<Result> = {
    onMessage: (next) => {
      listener = next;
    },
    postMessage: (message) => {
      posted.push(message);
    },
  };
  return { channel, posted, deliver: (message: unknown) => listener?.(message) };
}

describe('ocrWorkerBody', () => {
  const payload = { png: pngHeader(10, 10), width: 10, height: 10, scale: 1 };

  it('rejects a malformed request at entry without touching the engine', async () => {
    const recognizer = new FakeTextRecognizer();
    const { channel, posted, deliver } = channelOf<OcrResult>();
    runWorkerHost(channel, ocrWorkerBody(recognizer));

    deliver({ type: 'run', id: 1, payload: { ...payload, png: 'not bytes' } });
    await flush();

    expect(recognizer.recognize).not.toHaveBeenCalled();
    expect(posted.at(-1)).toEqual({ type: 'error', id: 1, message: 'Invalid worker request' });
  });

  it('rejects a PNG whose header describes a larger image than the request declares', async () => {
    const recognizer = new FakeTextRecognizer();
    const { channel, posted, deliver } = channelOf<OcrResult>();
    runWorkerHost(channel, ocrWorkerBody(recognizer));

    deliver({ type: 'run', id: 3, payload: { ...payload, png: pngHeader(30_000, 30_000) } });
    await flush();

    expect(recognizer.recognize).not.toHaveBeenCalled();
    expect(posted.at(-1)).toEqual({ type: 'error', id: 3, message: 'Invalid worker request' });
  });

  it('trims an oversized result to the budget before sending it', async () => {
    const recognizer = new FakeTextRecognizer();
    const words = Array.from({ length: 2_000 }, () => ({ text: 'a', box, confidence: 90 }));
    const line = { text: 'a', box, confidence: 90, words };
    recognizer.result = ocrResult({ lines: Array.from({ length: 31 }, () => line) });
    const { channel, posted, deliver } = channelOf<OcrResult>();
    runWorkerHost(channel, ocrWorkerBody(recognizer));

    deliver({ type: 'run', id: 2, payload });
    await flush();

    const answer = posted.at(-1);
    if (answer?.type !== 'result') throw new Error('expected a result');
    expect(answer.result.lines).toHaveLength(30);
    expect(ocrTotals(answer.result.lines).words).toBeLessThanOrEqual(OCR_BUDGET.maxWords);
  });
});

describe('analysisWorkerBody', () => {
  const image = {
    rgb: new Uint8Array(12),
    width: 2,
    height: 2,
    originalWidth: 2,
    originalHeight: 2,
  };

  it('rejects a request whose pixels do not match its size', async () => {
    const analyzer = new FakeImageAnalyzer();
    const { channel, posted, deliver } = channelOf<ImageAnalysis>();
    runWorkerHost(channel, analysisWorkerBody(analyzer));

    deliver({ type: 'run', id: 1, payload: { image: { ...image, width: 3 }, language: 'en' } });
    await flush();

    expect(analyzer.analyze).not.toHaveBeenCalled();
    expect(posted.at(-1)).toEqual({ type: 'error', id: 1, message: 'Invalid worker request' });
  });

  it('reports damaged weights to main with their code', async () => {
    const analyzer = new FakeImageAnalyzer();
    analyzer.analyze.mockRejectedValueOnce(
      new WorkerTaskError('The image analysis model is damaged', 'weights-integrity'),
    );
    const { channel, posted, deliver } = channelOf<ImageAnalysis>();
    runWorkerHost(channel, analysisWorkerBody(analyzer));

    deliver({ type: 'run', id: 4, payload: { image, language: 'en' } });
    await flush();

    expect(posted.at(-1)).toEqual({
      type: 'error',
      id: 4,
      message: 'The image analysis model is damaged',
      code: 'weights-integrity',
    });
  });

  it('trims an oversized analysis before sending it', async () => {
    const analyzer = new FakeImageAnalyzer();
    const text = Array.from({ length: 40 }, () => ({ text: 'x'.repeat(10_000), box, score: 1 }));
    analyzer.analyze.mockResolvedValueOnce(imageAnalysis({ text }));
    const { channel, posted, deliver } = channelOf<ImageAnalysis>();
    runWorkerHost(channel, analysisWorkerBody(analyzer));

    deliver({ type: 'run', id: 2, payload: { image, language: 'pl' } });
    await flush();

    const answer = posted.at(-1);
    if (answer?.type !== 'result') throw new Error('expected a result');
    expect(analysisTextChars(answer.result)).toBeLessThanOrEqual(ANALYSIS_BUDGET.maxTextChars);
    expect(analyzer.analyze).toHaveBeenCalledWith(expect.objectContaining({ width: 2 }), 'pl');
  });
});
