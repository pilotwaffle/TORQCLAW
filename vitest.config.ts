import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Pure-logic unit tests only — no network, no DB (a temp TORQCLAW_DATA_DIR
// where a module insists on the filesystem). Tests import package source
// directly; @torqclaw/contracts (the only cross-package import those sources
// pull) is aliased to its built dist so Vite's resolver finds it.
const contractsDist = fileURLToPath(
  new URL('./packages/contracts/dist/index.js', import.meta.url),
);
const contractsSource = fileURLToPath(
  new URL('./packages/contracts/src/index.ts', import.meta.url),
);
const contractsEntry = process.env.TORQCLAW_PROFILE_CONFORMANCE_SOURCE_CONTRACTS === '1'
  ? contractsSource
  : contractsDist;

// C0.1: collabIdentity.ts (packages/gateway/src) imports verifyCredential
// etc. from '@torqclaw/collab', which resolves to packages/collab/dist/.
// Tests that assert HMAC-operation-count equality on the SAME module
// instance collabIdentity.ts actually uses (packages/collab/src/credentials.ts's
// module-scoped counter) must resolve '@torqclaw/collab' identically, or
// they silently observe a different counter instance and pass vacuously.
// Same mechanism as the @torqclaw/contracts alias above.
const collabDist = fileURLToPath(
  new URL('./packages/collab/dist/index.js', import.meta.url),
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
      '@torqclaw/contracts': contractsEntry,
      '@torqclaw/collab': collabDist,
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
    // Built-artifact and failover files spawn their own Node, Python, build,
    // and server processes. Vitest's CPU-derived default (20 workers on the
    // primary Windows builder) multiplies that nested fanout until otherwise
    // healthy per-test deadlines expire. Two file workers preserve parallel
    // execution while allowing at most one competing suite beside a nested-
    // process test, placing a deterministic ceiling on subprocess pressure.
    minWorkers: 1,
    maxWorkers: 2,
  },
});
