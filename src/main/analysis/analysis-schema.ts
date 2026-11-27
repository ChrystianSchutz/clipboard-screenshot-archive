import { z } from 'zod';
import { ANALYSIS_LANGUAGES, type ImageAnalysis } from '@shared/image-analysis';
import { IMAGE_LIMITS } from '../images/image-policy';
import { boxSchema } from '../ocr/ocr-schema';
import { ANALYSIS_MAX_SIDE } from './analysis-image';
import type { AnalysisRequest } from './remote-image-analyzer';

/**
 * Aggregate limit of one analysis: characters across description, scene, object labels,
 * positions and attributes, and text lines (keys included). The per-field limits alone would
 * still admit tens of megabytes. The worker trims its result to it (`limitImageAnalysis`) and main
 * rejects anything bigger, so both sides agree on the same budget.
 */
export const ANALYSIS_BUDGET = { maxTextChars: 300_000 } as const;

export function analysisTextChars(
  analysis: Pick<ImageAnalysis, 'description' | 'scene' | 'objects' | 'text'>,
): number {
  let chars = recordChars(analysis.scene);
  for (const line of analysis.description) chars += line.length;
  for (const object of analysis.objects) chars += objectChars(object);
  for (const line of analysis.text) chars += line.text.length;
  return chars;
}

/** Validates an `ImageAnalysis` that crossed a process boundary (worker → main, database → main). */
export const imageAnalysisSchema: z.ZodType<ImageAnalysis> = z
  .object({
    engine: z.string().max(200),
    language: z.enum(ANALYSIS_LANGUAGES),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    description: z.array(z.string().max(2_000)).max(100),
    scene: z.record(z.string().max(100), z.string().max(500)),
    objects: z
      .array(
        z.object({
          id: z.number().int(),
          label: z.string().max(200),
          box: boxSchema,
          score: z.number(),
          position: z.string().max(200).optional(),
          attributes: z.record(z.string().max(100), z.string().max(500)),
        }),
      )
      .max(1_000),
    text: z
      .array(z.object({ text: z.string().max(10_000), box: boxSchema, score: z.number() }))
      .max(5_000),
    durationMs: z.number().nonnegative(),
  })
  .superRefine((analysis, context) => {
    if (analysisTextChars(analysis) > ANALYSIS_BUDGET.maxTextChars)
      context.addIssue({ code: 'custom', message: 'Image analysis result exceeds its budget' });
  });

/**
 * Trims an analysis to `ANALYSIS_BUDGET`, keeping what the panel shows first: the scene, then the
 * description, objects and text lines in order, each list cut where the budget runs out.
 */
export function limitImageAnalysis(analysis: ImageAnalysis): ImageAnalysis {
  if (analysisTextChars(analysis) <= ANALYSIS_BUDGET.maxTextChars) return analysis;
  let left: number = ANALYSIS_BUDGET.maxTextChars;
  const take = <T>(items: readonly T[], size: (item: T) => number): T[] => {
    const kept: T[] = [];
    for (const item of items) {
      const cost = size(item);
      if (cost > left) {
        left = 0;
        break;
      }
      left -= cost;
      kept.push(item);
    }
    return kept;
  };
  const sceneCost = recordChars(analysis.scene);
  const scene = sceneCost <= left ? analysis.scene : {};
  left -= sceneCost <= left ? sceneCost : 0;
  const description = take(analysis.description, (line) => line.length);
  const objects = take(analysis.objects, objectChars);
  const text = take(analysis.text, (line) => line.text.length);
  return { ...analysis, scene, description, objects, text };
}

function recordChars(record: Readonly<Record<string, string>>): number {
  let chars = 0;
  for (const [key, value] of Object.entries(record)) chars += key.length + value.length;
  return chars;
}

function objectChars(object: ImageAnalysis['objects'][number]): number {
  return object.label.length + (object.position?.length ?? 0) + recordChars(object.attributes);
}

/** Validates an analysis request at the worker's entry (see `runWorkerHost`). */
export const analysisRequestSchema: z.ZodType<AnalysisRequest> = z.object({
  image: z
    .object({
      rgb: z.instanceof(Uint8Array),
      width: z.number().int().positive().max(ANALYSIS_MAX_SIDE),
      height: z.number().int().positive().max(ANALYSIS_MAX_SIDE),
      originalWidth: z.number().int().positive().max(IMAGE_LIMITS.maxSide),
      originalHeight: z.number().int().positive().max(IMAGE_LIMITS.maxSide),
    })
    .refine((image) => image.rgb.byteLength === image.width * image.height * 3, {
      error: 'Pixel buffer does not match the image size',
    }),
  language: z.enum(ANALYSIS_LANGUAGES),
});
