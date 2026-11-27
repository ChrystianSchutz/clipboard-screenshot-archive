import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../models/model-downloader';
import { TESSDATA_FILES } from '../ocr/tessdata-files';
import { CACTUS_RUNTIME_FILES, CACTUS_RUNTIME_VERSION } from './mirage-model';

/**
 * Every vendored binary or script under resources/ is pinned by SHA-256. A repo-wide formatter
 * once rewrote cactus.js and the app then failed every analysis at runtime; this test makes such
 * a change fail CI instead of shipping.
 */
const RESOURCES = resolve(import.meta.dirname, '../../../resources');

interface PinnedFolder {
  readonly dir: string;
  readonly pinned: Readonly<Record<string, string>>;
  /** Files that may sit next to the pinned ones without a checksum (licence, loader hints). */
  readonly unpinned: readonly string[];
}

const FOLDERS: readonly PinnedFolder[] = [
  {
    dir: join(RESOURCES, 'analysis', `cactus-${CACTUS_RUNTIME_VERSION}`),
    pinned: Object.fromEntries(
      Object.values(CACTUS_RUNTIME_FILES).map((file) => [file.name, file.sha256]),
    ),
    unpinned: ['LICENSE', 'package.json'],
  },
  { dir: join(RESOURCES, 'ocr', 'tessdata'), pinned: TESSDATA_FILES, unpinned: [] },
];

describe('vendored resources', () => {
  for (const { dir, pinned, unpinned } of FOLDERS) {
    describe(dir.slice(RESOURCES.length + 1), () => {
      for (const [name, sha256] of Object.entries(pinned)) {
        it(`${name} matches its pinned checksum`, () => {
          expect(sha256Hex(readFileSync(join(dir, name)))).toBe(sha256);
        });
      }

      it('holds no file without a pin', () => {
        const expected = [...Object.keys(pinned), ...unpinned].sort();
        expect(readdirSync(dir).sort()).toEqual(expected);
      });
    });
  }

  it('has no other vendored folder that escapes the checks', () => {
    expect(readdirSync(join(RESOURCES, 'analysis')).sort()).toEqual([
      `cactus-${CACTUS_RUNTIME_VERSION}`,
    ]);
    expect(readdirSync(join(RESOURCES, 'ocr')).sort()).toEqual(['tessdata']);
  });
});
