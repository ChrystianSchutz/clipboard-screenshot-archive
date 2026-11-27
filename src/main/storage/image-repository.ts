import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';
import { analysisSearchText, type ImageAnalysis } from '@shared/image-analysis';
import { ocrText, type OcrResult } from '@shared/ocr';
import type {
  ImageAnalysisState,
  ScreenshotDetails,
  TextRecognitionState,
} from '@shared/screenshots';
import type { ClipSource } from '@shared/types';
import { imageAnalysisSchema } from '../analysis/analysis-schema';
import { ocrResultSchema } from '../ocr/ocr-schema';
import type { ClipRepository, RecordResult } from './clip-repository';
import { transaction } from './database';

/** Who asked for an analysis: the capture (automatic mode) or the user's Analyze action. */
export type AnalysisTrigger = 'auto' | 'user';

/** Origins in `clip_extra_text`: what makes a screenshot findable by plain search. */
export const OCR_SEARCH_ORIGIN = 'ocr';
export const ANALYSIS_SEARCH_ORIGIN = 'analysis';

export interface RecordImageInput {
  /** sha256 of the pixels (see `imageHash`): the identity of the image. */
  readonly hash: string;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly source: ClipSource;
  readonly copiedAt: number;
  /** `pending` when text recognition is on, `off` when it is not. */
  readonly textState: Extract<TextRecognitionState, 'pending' | 'off'>;
}

interface ImageRow {
  clip_id: number;
  width: number;
  height: number;
  byte_size: number;
  ocr_state: TextRecognitionState;
  ocr_json: string | null;
  analysis_state: ImageAnalysisState;
  analysis_json: string | null;
}

/** The label stored as an image clip's `content`: what a row or any text-only view shows. */
export function imageClipLabel(width: number, height: number): string {
  return `Image ${width}×${height}`;
}

/**
 * All SQL for image clips. An image clip is a normal row in `clips` (kind `'image'`, so the
 * history, pinning, deletion, pruning and stats treat it like any clip) plus one row in
 * `clip_images` with the image's identity, its recognised text and its analysis.
 *
 * Text and analysis results are keyed by image hash, because that is what the recognition queues
 * work on; a result for an image whose clip was deleted meanwhile is simply dropped. A result is
 * stored only while its row still waits for it (`pending`): a job that finishes after its work was
 * cancelled (analysis switched off) or already answered commits nothing.
 */
export class ImageRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clips: Pick<ClipRepository, 'get' | 'setExtraSearchText'>,
  ) {}

  /** Inserts a new image clip, or bumps the clip of the same image. Always logs a copy event. */
  record(input: RecordImageInput): RecordResult {
    const { hash, width, height, byteSize, source, copiedAt, textState } = input;
    return transaction(this.db, () => {
      const { id, copy_count: copyCount } = this.db
        .prepare(
          `INSERT INTO clips (content, content_hash, kind, char_count, line_count,
             first_copied_at, last_copied_at, source_app, source_exe, source_url)
           VALUES (?, ?, 'image', 0, 0, ?, ?, ?, ?, ?)
           ON CONFLICT (content_hash) DO UPDATE SET
             last_copied_at = excluded.last_copied_at,
             copy_count     = copy_count + 1,
             source_app     = excluded.source_app,
             source_exe     = excluded.source_exe,
             source_url     = excluded.source_url
           RETURNING id, copy_count`,
        )
        .get(
          imageClipLabel(width, height),
          // Never collides with a text clip: those hash to 64 hex characters without a prefix.
          `image:${hash}`,
          copiedAt,
          copiedAt,
          source.app,
          source.exe,
          source.url,
        ) as { id: number; copy_count: number };
      const created = copyCount === 1;

      if (created) {
        this.db
          .prepare(
            `INSERT INTO clip_images (clip_id, image_hash, width, height, byte_size, ocr_state)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(id, hash, width, height, byteSize, textState);
      }
      this.db
        .prepare(
          `INSERT INTO copy_events (clip_id, copied_at, source_app, source_exe, source_url)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, copiedAt, source.app, source.exe, source.url);

      const clip = this.clips.get(id);
      if (!clip) throw new Error(`Clip ${String(id)} vanished inside its own transaction`);
      return { clip, created };
    });
  }

  details(clipId: number): ScreenshotDetails | null {
    const row = this.db
      .prepare(
        `SELECT clip_id, width, height, byte_size, ocr_state, ocr_json, analysis_state, analysis_json
         FROM clip_images WHERE clip_id = ?`,
      )
      .get(clipId) as ImageRow | undefined;
    if (!row) return null;
    return {
      clipId: row.clip_id,
      width: row.width,
      height: row.height,
      byteSize: row.byte_size,
      text: { state: row.ocr_state, result: parseStored(row.ocr_json, ocrResultSchema) },
      analysis: {
        state: row.analysis_state,
        result: parseStored(row.analysis_json, imageAnalysisSchema),
      },
    };
  }

  hashOf(clipId: number): string | null {
    const row = this.db
      .prepare('SELECT image_hash FROM clip_images WHERE clip_id = ?')
      .get(clipId) as { image_hash: string } | undefined;
    return row?.image_hash ?? null;
  }

  /** The image hashes of these clips (text clips have none), each once. */
  hashesOf(clipIds: readonly number[]): string[] {
    if (clipIds.length === 0) return [];
    const rows = this.db
      .prepare(
        'SELECT DISTINCT image_hash FROM clip_images WHERE clip_id IN (SELECT value FROM json_each(?))',
      )
      .all(JSON.stringify(clipIds)) as { image_hash: string }[];
    return rows.map((row) => row.image_hash);
  }

  clipIdOf(hash: string): number | null {
    const row = this.db
      .prepare('SELECT clip_id FROM clip_images WHERE image_hash = ?')
      .get(hash) as { clip_id: number } | undefined;
    return row?.clip_id ?? null;
  }

  /** Whether any clip uses this image (the sweep's final check before deleting its files). */
  hasImage(hash: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM clip_images WHERE image_hash = ? LIMIT 1').get(hash) !==
      undefined
    );
  }

  /** Every stored image hash (to find files on disk that no clip uses any more). */
  hashes(): Set<string> {
    const rows = this.db.prepare('SELECT image_hash FROM clip_images').all() as {
      image_hash: string;
    }[];
    return new Set(rows.map((row) => row.image_hash));
  }

  /** Images whose text was never read (the app quit, or recognition was off and is now on). */
  pendingText(): string[] {
    return this.hashesWhere("ocr_state = 'pending'");
  }

  /** Images queued for analysis when the app quit. */
  /** Hashes with a pending analysis; only those asked for by `trigger` when it is given. */
  pendingAnalysis(trigger?: AnalysisTrigger): string[] {
    if (trigger === undefined) return this.hashesWhere("analysis_state = 'pending'");
    return this.hashesWhere(
      `analysis_state = 'pending' AND analysis_trigger = '${trigger === 'user' ? 'user' : 'auto'}'`,
    );
  }

  /** Marks an image's text as wanted again ("Read text" after recognition was off). */
  requestText(hash: string): number | null {
    return this.update(hash, "ocr_state = 'pending'", []);
  }

  /** Stores the recognised text and makes it searchable. Returns the clip id, or null if it is gone. */
  saveText(hash: string, result: OcrResult): number | null {
    return transaction(this.db, () => {
      const clipId = this.update(
        hash,
        "ocr_state = 'done', ocr_json = ?",
        [JSON.stringify(result)],
        "ocr_state = 'pending'",
      );
      if (clipId !== null)
        this.clips.setExtraSearchText(clipId, OCR_SEARCH_ORIGIN, ocrText(result));
      return clipId;
    });
  }

  failText(hash: string): number | null {
    return this.update(hash, "ocr_state = 'failed', ocr_json = NULL", [], "ocr_state = 'pending'");
  }

  /**
   * A capture's text job will not run after all (recognition was switched off between the row's
   * commit and its dispatch): its pending state becomes `off`, as if recorded a moment later.
   */
  withdrawText(hash: string): number | null {
    return this.update(hash, "ocr_state = 'off'", [], "ocr_state = 'pending'");
  }

  /** Like `withdrawText` for a capture's automatic analysis: `pending` goes back to `none`. */
  withdrawAnalysis(hash: string): number | null {
    return this.update(hash, "analysis_state = 'none'", [], "analysis_state = 'pending'");
  }

  /**
   * Marks an analysis as wanted, by the capture (`auto`) or the user's Analyze action (`user`).
   * An explicit request is never downgraded by a later automatic one while it is pending.
   */
  requestAnalysis(hash: string, trigger: AnalysisTrigger = 'user'): number | null {
    return this.update(
      hash,
      `analysis_trigger = CASE WHEN analysis_state = 'pending' AND analysis_trigger = 'user'
         THEN 'user' ELSE ? END,
       analysis_state = 'pending'`,
      [trigger],
    );
  }

  /**
   * Withdraws every pending automatic analysis (the user switched to "On demand"); explicit
   * requests stay pending. Returns the clips whose analysis was withdrawn.
   */
  withdrawAutomaticAnalysis(): number[] {
    const rows = this.db
      .prepare(
        "UPDATE clip_images SET analysis_state = 'none' WHERE analysis_state = 'pending' AND analysis_trigger = 'auto' RETURNING clip_id",
      )
      .all() as { clip_id: number }[];
    return rows.map((row) => row.clip_id);
  }

  /** Stores the analysis and makes its description and object labels searchable. */
  saveAnalysis(hash: string, analysis: ImageAnalysis): number | null {
    return transaction(this.db, () => {
      const clipId = this.update(
        hash,
        "analysis_state = 'done', analysis_json = ?",
        [JSON.stringify(analysis)],
        "analysis_state = 'pending'",
      );
      if (clipId !== null)
        this.clips.setExtraSearchText(clipId, ANALYSIS_SEARCH_ORIGIN, analysisSearchText(analysis));
      return clipId;
    });
  }

  failAnalysis(hash: string): number | null {
    return this.update(hash, "analysis_state = 'failed'", [], "analysis_state = 'pending'");
  }

  /**
   * Cancels every pending analysis that will not run (analysis was switched off, or the model is
   * missing or damaged). Returns the clips whose analysis was cancelled.
   */
  cancelPendingAnalysis(): number[] {
    const rows = this.db
      .prepare(
        "UPDATE clip_images SET analysis_state = 'none' WHERE analysis_state = 'pending' RETURNING clip_id",
      )
      .all() as { clip_id: number }[];
    return rows.map((row) => row.clip_id);
  }

  private hashesWhere(condition: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT i.image_hash FROM clip_images i JOIN clips c ON c.id = i.clip_id
                WHERE ${condition} ORDER BY c.last_copied_at DESC`,
      )
      .all() as { image_hash: string }[];
    return rows.map((row) => row.image_hash);
  }

  /** `assignments` and `condition` are static SQL fragments from this class; values are bound. */
  private update(
    hash: string,
    assignments: string,
    values: readonly string[],
    condition = '1',
  ): number | null {
    const row = this.db
      .prepare(
        `UPDATE clip_images SET ${assignments} WHERE image_hash = ? AND (${condition}) RETURNING clip_id`,
      )
      .get(...values, hash) as { clip_id: number } | undefined;
    return row?.clip_id ?? null;
  }
}

/**
 * Stored JSON is validated on the way out like worker output on the way in: a row written by an
 * older version (or edited by hand) shows as "no result" instead of breaking the preview.
 */
function parseStored<T>(json: string | null, schema: z.ZodType<T>): T | null {
  if (json === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
