import { describe, expect, it } from 'vitest';
import {
  BLACK,
  WHITE,
  contrastRatio,
  ensureContrast,
  hslToRgb,
  isHexColor,
  minContrast,
  mix,
  normalizeHex,
  parseHex,
  readableTextOn,
  relativeLuminance,
  rgbToHsl,
  toHex,
  withLightness,
} from './color';

describe('parseHex / toHex', () => {
  it('parses six- and three-digit hex in any case', () => {
    expect(parseHex('#0078D4')).toEqual({ r: 0, g: 120, b: 212 });
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('1f1f1f')).toEqual({ r: 31, g: 31, b: 31 });
  });

  it.each(['', '#12', '#12345', '#gggggg', 'red', '#1234567'])('rejects %j', (value) => {
    expect(parseHex(value)).toBeNull();
  });

  it('round-trips and clamps', () => {
    expect(toHex({ r: 0, g: 120, b: 212 })).toBe('#0078d4');
    expect(toHex({ r: -4, g: 300, b: 127.6 })).toBe('#00ff80');
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('nope')).toBeNull();
  });

  it('isHexColor accepts only #rrggbb', () => {
    expect(isHexColor('#0078d4')).toBe(true);
    expect(isHexColor('#0078D4')).toBe(true);
    expect(isHexColor('#fff')).toBe(false);
    expect(isHexColor(42)).toBe(false);
  });
});

describe('WCAG contrast', () => {
  it('matches the reference values', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    // VS Code's default accent on its own surfaces.
    expect(contrastRatio('#0078d4', '#ffffff')).toBeCloseTo(4.53, 2);
    expect(contrastRatio('#0078d4', '#1f1f1f')).toBeCloseTo(3.64, 2);
  });

  it('is symmetric and takes the worst surface', () => {
    expect(contrastRatio('#3b3b3b', '#f8f8f8')).toBe(contrastRatio('#f8f8f8', '#3b3b3b'));
    expect(minContrast('#cccccc', ['#181818', '#252526'])).toBe(
      contrastRatio('#cccccc', '#252526'),
    );
  });
});

describe('readableTextOn', () => {
  it('prefers white while it reaches AA', () => {
    // Black wins the raw comparison on VS Code blue by a hair; white still passes AA.
    expect(contrastRatio(BLACK, '#0078d4')).toBeGreaterThan(contrastRatio(WHITE, '#0078d4'));
    expect(readableTextOn('#0078d4')).toBe(WHITE);
    expect(readableTextOn('#005fb8')).toBe(WHITE);
  });

  it('switches to black on light colours', () => {
    expect(readableTextOn('#ffd700')).toBe(BLACK);
    expect(readableTextOn('#4daafc')).toBe(BLACK);
    expect(readableTextOn('#ffffff')).toBe(BLACK);
  });

  it('uses the worst case over several backgrounds', () => {
    // White passes on the blue but fails badly on the gold: black has the better worst case.
    expect(readableTextOn(['#0078d4', '#ffd700'])).toBe(BLACK);
  });
});

describe('HSL helpers', () => {
  it('round-trips through HSL', () => {
    for (const hex of ['#0078d4', '#d62681', '#268537', '#808080', '#000000', '#ffffff']) {
      const rgb = parseHex(hex);
      if (!rgb) throw new Error('bad fixture');
      expect(toHex(hslToRgb(rgbToHsl(rgb)))).toBe(hex);
    }
  });

  it('withLightness keeps hue and saturation', () => {
    const before = rgbToHsl(parseHex('#0078d4') ?? { r: 0, g: 0, b: 0 });
    const after = rgbToHsl(parseHex(withLightness('#0078d4', 0.7)) ?? { r: 0, g: 0, b: 0 });
    expect(after.l).toBeCloseTo(0.7, 2);
    expect(after.h).toBeCloseTo(before.h, 0);
    expect(after.s).toBeCloseTo(before.s, 1);
  });

  it('mix behaves like color-mix in srgb', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#0078d4', '#1f1f1f', 1)).toBe('#0078d4');
    expect(mix('#0078d4', '#1f1f1f', 0)).toBe('#1f1f1f');
  });
});

describe('ensureContrast', () => {
  const dark = ['#1f1f1f', '#181818', '#252526'];
  const light = ['#ffffff', '#f8f8f8'];

  it('returns a passing colour unchanged (normalised)', () => {
    expect(ensureContrast('#0078D4', dark, 3)).toBe('#0078d4');
  });

  it('lightens on dark surfaces and darkens on light ones, just enough', () => {
    const navy = ensureContrast('#001f5c', dark, 3);
    expect(minContrast(navy, dark)).toBeGreaterThanOrEqual(3);
    expect(minContrast(navy, dark)).toBeLessThan(3.15);
    expect(relativeLuminance(navy)).toBeGreaterThan(relativeLuminance('#001f5c'));

    const yellow = ensureContrast('#ffd700', light, 3);
    expect(minContrast(yellow, light)).toBeGreaterThanOrEqual(3);
    expect(minContrast(yellow, light)).toBeLessThan(3.15);
    expect(relativeLuminance(yellow)).toBeLessThan(relativeLuminance('#ffd700'));
  });

  it('keeps the hue of the requested colour', () => {
    const adjusted = ensureContrast('#ffd700', light, 4.5);
    const hue = (hex: string): number => rgbToHsl(parseHex(hex) ?? { r: 0, g: 0, b: 0 }).h;
    expect(Math.abs(hue(adjusted) - hue('#ffd700'))).toBeLessThan(3);
  });

  it.each(['#000000', '#ffffff', '#333333', '#ff00ff', '#00ffff', '#1e1e1e', '#f8f8f8'])(
    'always reaches 4.5:1 for %s in both themes',
    (color) => {
      expect(minContrast(ensureContrast(color, dark, 4.5), dark)).toBeGreaterThanOrEqual(4.5);
      expect(minContrast(ensureContrast(color, light, 4.5), light)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('throws on invalid input', () => {
    expect(() => ensureContrast('blue', dark, 3)).toThrow();
  });
});
