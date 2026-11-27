/** Pure helpers for actions on a multi-selection: what it holds, compare order, copy messages. */
import { pluralize } from '@shared/text';
import { CLIP_KINDS, type ClipKind, type ClipSummary } from '@shared/types';
import type { SelectionMenuContext, SelectionNoun } from '../../components/context-menu';

export interface SelectionFacts {
  readonly count: number;
  /** Clips with text to join (every kind but images). */
  readonly textCount: number;
  readonly imageCount: number;
  readonly pinnedCount: number;
  /** Kinds present, in the fixed `CLIP_KINDS` order, with how many of each. */
  readonly kinds: readonly { readonly kind: ClipKind; readonly count: number }[];
  /** Source apps, most frequent first (ties alphabetical); clips without an app are left out. */
  readonly apps: readonly string[];
  /** `lastCopiedAt` of the oldest and newest selected clip; `null` for an empty selection. */
  readonly oldest: number | null;
  readonly newest: number | null;
}

export function selectionFacts(clips: readonly ClipSummary[]): SelectionFacts {
  const kindCounts = new Map<ClipKind, number>();
  const appCounts = new Map<string, number>();
  let pinnedCount = 0;
  for (const clip of clips) {
    kindCounts.set(clip.kind, (kindCounts.get(clip.kind) ?? 0) + 1);
    if (clip.source.app !== null) {
      appCounts.set(clip.source.app, (appCounts.get(clip.source.app) ?? 0) + 1);
    }
    if (clip.pinned) pinnedCount++;
  }
  const imageCount = kindCounts.get('image') ?? 0;
  const times = clips.map((clip) => clip.lastCopiedAt);
  return {
    count: clips.length,
    textCount: clips.length - imageCount,
    imageCount,
    pinnedCount,
    kinds: CLIP_KINDS.flatMap((kind) => {
      const count = kindCounts.get(kind) ?? 0;
      return count > 0 ? [{ kind, count }] : [];
    }),
    apps: [...appCounts]
      .sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))
      .map(([app]) => app),
    oldest: times.length > 0 ? Math.min(...times) : null,
    newest: times.length > 0 ? Math.max(...times) : null,
  };
}

/** What the menu and the summary pane offer for this selection in a view. */
export function selectionMenuContext(
  clips: readonly ClipSummary[],
  options: {
    readonly noun: SelectionNoun;
    /** The gallery offers "Copy text" (the joined text read from the screenshots). */
    readonly copyText: boolean;
    /** History offers "Compare selected"; the gallery does not. */
    readonly compare: boolean;
  },
): SelectionMenuContext {
  const facts = selectionFacts(clips);
  return {
    noun: options.noun,
    count: facts.count,
    textCount: facts.textCount,
    allPinned: facts.count > 0 && facts.pinnedCount === facts.count,
    copyText: options.copyText,
    compare: options.compare ? compareOrder(clips) !== null : null,
  };
}

/**
 * The compare sides for a selection of exactly two text clips: A is the older one, B the newer
 * (by last copy; the higher id breaks a tie, as in the list). `null` for any other selection.
 */
export function compareOrder(
  clips: readonly ClipSummary[],
): readonly [older: number, newer: number] | null {
  const [first, second] = clips;
  if (clips.length !== 2 || !first || !second) return null;
  if (first.kind === 'image' || second.kind === 'image') return null;
  const firstIsOlder =
    first.lastCopiedAt < second.lastCopiedAt ||
    (first.lastCopiedAt === second.lastCopiedAt && first.id < second.id);
  return firstIsOlder ? [first.id, second.id] : [second.id, first.id];
}

/** Whether a selection holds clips Copy can join (any clip that is not an image). */
export function textClips(clips: readonly ClipSummary[]): ClipSummary[] {
  return clips.filter((clip) => clip.kind !== 'image');
}

/** "Copied 3 clips", "Copied 3 clips, 1 image skipped". */
export function copiedMessage(copied: number, skippedImages: number): string {
  const base = `Copied ${pluralize(copied, 'clip')}`;
  return skippedImages > 0 ? `${base}, ${pluralize(skippedImages, 'image')} skipped` : base;
}

/** "Copied the text of 2 screenshots", "…, 1 without text skipped". */
export function copiedTextMessage(copied: number, withoutText: number): string {
  const base = `Copied the text of ${pluralize(copied, 'screenshot')}`;
  return withoutText > 0 ? `${base}, ${String(withoutText)} without text skipped` : base;
}

/** Splits ids into batches of at most `size` (one IPC call and one transaction each). */
export function batches<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += step) {
    result.push(items.slice(start, start + step));
  }
  return result;
}
