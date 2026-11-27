/**
 * Pinned Tesseract language data shipped under resources/ocr/tessdata (tessdata_fast models,
 * uncompressed). The checksums guard the vendored bytes against accidental rewrites (a formatter,
 * a line-ending conversion, a bad merge); `vendored-resources.test.ts` hashes the files against
 * them on every test run.
 */
export const TESSDATA_FILES = {
  'eng.traineddata': '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2',
  'pol.traineddata': 'c4476cdbc0e33d898d32345122b7be1cbf85ace15f920f06c7714756e1ef79b2',
} as const satisfies Record<string, string>;
