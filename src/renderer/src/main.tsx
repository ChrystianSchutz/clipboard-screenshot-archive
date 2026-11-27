import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api';
import { ErrorBoundary } from './components/ErrorBoundary';
import { CompareApp } from './features/compare/CompareApp';
import { PaletteApp } from './palette/PaletteApp';
import { applyTheme } from './theme/apply-theme';
import './styles/global.css';

/** One bundle, two windows: the main process loads `index.html#palette` or `#compare`. */
const role = window.location.hash === '#compare' ? 'compare' : 'palette';
document.documentElement.dataset.window = role;
// Until settings arrive (a few ms; the palette is created hidden at startup) follow the OS.
applyTheme('system');

const reportError = (message: string, stack: string | undefined, where: string): void => {
  void api.app.reportError({ message, where, ...(stack ? { stack } : {}) }).catch(() => undefined);
};

window.addEventListener('error', (event) => {
  const error: unknown = event.error;
  reportError(event.message, error instanceof Error ? error.stack : undefined, `window:${role}`);
});
window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason;
  reportError(
    reason instanceof Error ? reason.message : String(reason),
    reason instanceof Error ? reason.stack : undefined,
    `promise:${role}`,
  );
});

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary where={role} onError={reportError}>
      {role === 'compare' ? <CompareApp /> : <PaletteApp />}
    </ErrorBoundary>
  </StrictMode>,
);
