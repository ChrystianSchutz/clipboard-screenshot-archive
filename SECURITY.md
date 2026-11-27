# Security policy

A clipboard history holds passwords that slipped through, tokens and private messages. Security reports are taken seriously and handled first.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub:

1. Go to the [Security tab](https://github.com/ChrystianSchutz/clipboard-screenshot-archive/security) of this repository.
2. Click **Report a vulnerability** and describe the issue, the affected version and the steps to reproduce it.

Once a fix is released, the advisory is published with credit to you, unless you prefer to stay anonymous.

## Supported versions

The project is pre-1.0. Only the latest release gets security fixes.

| Version        | Supported |
| -------------- | --------- |
| latest release | yes       |
| anything older | no        |

## Threat model in brief

**Local only.** History, screenshots, OCR text and settings live in a SQLite database and an image folder in the app's user-data directory. There is no account, no telemetry, no crash reporting and no update check. The error log is a local file with no clipboard content.

**One opt-in network call.** The app makes no network requests unless you click **Download** for the image-analysis model. That download goes over HTTPS only (no redirects to plain HTTP), from a pinned revision, and is SHA-256 verified in memory before it is written to disk. Text recognition (Tesseract) runs fully offline with bundled language data. Links you click in the UI open in your browser.

**In scope:**

- clipboard content that should have been skipped (private-copy markers, excluded apps, paused capture) but was stored;
- a renderer, web page or local file that gains access to IPC, the history or the file system;
- escapes from the `app://` or `clip-image://` protocols, or from the OCR and analysis utility processes;
- tampering with the bundled runtime or downloaded model that is not detected.

**Out of scope:** an attacker who already runs code as your user (they can read the database and the clipboard directly), and unsigned builds being flagged by Windows SmartScreen or macOS Gatekeeper.
