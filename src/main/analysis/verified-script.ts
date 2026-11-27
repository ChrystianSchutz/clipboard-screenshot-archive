import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { compileFunction } from 'node:vm';

/**
 * Runs a CommonJS script from bytes that were already read and checked, and returns its
 * `module.exports`.
 *
 * `require(path)` would open the file a second time after the checksum check, so a file swapped
 * in between (time-of-check to time-of-use) would run unverified. Here the checked buffer is the
 * code that runs: the file is never read again. `require`, `__filename` and `__dirname` behave as
 * if the script had been required from `filename`, which Emscripten builds use to find their
 * neighbours (they are handed `wasmBinary` anyway, so nothing else is loaded from disk).
 */
export function evaluateCommonJs(source: Uint8Array, filename: string): unknown {
  const module: { exports: unknown } = { exports: {} };
  const run = compileFunction(
    Buffer.from(source).toString('utf8'),
    ['exports', 'require', 'module', '__filename', '__dirname'],
    { filename },
  );
  run.call(
    module.exports,
    module.exports,
    createRequire(filename),
    module,
    filename,
    dirname(filename),
  );
  return module.exports;
}

/** Throws unless `bytes` hash to `sha256`; returns them for chaining. */
export function assertChecksum(bytes: Uint8Array, sha256: string, label: string): Uint8Array {
  if (createHash('sha256').update(bytes).digest('hex') !== sha256)
    throw new Error(`${label} does not match its checksum`);
  return bytes;
}
