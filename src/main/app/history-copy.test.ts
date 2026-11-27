import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_COPY_TEXT_CHARS, type Clip } from '@shared/types';
import { ClipRepository } from '../storage/clip-repository';
import { openDatabase } from '../storage/database';
import { ImageRepository } from '../storage/image-repository';
import { copyClips, type HistoryCopyDeps } from './history-copy';

describe('copyClips (history:copy-many)', () => {
  let db: DatabaseSync;
  let clips: ClipRepository;
  let images: ImageRepository;
  let write: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
  let deps: HistoryCopyDeps;
  let copiedAt: number;

  beforeEach(() => {
    db = openDatabase(':memory:');
    clips = new ClipRepository(db, () => 10_000);
    images = new ImageRepository(db, clips);
    write = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    deps = { repository: clips, write };
    copiedAt = 1_000;
  });

  afterEach(() => {
    db.close();
  });

  const text = (content: string): Clip =>
    clips.record({
      content,
      kind: 'text',
      categories: [],
      source: { app: null, exe: null, url: null },
      copiedAt: copiedAt++,
    }).clip;

  const screenshot = (seed: string): Clip =>
    images.record({
      hash: seed.repeat(64),
      width: 640,
      height: 480,
      byteSize: 2_048,
      source: { app: null, exe: null, url: null },
      copiedAt: copiedAt++,
      textState: 'pending',
    }).clip;

  it('joins the text clips in the order given, one per line, and skips images', async () => {
    const [a, b, c] = [text('first'), text('second\nline'), text('third')];
    const shot = screenshot('a');

    await expect(copyClips(deps, [c.id, shot.id, a.id, b.id])).resolves.toEqual({
      status: 'copied',
      copied: 3,
      skippedImages: 1,
    });
    expect(write).toHaveBeenCalledExactlyOnceWith('third\nfirst\nsecond\nline');
  });

  it('writes nothing when only images (or deleted clips) are selected', async () => {
    const shot = screenshot('b');

    await expect(copyClips(deps, [shot.id, 404])).resolves.toEqual({
      status: 'nothing',
      skippedImages: 1,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses a text that would be too large before reading any of it', async () => {
    const big = 'x'.repeat(MAX_COPY_TEXT_CHARS / 2);
    const ids = [text(`a${big}`).id, text(`b${big}`).id];
    const contentsOf = vi.spyOn(clips, 'contentsOf');

    await expect(copyClips(deps, ids)).resolves.toEqual({
      status: 'too-large',
      chars: MAX_COPY_TEXT_CHARS + 3,
    });
    expect(contentsOf).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('accepts a joined text of exactly the limit, separators included', async () => {
    const half = (MAX_COPY_TEXT_CHARS - 1) / 2;
    const ids = [text('a'.repeat(Math.floor(half))).id, text('b'.repeat(Math.ceil(half))).id];

    await expect(copyClips(deps, ids)).resolves.toMatchObject({ status: 'copied', copied: 2 });
    expect(write.mock.calls[0]?.[0]).toHaveLength(MAX_COPY_TEXT_CHARS);
  });

  it('leaves out a clip deleted between measuring and reading', async () => {
    const [a, b] = [text('kept'), text('gone')];
    const contentsOf = clips.contentsOf.bind(clips);
    vi.spyOn(clips, 'contentsOf').mockImplementationOnce((ids) => {
      clips.delete([b.id]);
      return contentsOf(ids);
    });

    await expect(copyClips(deps, [a.id, b.id])).resolves.toMatchObject({ copied: 1 });
    expect(write).toHaveBeenCalledExactlyOnceWith('kept');
  });

  it('passes a failed clipboard write on to the caller', async () => {
    write.mockRejectedValueOnce(new Error('OpenClipboard failed'));

    await expect(copyClips(deps, [text('a').id])).rejects.toThrow('OpenClipboard');
  });
});
