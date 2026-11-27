import type { z } from 'zod';
import {
  MAX_ERROR_MESSAGE,
  MAX_RESULT_BYTES,
  requestEnvelopeSchema,
  WorkerTaskError,
  type WorkerResponse,
} from './worker-protocol';

/**
 * The worker's side of the message channel (Electron's `process.parentPort` in production).
 * Incoming messages are `unknown`: the host validates them before anything uses them.
 */
export interface WorkerChannel<Result> {
  onMessage(listener: (message: unknown) => void): void;
  postMessage(message: WorkerResponse<Result>): void;
}

/** What a worker process does with each payload. */
export interface WorkerBody<Payload, Result> {
  readonly id: string;
  /** Validates a run payload at the process boundary; a payload that fails is answered with an error. */
  readonly payload: z.ZodType<Payload>;
  run(payload: Payload): Promise<Result>;
  dispose(): Promise<void>;
  /** Largest result (as JSON) the host sends back; bigger ones become an error. */
  readonly maxResultBytes?: number;
}

/**
 * Body of a worker utility process: receives payloads, runs them, posts results back.
 *
 * Free of Electron so it is unit-tested with an in-memory channel; the `*-host-entry.ts` files only
 * wire it to `process.parentPort`.
 * - Every message is validated (envelope, then the body's payload schema) before it is used; the
 *   host never casts what main sent.
 * - A failing payload never takes the worker down: it is answered with an `error` message and the
 *   next one runs normally.
 * - A result larger than `maxResultBytes` is answered with an error instead of being sent.
 */
export function runWorkerHost<Payload, Result>(
  channel: WorkerChannel<Result>,
  body: WorkerBody<Payload, Result>,
): void {
  const maxResultBytes = body.maxResultBytes ?? MAX_RESULT_BYTES;
  const fail = (id: number, error: unknown): void =>
    channel.postMessage({
      type: 'error',
      id,
      message: errorMessage(error),
      // A typed failure keeps its code across the process boundary (see `WorkerTaskError`).
      ...(error instanceof WorkerTaskError ? { code: error.code } : {}),
    });

  channel.onMessage((raw) => {
    const envelope = requestEnvelopeSchema.safeParse(raw);
    if (!envelope.success) {
      // Answer a broken request that still names its task, so main does not wait for a timeout.
      const id = messageId(raw);
      if (id !== null) fail(id, 'Invalid worker request');
      return;
    }
    const message = envelope.data;
    if (message.type === 'dispose') {
      void body.dispose();
      return;
    }
    const payload = body.payload.safeParse(message.payload);
    if (!payload.success) {
      fail(message.id, 'Invalid worker request');
      return;
    }
    let running: Promise<Result>;
    try {
      running = body.run(payload.data);
    } catch (error) {
      fail(message.id, error);
      return;
    }
    running.then(
      (result) => {
        if (serializedBytes(result) > maxResultBytes) {
          fail(message.id, 'Worker result is too large');
          return;
        }
        channel.postMessage({ type: 'result', id: message.id, result });
      },
      (error: unknown) => fail(message.id, error),
    );
  });
  channel.postMessage({ type: 'ready', worker: body.id });
}

export function errorMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Worker task failed';
  return message.length > MAX_ERROR_MESSAGE
    ? `${message.slice(0, MAX_ERROR_MESSAGE - 1)}…`
    : message;
}

/** Size of a result as JSON, in UTF-8 bytes (what crosses the process boundary, roughly). */
export function serializedBytes(value: unknown): number {
  const json = JSON.stringify(value) as string | undefined;
  return json === undefined ? 0 : Buffer.byteLength(json);
}

function messageId(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { id } = raw as { id?: unknown };
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? id : null;
}
