import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cactusFactory } from './mirage-analyzer';
import { CACTUS_RUNTIME_FILES, CACTUS_RUNTIME_VERSION } from './mirage-model';
import { assertChecksum, evaluateCommonJs } from './verified-script';

const RUNTIME = resolve(
  import.meta.dirname,
  '../../../resources/analysis',
  `cactus-${CACTUS_RUNTIME_VERSION}`,
);

const encode = (text: string) => new TextEncoder().encode(text);

describe('evaluateCommonJs', () => {
  it('returns module.exports of the given source', () => {
    const file = join(RUNTIME, 'virtual', 'script.js');
    const exported = evaluateCommonJs(
      encode('module.exports = { answer: 42, file: __filename, dir: __dirname };'),
      file,
    );
    expect(exported).toEqual({ answer: 42, file, dir: join(RUNTIME, 'virtual') });
  });

  it('gives the script a working require', () => {
    const exported = evaluateCommonJs(
      encode("module.exports = require('node:path').basename('/a/b.txt');"),
      join(RUNTIME, 'probe.js'),
    ) as string;
    expect(exported).toBe('b.txt');
  });

  it('runs exactly the bytes it was given, not the file at that path', () => {
    // The path points at the real cactus.js, but the checked buffer is what runs.
    const exported = evaluateCommonJs(
      encode('module.exports = "from the buffer";'),
      join(RUNTIME, CACTUS_RUNTIME_FILES.script.name),
    );
    expect(exported).toBe('from the buffer');
  });

  it('loads the bundled Cactus runtime from its verified bytes and instantiates it', async () => {
    const script = assertChecksum(
      readFileSync(join(RUNTIME, CACTUS_RUNTIME_FILES.script.name)),
      CACTUS_RUNTIME_FILES.script.sha256,
      'cactus.js',
    );
    const wasmBinary = assertChecksum(
      readFileSync(join(RUNTIME, CACTUS_RUNTIME_FILES.wasm.name)),
      CACTUS_RUNTIME_FILES.wasm.sha256,
      'cactus.wasm',
    );
    const createCactus = cactusFactory(
      evaluateCommonJs(script, join(RUNTIME, CACTUS_RUNTIME_FILES.script.name)),
    );
    const engine = await createCactus({ wasmBinary });
    expect(typeof engine._malloc).toBe('function');
    expect(typeof engine.ccall).toBe('function');
  });
});

describe('assertChecksum', () => {
  it('passes matching bytes through and rejects anything else', () => {
    const bytes = encode('abc');
    const sha = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    expect(assertChecksum(bytes, sha, 'abc')).toBe(bytes);
    expect(() => assertChecksum(encode('abd'), sha, 'abd')).toThrow(
      'abd does not match its checksum',
    );
  });
});
