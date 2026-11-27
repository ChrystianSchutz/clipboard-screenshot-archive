/**
 * Pinned Cactus Mirage artefacts. Every file is identified by an immutable Hugging Face revision
 * and a SHA-256, checked after download and again each time the model is loaded.
 *
 * - Runtime (Apache-2.0): bundled with the app under resources/analysis/cactus-4.1.4/, copied from
 *   https://huggingface.co/Cactus-Compute/cactus/tree/f4ab2741203a282c6e7b89983de2b5e5b2e805a8/releases/4.1.4/wasm
 *   (hashes match that release's manifest.json).
 * - Weights (Apache-2.0, 21.6 MB): downloaded on first use, when the user turns analysis on.
 *   Source: https://huggingface.co/Cactus-Compute/mirage
 */
import type { ModelFile } from '../models/model-downloader';

export const CACTUS_RUNTIME_VERSION = '4.1.4';

export const CACTUS_RUNTIME_FILES = {
  script: {
    name: 'cactus.js',
    sha256: '707341e44776ab0eb8dfc8f6a579ed5ac41e2ffc6419a18012f61619a6dfc70c',
  },
  wasm: {
    name: 'cactus.wasm',
    sha256: 'fae56a5aae883224e8b196d2bc2fcd6ba1db5347ed2fcfd733f545775c7d3be0',
  },
} as const;

export const MIRAGE_REVISION = '3d03cee88c0acbe4e71b94b567ab14e6e55f40c9';

export const MIRAGE_WEIGHTS: ModelFile = {
  name: 'mirage.cact',
  url: `https://huggingface.co/Cactus-Compute/mirage/resolve/${MIRAGE_REVISION}/mirage.cact`,
  sha256: '4249a0f7515272ff76b9414bec17d7e7daf84b15b66c7fb4f17fce1e66f9f237',
  size: 21_611_043,
};

export const MIRAGE_ANALYZER_ID = `mirage.cact@${MIRAGE_REVISION.slice(0, 7)}/cactus@${CACTUS_RUNTIME_VERSION}`;
