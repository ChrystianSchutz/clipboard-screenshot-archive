/**
 * Hand-written test doubles for the screenshot, text-recognition and image-analysis ports
 * (see `fakes.ts` for the clipboard ones).
 */
import { basename, dirname } from 'node:path';
import { vi } from 'vitest';
import type { AnalysisLanguage, ImageAnalysis } from '@shared/image-analysis';
import type { OcrResult } from '@shared/ocr';
import type { AnalysisImage, ImageAnalyzer } from '../analysis/ports';
import type { ImageFileSystem, ImageHandle } from '../images/ports';
import type { OcrImage, TextRecognizer } from '../ocr/ports';

/**
 * A decoded image whose pixels are a solid `fill` byte. `png()` returns a readable fake encoding
 * ("png:<w>x<h>:<fill>") so tests can assert which size was encoded.
 */
export class FakeImage implements ImageHandle {
  readonly resizes: { width: number; height: number }[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
    readonly fill = 1,
  ) {}

  bitmap(): Uint8Array {
    return new Uint8Array(this.width * this.height * 4).fill(this.fill);
  }

  png(): Uint8Array {
    return new TextEncoder().encode(`png:${this.width}x${this.height}:${this.fill}`);
  }

  resized(width: number, height: number): ImageHandle {
    this.resizes.push({ width, height });
    return new FakeImage(width, height, this.fill);
  }
}

export function decodeFakePng(png: Uint8Array): string {
  return new TextDecoder().decode(png);
}

/** In-memory file system keyed by path. */
export class MemoryImageFs implements ImageFileSystem {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();
  readonly writes: string[] = [];

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }

  mkdir(path: string): Promise<void> {
    this.dirs.add(path);
    return Promise.resolve();
  }

  writeFile(path: string, data: Uint8Array): Promise<void> {
    this.writes.push(path);
    this.files.set(path, data);
    return Promise.resolve();
  }

  readFile(path: string): Promise<Uint8Array> {
    const data = this.files.get(path);
    return data ? Promise.resolve(data) : Promise.reject(new Error(`ENOENT: ${path}`));
  }

  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }

  list(dir: string): Promise<string[]> {
    const names = [...this.files.keys()]
      .filter((path) => dirname(path) === dir)
      .map((path) => basename(path));
    return Promise.resolve(names);
  }
}

export function ocrResult(overrides: Partial<OcrResult> = {}): OcrResult {
  return { engine: 'fake', width: 100, height: 50, lines: [], durationMs: 1, ...overrides };
}

/** Text recognizer that answers every image with `result` (or fails when `failWith` is set). */
export class FakeTextRecognizer implements TextRecognizer {
  readonly id = 'fake-ocr';
  result: OcrResult = ocrResult();
  failWith: Error | null = null;
  readonly images: OcrImage[] = [];
  readonly recognize = vi.fn((image: OcrImage) => {
    this.images.push(image);
    return this.failWith ? Promise.reject(this.failWith) : Promise.resolve(this.result);
  });
  readonly dispose = vi.fn(() => Promise.resolve());
}

export function imageAnalysis(overrides: Partial<ImageAnalysis> = {}): ImageAnalysis {
  return {
    engine: 'fake-analyzer',
    language: 'en',
    width: 100,
    height: 50,
    description: [],
    scene: {},
    objects: [],
    text: [],
    durationMs: 1,
    ...overrides,
  };
}

export class FakeImageAnalyzer implements ImageAnalyzer {
  readonly id = 'fake-analyzer';
  readonly calls: { image: AnalysisImage; language: AnalysisLanguage }[] = [];
  readonly analyze = vi.fn((image: AnalysisImage, language: AnalysisLanguage) => {
    this.calls.push({ image, language });
    return Promise.resolve(imageAnalysis({ language }));
  });
  readonly dispose = vi.fn(() => Promise.resolve());
}
