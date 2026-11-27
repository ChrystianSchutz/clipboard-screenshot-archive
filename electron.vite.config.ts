import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

const shared = { '@shared': resolve(import.meta.dirname, 'src/shared') };

/**
 * The dev server injects CSS as inline <style> tags, React Fast Refresh adds an inline preamble
 * script and HMR talks over a WebSocket. The strict production CSP in index.html blocks all three,
 * so in `npm run dev` only, it is relaxed. Builds keep the strict policy untouched.
 */
function devCsp(): Plugin {
  return {
    name: 'clipboard-archive:dev-csp',
    apply: 'serve',
    transformIndexHtml: (html) =>
      html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
        .replace("connect-src 'self'", "connect-src 'self' ws: http://localhost:*"),
  };
}

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      // koffi is a native module and tesseract.js starts its own worker script by file path, so
      // both stay in node_modules; everything else is bundled.
      externalizeDeps: { include: ['koffi', 'tesseract.js'] },
      rolldownOptions: {
        // The OCR and analysis hosts run in their own utility processes (see workers/electron-worker.ts).
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          'ocr-host': resolve(import.meta.dirname, 'src/main/ocr/ocr-host-entry.ts'),
          'analysis-host': resolve(import.meta.dirname, 'src/main/analysis/analysis-host-entry.ts'),
        },
      },
    },
  },
  preload: {
    resolve: { alias: shared },
    build: {
      // Sandboxed preloads cannot `import`: emit a single self-contained CommonJS file.
      externalizeDeps: false,
      rolldownOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    resolve: {
      alias: { ...shared, '@renderer': resolve(import.meta.dirname, 'src/renderer/src') },
    },
    plugins: [react(), devCsp()],
  },
});
