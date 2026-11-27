import { z } from 'zod';
import type {
  AnalysisLanguage,
  AnalysisObject,
  AnalysisText,
  ImageAnalysis,
} from '@shared/image-analysis';
import type { OcrBox } from '@shared/ocr';

/**
 * Mirage's JSON record, as `cactus_describe` returns it (see the official browser worker,
 * https://cactuscompute.com/cactus/mirage.worker.js, and the examples on
 * https://cactuscompute.com/blog/mirage). Boxes are `[x0, y0, x1, y1]` on a 0–1000 scale per axis.
 *
 * Parsed leniently: every section is optional and an entry with a wrong shape is dropped, not
 * fatal, because the record comes from a generative model.
 */
const normalizedBox = z.tuple([z.number(), z.number(), z.number(), z.number()]);

const recordSchema = z.object({
  scene: z.record(z.string(), z.unknown()).optional(),
  objects: z.array(z.unknown()).optional(),
  text: z.array(z.unknown()).optional(),
  reasoning: z.string().optional(),
});

const objectSchema = z.object({
  id: z.number().int().optional(),
  name: z.string().min(1),
  bbox: normalizedBox,
  score: z.number().optional(),
  position: z.string().optional(),
  description: z.record(z.string(), z.unknown()).optional(),
});

const textSchema = z.object({
  string: z.string().min(1),
  bbox: normalizedBox,
  score: z.number().optional(),
});

export const MIRAGE_SCALE = 1000;

export interface MirageRecordContext {
  readonly engine: string;
  readonly language: AnalysisLanguage;
  /** Original screenshot size: normalised boxes are mapped onto it. */
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
}

export function mapMirageRecord(raw: unknown, context: MirageRecordContext): ImageAnalysis {
  const parsed = recordSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Image analysis returned an unexpected result');
  const record = parsed.data;
  const scene = stringEntries(record.scene);
  const toBox = (box: readonly [number, number, number, number]) =>
    denormalize(box, context.width, context.height);

  const objects: AnalysisObject[] = [];
  for (const [index, entry] of (record.objects ?? []).entries()) {
    const object = objectSchema.safeParse(entry);
    if (!object.success) continue;
    const { id, name, bbox, score, position, description } = object.data;
    objects.push({
      id: id ?? index + 1,
      label: name.trim(),
      box: toBox(bbox),
      score: clampScore(score),
      ...(position?.trim() ? { position: position.trim() } : {}),
      attributes: stringEntries(description),
    });
  }

  const text: AnalysisText[] = [];
  for (const entry of record.text ?? []) {
    const line = textSchema.safeParse(entry);
    if (line.success)
      text.push({
        text: line.data.string,
        box: toBox(line.data.bbox),
        score: clampScore(line.data.score),
      });
  }

  return {
    engine: context.engine,
    language: context.language,
    width: context.width,
    height: context.height,
    description: describe(record.reasoning, scene),
    scene,
    objects,
    text,
    durationMs: context.durationMs,
  };
}

/**
 * Mirage's prose is its `reasoning` trace: "lang: en | wine bottle, wine glass | glasses hold
 * beverages". Each part except the language tag is one statement. Without a trace, the scene
 * attributes are the description. This is how the vendor's own sandbox renders it.
 */
export function describe(
  reasoning: string | undefined,
  scene: Readonly<Record<string, string>>,
): string[] {
  const parts = (reasoning ?? '')
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !/^lang\s*:/i.test(part));
  if (parts.length > 0) return parts;
  return Object.entries(scene).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value}`);
}

/** Maps a 0–1000 box onto image pixels: grown outwards to whole pixels, ordered, clamped. */
export function denormalize(
  box: readonly [number, number, number, number],
  width: number,
  height: number,
): OcrBox {
  const [ax, ay, bx, by] = box;
  const x = (value: number, round: (n: number) => number) =>
    clamp(round((value / MIRAGE_SCALE) * width), width);
  const y = (value: number, round: (n: number) => number) =>
    clamp(round((value / MIRAGE_SCALE) * height), height);
  return {
    x0: x(Math.min(ax, bx), Math.floor),
    y0: y(Math.min(ay, by), Math.floor),
    x1: x(Math.max(ax, bx), Math.ceil),
    y1: y(Math.max(ay, by), Math.ceil),
  };
}

function stringEntries(
  source: Readonly<Record<string, unknown>> | undefined,
): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    if (typeof value === 'string' && value.trim()) entries[key] = value.trim();
  }
  return entries;
}

function clampScore(score: number | undefined): number {
  return score === undefined ? 0 : Math.round(Math.min(Math.max(score, 0), 1) * 1000) / 1000;
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}
