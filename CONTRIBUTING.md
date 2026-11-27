# Contributing

Thanks for helping. This is a small Electron app that reads the system clipboard, so the rules below are mostly about keeping your desktop, and every user's clipboard, safe.

## Setup

- Node.js 24 or newer (CI uses 24).
- Windows is the main platform: source-app and page detection use Win32. macOS and Linux run everything else with clipboard polling.

```sh
npm ci
npm run dev        # the app with hot reload; it records your real clipboard
```

## Before you open a pull request

```sh
npm run check      # typecheck, ESLint, Prettier check, unit tests
npm run test:e2e   # builds, then runs the Playwright suite
```

`npm run check` is what CI runs first. A PR that fails it will not be reviewed.

## The E2E sandbox

Every E2E test launches its own app with `CLIPBOARD_ARCHIVE_E2E=1` (see `tests/e2e/fixtures.ts`). In that mode the app:

- shows no windows, tray icon or global shortcuts, so tests never steal focus or flash on screen;
- uses an in-memory clipboard and **never reads or writes the real one**;
- uses a fresh temporary profile and never touches login items.

Keep it that way. A test that needs the OS clipboard does not belong in `tests/e2e/`. The only real-clipboard check is the packaged smoke test (`node scripts/smoke-packaged.mjs --capture`), which refuses to run outside CI.

## Formatting

Prettier formats the code (`npm run format`), with one hard rule: **never run Prettier on `resources/`**. It holds vendored third-party files (the Cactus runtime and the Tesseract language data) that are pinned by SHA-256: a unit test checks every file, and the app checks the Cactus runtime again each time it loads it. Reformatting them fails both checks and breaks image analysis. `resources/` is in `.prettierignore`; do not pass it to Prettier explicitly either.

## Commits and pull requests

- One topic per PR. Keep unrelated refactors out.
- Write commit messages in the imperative, with a short subject line ("Fix duplicate capture after restore").
- Add or update tests with every behaviour change. A bug fix comes with a regression test that fails without the fix.
- Clipboard capture, privacy filtering, IPC and the `app://` / `clip-image://` protocols are security-sensitive. Explain in the PR what you changed there and how you tested it.
- No new runtime dependencies without discussing them in an issue first. Pin exact versions.
- Code, comments and UI text are in English.

## Reporting bugs and security issues

Bugs and feature ideas: [open an issue](https://github.com/ChrystianSchutz/clipboard-screenshot-archive/issues/new/choose). Security issues: do not open a public issue; see [SECURITY.md](SECURITY.md).

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
