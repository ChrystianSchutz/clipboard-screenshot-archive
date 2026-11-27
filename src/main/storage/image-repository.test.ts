import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OcrResult } from '@shared/ocr';
import { imageAnalysis, ocrResult } from '../test-support/image-fakes';
import { ClipRepository } from './clip-repository';
import { openDatabase } from './database';
import { ImageRepository, imageClipLabel, type RecordImageInput } from './image-repository';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function image(overrides: Partial<RecordImageInput> = {}): RecordImageInput {
  return {
    hash: HASH_A,
    width: 800,
    height: 600,
    byteSize: 12_345,
    source: { app: 'Snipping Tool', exe: 'SnippingTool.exe', url: null },
    copiedAt: 1_000,
    textState: 'pending',
    ...overrides,
  };
}

function textResult(...lines: string[]): OcrResult {
  return ocrResult({
    lines: lines.map((text, index) => ({
      text,
      confidence: 90,
      box: { x0: 0, y0: index * 20, x1: 100, y1: index * 20 + 18 },
      words: [],
    })),
  });
}

describe('ImageRepository', () => {
  let db: DatabaseSync;
  let clips: ClipRepository;
  let images: ImageRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    clips = new ClipRepository(db, () => 5_000);
    images = new ImageRepository(db, clips);
  });

  afterEach(() => {
    db.close();
  });

  const search = (text: string): number[] => clips.query({ text }).clips.map((clip) => clip.id);

  describe('record', () => {
    it('stores a new image as an image clip labelled with its size, with a copy event', () => {
      const { clip, created } = images.record(image());

      expect(created).toBe(true);
      expect(clip).toMatchObject({
        kind: 'image',
        content: imageClipLabel(800, 600),
        charCount: 0,
        lineCount: 0,
        copyCount: 1,
        source: { app: 'Snipping Tool', exe: 'SnippingTool.exe', url: null },
      });
      expect(images.details(clip.id)).toEqual({
        clipId: clip.id,
        width: 800,
        height: 600,
        byteSize: 12_345,
        text: { state: 'pending', result: null },
        analysis: { state: 'none', result: null },
      });
      expect(db.prepare('SELECT COUNT(*) AS n FROM copy_events').get()).toEqual({ n: 1 });
    });

    it('bumps the clip of an image copied again instead of storing it twice', () => {
      const first = images.record(image()).clip;
      const again = images.record(
        image({ copiedAt: 2_000, source: { app: 'Chrome', exe: null, url: null } }),
      );

      expect(again.created).toBe(false);
      expect(again.clip).toMatchObject({
        id: first.id,
        copyCount: 2,
        lastCopiedAt: 2_000,
        source: { app: 'Chrome', exe: null, url: null },
      });
      expect(db.prepare('SELECT COUNT(*) AS n FROM clip_images').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM copy_events').get()).toEqual({ n: 2 });
    });

    it('never merges an image with a text clip, whatever the text is', () => {
      const text = clips.record({
        content: `image:${HASH_A}`,
        kind: 'text',
        categories: [],
        source: { app: null, exe: null, url: null },
        copiedAt: 1,
      }).clip;

      const { clip, created } = images.record(image());

      expect(created).toBe(true);
      expect(clip.id).not.toBe(text.id);
    });

    it('records the text state it is given (off when recognition is switched off)', () => {
      const { clip } = images.record(image({ textState: 'off' }));

      expect(images.details(clip.id)?.text.state).toBe('off');
      expect(images.pendingText()).toEqual([]);
    });
  });

  describe('lookups', () => {
    it('maps clip ids to image hashes and back, and lists every hash', () => {
      const a = images.record(image()).clip.id;
      const b = images.record(image({ hash: HASH_B, copiedAt: 2_000 })).clip.id;

      expect(images.hashOf(a)).toBe(HASH_A);
      expect(images.clipIdOf(HASH_B)).toBe(b);
      expect(images.hashes()).toEqual(new Set([HASH_A, HASH_B]));
      expect(images.hashOf(999)).toBeNull();
      expect(images.clipIdOf('c'.repeat(64))).toBeNull();
      expect(images.details(999)).toBeNull();
    });

    it('lists pending work newest first', () => {
      images.record(image({ hash: HASH_A, copiedAt: 1_000 }));
      images.record(image({ hash: HASH_B, copiedAt: 2_000 }));
      images.requestAnalysis(HASH_A);

      expect(images.pendingText()).toEqual([HASH_B, HASH_A]);
      expect(images.pendingAnalysis()).toEqual([HASH_A]);
    });
  });

  describe('recognised text', () => {
    it('stores the text with its boxes and makes the image findable by any line', () => {
      const id = images.record(image()).clip.id;
      const result = textResult('npm ERR! code ECONNRESET', 'network timeout at registry');

      expect(images.saveText(HASH_A, result)).toBe(id);

      expect(images.details(id)?.text).toEqual({ state: 'done', result });
      expect(images.pendingText()).toEqual([]);
      expect(search('ECONNRESET')).toEqual([id]);
      expect(search('registry timeout')).toEqual([id]);
    });

    it('replaces the searchable text when the image is read again', () => {
      const id = images.record(image()).clip.id;
      images.saveText(HASH_A, textResult('first reading'));
      images.requestText(HASH_A);
      images.saveText(HASH_A, textResult('second reading'));

      expect(search('first')).toEqual([]);
      expect(search('second')).toEqual([id]);
    });

    it('marks a failed reading and drops a result for a deleted clip', () => {
      const id = images.record(image()).clip.id;
      expect(images.failText(HASH_A)).toBe(id);
      expect(images.details(id)?.text).toEqual({ state: 'failed', result: null });

      clips.delete([id]);
      expect(images.saveText(HASH_A, textResult('too late'))).toBeNull();
      expect(db.prepare('SELECT COUNT(*) AS n FROM clip_extra_text').get()).toEqual({ n: 0 });
    });
  });

  describe('analysis', () => {
    it('stores the analysis next to the text and makes its description and objects searchable', () => {
      const id = images.record(image()).clip.id;
      images.saveText(HASH_A, textResult('Invoice 2026/11'));
      const analysis = imageAnalysis({
        description: ['A spreadsheet with a bar chart'],
        objects: [
          {
            id: 1,
            label: 'laptop',
            score: 0.9,
            box: { x0: 0, y0: 0, x1: 10, y1: 10 },
            attributes: {},
          },
        ],
      });

      images.requestAnalysis(HASH_A);
      expect(images.details(id)?.analysis.state).toBe('pending');
      expect(images.saveAnalysis(HASH_A, analysis)).toBe(id);

      const details = images.details(id);
      expect(details?.analysis).toEqual({ state: 'done', result: analysis });
      expect(details?.text.state).toBe('done');
      expect(search('spreadsheet')).toEqual([id]);
      expect(search('laptop')).toEqual([id]);
      expect(search('invoice')).toEqual([id]); // the OCR text is still there
    });

    it('marks a failed analysis and cancels every pending one', () => {
      const a = images.record(image()).clip.id;
      const b = images.record(image({ hash: HASH_B })).clip.id;
      images.requestAnalysis(HASH_A);
      images.requestAnalysis(HASH_B);

      expect(images.failAnalysis(HASH_A)).toBe(a);
      expect(images.cancelPendingAnalysis()).toEqual([b]);
      expect(images.pendingAnalysis()).toEqual([]);
      expect(images.details(a)?.analysis.state).toBe('failed');
    });

    it('remembers who asked: an explicit request is never downgraded, and only automatic ones are withdrawn', () => {
      const a = images.record(image()).clip.id;
      const b = images.record(image({ hash: HASH_B })).clip.id;
      images.requestAnalysis(HASH_A, 'auto');
      images.requestAnalysis(HASH_B, 'auto');
      images.requestAnalysis(HASH_B, 'user'); // the user clicked Analyze while it waited
      images.requestAnalysis(HASH_B, 'auto'); // a re-copy does not take that back

      expect(images.pendingAnalysis('auto')).toEqual([HASH_A]);
      expect(images.pendingAnalysis('user')).toEqual([HASH_B]);
      expect(images.withdrawAutomaticAnalysis()).toEqual([a]);
      expect(images.details(a)?.analysis.state).toBe('none');
      expect(images.details(b)?.analysis.state).toBe('pending');
      expect(images.pendingAnalysis()).toEqual([HASH_B]);
    });
  });

  it('shows stored JSON that no longer matches the schema as "no result"', () => {
    const id = images.record(image()).clip.id;
    db.prepare(
      "UPDATE clip_images SET ocr_state = 'done', ocr_json = '{\"lines\": 5}' WHERE clip_id = ?",
    ).run(id);
    db.prepare(
      "UPDATE clip_images SET analysis_state = 'done', analysis_json = 'not json' WHERE clip_id = ?",
    ).run(id);

    expect(images.details(id)).toMatchObject({
      text: { state: 'done', result: null },
      analysis: { state: 'done', result: null },
    });
  });

  it('deletes the image row with its clip', () => {
    const id = images.record(image()).clip.id;

    clips.delete([id]);

    expect(images.details(id)).toBeNull();
    expect(images.hashes()).toEqual(new Set());
  });

  describe('hasImage', () => {
    it('is true while a clip uses the image and false once it is deleted', () => {
      const id = images.record(image()).clip.id;

      expect(images.hasImage(HASH_A)).toBe(true);
      expect(images.hasImage(HASH_B)).toBe(false);

      clips.delete([id]);
      expect(images.hasImage(HASH_A)).toBe(false);
    });
  });

  describe('results commit only while their row waits for them', () => {
    const extraTextRows = (): unknown =>
      db.prepare('SELECT COUNT(*) AS n FROM clip_extra_text').get();

    it('drops a second text result once the first one was saved', () => {
      const id = images.record(image()).clip.id;
      const first = textResult('first reading');
      images.saveText(HASH_A, first);

      expect(images.saveText(HASH_A, textResult('late duplicate'))).toBeNull();
      expect(images.failText(HASH_A)).toBeNull();

      expect(images.details(id)?.text).toEqual({ state: 'done', result: first });
      expect(search('first')).toEqual([id]);
      expect(search('duplicate')).toEqual([]);
    });

    it('drops text results for an image whose recognition was off', () => {
      const id = images.record(image({ textState: 'off' })).clip.id;

      expect(images.saveText(HASH_A, textResult('should not be stored'))).toBeNull();
      expect(images.failText(HASH_A)).toBeNull();

      expect(images.details(id)?.text).toEqual({ state: 'off', result: null });
      expect(extraTextRows()).toEqual({ n: 0 });
    });

    it('drops a text result after the reading already failed', () => {
      const id = images.record(image()).clip.id;
      images.failText(HASH_A);

      expect(images.saveText(HASH_A, textResult('too late'))).toBeNull();
      expect(images.details(id)?.text).toEqual({ state: 'failed', result: null });
      expect(extraTextRows()).toEqual({ n: 0 });
    });

    it('commits again once the text is requested again', () => {
      const id = images.record(image({ textState: 'off' })).clip.id;
      expect(images.requestText(HASH_A)).toBe(id);

      const result = textResult('now wanted');
      expect(images.saveText(HASH_A, result)).toBe(id);
      expect(images.details(id)?.text).toEqual({ state: 'done', result });
    });

    it('drops analysis results for an image whose analysis was never requested', () => {
      const id = images.record(image()).clip.id;

      expect(images.saveAnalysis(HASH_A, imageAnalysis())).toBeNull();
      expect(images.failAnalysis(HASH_A)).toBeNull();

      expect(images.details(id)?.analysis).toEqual({ state: 'none', result: null });
    });

    it('drops a late analysis result after the pending analysis was cancelled', () => {
      const id = images.record(image()).clip.id;
      images.requestAnalysis(HASH_A);
      expect(images.cancelPendingAnalysis()).toEqual([id]);

      const late = imageAnalysis({ description: ['A cancelled description'] });
      expect(images.saveAnalysis(HASH_A, late)).toBeNull();
      expect(images.failAnalysis(HASH_A)).toBeNull();

      expect(images.details(id)?.analysis).toEqual({ state: 'none', result: null });
      expect(search('cancelled')).toEqual([]);
      expect(extraTextRows()).toEqual({ n: 0 });
    });

    it('drops a second analysis result once the first one was saved', () => {
      const id = images.record(image()).clip.id;
      images.requestAnalysis(HASH_A);
      const first = imageAnalysis({ description: ['A spreadsheet'] });
      expect(images.saveAnalysis(HASH_A, first)).toBe(id);

      expect(images.saveAnalysis(HASH_A, imageAnalysis({ description: ['A cat'] }))).toBeNull();
      expect(images.failAnalysis(HASH_A)).toBeNull();

      expect(images.details(id)?.analysis).toEqual({ state: 'done', result: first });
      expect(search('cat')).toEqual([]);
    });

    it('drops an analysis result after the analysis already failed', () => {
      const id = images.record(image()).clip.id;
      images.requestAnalysis(HASH_A);
      images.failAnalysis(HASH_A);

      expect(images.saveAnalysis(HASH_A, imageAnalysis())).toBeNull();
      expect(images.details(id)?.analysis).toEqual({ state: 'failed', result: null });
    });

    it('commits only for the image whose row waits, not for another pending image', () => {
      const a = images.record(image()).clip.id;
      const b = images.record(image({ hash: HASH_B })).clip.id;
      images.requestAnalysis(HASH_B);

      expect(images.saveAnalysis(HASH_A, imageAnalysis())).toBeNull();
      expect(images.saveAnalysis(HASH_B, imageAnalysis())).toBe(b);
      expect(images.details(a)?.analysis.state).toBe('none');
      expect(images.details(b)?.analysis.state).toBe('done');
    });
  });
});
