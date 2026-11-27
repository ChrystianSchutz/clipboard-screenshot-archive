import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clip } from '@shared/types';
import { ClipRepository } from '../storage/clip-repository';
import { openDatabase } from '../storage/database';
import { ImageRepository } from '../storage/image-repository';
import { imageAnalysis, ocrResult } from '../test-support/image-fakes';
import { historyMutationHandlers } from './history-mutations';

const PALETTE = { role: 'palette' } as const;

describe('historyMutationHandlers', () => {
  let db: DatabaseSync;
  let clips: ClipRepository;
  let images: ImageRepository;
  let scheduleSweep: ReturnType<typeof vi.fn<() => void>>;
  let announce: ReturnType<typeof vi.fn<() => void>>;
  let forget: ReturnType<typeof vi.fn<(hashes: readonly string[]) => void>>;
  let handlers: ReturnType<typeof historyMutationHandlers>;
  let copiedAt: number;

  beforeEach(() => {
    db = openDatabase(':memory:');
    clips = new ClipRepository(db, () => 10_000);
    images = new ImageRepository(db, clips);
    scheduleSweep = vi.fn<() => void>();
    announce = vi.fn<() => void>();
    forget = vi.fn<(hashes: readonly string[]) => void>();
    handlers = historyMutationHandlers({
      repository: clips,
      images: { hashesOf: (ids) => images.hashesOf(ids), forget },
      scheduleSweep,
      announce,
    });
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

  /** An image clip whose text recognition and analysis are still queued. */
  const screenshot = (hash: string): Clip => {
    const { clip } = images.record({
      hash,
      width: 640,
      height: 480,
      byteSize: 2_048,
      source: { app: 'Snipping Tool', exe: 'SnippingTool.exe', url: null },
      copiedAt: copiedAt++,
      textState: 'pending',
    });
    images.requestAnalysis(hash, 'auto');
    return clip;
  };

  const remaining = (): number[] => clips.query({}).clips.map((clip) => clip.id);

  describe('history:delete-many', () => {
    it('deletes every selected clip, then sweeps and announces once', () => {
      const [a, b, c] = [text('a'), text('b'), text('c')];

      expect(handlers['history:delete-many']([a.id, c.id], PALETTE)).toBe(2);

      expect(remaining()).toEqual([b.id]);
      expect(scheduleSweep).toHaveBeenCalledOnce();
      expect(announce).toHaveBeenCalledOnce();
      // Text clips have no image work to withdraw.
      expect(forget).not.toHaveBeenCalled();
    });

    it('leaves the files of deleted screenshots to the sweep and drops their queued work', () => {
      const hashA = 'a'.repeat(64);
      const hashB = 'b'.repeat(64);
      const shotA = screenshot(hashA);
      const shotB = screenshot(hashB);
      const note = text('note');

      expect(handlers['history:delete-many']([shotA.id, shotB.id], PALETTE)).toBe(2);
      // Their queued recognition and analysis are withdrawn (see `Screenshots.forgetImages`).
      expect(forget).toHaveBeenCalledOnce();
      expect([...(forget.mock.calls[0]?.[0] ?? [])].sort()).toEqual([hashA, hashB]);

      // No clip uses the images any more, so the scheduled sweep deletes their files.
      expect(images.hasImage(hashA)).toBe(false);
      expect(images.hasImage(hashB)).toBe(false);
      expect(images.pendingText()).toEqual([]);
      expect(images.pendingAnalysis()).toEqual([]);
      expect(scheduleSweep).toHaveBeenCalledOnce();
      // A recognition or analysis that was already running finds no row: nothing is stored.
      expect(images.saveText(hashA, ocrResult())).toBeNull();
      expect(images.saveAnalysis(hashB, imageAnalysis())).toBeNull();
      expect(remaining()).toEqual([note.id]);
    });

    it('skips ids that are already gone, and does nothing when none is left', () => {
      const a = text('a');

      expect(handlers['history:delete-many']([a.id, 404], PALETTE)).toBe(1);
      scheduleSweep.mockClear();
      announce.mockClear();

      expect(handlers['history:delete-many']([a.id, 404], PALETTE)).toBe(0);
      expect(scheduleSweep).not.toHaveBeenCalled();
      expect(announce).not.toHaveBeenCalled();
    });

    it('deletes nothing and announces nothing when the transaction fails', () => {
      const [a, b] = [text('a'), text('b')];
      db.exec(`CREATE TRIGGER fail_delete BEFORE DELETE ON clips WHEN old.id = ${String(b.id)}
               BEGIN SELECT RAISE(ABORT, 'disk full'); END`);

      expect(() => handlers['history:delete-many']([a.id, b.id], PALETTE)).toThrow(/disk full/);

      expect(remaining().sort()).toEqual([a.id, b.id].sort());
      expect(scheduleSweep).not.toHaveBeenCalled();
      expect(announce).not.toHaveBeenCalled();
    });
  });

  describe('history:delete', () => {
    it('deletes one clip the same way', () => {
      const shot = screenshot('c'.repeat(64));

      expect(handlers['history:delete'](shot.id, PALETTE)).toBe(1);

      expect(remaining()).toEqual([]);
      expect(scheduleSweep).toHaveBeenCalledOnce();
      expect(announce).toHaveBeenCalledOnce();
    });
  });

  describe('history:set-pinned-many', () => {
    it('pins every selected clip in one call and announces once', () => {
      const [a, b, c] = [text('a'), text('b'), text('c')];

      expect(handlers['history:set-pinned-many']([a.id, c.id], true, PALETTE)).toBe(2);

      expect(
        clips
          .query({ pinnedOnly: true })
          .clips.map((clip) => clip.id)
          .sort(),
      ).toEqual([a.id, c.id].sort());
      expect(clips.get(b.id)?.pinned).toBe(false);
      expect(announce).toHaveBeenCalledOnce();
      expect(scheduleSweep).not.toHaveBeenCalled();
    });

    it('announces nothing when none of the clips exists', () => {
      expect(handlers['history:set-pinned-many']([404, 405], true, PALETTE)).toBe(0);
      expect(announce).not.toHaveBeenCalled();
    });
  });

  describe('history:set-pinned', () => {
    it('pins and unpins one clip', async () => {
      const a = text('a');

      await handlers['history:set-pinned'](a.id, true, PALETTE);
      expect(clips.get(a.id)?.pinned).toBe(true);
      await handlers['history:set-pinned'](a.id, false, PALETTE);
      expect(clips.get(a.id)?.pinned).toBe(false);
      expect(announce).toHaveBeenCalledTimes(2);
    });
  });
});
