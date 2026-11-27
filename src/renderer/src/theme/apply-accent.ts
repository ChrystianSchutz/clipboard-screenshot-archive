import { normalizeHex } from '@shared/color';
import { DEFAULT_ACCENT, accentCssVariables } from '@shared/theme';

/**
 * Publishes the accent tokens for both themes as CSS custom properties on <html>. global.css picks
 * the dark or light set through `prefers-color-scheme`, so a theme switch needs no JavaScript.
 * Set through the CSSOM, which the strict CSP (no inline styles) allows.
 */
export function applyAccent(color: string, root: HTMLElement = document.documentElement): void {
  const hex = normalizeHex(color) ?? DEFAULT_ACCENT;
  for (const [name, value] of Object.entries(accentCssVariables(hex))) {
    root.style.setProperty(name, value);
  }
  root.dataset.accent = hex;
}
