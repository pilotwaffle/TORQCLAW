/**
 * T-8 (G1D-FABLE-CLEANUP-DOCS-TRUTH-2026-08-23, Item 9 reduced per B-6).
 *
 * `pnpm lint` used to be `turbo run lint`, and no package in this repo
 * defines a `lint` script -- so turbo silently ran ZERO tasks and exited 0.
 * That is indistinguishable, from the caller's side (exit code alone), from
 * "lint ran across every package and passed." An honest red would have been
 * better than a vacuous green; this slice does neither -- it makes the
 * green SELF-DESCRIBING instead, per B-6's ruling (no ESLint this slice).
 *
 * This test pins the two properties that make it honest rather than silent:
 * exit code 0 (so CI does not break), and stdout that says PLAINLY that lint
 * is not configured (so a human or a script reading the output cannot
 * mistake this for a real lint pass).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('pnpm lint is self-describing, not silently vacuous', () => {
  it('exits 0 AND stdout names the gap plainly (never a bare, unexplained green)', () => {
    const result = spawnSync('pnpm', ['lint'], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32', // pnpm is a .cmd shim on Windows
    });

    expect(result.error, `pnpm lint failed to spawn: ${result.error}`).toBeUndefined();
    expect(result.status, `pnpm lint stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('lint not configured');
  });

  it('the underlying script itself exits 0 and prints the honest message (isolated from pnpm/turbo resolution)', () => {
    const result = spawnSync(process.execPath, [join(ROOT, 'ops', 'lint-not-configured.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('lint not configured — no ESLint in this repo');
    expect(result.stdout).toContain('docs/FOLLOWUPS-CI-E2E-GATES.md');
  });

  it('root package.json no longer routes lint through turbo (no vacuous 0-task green)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const lintScript = pkg.scripts.lint;
    expect(lintScript).not.toContain('turbo run lint');
    expect(lintScript).toContain('lint-not-configured.mjs');
  });
});
