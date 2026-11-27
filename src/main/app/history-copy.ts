import { joinedLength, joinTexts } from '@shared/text';
import { MAX_COPY_TEXT_CHARS, type CopyClipsResult } from '@shared/types';
import type { ClipRepository } from '../storage/clip-repository';

export interface HistoryCopyDeps {
  readonly repository: Pick<ClipRepository, 'sizesOf' | 'contentsOf'>;
  /**
   * Puts composed text on the clipboard without recording it, skipped by its write marker like a
   * restore (`CaptureService.writeComposedText`).
   */
  readonly write: (text: string) => Promise<void>;
}

/**
 * Copies several clips as one text (`history:copy-many`): the text clips among `ids`, joined in
 * the order given (the list's order), one per line. Image clips are skipped.
 *
 * The size limit is decided from the stored lengths before any text is read, so a selection of
 * 500 large clips costs one small query, not 500 reads and a string of hundreds of megabytes.
 * The texts are then read in one query, in main, where they already are.
 */
export async function copyClips(
  deps: HistoryCopyDeps,
  ids: readonly number[],
): Promise<CopyClipsResult> {
  const sizes = deps.repository.sizesOf(ids);
  const textIds: number[] = [];
  const lengths: number[] = [];
  let skippedImages = 0;
  for (const id of ids) {
    const size = sizes.get(id);
    if (!size) continue;
    if (size.kind === 'image') {
      skippedImages++;
      continue;
    }
    textIds.push(id);
    lengths.push(size.charCount);
  }
  if (textIds.length === 0) return { status: 'nothing', skippedImages };
  const chars = joinedLength(lengths);
  if (chars > MAX_COPY_TEXT_CHARS) return { status: 'too-large', chars };

  const contents = deps.repository.contentsOf(textIds);
  // A clip deleted between the two queries is left out, like one deleted before the call.
  const texts = textIds.flatMap((id) => {
    const content = contents.get(id);
    return content === undefined ? [] : [content];
  });
  if (texts.length === 0) return { status: 'nothing', skippedImages };
  await deps.write(joinTexts(texts));
  return { status: 'copied', copied: texts.length, skippedImages };
}
