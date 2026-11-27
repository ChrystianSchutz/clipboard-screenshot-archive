import { describe, expect, it } from 'vitest';
import {
  analysisLanguageFor,
  DEFAULT_IMAGE_RECOGNITION_SETTINGS,
  imageRecognitionSettingsSchema,
  shouldAnalyze,
} from './image-settings';

describe('image recognition settings', () => {
  it('reads text by default and leaves analysis off until the user opts in', () => {
    expect(DEFAULT_IMAGE_RECOGNITION_SETTINGS).toEqual({
      textRecognition: true,
      imageAnalysis: 'off',
      analysisLanguage: null,
    });
    expect(imageRecognitionSettingsSchema.parse(DEFAULT_IMAGE_RECOGNITION_SETTINGS)).toEqual(
      DEFAULT_IMAGE_RECOGNITION_SETTINGS,
    );
  });

  it('rejects unknown modes and languages', () => {
    const base = DEFAULT_IMAGE_RECOGNITION_SETTINGS;
    expect(
      imageRecognitionSettingsSchema.safeParse({ ...base, imageAnalysis: 'always' }).success,
    ).toBe(false);
    expect(
      imageRecognitionSettingsSchema.safeParse({ ...base, analysisLanguage: 'de' }).success,
    ).toBe(false);
  });
});

describe('analysisLanguageFor', () => {
  it('follows the UI language: Polish for pl-*, English otherwise', () => {
    expect(analysisLanguageFor({ analysisLanguage: null }, 'pl-PL')).toBe('pl');
    expect(analysisLanguageFor({ analysisLanguage: null }, 'pl')).toBe('pl');
    expect(analysisLanguageFor({ analysisLanguage: null }, 'en-US')).toBe('en');
    expect(analysisLanguageFor({ analysisLanguage: null }, 'de-DE')).toBe('en');
  });

  it('uses an explicit choice over the UI language', () => {
    expect(analysisLanguageFor({ analysisLanguage: 'en' }, 'pl-PL')).toBe('en');
    expect(analysisLanguageFor({ analysisLanguage: 'pl' }, 'en-GB')).toBe('pl');
  });
});

describe('shouldAnalyze', () => {
  it.each([
    ['off', 'capture', false],
    ['off', 'user', false],
    ['on-demand', 'capture', false],
    ['on-demand', 'user', true],
    ['automatic', 'capture', true],
    ['automatic', 'user', true],
  ] as const)('%s + %s gives %s', (mode, trigger, expected) => {
    expect(shouldAnalyze(mode, trigger)).toBe(expected);
  });
});
