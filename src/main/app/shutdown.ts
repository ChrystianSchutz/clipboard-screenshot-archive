import type { CaptureGate } from '../clipboard/capture-gate';

/**
 * The app's shutdown order, kept out of the Electron composition root so it is tested with the
 * real capture pipeline: the capture gate closes for good first, before any watcher stops or the
 * database closes. A poll, a folder settle, a privacy retry or an image save that is still in
 * flight then finds no current generation at its record boundary and never touches the closed
 * database. Every later step runs even if an earlier one throws; the first error is rethrown.
 */
export function shutDown(gate: CaptureGate, steps: readonly (() => void)[]): void {
  gate.close();
  let failure: { error: unknown } | null = null;
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}
