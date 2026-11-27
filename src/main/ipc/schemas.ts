import { z } from 'zod';
import { CATEGORIES } from '@shared/categories';
import type { InvokeChannel } from '@shared/ipc-contract';
import { CLIP_KINDS, PREVIEW_PANE_CHARS, TIME_RANGES } from '@shared/types';
import { MAX_PATTERN_LENGTH } from '@shared/user-regex';
import { MAX_PAGE_SIZE } from '../storage/clip-repository';
import { settingsPatchSchema } from '../storage/settings-store';

/**
 * Runtime validation for every IPC argument list. The renderer is treated as untrusted input:
 * TypeScript types vanish at runtime, these schemas do not.
 */
const id = z.number().int().positive();

const historyQuery = z
  .object({
    text: z.string().max(Math.max(MAX_PATTERN_LENGTH, 500)).optional(),
    regex: z.boolean().optional(),
    app: z.string().max(260).optional(),
    kind: z.enum(CLIP_KINDS).optional(),
    range: z.enum(TIME_RANGES).optional(),
    pinnedOnly: z.boolean().optional(),
    category: z.enum(CATEGORIES).optional(),
    before: z.object({ lastCopiedAt: z.number().int(), id }).strict().optional(),
    limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  })
  .strict();

const clientError = z
  .object({
    message: z.string().max(2000),
    stack: z.string().max(8000).optional(),
    where: z.string().max(120),
  })
  .strict();

export const ipcSchemas = {
  'history:query': z.tuple([historyQuery]),
  'history:get': z.tuple([id]),
  'history:regex-ranges': z.tuple([
    z.string().min(1).max(MAX_PATTERN_LENGTH),
    z.string().max(PREVIEW_PANE_CHARS),
  ]),
  'history:apps': z.tuple([]),
  'history:restore': z.tuple([id]),
  'history:delete': z.tuple([z.array(id).max(10_000)]),
  'history:clear': z.tuple([z.object({ keepPinned: z.boolean() }).strict()]),
  'history:set-pinned': z.tuple([id, z.boolean()]),
  'stats:get': z.tuple([]),
  'settings:get': z.tuple([]),
  'settings:update': z.tuple([settingsPatchSchema]),
  'compare:open-clips': z.tuple([id, id]),
  'compare:get-state': z.tuple([]),
  'compare:reset': z.tuple([]),
  'window:hide': z.tuple([]),
  'app:info': z.tuple([]),
  'diagnostics:report-error': z.tuple([clientError]),
  'screenshot:details': z.tuple([id]),
  // A screenshot holds at most a few thousand characters of text; the cap keeps abuse cheap.
  'screenshot:copy-text': z.tuple([z.string().min(1).max(200_000)]),
  'screenshot:analyze': z.tuple([id]),
  'screenshot:retry-text': z.tuple([id]),
  'screenshot:model-state': z.tuple([]),
  'screenshot:download-model': z.tuple([]),
  'screenshot:cancel-download': z.tuple([]),
} satisfies Record<InvokeChannel, z.ZodType>;
