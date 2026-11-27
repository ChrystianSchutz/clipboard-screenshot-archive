/**
 * Accuracy and speed of the two screenshot engines on the same fixtures (tests/fixtures/ocr,
 * rendered by scripts/generate-ocr-fixtures.mjs): a terminal with ECONNRESET, a code snippet and a
 * Polish sentence with every diacritic.
 *
 * - Tesseract (text recognition) always runs: it is bundled, so its accuracy is a regression test.
 * - Mirage (image analysis) runs only when `MIRAGE_WEIGHTS=<path to mirage.cact>` is set, because
 *   its 22 MB model is a user download, not part of the repository.
 *
 * Prints a side-by-side table: character error rate (CER) of the text each engine read, and time.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import tesseract from 'tesseract.js';
import { afterAll, describe, expect, it } from 'vitest';
import { ocrText } from '@shared/ocr';
import { CACTUS_RUNTIME_FILES, MIRAGE_ANALYZER_ID, MIRAGE_WEIGHTS } from '../analysis/mirage-model';
import { MirageAnalyzer, cactusFactory } from '../analysis/mirage-analyzer';
import { sha256Hex } from '../models/model-downloader';
import { TesseractRecognizer } from '../ocr/tesseract-recognizer';
import { decodePng } from '../test-support/png';
import { characterErrorRate } from './text-metrics';

const ROOT = join(__dirname, '..', '..', '..');
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'ocr');
const TESSDATA = join(ROOT, 'resources', 'ocr', 'tessdata');
const CACTUS_RUNTIME = join(ROOT, 'resources', 'analysis', 'cactus-4.1.4');

interface Fixture {
  readonly width: number;
  readonly height: number;
  readonly lines: readonly string[];
}

const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as Record<
  string,
  Fixture
>;
const names = Object.keys(expected);
const fixture = (name: string): Fixture => expected[name]!;
const png = (file: string) => new Uint8Array(readFileSync(join(FIXTURES, file)));

interface Row {
  readonly engine: string;
  readonly fixture: string;
  readonly cer: number;
  readonly ms: number;
  readonly note?: string;
}
const rows: Row[] = [];

afterAll(() => {
  const table = rows
    .map(
      (row) =>
        `${row.engine.padEnd(22)} ${row.fixture.padEnd(9)} CER ${(row.cer * 100).toFixed(1).padStart(5)} %  ${String(row.ms).padStart(5)} ms  ${row.note ?? ''}`,
    )
    .join('\n');
  process.stdout.write(`\nScreenshot engines on tests/fixtures/ocr\n${table}\n\n`);
});

describe('Tesseract text recognition (bundled eng+pol tessdata_fast)', () => {
  const { version } = createRequire(__filename)('tesseract.js/package.json') as { version: string };
  const recognizer = new TesseractRecognizer({
    tesseract,
    tessdataDir: TESSDATA,
    languages: ['eng', 'pol'],
    version,
  });
  afterAll(() => recognizer.dispose());

  it('ships the pinned models', () => {
    expect(sha256Hex(readFileSync(join(TESSDATA, 'eng.traineddata')))).toBe(
      '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2',
    );
    expect(sha256Hex(readFileSync(join(TESSDATA, 'pol.traineddata')))).toBe(
      'c4476cdbc0e33d898d32345122b7be1cbf85ace15f920f06c7714756e1ef79b2',
    );
  });

  async function read(name: string, scale: 1 | 2) {
    const { width, height } = fixture(name);
    const file = scale === 2 ? `${name}.x2.png` : `${name}.png`;
    const result = await recognizer.recognize({ png: png(file), width, height, scale });
    const cer = characterErrorRate(fixture(name).lines.join('\n'), ocrText(result));
    rows.push({ engine: `tesseract ${scale}x`, fixture: name, cer, ms: result.durationMs });
    return { result, cer };
  }

  it.each(names)('reads %s at 1x (as captured)', async (name) => {
    const { result } = await read(name, 1);
    expect(result.width).toBe(fixture(name).width);
    expect(result.lines.length).toBeGreaterThan(0);
  });

  it('finds ECONNRESET in the terminal screenshot (2x, the production path)', async () => {
    const { result, cer } = await read('terminal', 2);
    const text = ocrText(result);
    expect(text).toContain('Error: read ECONNRESET');
    expect(text).toContain('TLSWrap.onStreamRead');
    expect(cer).toBeLessThan(0.05);
    // Boxes refer to the original image even though Tesseract read a 2x copy.
    for (const line of result.lines)
      expect(line.box.x1).toBeLessThanOrEqual(fixture('terminal').width);
  });

  it('reads the code snippet closely enough to search identifiers (2x)', async () => {
    const { result, cer } = await read('code', 2);
    expect(ocrText(result)).toContain('fetchInvoices(customerId: string)');
    expect(cer).toBeLessThan(0.05);
  });

  it('reads Polish diacritics exactly (2x)', async () => {
    const { result, cer } = await read('polish', 2);
    expect(ocrText(result)).toContain('Zażółć gęślą jaźń.');
    expect(cer).toBeLessThan(0.01);
  });
});

const mirageWeights = process.env.MIRAGE_WEIGHTS;

describe.skipIf(!mirageWeights)('Mirage image analysis (MIRAGE_WEIGHTS set)', () => {
  const analyzer = new MirageAnalyzer({
    id: MIRAGE_ANALYZER_ID,
    loadRuntime: () => {
      const wasmBinary = readFileSync(join(CACTUS_RUNTIME, CACTUS_RUNTIME_FILES.wasm.name));
      expect(sha256Hex(wasmBinary)).toBe(CACTUS_RUNTIME_FILES.wasm.sha256);
      const createCactus = cactusFactory(
        createRequire(__filename)(join(CACTUS_RUNTIME, CACTUS_RUNTIME_FILES.script.name)),
      );
      return createCactus({ wasmBinary });
    },
    loadWeights: () => {
      const weights = readFileSync(mirageWeights!);
      expect(sha256Hex(weights)).toBe(MIRAGE_WEIGHTS.sha256);
      return Promise.resolve(new Uint8Array(weights));
    },
  });
  afterAll(() => analyzer.dispose());

  it.each(names.flatMap((name) => [[name, 'en'] as const, [name, 'pl'] as const]))(
    'analyses %s (%s)',
    async (name, language) => {
      const { width, height, rgba } = decodePng(png(`${name}.png`));
      const rgb = new Uint8Array(width * height * 3);
      for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) rgb.set(rgba.subarray(i, i + 3), j);
      const analysis = await analyzer.analyze(
        { rgb, width, height, originalWidth: width, originalHeight: height },
        language,
      );
      const read = analysis.text.map((line) => line.text).join('\n');
      rows.push({
        engine: `mirage (${language})`,
        fixture: name,
        cer: characterErrorRate(fixture(name).lines.join('\n'), read),
        ms: analysis.durationMs,
        note: `${analysis.objects.length} objects | ${analysis.description.join(' / ').slice(0, 120)}`,
      });
      expect(analysis.width).toBe(width);
    },
    180_000,
  );
});
