import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve workspace packages to their TypeScript sources, so tests never need a build.
  resolve: { conditions: ['@communal/source'] },
  ssr: { resolve: { conditions: ['@communal/source'] } },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 20_000,
    // Cleanup after the 100k-file M2 test (stopping the core, deleting the tree) is slow on CI.
    hookTimeout: 60_000,
  },
});
