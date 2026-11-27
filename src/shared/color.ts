/**
 * Small, dependency-free colour maths for theming: hex parsing, WCAG 2.x contrast and HSL
 * lightness adjustment. Pure functions only, so they run (and are tested) anywhere.
 */

export interface Rgb {
  /** 0..255 */
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface Hsl {
  /** Hue in degrees, 0..360. */
  readonly h: number;
  /** Saturation, 0..1. */
  readonly s: number;
  /** Lightness, 0..1. */
  readonly l: number;
}

/** `#rrggbb`, the only format the settings store accepts. */
export const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export const WHITE = '#ffffff';
export const BLACK = '#000000';

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value);
}

/** Parses `#rrggbb` or `#rgb` (case-insensitive). Returns `null` for anything else. */
export function parseHex(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match?.[1]) return null;
  const digits = match[1].length === 3 ? match[1].replace(/./g, '$&$&') : match[1];
  const value = Number.parseInt(digits, 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

export function toHex({ r, g, b }: Rgb): string {
  const channel = (value: number): string =>
    Math.round(Math.min(255, Math.max(0, value)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Normalises a colour to lowercase `#rrggbb`, or returns `null` when it cannot be parsed. */
export function normalizeHex(hex: string): string | null {
  const rgb = parseHex(hex);
  return rgb ? toHex(rgb) : null;
}

function requireRgb(hex: string): Rgb {
  const rgb = parseHex(hex);
  if (!rgb) throw new Error(`Not a hex colour: ${hex}`);
  return rgb;
}

/** WCAG 2.x relative luminance, 0 (black) .. 1 (white). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = requireRgb(hex);
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2.x contrast ratio, 1 .. 21. Symmetric. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Lowest contrast of `color` against any of `surfaces`. */
export function minContrast(color: string, surfaces: readonly string[]): number {
  return Math.min(...surfaces.map((surface) => contrastRatio(color, surface)));
}

/** WCAG AA for normal-size text. */
export const AA_TEXT = 4.5;
/** WCAG AA for UI components, graphics and large text (1.4.11 / 1.4.3). */
export const AA_UI = 3;

/**
 * Black or white text for a filled background. White is preferred while it still reaches AA
 * (4.5:1): it is what native and VS Code buttons use, and on mid-tone blues black wins the raw
 * comparison by a hair while looking wrong. Below AA the higher-contrast ink wins.
 * With several backgrounds (e.g. a button and its hover state) the worst case decides.
 */
export function readableTextOn(
  backgrounds: string | readonly string[],
): typeof WHITE | typeof BLACK {
  const list = typeof backgrounds === 'string' ? [backgrounds] : backgrounds;
  const white = minContrast(WHITE, list);
  if (white >= AA_TEXT) return WHITE;
  return minContrast(BLACK, list) > white ? BLACK : WHITE;
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = l - c / 2;
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 };
}

/** Returns the colour with its HSL lightness replaced (clamped to 0..1). */
export function withLightness(hex: string, lightness: number): string {
  const hsl = rgbToHsl(requireRgb(hex));
  return toHex(hslToRgb({ ...hsl, l: Math.min(1, Math.max(0, lightness)) }));
}

/** Mixes two colours in sRGB, like CSS `color-mix(in srgb, a weight, b)`. */
export function mix(a: string, b: string, weightOfA: number): string {
  const ca = requireRgb(a);
  const cb = requireRgb(b);
  const w = Math.min(1, Math.max(0, weightOfA));
  return toHex({
    r: ca.r * w + cb.r * (1 - w),
    g: ca.g * w + cb.g * (1 - w),
    b: ca.b * w + cb.b * (1 - w),
  });
}

/**
 * Makes `hex` reach `ratio` against every surface by moving only its HSL lightness: up on dark
 * surfaces, down on light ones. Hue and saturation are kept, so a custom colour still reads as
 * "the user's colour". Returns the input unchanged when it already passes, and the smallest
 * lightness change that passes otherwise (binary search: luminance is monotonic in lightness).
 */
export function ensureContrast(hex: string, surfaces: readonly string[], ratio: number): string {
  const color = normalizeHex(hex);
  if (!color) throw new Error(`Not a hex colour: ${hex}`);
  if (surfaces.length === 0 || minContrast(color, surfaces) >= ratio) return color;

  const surfaceLuminance =
    surfaces.reduce((sum, s) => sum + relativeLuminance(s), 0) / surfaces.length;
  const lighten = surfaceLuminance < 0.5;
  const start = rgbToHsl(requireRgb(color)).l;
  const extreme = lighten ? 1 : 0;
  if (minContrast(withLightness(color, extreme), surfaces) < ratio)
    return withLightness(color, extreme);

  // Invariant: `low` (distance from start) fails, `high` passes.
  let low = 0;
  let high = Math.abs(extreme - start);
  for (let i = 0; i < 24; i += 1) {
    const mid = (low + high) / 2;
    const candidate = withLightness(color, lighten ? start + mid : start - mid);
    if (minContrast(candidate, surfaces) >= ratio) high = mid;
    else low = mid;
  }
  // Rounding to 8-bit channels can land a hair under the target: nudge until it passes.
  let distance = high;
  let result = withLightness(color, lighten ? start + distance : start - distance);
  while (minContrast(result, surfaces) < ratio && distance < 1) {
    distance += 0.002;
    result = withLightness(color, lighten ? start + distance : start - distance);
  }
  return result;
}
