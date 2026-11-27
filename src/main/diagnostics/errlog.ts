import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Local, dependency-free error log: one JSON line per event in `<dir>/errors.jsonl`.
 *
 * - Errors are grouped by a fingerprint; repeats within `dedupeMs` are counted, not re-written.
 * - The file rotates at `maxBytes` (one `.1` backup).
 * - Nothing leaves the machine, and clipboard content is never logged: messages are scrubbed
 *   of quoted text, and context accepts short identifiers only.
 */

export interface ErrlogOptions {
  readonly dir: string;
  readonly app: string;
  readonly dedupeMs?: number;
  readonly maxBytes?: number;
  readonly now?: () => number;
}

export type ErrorKind = 'main' | 'renderer' | 'uncaught' | 'unhandled-rejection' | 'process-gone';

export interface ErrorEvent {
  readonly time: string;
  readonly app: string;
  readonly kind: ErrorKind;
  readonly fingerprint: string;
  readonly message: string;
  readonly stack: string | undefined;
  readonly where: string;
  readonly count: number;
}

export interface Errlog {
  readonly file: string;
  error(error: unknown, where: string, kind?: ErrorKind): void;
  installProcessHandlers(): void;
}

const QUOTED = /"[^"\n]{1,200}"|'[^'\n]{1,200}'|`[^`\n]{1,200}`/g;
const SECRETISH = /(bearer\s+[\w.-]+|eyJ[\w-]{10,}\.[\w-]+\.[\w-]+|sk-[\w-]{10,})/gi;
const WHERE = /^[\w .:/#()-]{0,80}$/;

/** Removes anything that could be user data from free text. */
export function scrub(text: string): string {
  return text.replace(SECRETISH, '[redacted]').replace(QUOTED, '[text]').slice(0, 2000);
}

/** Same bug → same fingerprint, even when numbers in the message differ. */
export function fingerprint(kind: string, message: string, stack: string | undefined): string {
  const topFrame = stack?.split('\n').find((line) => line.trim().startsWith('at ')) ?? '';
  const normalized = `${kind}|${message.replace(/\d+/g, 'N')}|${topFrame.trim()}`;
  return createHash('sha1').update(normalized).digest('hex').slice(0, 12);
}

export function createErrlog(options: ErrlogOptions): Errlog {
  const dedupeMs = options.dedupeMs ?? 60_000;
  const maxBytes = options.maxBytes ?? 1_000_000;
  const now = options.now ?? Date.now;
  const file = join(options.dir, 'errors.jsonl');
  const recent = new Map<string, { at: number; suppressed: number }>();

  const write = (event: ErrorEvent): void => {
    try {
      if (!existsSync(options.dir)) mkdirSync(options.dir, { recursive: true });
      if (existsSync(file) && statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
      appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
    } catch {
      // The error log must never become a source of errors itself.
    }
  };

  const error = (err: unknown, where: string, kind: ErrorKind = 'main'): void => {
    const message = scrub(err instanceof Error ? err.message : String(err));
    const stack = err instanceof Error && err.stack ? scrub(err.stack).slice(0, 1500) : undefined;
    const print = fingerprint(kind, message, stack);
    const at = now();

    const seen = recent.get(print);
    if (seen && at - seen.at < dedupeMs) {
      seen.suppressed++;
      return;
    }
    recent.set(print, { at, suppressed: 0 });

    write({
      time: new Date(at).toISOString(),
      app: options.app,
      kind,
      fingerprint: print,
      message,
      stack,
      where: WHERE.test(where) ? where : '[where]',
      count: (seen?.suppressed ?? 0) + 1,
    });
    console.error(`[${kind}] ${where}: ${message}`);
  };

  return {
    file,
    error,
    installProcessHandlers() {
      process.on('uncaughtException', (err) => error(err, 'process', 'uncaught'));
      process.on('unhandledRejection', (reason) => error(reason, 'process', 'unhandled-rejection'));
    },
  };
}
