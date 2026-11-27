/**
 * Entry point of the image-analysis utility process (started with `spawnElectronWorker`).
 *
 * Runs Cactus Mirage (WebAssembly) in its own OS process, for the same reasons as the text
 * recognizer: crash and out-of-memory isolation, and all memory returned when it is ended.
 *
 * Arguments: `--runtime=<folder with cactus.js and cactus.wasm>` and `--weights=<mirage.cact>`.
 *
 * Every file is read once, checked against its pinned SHA-256, and then used from that same
 * buffer: cactus.js is evaluated from the verified bytes (`evaluateCommonJs`) instead of being
 * `require`d, which would open the file again after the check.
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { workerArgument } from '../workers/worker-args';
import { runWorkerHost } from '../workers/worker-host';
import { WorkerTaskError } from '../workers/worker-protocol';
import { analysisWorkerBody } from './analysis-worker-body';
import { CACTUS_RUNTIME_FILES, MIRAGE_ANALYZER_ID, MIRAGE_WEIGHTS } from './mirage-model';
import { MirageAnalyzer, cactusFactory } from './mirage-analyzer';
import { assertChecksum, evaluateCommonJs } from './verified-script';

const parentPort = process.parentPort;
const runtimeDir = workerArgument(process.argv, 'runtime');
const weightsPath = workerArgument(process.argv, 'weights');

async function verified(path: string, sha256: string): Promise<Uint8Array> {
  return assertChecksum(await readFile(path), sha256, path);
}

/**
 * The weights, checked like the runtime; a failure is reported to main as `weights-integrity`, so
 * main forgets the file's `.verified` marker and offers the download again.
 */
async function verifiedWeights(path: string): Promise<Uint8Array> {
  try {
    return await verified(path, MIRAGE_WEIGHTS.sha256);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new WorkerTaskError(
      `The image analysis model is damaged: ${reason}`,
      'weights-integrity',
    );
  }
}

const analyzer = new MirageAnalyzer({
  id: MIRAGE_ANALYZER_ID,
  loadRuntime: async () => {
    const scriptPath = join(runtimeDir, CACTUS_RUNTIME_FILES.script.name);
    const [script, wasmBinary] = await Promise.all([
      verified(scriptPath, CACTUS_RUNTIME_FILES.script.sha256),
      verified(join(runtimeDir, CACTUS_RUNTIME_FILES.wasm.name), CACTUS_RUNTIME_FILES.wasm.sha256),
    ]);
    const createCactus = cactusFactory(evaluateCommonJs(script, scriptPath));
    return createCactus({ wasmBinary });
  },
  loadWeights: () => verifiedWeights(weightsPath),
});

runWorkerHost(
  {
    // `event.data` is unknown here on purpose: runWorkerHost validates it before use.
    onMessage: (listener) => parentPort.on('message', (event) => listener(event.data)),
    postMessage: (message) => parentPort.postMessage(message),
  },
  analysisWorkerBody(analyzer),
);
