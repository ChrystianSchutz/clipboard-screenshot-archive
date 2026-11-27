import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OcrResult } from '@shared/ocr';
import type { WorkerProcess } from '../workers/worker-client';
import type { WorkerRequest } from '../workers/worker-protocol';
import type { OcrImage } from './ports';
import { RemoteTextRecognizer, TEXT_RECOGNITION_TIMEOUT_MS } from './remote-text-recognizer';

/** The OCR utility process, held in memory: tests answer for it with `send`. */
class FakeOcrWorker implements WorkerProcess<OcrImage> {
  readonly posted: WorkerRequest<OcrImage>[] = [];
  killed = false;
  private listener: ((message: unknown) => void) | null = null;

  postMessage(message: WorkerRequest<OcrImage>): void {
    this.posted.push(message);
  }

  onMessage(listener: (message: unknown) => void): void {
    this.listener = listener;
  }

  onExit(): void {
    // Exits are covered by the WorkerClient tests.
  }

  kill(): void {
    this.killed = true;
  }

  send(message: unknown): void {
    this.listener?.(message);
  }
}

const image: OcrImage = {
  png: new Uint8Array([137, 80, 78, 71]),
  width: 320,
  height: 180,
  scale: 2,
};

const result: OcrResult = {
  engine: 'tesseract.js@7.0.0/eng+pol',
  width: 320,
  height: 180,
  durationMs: 250,
  lines: [{ text: 'Hello', box: { x0: 1, y0: 2, x1: 40, y1: 14 }, confidence: 96, words: [] }],
};

function setup(options: { timeoutMs?: number } = {}) {
  const workers: FakeOcrWorker[] = [];
  const errors: Error[] = [];
  const recognizer = new RemoteTextRecognizer({
    id: 'tesseract.js@7.0.0/eng+pol',
    spawn: () => {
      const worker = new FakeOcrWorker();
      workers.push(worker);
      return worker;
    },
    onError: (error) => errors.push(error),
    ...options,
  });
  return { recognizer, workers, errors };
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`Rejected with a non-Error: ${String(error)}`, { cause: error });
  }
  throw new Error('Expected the promise to reject');
}

describe('RemoteTextRecognizer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the id it was given and starts no process before the first image', () => {
    const { recognizer, workers } = setup();
    expect(recognizer.id).toBe('tesseract.js@7.0.0/eng+pol');
    expect(workers).toHaveLength(0);
  });

  it('sends the image to the OCR process and resolves with its validated result', async () => {
    const { recognizer, workers } = setup();

    const recognized = recognizer.recognize(image);
    expect(workers[0]!.posted).toEqual([{ type: 'run', id: 1, payload: image }]);
    workers[0]!.send({ type: 'result', id: 1, result });

    await expect(recognized).resolves.toEqual(result);
  });

  it('gives each image its own id', async () => {
    const { recognizer, workers } = setup();

    const first = recognizer.recognize(image);
    const second = recognizer.recognize({ ...image, width: 640 });
    workers[0]!.send({ type: 'result', id: 2, result: { ...result, width: 640 } });
    workers[0]!.send({ type: 'result', id: 1, result });

    expect(
      workers[0]!.posted.map((message) => (message.type === 'run' ? message.id : null)),
    ).toEqual([1, 2]);
    expect((await first).width).toBe(320);
    expect((await second).width).toBe(640);
  });

  it('rejects a result that fails the OCR schema at once, and keeps the worker', async () => {
    const { recognizer, workers, errors } = setup({ timeoutMs: 500 });
    const recognized = rejectionOf(recognizer.recognize(image));

    workers[0]!.send({ type: 'result', id: 1, result: { ...result, width: 0 } });
    expect(errors.map((error) => error.message)).toEqual([
      'Text recognition process sent an invalid message',
    ]);

    expect((await recognized).message).toBe('Text recognition process sent an invalid message');
    expect(workers[0]!.killed).toBe(false);
  });

  it('rejects with the message the OCR process reported', async () => {
    const { recognizer, workers } = setup();
    const recognized = rejectionOf(recognizer.recognize(image));

    workers[0]!.send({ type: 'error', id: 1, message: 'Error opening data file eng.traineddata' });

    expect((await recognized).message).toBe('Error opening data file eng.traineddata');
  });

  it('waits a full minute for an image by default', async () => {
    const { recognizer } = setup();
    let settled = false;
    const recognized = rejectionOf(recognizer.recognize(image)).finally(() => (settled = true));

    await vi.advanceTimersByTimeAsync(TEXT_RECOGNITION_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect((await recognized).message).toBe('Text recognition timed out after 60000 ms');
  });

  it('stops the OCR process on dispose and rejects the image in flight', async () => {
    const { recognizer, workers } = setup();
    const recognized = rejectionOf(recognizer.recognize(image));

    await recognizer.dispose();

    expect((await recognized).message).toBe('Text recognition was stopped');
    expect(workers[0]!.posted.at(-1)).toEqual({ type: 'dispose' });
    expect(workers[0]!.killed).toBe(true);
  });
});
