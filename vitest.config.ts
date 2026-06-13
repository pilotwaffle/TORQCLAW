import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Pure-logic unit tests only — no network, no DB (a temp TORQCLAW_DATA_DIR
// where a module insists on the filesystem). Tests import package source
// directly; @torqclaw/contracts (the only cross-package import those sources
// pull) is aliased to its built dist so Vite's resolver finds it.
const contractsDist = fileURLToPath(
  new URL('./packages/contracts/dist/index.js', import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: { '@torqclaw/contracts': contractsDist },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
