/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ocrText } from '@shared/ocr';
import { approximateMeasure } from './text-layer-geometry';
import { COPY_NOTICE_MS, ScreenshotView, type ScreenshotViewProps } from './ScreenshotView';
import { ocrLine, ocrResult, settle, stubImageSize } from './test-fixtures';

function renderView(overrides: Partial<ScreenshotViewProps> = {}) {
  const props: ScreenshotViewProps = {
    src: 'clip-image://clip/7/full',
    alt: 'Screenshot',
    ocr: ocrResult(),
    status: 'done',
    onCopyText: vi.fn(() => Promise.resolve()),
    measure: approximateMeasure,
    ...overrides,
  };
  return { ...render(<ScreenshotView {...props} />), props };
}

const status = () => screen.getByRole('status');
const highlight = () => screen.queryByTestId('screenshot-highlight');

describe('ScreenshotView', () => {
  beforeEach(() => {
    // The 800 × 400 screenshot is displayed at half size.
    stubImageSize(400, 200);
  });

  describe('highlight', () => {
    it('outlines the box at the displayed scale', () => {
      renderView({
        imageSize: { width: 800, height: 400 },
        highlight: { x0: 100, y0: 40, x1: 300, y1: 120 },
      });

      const box = highlight()!;
      expect(box.style.left).toBe('50px');
      expect(box.style.top).toBe('20px');
      expect(box.style.width).toBe('100px');
      expect(box.style.height).toBe('40px');
      expect(box.getAttribute('aria-hidden')).toBe('true');
    });

    it('falls back to the OCR result size without an explicit image size', () => {
      renderView({ highlight: { x0: 0, y0: 0, x1: 800, y1: 400 } });
      expect(highlight()!.style.width).toBe('400px');
      expect(highlight()!.style.height).toBe('200px');
    });

    it('is not drawn without a box', () => {
      renderView({ highlight: null });
      expect(highlight()).toBeNull();
    });

    it('is not drawn before the image has a size to scale to', () => {
      renderView({ ocr: null, status: 'off', highlight: { x0: 0, y0: 0, x1: 10, y1: 10 } });
      // No OCR result, no image size and jsdom reports no natural size: nothing to scale against.
      expect(highlight()).toBeNull();
    });
  });

  describe('copying', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('"Copy all text" copies the OCR text and confirms it briefly', async () => {
      vi.useFakeTimers();
      const result = ocrResult();
      const { props } = renderView({ ocr: result });

      fireEvent.click(screen.getByRole('button', { name: 'Copy all text' }));
      expect(props.onCopyText).toHaveBeenCalledWith(ocrText(result), 'all');
      await settle();
      expect(status().textContent).toBe('Copied all text');

      act(() => {
        vi.advanceTimersByTime(COPY_NOTICE_MS);
      });
      expect(status().textContent).toBe('2 lines of text');
    });

    it('a click on a line copies that line', async () => {
      const { props } = renderView();

      fireEvent.click(screen.getByTestId('ocr-text-layer').querySelector('[data-line="1"]')!);
      expect(props.onCopyText).toHaveBeenCalledWith('Second line', 'line');
      await settle();
      expect(status().textContent).toBe('Copied line');
    });

    it('says when copying failed', async () => {
      renderView({ onCopyText: () => Promise.reject(new Error('clipboard busy')) });
      fireEvent.click(screen.getByRole('button', { name: 'Copy all text' }));
      await settle();
      expect(status().textContent).toBe('Could not copy the text');
    });

    it('"Copy all text" is disabled when there is no text', () => {
      renderView({ ocr: ocrResult([]) });
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Copy all text' }).disabled,
      ).toBe(true);
    });
  });

  describe('status line', () => {
    it.each([
      ['pending', 'Reading text…'],
      ['failed', 'Text could not be read from this image.'],
      ['off', 'Text recognition is off.'],
    ] as const)('%s → "%s"', (state, text) => {
      renderView({ ocr: null, status: state });
      expect(status().textContent).toBe(text);
    });

    it('offers "Try again" only when reading failed and a retry is possible', () => {
      const onRetryText = vi.fn();
      const { rerender, props } = renderView({ ocr: null, status: 'failed', onRetryText });

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(onRetryText).toHaveBeenCalledTimes(1);

      rerender(<ScreenshotView {...props} status="pending" />);
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      rerender(<ScreenshotView {...props} onRetryText={undefined} />);
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    });

    it('counts the lines that were read', () => {
      const { rerender, props } = renderView({
        ocr: ocrResult([ocrLine('Only line', 0, 0, 50, 10)]),
      });
      expect(status().textContent).toBe('1 line of text');

      rerender(<ScreenshotView {...props} ocr={ocrResult([])} />);
      expect(status().textContent).toBe('No text found');
    });
  });
});
