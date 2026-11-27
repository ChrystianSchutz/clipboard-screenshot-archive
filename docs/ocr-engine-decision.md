# Screenshot text and image analysis: engine decision

Status: accepted for text recognition. Image analysis is built and tested, but its benchmark numbers are still pending (see the end of this file).

## Two engines, two jobs

|           | Tesseract (tesseract.js 7.0.0)                                                                                                                    | Cactus Mirage                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Job       | Text. Exact word boxes for the selectable text layer and for search                                                                               | Meaning. A description (EN/PL), the objects it sees with boxes, and its own reading of the text                                                                |
| When      | Every captured image, automatically (Settings → Images → Text recognition)                                                                        | Off by default. Can run on demand ("Analyze" button) or automatically                                                                                          |
| Ships as  | `tesseract.js` and `tesseract.js-core` (WASM) unpacked from the asar, plus `resources/ocr/tessdata/{eng,pol}.traineddata` (tessdata_fast, 8.9 MB) | The Cactus 4.1.4 WASM runtime, bundled in `resources/analysis/cactus-4.1.4/` (1.3 MB, Apache-2.0). The 21.6 MB `mirage.cact` weights are downloaded on request |
| Stored as | `clip_images.ocr_json`. The text goes into `clip_extra_text` (origin `ocr`)                                                                       | `clip_images.analysis_json`. The description, scene words and object labels go into `clip_extra_text` (origin `analysis`)                                      |

Both results are stored side by side. Neither replaces the other. Mirage's own text reading is shown in the panel but is not used for the text layer: its line boxes are coarser than Tesseract's word boxes.

## Why a utility process

Each engine runs in its own Electron `utilityProcess`: `out/main/ocr-host.js` and `out/main/analysis-host.js`, started by `spawnElectronWorker` and driven by `WorkerClient`.

- A large screenshot ties up a WASM engine for hundreds of milliseconds. On the main thread, that would stall clipboard capture, IPC and global shortcuts.
- A crash or out-of-memory error in WASM ends that process only. `RemoteTextRecognizer` and `RemoteImageAnalyzer` restart it on the next job, and the job fails cleanly (the state becomes `failed` and the error is logged with errlog).
- `KeyedQueue` runs one job per image hash, so the same image copied twice is recognized once.

## Runtime bundled, weights downloaded

- **Runtime (bundled):**
  - Small: 1.3 MB.
  - Pinned to Hugging Face revision `f4ab274`.
  - Both files are SHA-256-checked against the release manifest, at load time too.
  - Bundling it means no code is ever downloaded at run time.
- **Weights (downloaded, 21.6 MB):**
  - Downloaded only when the user clicks Download (in Settings or the Analysis panel).
  - Source: the official repository, pinned to revision `3d03cee`: <https://huggingface.co/Cactus-Compute/mirage>.
  - Download path: received and SHA-256 verified in memory, then written atomically to `userData/models/mirage.cact`. A broken or tampered download never reaches the disk.
  - The hash is checked again on every model load.
  - Progress is shown in the UI, and the download can be cancelled.
- **Why not bundle the weights:** they would almost double the installer for a feature that is off by default.

## Loading the Cactus runtime (ESM/CJS)

The runtime's `cactus.js` is an Emscripten CommonJS module. The main bundle is ESM.

- **Fix:** the runtime folder carries its own `package.json` with `"type": "commonjs"`, and the host loads it with `createRequire`.
- **Entry point:** the loader calls the exported `cactusFactory`. There is no `createCactus` export; calling that name was the cause of the first benchmark failure ("createCactus is not a function").
- **How the exports were checked:** statically, by reading the file. The downloaded code was never executed to find out.

## Adaptive 2x upscaling for text recognition

Tesseract reads small UI text much better when it is enlarged. Local benchmark, tessdata_fast, eng+pol, `src/main/benchmarks/image-engines.test.ts`:

| Scale | Fixture  | CER   | Time   |
| ----- | -------- | ----- | ------ |
| 1x    | terminal | 2.0%  | 360 ms |
| 1x    | code     | 19.6% | 204 ms |
| 1x    | polish   | 0.0%  | 67 ms  |
| 2x    | terminal | 1.3%  | 525 ms |
| 2x    | code     | 2.0%  | 250 ms |
| 2x    | polish   | 0.0%  | 90 ms  |

Decision (`src/main/ocr/ocr-scale.ts`):

- Images up to 2.5 MP are read at 2x.
- Larger images are read at 1x. A full-HD or 4K screen capture already has readable text, and 2x would cost four times the memory and time.
- Boxes are always mapped back to original pixels (`OcrImage.scale`).

## Mirage numbers

Pending: a rerun of the benchmark after the loader fix. When it arrives, fill in the description quality, object recall and time per image here.

## Verification

- **Unit tests:** repository, migration v3, capture, the `Screenshots` service, the `clip-image:` protocol and the renderer components.
- **E2E** (`tests/e2e/screenshots.spec.ts`, sandboxed: hidden windows, in-memory clipboard):
  - capture, thumbnail, OCR text layer, search and restore with Enter;
  - the Analysis panel, using an analysis injected through the E2E hook, because the model is not downloaded in CI;
  - the Images settings section.
- **Packaged smoke check** (`scripts/smoke-packaged.mjs`): the renderer draws a word and the packaged OCR worker reads it back. This proves that tesseract.js, its WASM core and tessdata load from the installed app.
