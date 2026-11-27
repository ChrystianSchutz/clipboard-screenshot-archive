/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ocrText } from '@shared/ocr';
import type { ScreenshotDetails } from '@shared/screenshots';
import { ScreenshotPreview } from './ScreenshotPreview';
import {
  deferred,
  imageAnalysis,
  installFakeApi,
  ocrResult,
  screenshotDetails,
  settingsFixture,
  disableCanvas,
  settle,
  stubImageSize,
} from './test-fixtures';

const highlight = () => screen.queryByTestId('screenshot-highlight');

/** Waits until the preview has its details, model state and settings. */
const findPanel = () => screen.findByRole('region', { name: 'Image analysis' });

describe('ScreenshotPreview', () => {
  beforeEach(() => {
    stubImageSize(400, 200);
    disableCanvas();
  });

  it('loads the screenshot and its analysis', async () => {
    const fake = installFakeApi();
    render(<ScreenshotPreview clipId={7} />);

    expect(screen.getByText('Loading image…')).toBeTruthy();
    await findPanel();
    expect(fake.screenshots.details).toHaveBeenCalledWith(7);
    expect(screen.getByRole('img', { name: 'Screenshot' }).getAttribute('src')).toBe(
      'clip-image://clip/7/full',
    );
    expect(screen.getByRole('status').textContent).toBe('2 lines of text');
    expect(screen.getByLabelText('Objects')).toBeTruthy();
  });

  it('says when the image is gone', async () => {
    installFakeApi({ details: () => Promise.resolve(null) });
    render(<ScreenshotPreview clipId={7} />);
    expect(await screen.findByText('This image is no longer available.')).toBeTruthy();
  });

  it('reloads when this clip is updated, not when another one is', async () => {
    const fake = installFakeApi();
    render(<ScreenshotPreview clipId={7} />);
    await findPanel();
    expect(fake.screenshots.details).toHaveBeenCalledTimes(1);

    fake.screenshots.details.mockResolvedValueOnce(
      screenshotDetails(7, { text: { state: 'done', result: ocrResult([]) } }),
    );
    await settle(() => fake.emitUpdated(8));
    expect(fake.screenshots.details).toHaveBeenCalledTimes(1);

    await settle(() => fake.emitUpdated(7));
    expect(fake.screenshots.details).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status').textContent).toBe('No text found');
  });

  it('outlines the selected object on the image', async () => {
    installFakeApi();
    render(<ScreenshotPreview clipId={7} />);
    await findPanel();
    expect(highlight()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^button/ }));
    // Box 400,200 → 480,240 on the 800 × 400 image, displayed at half size.
    const box = highlight()!;
    expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual([
      '200px',
      '100px',
      '40px',
      '20px',
    ]);

    fireEvent.click(screen.getByRole('button', { name: /^button/ }));
    expect(highlight()).toBeNull();
  });

  it('drops the selection and ignores late answers when the clip changes', async () => {
    const late = deferred<ScreenshotDetails | null>();
    const fake = installFakeApi({
      details: (clipId) => (clipId === 7 ? Promise.resolve(screenshotDetails(7)) : late.promise),
    });
    const { rerender } = render(<ScreenshotPreview clipId={7} />);
    await findPanel();
    fireEvent.click(screen.getByRole('button', { name: /^button/ }));
    expect(highlight()).not.toBeNull();

    rerender(<ScreenshotPreview clipId={8} />);
    expect(screen.getByText('Loading image…')).toBeTruthy();

    // Clip 7 is updated after the switch: its listener is gone, so nothing reloads it.
    await settle(() => fake.emitUpdated(7));
    expect(fake.screenshots.details.mock.calls.map(([id]) => id)).toEqual([7, 8]);

    await settle(() => late.resolve(screenshotDetails(8)));
    expect(screen.getByRole('img', { name: 'Screenshot' }).getAttribute('src')).toBe(
      'clip-image://clip/8/full',
    );
    expect(highlight()).toBeNull();
  });

  it('ignores an answer for the previous clip that arrives after the switch', async () => {
    const slow = deferred<ScreenshotDetails | null>();
    installFakeApi({
      details: (clipId) => (clipId === 7 ? slow.promise : Promise.resolve(screenshotDetails(8))),
    });
    const { rerender } = render(<ScreenshotPreview clipId={7} />);
    rerender(<ScreenshotPreview clipId={8} />);
    await findPanel();

    await settle(() => slow.resolve(screenshotDetails(7)));
    expect(screen.getByRole('img', { name: 'Screenshot' }).getAttribute('src')).toBe(
      'clip-image://clip/8/full',
    );
  });

  it('copies text through the bridge and confirms it', async () => {
    const fake = installFakeApi();
    render(<ScreenshotPreview clipId={7} />);
    await findPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Copy all text' }));
    expect(fake.screenshots.copyText).toHaveBeenCalledWith(ocrText(ocrResult()));
    expect(await screen.findByText('Copied all text')).toBeTruthy();
  });

  it('analyzes on request and shows progress until the details change', async () => {
    const fake = installFakeApi({
      details: (clipId) =>
        Promise.resolve(screenshotDetails(clipId, { analysis: { state: 'none', result: null } })),
    });
    const analysis = deferred<boolean>();
    fake.screenshots.analyze.mockReturnValueOnce(analysis.promise);
    render(<ScreenshotPreview clipId={7} />);
    await findPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    expect(fake.screenshots.analyze).toHaveBeenCalledWith(7);
    expect(screen.getByText('Analyzing…')).toBeTruthy();

    fake.screenshots.details.mockResolvedValueOnce(
      screenshotDetails(7, { analysis: { state: 'done', result: imageAnalysis() } }),
    );
    await settle(() => analysis.resolve(true));
    expect(screen.getByLabelText('Objects')).toBeTruthy();
  });

  it('reads the text again on "Try again" and shows progress until the details change', async () => {
    const fake = installFakeApi({
      details: (clipId) =>
        Promise.resolve(screenshotDetails(clipId, { text: { state: 'failed', result: null } })),
    });
    const retry = deferred<boolean>();
    fake.screenshots.retryText.mockReturnValueOnce(retry.promise);
    render(<ScreenshotPreview clipId={7} />);
    expect(await screen.findByText('Text could not be read from this image.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(fake.screenshots.retryText).toHaveBeenCalledWith(7);
    expect(screen.getByText('Reading text…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();

    fake.screenshots.details.mockResolvedValueOnce(screenshotDetails(7));
    await settle(() => retry.resolve(true));
    expect(screen.queryByText('Reading text…')).toBeNull();
  });

  it('follows the model state and the analysis mode', async () => {
    const fake = installFakeApi({
      model: { state: 'missing', size: 22_000_000 },
      details: (clipId) =>
        Promise.resolve(screenshotDetails(clipId, { analysis: { state: 'none', result: null } })),
    });
    render(<ScreenshotPreview clipId={7} />);
    await findPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Download model' }));
    expect(fake.screenshots.downloadModel).toHaveBeenCalledOnce();
    await settle(() =>
      fake.emitModelState({ state: 'downloading', received: 11_000_000, total: 22_000_000 }),
    );
    expect(screen.getByRole('progressbar')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fake.screenshots.cancelDownload).toHaveBeenCalledOnce();

    await settle(() => fake.emitSettings(settingsFixture({ imageAnalysis: 'off' })));
    expect(screen.getByText(/Image analysis is off/)).toBeTruthy();
  });

  it('unsubscribes from every event on unmount', async () => {
    const fake = installFakeApi();
    const { unmount } = render(<ScreenshotPreview clipId={7} />);
    await findPanel();
    expect(fake.listenerCount()).toBe(3);

    unmount();
    expect(fake.listenerCount()).toBe(0);
  });
});
