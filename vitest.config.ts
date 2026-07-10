import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Pure-logic unit tests only — no network, no DB (a temp TORQCLAW_DATA_DIR
// where a module insists on the filesystem). Tests import package source
// directly; @torqclaw/contracts (the only cross-package import those sources
// pull) is aliased to its built dist so Vite's resolver finds it.
const contractsDist = fileURLToPath(
  new URL('./packages/contracts/dist/index.js', import.meta.url),
);

// TCLAW-QA-1: react/react-dom are a dependency of apps/console only (not the
// workspace root), so under pnpm's strict node_modules isolation they have no
// top-level symlink at the repo root — Vite's resolver can't find them for
// tests/*.test.tsx importing console components. This mirrors the existing
// @torqclaw/contracts alias above: point at the already-installed workspace
// copies (same mechanism, not a new dependency) rather than adding react as a
// root devDependency.
const consoleReact = fileURLToPath(new URL('./apps/console/node_modules/react', import.meta.url));
const consoleReactDom = fileURLToPath(new URL('./apps/console/node_modules/react-dom', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@torqclaw/contracts': contractsDist,
      react: consoleReact,
      'react-dom': consoleReactDom,
    },
  },
  // apps/console/tsconfig.json sets "jsx": "preserve" (Next.js handles the
  // actual transform there); Vite's esbuild-based transform picks up that
  // nearest tsconfig for files under apps/console/src and does not treat
  // "preserve" as "automatic", producing bare React.createElement calls with
  // no React import in scope. Force the automatic runtime for this test run
  // regardless of which tsconfig esbuild finds — config-only, no tsconfig edit.
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
