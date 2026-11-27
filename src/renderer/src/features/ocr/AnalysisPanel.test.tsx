/** @vitest-environment jsdom */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AnalysisPanel, type AnalysisPanelProps } from './AnalysisPanel';
import { imageAnalysis } from './test-fixtures';

function renderPanel(overrides: Partial<AnalysisPanelProps> = {}) {
  const props: AnalysisPanelProps = {
    mode: 'on-demand',
    state: 'none',
    result: null,
    model: { state: 'ready' },
    selectedObjectId: null,
    onSelectObject: vi.fn(),
    onAnalyze: vi.fn(),
    onDownloadModel: vi.fn(),
    onCancelDownload: vi.fn(),
    ...overrides,
  };
  const view = render(<AnalysisPanel {...props} />);
  return { ...view, props, panel: screen.getByRole('region', { name: 'Image analysis' }) };
}

describe('AnalysisPanel', () => {
  describe('when analysis is off', () => {
    it('says so and links to Settings', () => {
      const onOpenSettings = vi.fn();
      const { panel } = renderPanel({ mode: 'off', onOpenSettings });

      expect(panel.textContent).toContain('Image analysis is off.');
      fireEvent.click(screen.getByRole('button', { name: 'Turn it on in Settings' }));
      expect(onOpenSettings).toHaveBeenCalledOnce();
    });

    it('has no Settings link without a handler', () => {
      renderPanel({ mode: 'off' });
      expect(screen.queryByRole('button')).toBeNull();
    });
  });

  describe('model setup', () => {
    it('explains the one-time download and starts it', () => {
      const { panel, props } = renderPanel({ model: { state: 'missing', size: 22_400_000 } });

      expect(panel.textContent).toContain('one-time download of the 22 MB model');
      expect(panel.textContent).toContain('checksum-verified');
      expect(panel.textContent).toContain('offline');
      fireEvent.click(screen.getByRole('button', { name: 'Download model' }));
      expect(props.onDownloadModel).toHaveBeenCalledOnce();
    });

    it('shows why a download failed and offers it again', () => {
      const { props } = renderPanel({
        model: { state: 'failed', size: 22_000_000, error: 'Checksum mismatch' },
      });

      expect(screen.getByRole('alert').textContent).toBe('Download failed: Checksum mismatch');
      fireEvent.click(screen.getByRole('button', { name: 'Download model' }));
      expect(props.onDownloadModel).toHaveBeenCalledOnce();
    });

    it('shows download progress with a Cancel button', () => {
      const { panel, props } = renderPanel({
        model: { state: 'downloading', received: 9_900_000, total: 22_000_000 },
      });

      const progress = screen.getByRole('progressbar', { name: 'Model download' });
      expect(progress.getAttribute('value')).toBe('9900000');
      expect(progress.getAttribute('max')).toBe('22000000');
      expect(panel.textContent).toContain('45%');
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(props.onCancelDownload).toHaveBeenCalledOnce();
    });

    it('shows an indeterminate bar while the size is unknown', () => {
      renderPanel({ model: { state: 'downloading', received: 0, total: 0 } });
      expect(screen.getByRole('progressbar').hasAttribute('value')).toBe(false);
    });
  });

  describe('with the model ready', () => {
    it('offers "Analyze" in on-demand mode', () => {
      const { props } = renderPanel();
      fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
      expect(props.onAnalyze).toHaveBeenCalledOnce();
    });

    it('shows progress while analyzing', () => {
      const { panel } = renderPanel({ state: 'pending' });
      expect(panel.textContent).toContain('Analyzing…');
      expect(screen.queryByRole('button')).toBeNull();
    });

    it('offers "Try again" after a failure', () => {
      const { panel, props } = renderPanel({ state: 'failed' });
      expect(panel.textContent).toContain('could not be analyzed');
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(props.onAnalyze).toHaveBeenCalledOnce();
    });
  });

  describe('a finished analysis', () => {
    it('shows the description, scene, objects, text and footer', () => {
      const { panel } = renderPanel({ state: 'done', result: imageAnalysis() });

      expect(panel.textContent).toContain('A settings dialog. It has an OK button.');

      const scene = within(panel).getByLabelText('Scene');
      expect([...scene.querySelectorAll('dt')].map((term) => term.textContent)).toEqual([
        'setting',
        'style',
      ]);
      expect([...scene.querySelectorAll('dd')].map((value) => value.textContent)).toEqual([
        'indoor',
        'screenshot',
      ]);

      // The two "dialog box" boxes share entity id 1, so they are one button with the best score.
      const objects = within(within(panel).getByLabelText('Objects')).getAllByRole('button');
      expect(objects.map((button) => button.textContent)).toEqual([
        'dialog box91% · center · ×2',
        'button50%',
      ]);

      const text = panel.querySelector('details')!;
      expect(text.open).toBe(false);
      expect(within(text).getByText('Text read by the analyzer (2)')).toBeTruthy();
      expect([...text.querySelectorAll('li')].map((line) => line.textContent)).toEqual([
        'Settings',
        'OK',
      ]);

      expect(panel.textContent).toContain('mirage.cact@3d03cee/cactus@4.1.4 · English · 1.2 s');
    });

    it('is shown even when the model has been removed since', () => {
      renderPanel({
        state: 'done',
        result: imageAnalysis(),
        model: { state: 'missing', size: 22_000_000 },
      });
      expect(screen.queryByRole('button', { name: 'Download model' })).toBeNull();
      expect(screen.getByLabelText('Objects')).toBeTruthy();
    });

    it('selects an object, and deselects it on a second click', () => {
      const onSelectObject = vi.fn();
      const { rerender, props } = renderPanel({
        state: 'done',
        result: imageAnalysis(),
        onSelectObject,
      });
      const dialog = () => screen.getByRole('button', { name: /dialog box/ });

      expect(dialog().getAttribute('aria-pressed')).toBe('false');
      fireEvent.click(dialog());
      expect(onSelectObject).toHaveBeenLastCalledWith(1);

      rerender(<AnalysisPanel {...props} selectedObjectId={1} />);
      expect(dialog().getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByRole('button', { name: /^button/ }).getAttribute('aria-pressed')).toBe(
        'false',
      );
      fireEvent.click(dialog());
      expect(onSelectObject).toHaveBeenLastCalledWith(null);
    });

    it('leaves out empty sections', () => {
      const { panel } = renderPanel({
        state: 'done',
        result: imageAnalysis({
          description: [],
          scene: {},
          objects: [],
          text: [],
          durationMs: 850,
        }),
      });
      expect(within(panel).queryByLabelText('Scene')).toBeNull();
      expect(panel.querySelector('details')).toBeNull();
      expect(panel.textContent).toContain('No objects found.');
      expect(panel.textContent).toContain('850 ms');
    });
  });
});
