/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_BATCH_IDS,
  MAX_COPY_TEXT_CHARS,
  type ClipSummary,
  type CopyClipsResult,
} from '@shared/types';
import type { ScreenshotDetails } from '@shared/screenshots';
import { selectOnly } from '../../lib/selection';
import { clipSummary } from './test-fixtures';
import { COPY_TEXT_CONCURRENCY, useSelectionActions } from './useSelectionActions';

const copyMany = vi.fn<(ids: number[]) => Promise<CopyClipsResult>>();
const copyText = vi.fn<(text: string) => Promise<void>>();
const details = vi.fn<(id: number) => Promise<ScreenshotDetails | null>>();
const hide = vi.fn<() => Promise<void>>();
const get = vi.fn();

beforeEach(() => {
  copyMany.mockReset();
  copyText.mockReset().mockResolvedValue(undefined);
  details.mockReset();
  hide.mockReset().mockResolvedValue(undefined);
  get.mockReset();
  (window as { clipboardArchive?: unknown }).clipboardArchive = {
    history: { copyMany, get },
    screenshots: { copyText, details },
    window: { hide },
  };
});

afterEach(() => {
  delete (window as { clipboardArchive?: unknown }).clipboardArchive;
});

function actionsFor(clips: readonly ClipSummary[], noun: 'clip' | 'screenshot' = 'clip') {
  const onNotify = vi.fn<(message: string) => void>();
  const { result } = renderHook(() =>
    useSelectionActions({
      noun,
      selection: selectOnly(clips[0]?.id ?? null),
      clips,
      ids: clips.map((clip) => clip.id),
      onNotify,
      onRemoved: vi.fn(),
    }),
  );
  return { actions: () => result.current, onNotify };
}

/** A screenshot whose recognised text is `text` (one line). */
function shotDetails(text: string): ScreenshotDetails {
  return {
    text: { state: 'done', result: { lines: [{ text, words: [] }] } },
  } as unknown as ScreenshotDetails;
}

describe('useSelectionActions copy', () => {
  it('asks main to join and write the text clips, in display order, images left out', async () => {
    const clips = [
      clipSummary({ id: 9 }),
      clipSummary({ id: 7, kind: 'image' }),
      clipSummary({ id: 4 }),
    ];
    copyMany.mockResolvedValue({ status: 'copied', copied: 2, skippedImages: 0 });
    const { actions, onNotify } = actionsFor(clips);

    await act(() => actions().copy());

    expect(copyMany).toHaveBeenCalledExactlyOnceWith([9, 4]);
    expect(get).not.toHaveBeenCalled();
    expect(onNotify).toHaveBeenCalledWith('Copied 2 clips, 1 image skipped');
    expect(hide).toHaveBeenCalledOnce();
  });

  it('refuses too much text from the stored lengths, without reading or writing anything', async () => {
    const half = MAX_COPY_TEXT_CHARS / 2;
    const clips = [
      clipSummary({ id: 2, charCount: half }),
      clipSummary({ id: 1, charCount: half }),
    ];
    const { actions, onNotify } = actionsFor(clips);

    await act(() => actions().copy());

    expect(copyMany).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(onNotify).toHaveBeenCalledWith('Too much text to copy at once. Select fewer clips.');
    expect(hide).not.toHaveBeenCalled();
  });

  it('refuses more text clips than one call takes', async () => {
    const clips = Array.from({ length: MAX_BATCH_IDS + 1 }, (_, index) =>
      clipSummary({ id: index + 1, charCount: 1 }),
    );
    const { actions, onNotify } = actionsFor(clips);

    await act(() => actions().copy());

    expect(copyMany).not.toHaveBeenCalled();
    expect(onNotify).toHaveBeenCalledWith('Copy takes up to 500 clips at once. Select fewer.');
  });

  it('reports what main decided, and keeps the window open unless it copied', async () => {
    const clips = [clipSummary({ id: 2 }), clipSummary({ id: 1 })];
    const { actions, onNotify } = actionsFor(clips);

    copyMany.mockResolvedValueOnce({ status: 'too-large', chars: MAX_COPY_TEXT_CHARS + 1 });
    await act(() => actions().copy());
    copyMany.mockResolvedValueOnce({ status: 'nothing', skippedImages: 0 });
    await act(() => actions().copy());
    copyMany.mockRejectedValueOnce(new Error('busy'));
    await act(() => actions().copy());

    expect(onNotify.mock.calls.map(([message]) => message)).toEqual([
      'Too much text to copy at once. Select fewer clips.',
      'Nothing to copy: the selected clips are gone',
      'Could not copy the selected clips',
    ]);
    expect(hide).not.toHaveBeenCalled();
  });

  it('acts on the clips it is given (the menu passes the ones it showed)', async () => {
    const shown = [clipSummary({ id: 5 }), clipSummary({ id: 3 })];
    copyMany.mockResolvedValue({ status: 'copied', copied: 2, skippedImages: 0 });
    const { actions } = actionsFor([...shown, clipSummary({ id: 1 })]);

    await act(() => actions().copy(shown));

    expect(copyMany).toHaveBeenCalledExactlyOnceWith([5, 3]);
  });
});

describe('useSelectionActions copyText', () => {
  it(`reads at most ${String(COPY_TEXT_CONCURRENCY)} screenshots at a time, in order`, async () => {
    const shots = Array.from({ length: 20 }, (_, index) =>
      clipSummary({ id: 20 - index, kind: 'image' }),
    );
    let running = 0;
    let peak = 0;
    details.mockImplementation(async (id) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      return shotDetails(`text ${String(id)}`);
    });
    const { actions, onNotify } = actionsFor(shots, 'screenshot');

    await act(() => actions().copyText());

    expect(peak).toBe(COPY_TEXT_CONCURRENCY);
    expect(copyText).toHaveBeenCalledExactlyOnceWith(
      shots.map((shot) => `text ${String(shot.id)}`).join('\n'),
    );
    expect(onNotify).toHaveBeenCalledWith('Copied the text of 20 screenshots');
  });

  it('stops reading as soon as the joined text cannot fit', async () => {
    const shots = Array.from({ length: 30 }, (_, index) =>
      clipSummary({ id: 30 - index, kind: 'image' }),
    );
    details.mockResolvedValue(shotDetails('x'.repeat(MAX_COPY_TEXT_CHARS / 4)));
    const { actions, onNotify } = actionsFor(shots, 'screenshot');

    await act(() => actions().copyText());

    // The first group of six already exceeds the limit: no further lookups, nothing written.
    expect(details).toHaveBeenCalledTimes(COPY_TEXT_CONCURRENCY);
    expect(copyText).not.toHaveBeenCalled();
    expect(onNotify).toHaveBeenCalledWith(
      'Too much text to copy at once. Select fewer screenshots.',
    );
  });
});
