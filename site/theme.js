// Applies a theme the visitor picked earlier before the page paints. Without a stored choice the
// page follows prefers-color-scheme (dark unless the system asks for light).
(function () {
  try {
    var saved = localStorage.getItem('theme');
    if (saved === 'dark' || saved === 'light') {
      document.documentElement.setAttribute('data-theme', saved);
    }
  } catch {
    // Storage blocked (private mode, strict settings): follow the system theme.
  }
})();
