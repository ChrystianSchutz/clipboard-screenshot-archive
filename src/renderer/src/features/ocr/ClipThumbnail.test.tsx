/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ClipThumbnail } from './ClipThumbnail';

describe('ClipThumbnail', () => {
  it('loads the thumbnail lazily through the image protocol', () => {
    const { container } = render(<ClipThumbnail clipId={42} />);
    const image = container.querySelector('img')!;

    expect(image.getAttribute('src')).toBe('clip-image://clip/42/thumb');
    expect(image.getAttribute('alt')).toBe('');
    expect(image.getAttribute('loading')).toBe('lazy');
    expect(image.getAttribute('decoding')).toBe('async');
    expect(image.getAttribute('draggable')).toBe('false');
  });

  it('keeps an empty frame when the thumbnail cannot be loaded, until the clip changes', () => {
    const { container, rerender } = render(<ClipThumbnail clipId={42} />);
    fireEvent.error(container.querySelector('img')!);

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('clip-thumbnail').className).toContain('clip-thumbnail--empty');

    rerender(<ClipThumbnail clipId={43} />);
    expect(container.querySelector('img')!.getAttribute('src')).toBe('clip-image://clip/43/thumb');
  });
});
