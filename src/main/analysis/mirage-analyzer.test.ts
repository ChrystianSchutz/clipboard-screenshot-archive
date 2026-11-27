import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '../test-support/fakes';
import {
  MIRAGE_OPTIONS,
  MIRAGE_OUTPUT_CAPACITY,
  MirageAnalyzer,
  cactusFactory,
  type CactusModule,
} from './mirage-analyzer';
import type { AnalysisImage } from './ports';

const DESCRIBE_ARG_TYPES = [
  'number',
  'number',
  'number',
  'string',
  'string',
  'number',
  'number',
  'number',
];

/**
 * Just enough of the Emscripten module: a heap, a bump allocator that records frees, and a
 * `cactus_describe` that writes `response` as a null-terminated string into the output buffer.
 */
class FakeCactus implements CactusModule {
  readonly HEAPU8 = new Uint8Array(MIRAGE_OUTPUT_CAPACITY + 64 * 1024);
  readonly allocations: { pointer: number; size: number }[] = [];
  readonly freed: number[] = [];
  /** What `cactus_describe` writes (a JSON record) and returns. */
  response = JSON.stringify({ reasoning: 'lang: en | a dialog box' });
  describeCode = 0;
  loadCode = 0;
  lastError = 'model archive is corrupt';
  /** When set, the next allocation of this size fails (returns 0). */
  failAllocationOf: number | null = null;
  /** The pixels `cactus_describe` found in the heap, per call. */
  readonly pixelsSeen: Uint8Array[] = [];
  private next = 16;

  _malloc = vi.fn((size: number): number => {
    if (size === this.failAllocationOf) return 0;
    const pointer = this.next;
    this.next += size;
    this.allocations.push({ pointer, size });
    return pointer;
  });

  _free = vi.fn((pointer: number): void => {
    this.freed.push(pointer);
  });

  _cactus_load = vi.fn<(pointer: number, size: bigint) => number>(() => this.loadCode);

  ccall = vi.fn<CactusModule['ccall']>((name, ...rest) => {
    if (name === 'cactus_last_error') return this.writeString(this._malloc(1024), this.lastError);
    if (name !== 'cactus_describe') throw new Error(`Unexpected ccall ${name}`);
    const args = rest[2];
    const [input = 0, width = 0, height = 0, , , , output = 0] = args as number[];
    this.pixelsSeen.push(this.HEAPU8.slice(input, input + width * height * 3));
    this.writeString(output, this.response);
    return this.describeCode;
  });

  UTF8ToString(pointer: number): string {
    const end = this.HEAPU8.indexOf(0, pointer);
    return new TextDecoder().decode(this.HEAPU8.subarray(pointer, end));
  }

  /** Pointer of the most recent allocation of `size` bytes. */
  pointerOf(size: number): number {
    return this.allocations.findLast((allocation) => allocation.size === size)!.pointer;
  }

  describeCalls(): (readonly unknown[])[] {
    return this.ccall.mock.calls.filter(([name]) => name === 'cactus_describe');
  }

  private writeString(pointer: number, text: string): number {
    const bytes = new TextEncoder().encode(text);
    this.HEAPU8.set(bytes, pointer);
    this.HEAPU8[pointer + bytes.length] = 0;
    return pointer;
  }
}

/** A `width` × `height` RGB image cut down from an original of `originalWidth` × `originalHeight`. */
function analysisImage(
  width: number,
  height: number,
  original = { originalWidth: width * 4, originalHeight: height * 4 },
): AnalysisImage {
  const rgb = new Uint8Array(width * height * 3).map((_, index) => index % 251);
  return { rgb, width, height, ...original };
}

describe('MirageAnalyzer', () => {
  const WEIGHTS = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  let engine: FakeCactus;
  let loadRuntime: ReturnType<typeof vi.fn<() => Promise<CactusModule>>>;
  let loadWeights: ReturnType<typeof vi.fn<() => Promise<Uint8Array>>>;
  let clock: number;
  let analyzer: MirageAnalyzer;

  beforeEach(() => {
    engine = new FakeCactus();
    loadRuntime = vi.fn(() => Promise.resolve<CactusModule>(engine));
    loadWeights = vi.fn(() => Promise.resolve(WEIGHTS));
    clock = 1_000;
    analyzer = new MirageAnalyzer({
      id: 'mirage-test',
      loadRuntime,
      loadWeights,
      // Every reading advances the clock by 250 ms.
      now: () => (clock += 250),
    });
  });

  it('loads the runtime and the weights once and reuses them', async () => {
    await analyzer.analyze(analysisImage(4, 3), 'en');
    await analyzer.analyze(analysisImage(2, 2), 'en');

    expect(loadRuntime).toHaveBeenCalledTimes(1);
    expect(loadWeights).toHaveBeenCalledTimes(1);
    expect(engine._cactus_load).toHaveBeenCalledTimes(1);
    expect(engine.describeCalls()).toHaveLength(2);
  });

  it('copies the weights into WASM memory and loads them with a 64-bit size', async () => {
    await analyzer.analyze(analysisImage(4, 3), 'en');

    const pointer = engine.pointerOf(WEIGHTS.length);
    expect([...engine.HEAPU8.subarray(pointer, pointer + WEIGHTS.length)]).toEqual([...WEIGHTS]);
    expect(engine._cactus_load).toHaveBeenCalledWith(pointer, BigInt(WEIGHTS.length));
  });

  it('calls cactus_describe with the pixels, the size, the requested sections and the language', async () => {
    const image = analysisImage(4, 3);
    await analyzer.analyze(image, 'pl');

    const input = engine.pointerOf(image.rgb.length);
    const output = engine.pointerOf(MIRAGE_OUTPUT_CAPACITY);
    expect(engine.ccall).toHaveBeenCalledWith('cactus_describe', 'number', DESCRIBE_ARG_TYPES, [
      input,
      4,
      3,
      JSON.stringify(MIRAGE_OPTIONS),
      'pl',
      0,
      output,
      MIRAGE_OUTPUT_CAPACITY,
    ]);
    expect(engine.pixelsSeen[0]).toEqual(image.rgb);
  });

  it('maps the record onto the original screenshot size and measures the call', async () => {
    engine.response = JSON.stringify({
      objects: [{ id: 1, name: 'dialog box', bbox: [0, 0, 500, 500], score: 0.9 }],
      reasoning: 'lang: pl | okno dialogowe',
    });

    const analysis = await analyzer.analyze(
      analysisImage(4, 3, { originalWidth: 800, originalHeight: 600 }),
      'pl',
    );

    expect(analysis).toMatchObject({
      engine: 'mirage-test',
      language: 'pl',
      width: 800,
      height: 600,
      description: ['okno dialogowe'],
      durationMs: 250,
    });
    expect(analysis.objects[0]!.box).toEqual({ x0: 0, y0: 0, x1: 400, y1: 300 });
  });

  it('rejects with the engine error when cactus_describe fails, and frees the input', async () => {
    engine.describeCode = -1;
    engine.lastError = 'image too large for context';
    const image = analysisImage(4, 3);

    await expect(analyzer.analyze(image, 'en')).rejects.toThrow('image too large for context');
    expect(engine.freed).toContain(engine.pointerOf(image.rgb.length));
  });

  it('frees the input when the engine output cannot be parsed', async () => {
    engine.response = '{"objects": [';
    const image = analysisImage(4, 3);

    await expect(analyzer.analyze(image, 'en')).rejects.toThrow(SyntaxError);
    expect(engine.freed).toContain(engine.pointerOf(image.rgb.length));
  });

  it('rejects when there is no memory for the input', async () => {
    const image = analysisImage(4, 3);
    engine.failAllocationOf = image.rgb.length;

    await expect(analyzer.analyze(image, 'en')).rejects.toThrow(
      'Not enough memory to analyse this image',
    );
    expect(engine.describeCalls()).toHaveLength(0);
  });

  it('rejects when the model cannot be loaded, frees the weights and loads again on the next call', async () => {
    engine.loadCode = -1;

    await expect(analyzer.analyze(analysisImage(4, 3), 'en')).rejects.toThrow(
      'model archive is corrupt',
    );
    expect(engine.freed).toContain(engine.pointerOf(WEIGHTS.length));
    expect(engine.describeCalls()).toHaveLength(0);

    engine.loadCode = 0;
    await expect(analyzer.analyze(analysisImage(4, 3), 'en')).resolves.toMatchObject({
      engine: 'mirage-test',
    });
    expect(loadRuntime).toHaveBeenCalledTimes(2);
    expect(engine._cactus_load).toHaveBeenCalledTimes(2);
  });

  it('lets a call queued behind a failed load try loading again', async () => {
    loadRuntime.mockRejectedValueOnce(new Error('wasm fetch failed'));

    const first = analyzer.analyze(analysisImage(4, 3), 'en');
    const second = analyzer.analyze(analysisImage(4, 3), 'en');

    await expect(first).rejects.toThrow('wasm fetch failed');
    await expect(second).resolves.toMatchObject({ engine: 'mirage-test' });
    expect(loadRuntime).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'wider than the model limit',
      { ...analysisImage(1, 1), width: 1025, rgb: new Uint8Array(1025 * 3) },
    ],
    [
      'taller than the model limit',
      { ...analysisImage(1, 1), height: 1025, rgb: new Uint8Array(1025 * 3) },
    ],
    ['with pixels that do not match its size', { ...analysisImage(4, 3), rgb: new Uint8Array(10) }],
    ['with a zero side', { ...analysisImage(1, 1), width: 0, rgb: new Uint8Array(0) }],
    ['with a fractional side', { ...analysisImage(1, 1), width: 1.5, rgb: new Uint8Array(4) }],
  ])('rejects an image %s before touching the engine', async (_case, image: AnalysisImage) => {
    await expect(analyzer.analyze(image, 'en')).rejects.toThrow('Invalid image for analysis');
    expect(loadRuntime).not.toHaveBeenCalled();
    expect(engine._malloc).not.toHaveBeenCalled();
  });

  it('runs calls one at a time, in order, and a failed call does not block the next', async () => {
    const runtime = deferred<CactusModule>();
    loadRuntime.mockReturnValueOnce(runtime.promise);

    const first = analyzer.analyze(analysisImage(4, 3), 'en');
    const invalid = analyzer.analyze({ ...analysisImage(4, 3), rgb: new Uint8Array(1) }, 'en');
    const third = analyzer.analyze(analysisImage(2, 2), 'pl');
    runtime.resolve(engine);

    await expect(first).resolves.toMatchObject({ language: 'en' });
    await expect(invalid).rejects.toThrow('Invalid image for analysis');
    await expect(third).resolves.toMatchObject({ language: 'pl' });
    expect(engine.describeCalls().map((call) => (call[3] as unknown[]).slice(1, 3))).toEqual([
      [4, 3],
      [2, 2],
    ]);
  });

  it('loads the model again, into a fresh runtime, after dispose', async () => {
    await analyzer.analyze(analysisImage(4, 3), 'en');
    await analyzer.dispose();
    const fresh = new FakeCactus();
    loadRuntime.mockResolvedValueOnce(fresh);

    await analyzer.analyze(analysisImage(4, 3), 'en');

    expect(loadRuntime).toHaveBeenCalledTimes(2);
    expect(loadWeights).toHaveBeenCalledTimes(2);
    expect(fresh._cactus_load).toHaveBeenCalledTimes(1);
    expect(fresh.describeCalls()).toHaveLength(1);
    expect(engine.describeCalls()).toHaveLength(1);
  });
});

describe('cactusFactory', () => {
  const factory = () => Promise.reject(new Error('not called'));

  it('accepts the CommonJS export (module.exports = createCactus)', () => {
    expect(cactusFactory(factory)).toBe(factory);
  });

  it('accepts a default export', () => {
    expect(cactusFactory({ default: factory })).toBe(factory);
  });

  it('explains an empty ESM namespace instead of failing later', () => {
    expect(() => cactusFactory({})).toThrow('cactus.js did not export createCactus');
    expect(() => cactusFactory(null)).toThrow('cactus.js did not export createCactus');
  });
});
