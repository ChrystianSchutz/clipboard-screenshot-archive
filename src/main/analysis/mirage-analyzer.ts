import type { AnalysisLanguage, ImageAnalysis } from '@shared/image-analysis';
import { ANALYSIS_MAX_SIDE } from './analysis-image';
import { mapMirageRecord } from './mirage-record';
import type { AnalysisImage, ImageAnalyzer } from './ports';

/**
 * The slice of the Cactus WebAssembly module (Emscripten, `createCactus()` from cactus.js) this
 * adapter uses. Tests pass a fake; production loads the bundled runtime.
 */
export interface CactusModule {
  readonly HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  /** Loads a `.cact` archive from WASM memory; negative on failure. */
  _cactus_load(pointer: number, size: bigint): number;
  ccall(
    name: string,
    returnType: 'number',
    argTypes: readonly string[],
    args: readonly unknown[],
  ): number;
  UTF8ToString(pointer: number): string;
}

/** `createCactus` from cactus.js: instantiates the WASM module. */
export type CreateCactus = (options: { wasmBinary: Uint8Array }) => Promise<CactusModule>;

/**
 * The factory from a loaded cactus.js. The file is a UMD build: CommonJS sets
 * `module.exports = createCactus` (and `.default`). Production evaluates the checksum-verified
 * bytes as CommonJS (`evaluateCommonJs`); if a loader ever treats it as ESM, it exports nothing,
 * and this says so instead of failing later with "createCactus is not a function".
 */
export function cactusFactory(loaded: unknown): CreateCactus {
  if (typeof loaded === 'function') return loaded as CreateCactus;
  const fallback: unknown =
    typeof loaded === 'object' && loaded !== null
      ? (loaded as { default?: unknown }).default
      : undefined;
  if (typeof fallback === 'function') return fallback as CreateCactus;
  throw new Error(
    'cactus.js did not export createCactus; it must be loaded as CommonJS (see its package.json)',
  );
}

export interface MirageAnalyzerOptions {
  readonly id: string;
  /** Instantiates the WASM runtime. */
  readonly loadRuntime: () => Promise<CactusModule>;
  /** Reads (and verifies) mirage.cact. */
  readonly loadWeights: () => Promise<Uint8Array>;
  readonly now?: () => number;
}

/** Same bound as the vendor's browser worker: plenty for the JSON of one image. */
export const MIRAGE_OUTPUT_CAPACITY = 16 * 1024 * 1024;

/**
 * Sections and fields requested from `cactus_describe`. Masks and relations are left out: the
 * Analysis panel shows boxes, and polygons would multiply the output size for nothing.
 */
export const MIRAGE_OPTIONS = {
  sections: ['scene', 'objects', 'text', 'reasoning'],
  fields: ['bbox', 'score', 'description'],
} as const;

interface Loaded {
  readonly engine: CactusModule;
  readonly output: number;
}

/**
 * `ImageAnalyzer` backed by Cactus Mirage running in WebAssembly, following the vendor's own
 * browser worker (https://cactuscompute.com/cactus/mirage.worker.js): load the runtime, copy the
 * weights into WASM memory, call `cactus_describe` with RGB pixels, parse the JSON it writes.
 *
 * The model is loaded on first use and kept until `dispose()`. Calls are serialised: the engine
 * has one output buffer and is not re-entrant.
 */
export class MirageAnalyzer implements ImageAnalyzer {
  readonly id: string;
  private loaded: Promise<Loaded> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly options: MirageAnalyzerOptions) {
    this.id = options.id;
    this.now = options.now ?? (() => performance.now());
  }

  analyze(image: AnalysisImage, language: AnalysisLanguage): Promise<ImageAnalysis> {
    const job = this.queue.then(() => this.run(image, language));
    this.queue = job.catch(() => undefined);
    return job;
  }

  dispose(): Promise<void> {
    // The Emscripten module has no destructor; dropping it lets the worker process be ended,
    // which is how memory is returned (see WorkerClient's idle shutdown).
    this.loaded = null;
    return Promise.resolve();
  }

  private async run(image: AnalysisImage, language: AnalysisLanguage): Promise<ImageAnalysis> {
    validate(image);
    const { engine, output } = await this.ensureLoaded();
    const input = engine._malloc(image.rgb.byteLength);
    if (!input) throw new Error('Not enough memory to analyse this image');
    try {
      engine.HEAPU8.set(image.rgb, input);
      const started = this.now();
      const code = engine.ccall(
        'cactus_describe',
        'number',
        ['number', 'number', 'number', 'string', 'string', 'number', 'number', 'number'],
        [
          input,
          image.width,
          image.height,
          JSON.stringify(MIRAGE_OPTIONS),
          language,
          0,
          output,
          MIRAGE_OUTPUT_CAPACITY,
        ],
      );
      const durationMs = Math.round(this.now() - started);
      if (code < 0) throw new Error(lastError(engine) || 'Image analysis failed');
      const record: unknown = JSON.parse(engine.UTF8ToString(output));
      return mapMirageRecord(record, {
        engine: this.id,
        language,
        width: image.originalWidth,
        height: image.originalHeight,
        durationMs,
      });
    } finally {
      engine._free(input);
    }
  }

  private ensureLoaded(): Promise<Loaded> {
    if (!this.loaded) {
      const loading = this.load();
      loading.catch(() => {
        if (this.loaded === loading) this.loaded = null;
      });
      this.loaded = loading;
    }
    return this.loaded;
  }

  private async load(): Promise<Loaded> {
    const [engine, weights] = await Promise.all([
      this.options.loadRuntime(),
      this.options.loadWeights(),
    ]);
    const pointer = engine._malloc(weights.byteLength);
    if (!pointer) throw new Error('Not enough memory to load the image analysis model');
    engine.HEAPU8.set(weights, pointer);
    if (engine._cactus_load(pointer, BigInt(weights.byteLength)) < 0) {
      engine._free(pointer);
      throw new Error(lastError(engine) || 'The image analysis model could not be loaded');
    }
    const output = engine._malloc(MIRAGE_OUTPUT_CAPACITY);
    if (!output) {
      engine._free(pointer);
      throw new Error('Not enough memory for image analysis');
    }
    return { engine, output };
  }
}

function validate(image: AnalysisImage): void {
  const { width, height, rgb } = image;
  const valid =
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= ANALYSIS_MAX_SIDE &&
    height <= ANALYSIS_MAX_SIDE &&
    rgb.length === width * height * 3;
  if (!valid) throw new Error('Invalid image for analysis');
}

function lastError(engine: CactusModule): string {
  return engine.UTF8ToString(engine.ccall('cactus_last_error', 'number', [], []));
}
