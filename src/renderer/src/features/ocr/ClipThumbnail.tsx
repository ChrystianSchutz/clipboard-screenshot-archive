import { useState } from 'react';
import { screenshotUrl } from '@shared/screenshots';
import './ocr.css';

export interface ClipThumbnailProps {
  readonly clipId: number;
}

/**
 * A small preview of an image clip for a history row. Decorative (`alt=""`): the row already
 * names the clip. A thumbnail that fails to load leaves an empty frame, so rows keep their height.
 */
export function ClipThumbnail({ clipId }: ClipThumbnailProps) {
  const [failedFor, setFailedFor] = useState<number | null>(null);
  const failed = failedFor === clipId;

  return (
    <span
      className={failed ? 'clip-thumbnail clip-thumbnail--empty' : 'clip-thumbnail'}
      data-testid="clip-thumbnail"
    >
      {failed ? null : (
        <img
          className="clip-thumbnail__image"
          src={screenshotUrl(clipId, 'thumb')}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailedFor(clipId)}
        />
      )}
    </span>
  );
}
