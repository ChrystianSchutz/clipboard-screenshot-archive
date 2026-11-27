import { resolveTheme, type ResolvedTheme, type ThemeSource } from '@shared/theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

let source: ThemeSource = 'system';
let listening = false;

function render(root: HTMLElement): ResolvedTheme {
  const theme = resolveTheme(source, window.matchMedia(DARK_QUERY).matches);
  root.dataset.theme = theme;
  return theme;
}

/**
 * Sets `<html data-theme>` from the theme setting. An explicit Dark / Light choice is applied
 * directly: `prefers-color-scheme` does not follow `nativeTheme.themeSource` in windows that have
 * not been shown yet, so it cannot be trusted for that. `system` tracks the OS preference live.
 */
export function applyTheme(
  next: ThemeSource,
  root: HTMLElement = document.documentElement,
): ResolvedTheme {
  source = next;
  if (!listening) {
    listening = true;
    window.matchMedia(DARK_QUERY).addEventListener('change', () => {
      if (source === 'system') render(root);
    });
  }
  return render(root);
}
