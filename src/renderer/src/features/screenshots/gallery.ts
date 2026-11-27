/** Pure helpers for the Screenshots tab: grid navigation, tile labels and the empty-state hint. */
import { ocrText } from '@shared/ocr';
import type { ScreenshotDetails } from '@shared/screenshots';

export type GridKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

export function isGridKey(key: string): key is GridKey {
  return (
    key === 'ArrowLeft' ||
    key === 'ArrowRight' ||
    key === 'ArrowUp' ||
    key === 'ArrowDown' ||
    key === 'Home' ||
    key === 'End'
  );
}

/**
 * The tile a key moves to in a grid of `columns` columns filled row by row. Left/right step
 * through the list (wrapping to the previous/next row), up/down jump a whole row and stay put at
 * the edges. With nothing selected yet, any key selects the first tile.
 */
export function moveInGrid(
  ids: readonly number[],
  current: number | null,
  key: GridKey,
  columns: number,
): number | null {
  if (ids.length === 0) return null;
  const index = current === null ? -1 : ids.indexOf(current);
  if (index === -1) return ids[0] ?? null;
  const cols = Math.max(1, Math.floor(columns));
  const last = ids.length - 1;
  const target = ((): number => {
    switch (key) {
      case 'ArrowLeft':
        return Math.max(index - 1, 0);
      case 'ArrowRight':
        return Math.min(index + 1, last);
      case 'ArrowUp':
        return index - cols >= 0 ? index - cols : index;
      case 'ArrowDown':
        // A partial last row: jump to its last tile rather than nowhere.
        if (index + cols <= last) return index + cols;
        return Math.floor(index / cols) < Math.floor(last / cols) ? last : index;
      case 'Home':
        return 0;
      case 'End':
        return last;
    }
  })();
  return ids[target] ?? null;
}

/** "Image 900×216" (an image clip's preview label) → "900×216". */
export function imageDimensions(preview: string): string {
  return preview.replace(/^Image\s+/, '');
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1_000) return `${String(Math.round(bytes))} B`;
  if (bytes < 1_000_000) return `${String(Math.round(bytes / 1_000))} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export type StatusTone = 'ok' | 'busy' | 'muted' | 'error';

export interface TileStatus {
  readonly label: string;
  readonly tone: StatusTone;
}

/** The small OCR and analysis badges of a tile; empty when there is nothing worth saying. */
export function tileStatuses(details: Pick<ScreenshotDetails, 'text' | 'analysis'>): TileStatus[] {
  const statuses: TileStatus[] = [];
  const { text, analysis } = details;
  if (text.state === 'pending') statuses.push({ label: 'Reading text…', tone: 'busy' });
  else if (text.state === 'failed') statuses.push({ label: 'Text failed', tone: 'error' });
  else if (text.state === 'done') {
    const hasText = text.result !== null && ocrText(text.result).trim() !== '';
    statuses.push(hasText ? { label: 'Text', tone: 'ok' } : { label: 'No text', tone: 'muted' });
  }
  if (analysis.state === 'pending') statuses.push({ label: 'Analyzing…', tone: 'busy' });
  else if (analysis.state === 'failed') statuses.push({ label: 'Analysis failed', tone: 'error' });
  else if (analysis.state === 'done') statuses.push({ label: 'Analyzed', tone: 'ok' });
  return statuses;
}

export interface EmptyHint {
  /** The keys to press, shown as keycaps. */
  readonly keys: string;
  /** What to do after (or instead of) the keys. */
  readonly after: string;
  /** Whether the hint points at the folder import option in Settings. */
  readonly needsFolderImport: boolean;
}

/** How to fill the gallery on this platform (`app:info.platform`). */
export function emptyHint(platform: string): EmptyHint {
  if (platform === 'darwin') {
    return {
      keys: 'Cmd+Shift+4',
      after:
        'then turn on screenshot folder import in Settings. Your screenshots appear here with their text.',
      needsFolderImport: true,
    };
  }
  if (platform === 'win32') {
    return {
      keys: 'Win+Shift+S',
      after: 'and your screenshots appear here with their text.',
      needsFolderImport: false,
    };
  }
  return {
    keys: 'PrtSc',
    after: 'or copy any image, and it appears here with its text.',
    needsFolderImport: false,
  };
}
