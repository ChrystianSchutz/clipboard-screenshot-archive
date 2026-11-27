import type { OcrResult } from '@shared/ocr';
import type { WorkerBody } from '../workers/worker-host';
import { limitOcrResult, ocrImageSchema } from './ocr-schema';
import type { OcrImage, TextRecognizer } from './ports';

/**
 * What the text-recognition worker runs: requests are validated at entry (`ocrImageSchema`) and
 * results are trimmed to `OCR_BUDGET` before they are sent back.
 */
export function ocrWorkerBody(recognizer: TextRecognizer): WorkerBody<OcrImage, OcrResult> {
  return {
    id: recognizer.id,
    payload: ocrImageSchema,
    run: async (image) => limitOcrResult(await recognizer.recognize(image)),
    dispose: () => recognizer.dispose(),
  };
}
