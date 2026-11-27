/**
 * Entry point of the text-recognition utility process (started with `spawnElectronWorker`).
 *
 * Runs Tesseract (WebAssembly) in its own OS process, away from the UI and the main process:
 * a crash or an out-of-memory abort on a hostile image kills only this process, and main frees
 * all of its memory by ending it when recognition has been idle for a while.
 *
 * Arguments: `--tessdata=<folder>` and `--languages=eng,pol`.
 */
import { createRequire } from 'node:module';
import tesseract from 'tesseract.js';
import { workerArgument } from '../workers/worker-args';
import { runWorkerHost } from '../workers/worker-host';
import { ocrWorkerBody } from './ocr-worker-body';
import { TesseractRecognizer } from './tesseract-recognizer';

const parentPort = process.parentPort;
const { version } = createRequire(import.meta.url)('tesseract.js/package.json') as {
  version: string;
};

const recognizer = new TesseractRecognizer({
  tesseract,
  tessdataDir: workerArgument(process.argv, 'tessdata'),
  languages: workerArgument(process.argv, 'languages').split(','),
  version,
});

runWorkerHost(
  {
    // `event.data` is unknown here on purpose: runWorkerHost validates it before use.
    onMessage: (listener) => parentPort.on('message', (event) => listener(event.data)),
    postMessage: (message) => parentPort.postMessage(message),
  },
  ocrWorkerBody(recognizer),
);
