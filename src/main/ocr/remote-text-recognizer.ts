import type { OcrResult } from '@shared/ocr';
import { WorkerClient, type WorkerProcess } from '../workers/worker-client';
import { responseParser } from '../workers/worker-protocol';
import { ocrResultSchema } from './ocr-schema';
import type { OcrImage, TextRecognizer } from './ports';

export const TEXT_RECOGNITION_TIMEOUT_MS = 60_000;
/** Tesseract with both models holds ~100 MB; it is let go after 90 s without screenshots. */
export const TEXT_RECOGNITION_IDLE_MS = 90_000;

export interface RemoteTextRecognizerOptions {
  /** Id of the recognizer running in the worker (known up front: results carry it anyway). */
  readonly id: string;
  readonly spawn: () => WorkerProcess<OcrImage>;
  readonly onError?: (error: Error) => void;
  readonly timeoutMs?: number;
  readonly idleMs?: number;
}

/** `TextRecognizer` that runs Tesseract in the OCR utility process (see ocr-host-entry.ts). */
export class RemoteTextRecognizer implements TextRecognizer {
  readonly id: string;
  private readonly client: WorkerClient<OcrImage, OcrResult>;

  constructor(options: RemoteTextRecognizerOptions) {
    this.id = options.id;
    this.client = new WorkerClient({
      name: 'Text recognition',
      spawn: options.spawn,
      parse: responseParser(ocrResultSchema),
      timeoutMs: options.timeoutMs ?? TEXT_RECOGNITION_TIMEOUT_MS,
      idleMs: options.idleMs ?? TEXT_RECOGNITION_IDLE_MS,
      ...(options.onError ? { onError: options.onError } : {}),
    });
  }

  recognize(image: OcrImage): Promise<OcrResult> {
    return this.client.run(image);
  }

  dispose(): Promise<void> {
    return this.client.dispose();
  }
}
