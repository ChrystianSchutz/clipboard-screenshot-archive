import { parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';
import type { HistoryQuery } from '@shared/types';
import { ClipRepository } from '../storage/clip-repository';
import { openReadOnlyDatabase } from '../storage/database';
import { runWorkerHost } from '../workers/worker-host';
import { runRegexTask, type RegexTask, type RegexTaskResult } from './regex-task';

/**
 * Entry of the regex search worker thread (started by regex-search.ts). It owns a read-only
 * connection to the history, so the main thread can terminate it mid-search at any time.
 */
const port = parentPort;
if (!port) throw new Error('regex-worker must run as a worker thread');

const { dbPath } = workerData as { readonly dbPath: string };
const db = openReadOnlyDatabase(dbPath);
const repository = new ClipRepository(db);

/**
 * Request shape check at the worker's entry (see `runWorkerHost`). The query itself was validated
 * at the IPC boundary (`ipcSchemas['history:query']`) before main forwarded it here.
 */
const regexTaskSchema: z.ZodType<RegexTask> = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('query'),
    query: z.custom<HistoryQuery>((value) => typeof value === 'object' && value !== null),
  }),
  z.object({ op: z.literal('ranges'), pattern: z.string(), text: z.string() }),
]);

runWorkerHost<RegexTask, RegexTaskResult>(
  {
    onMessage: (listener) => port.on('message', (message: unknown) => listener(message)),
    postMessage: (message) => {
      port.postMessage(message);
    },
  },
  {
    id: 'regex-search',
    payload: regexTaskSchema,
    run: (task) => Promise.resolve(runRegexTask(repository, task)),
    dispose: () => {
      db.close();
      port.close();
      return Promise.resolve();
    },
  },
);
