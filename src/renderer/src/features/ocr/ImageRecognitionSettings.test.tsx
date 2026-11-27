/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Settings } from '@shared/types';
import { ImageRecognitionSettings } from './ImageRecognitionSettings';
import { installFakeApi, settingsFixture, settle } from './test-fixtures';

function renderSettings(overrides: Partial<Settings> = {}) {
  const onChange = vi.fn();
  const view = render(
    <ImageRecognitionSettings settings={settingsFixture(overrides)} onChange={onChange} />,
  );
  return { ...view, onChange };
}

const languageSelect = () =>
  screen.getByRole<HTMLSelectElement>('combobox', { name: 'Analysis language' });

describe('ImageRecognitionSettings', () => {
  it('switches text recognition', () => {
    installFakeApi();
    const { onChange } = renderSettings({ textRecognition: true });

    const toggle = screen.getByRole('switch', { name: 'Text recognition' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ textRecognition: false });
  });

  it('chooses the analysis mode', () => {
    installFakeApi();
    const { onChange } = renderSettings({ imageAnalysis: 'off' });

    expect(screen.getByRole('button', { name: 'Off' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Automatic' }));
    expect(onChange).toHaveBeenCalledWith({ imageAnalysis: 'automatic' });
    fireEvent.click(screen.getByRole('button', { name: 'On demand' }));
    expect(onChange).toHaveBeenCalledWith({ imageAnalysis: 'on-demand' });
  });

  it('maps the language choice to null, "en" or "pl"', () => {
    installFakeApi();
    const { onChange } = renderSettings({ analysisLanguage: null });

    expect(languageSelect().value).toBe('');
    fireEvent.change(languageSelect(), { target: { value: 'pl' } });
    expect(onChange).toHaveBeenLastCalledWith({ analysisLanguage: 'pl' });
    fireEvent.change(languageSelect(), { target: { value: 'en' } });
    expect(onChange).toHaveBeenLastCalledWith({ analysisLanguage: 'en' });
    fireEvent.change(languageSelect(), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ analysisLanguage: null });
  });

  it('disables the language and hides the model while analysis is off', () => {
    const fake = installFakeApi();
    renderSettings({ imageAnalysis: 'off', analysisLanguage: 'pl' });

    expect(languageSelect().disabled).toBe(true);
    expect(languageSelect().value).toBe('pl');
    expect(screen.queryByText('Analysis model')).toBeNull();
    expect(fake.screenshots.modelState).not.toHaveBeenCalled();
  });

  it('shows the model state and downloads the model', async () => {
    const fake = installFakeApi({ model: { state: 'missing', size: 22_000_000 } });
    renderSettings({ imageAnalysis: 'on-demand' });

    expect(languageSelect().disabled).toBe(false);
    expect(await screen.findByText('Not downloaded · 22 MB')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(fake.screenshots.downloadModel).toHaveBeenCalledOnce();

    await settle(() =>
      fake.emitModelState({ state: 'downloading', received: 9_900_000, total: 22_000_000 }),
    );
    expect(screen.getByText('Downloading 45%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fake.screenshots.cancelDownload).toHaveBeenCalledOnce();

    await settle(() =>
      fake.emitModelState({ state: 'failed', size: 22_000_000, error: 'Network error' }),
    );
    expect(screen.getByText('Failed: Network error')).toBeTruthy();

    await settle(() => fake.emitModelState({ state: 'ready' }));
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  });

  it('keeps a progress event that arrives before the first answer', async () => {
    const fake = installFakeApi();
    let answer!: (state: { state: 'missing'; size: number }) => void;
    fake.screenshots.modelState.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    renderSettings({ imageAnalysis: 'automatic' });

    await settle(() =>
      fake.emitModelState({ state: 'downloading', received: 11_000_000, total: 22_000_000 }),
    );
    await settle(() => answer({ state: 'missing', size: 22_000_000 }));
    expect(screen.getByText('Downloading 50%')).toBeTruthy();
  });
});
