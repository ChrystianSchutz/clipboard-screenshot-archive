import { execFile } from 'node:child_process';
import { watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { resolveScreenshotFolder, ScreenshotFolderWatcher } from './screenshot-folder';

const run = promisify(execFile);

/** `defaults read com.apple.screencapture location` (macOS only). */
async function readScreencaptureLocation(): Promise<string | null> {
  const { stdout } = await run(
    '/usr/bin/defaults',
    ['read', 'com.apple.screencapture', 'location'],
    {
      timeout: 5_000,
    },
  );
  return stdout;
}

/** Creates the screenshots-folder watcher with real file-system adapters (macOS). */
export async function createMacScreenshotWatcher(
  onScreenshot: (path: string, ticket: number) => void,
  ticket: () => number,
): Promise<ScreenshotFolderWatcher> {
  const dir = await resolveScreenshotFolder(readScreencaptureLocation, homedir());
  return new ScreenshotFolderWatcher(dir, {
    watch: (folder, onName) => {
      const watcher = watch(folder, { persistent: false }, (_event, fileName) => {
        if (fileName) onName(fileName);
      });
      return () => watcher.close();
    },
    stat: async (path) => {
      try {
        const facts = await stat(path);
        return facts.isFile() ? { size: facts.size, mtimeMs: facts.mtimeMs } : null;
      } catch {
        return null;
      }
    },
    sleep: (ms) => sleep(ms),
    now: Date.now,
    onScreenshot,
    ticket,
  });
}
