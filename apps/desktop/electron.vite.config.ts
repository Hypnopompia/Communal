import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

/**
 * Main and preload stay small: every dependency, the workspace packages included, is loaded
 * from node_modules at run time. `@communal/core` therefore resolves to its compiled `dist/`
 * (`pnpm build` first), and its native modules load from core's own node_modules.
 */
/**
 * The page's CSP allows only bundled scripts. Vite's dev server needs inline scripts (React
 * refresh) and its own WebSocket, so the dev server relaxes it; builds keep it strict.
 */
function devCsp(): Plugin {
  return {
    name: 'communal-dev-csp',
    apply: 'serve',
    transformIndexHtml: (html) =>
      html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace(
          'connect-src communal:',
          'connect-src communal: ws://localhost:* http://localhost:*',
        ),
  };
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          // Runs in Electron's utilityProcess: the core engine and its local API.
          'core-host': resolve(import.meta.dirname, 'src/main/core-host.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        // A sandboxed preload must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: resolve(import.meta.dirname, 'src/renderer/index.html') },
    },
    plugins: [react(), devCsp()],
  },
});
