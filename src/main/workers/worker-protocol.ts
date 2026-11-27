import { z } from 'zod';

/** Longest error message a worker may send (worker-host.ts shortens longer ones). */
export const MAX_ERROR_MESSAGE = 2_000;

/**
 * Largest result a worker sends, as JSON. Real results are far smaller (a dense full-screen OCR
 * result is a few MB); the cap stops a broken engine from flooding main's memory.
 */
export const MAX_RESULT_BYTES = 16 * 1024 * 1024;

/**
 * Messages between the main process and a worker utility process (the Tesseract text recognizer
 * and the Mirage image analyzer use the same protocol, with different payloads and results).
 *
 * Both directions are validated with zod. Workers run third-party WebAssembly on untrusted pixels,
 * so main treats whatever comes back as data to check, not as trusted objects; and a worker checks
 * every request (envelope and payload, see `runWorkerHost`) instead of casting it.
 */
/**
 * Failures a worker reports with a machine-readable code, so main can act on them instead of
 * matching message text. `weights-integrity`: the model weights failed their checksum (or could
 * not be read) when the worker loaded them.
 */
export const WORKER_ERROR_CODES = ['weights-integrity'] as const;
export type WorkerErrorCode = (typeof WORKER_ERROR_CODES)[number];

/** A task failure with a `WorkerErrorCode`: thrown in the worker, rebuilt in main. */
export class WorkerTaskError extends Error {
  override readonly name = 'WorkerTaskError';

  constructor(
    message: string,
    readonly code: WorkerErrorCode,
  ) {
    super(message);
  }
}

/** Whether a task failed because the worker found the model weights damaged. */
export function isWeightsIntegrityError(error: unknown): boolean {
  // 'weights-integrity' is the only code today; compare `error.code` once another one exists.
  return error instanceof WorkerTaskError;
}

export type WorkerRequest<Payload> =
  | { readonly type: 'run'; readonly id: number; readonly payload: Payload }
  | { readonly type: 'dispose' };

export type WorkerResponse<Result> =
  | { readonly type: 'ready'; readonly worker: string }
  | { readonly type: 'result'; readonly id: number; readonly result: Result }
  | {
      readonly type: 'error';
      readonly id: number;
      readonly message: string;
      readonly code?: WorkerErrorCode | undefined;
    };

/** The envelope of a main → worker message; the payload is checked by the worker body's schema. */
export const requestEnvelopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run'), id: z.number().int().nonnegative(), payload: z.unknown() }),
  z.object({ type: z.literal('dispose') }),
]);

/** Returns a parser for one worker's responses: `null` for anything outside the protocol. */
export function responseParser<Result>(
  resultSchema: z.ZodType<Result>,
): (message: unknown) => WorkerResponse<Result> | null {
  const schema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('ready'), worker: z.string().max(200) }),
    z.object({ type: z.literal('result'), id: z.number().int(), result: resultSchema }),
    z.object({
      type: z.literal('error'),
      id: z.number().int(),
      message: z.string().max(MAX_ERROR_MESSAGE),
      code: z.enum(WORKER_ERROR_CODES).optional(),
    }),
  ]);
  return (message) => {
    const parsed = schema.safeParse(message);
    return parsed.success ? parsed.data : null;
  };
}
