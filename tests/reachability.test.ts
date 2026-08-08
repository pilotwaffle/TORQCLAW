import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tests for the reachability gate (ops/reachability.mjs).
 *
 * The gate exists because this repo repeatedly shipped strong, well-tested
 * modules that no running program could reach. A gate that is itself wrong --
 * in either direction -- would be worse than none: false positives train
 * people to ignore it, false negatives let the defect back in. So both
 * directions are pinned here.
 */

const ROOT = join(import.meta.dirname, '..');
const PROBE = join(ROOT, 'packages/gateway/src/__reachability_probe.ts');

function runGate(): { code: number; out: string } {
  try {
    const out = execFileSync('node', ['ops/reachability.mjs'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err: any) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('reachability gate', () => {
  it('passes on the current tree', () => {
    const { code, out } = runGate();
    expect(out).toContain('PASS');
    expect(code).toBe(0);
  });

  it('does NOT report the console component tree as orphaned', () => {
    // Regression: the first version of the gate could not resolve Next.js
    // "@/..." path aliases and reported TorqTerminal.tsx (1,288 lines, the
    // app's only rendered component) as dead code. A gate that cries wolf
    // gets ignored, so this specific false positive is pinned.
    const { out } = runGate();
    expect(out).not.toContain('TorqTerminal');
    expect(out).not.toContain('friendly.ts');
  });

  it('does NOT report CI build scripts as orphaned', () => {
    // check-schemas.ts / emit-schemas.ts are invoked by package.json scripts
    // (`pnpm contracts:check`), not imported by anything. They are entry
    // points, not dead code.
    const { out } = runGate();
    expect(out).not.toContain('check-schemas');
    expect(out).not.toContain('emit-schemas');
  });

  it('FAILS when a substantial unreachable module appears', () => {
    const body = ['// temporary probe\n', ...Array.from({ length: 200 }, (_, i) => `export const p${i} = ${i};\n`)].join('');
    writeFileSync(PROBE, body, 'utf8');
    try {
      const { code, out } = runGate();
      expect(out).toContain('__reachability_probe');
      expect(out).toContain('FAIL');
      expect(code).toBe(1);
    } finally {
      rmSync(PROBE, { force: true });
    }
    expect(existsSync(PROBE)).toBe(false);
  });

  it('ignores small helper files below the size threshold', () => {
    // The gate deliberately only flags substantial modules; a 3-line helper
    // being unreferenced is noise, not a governance failure.
    writeFileSync(PROBE, 'export const tiny = 1;\n', 'utf8');
    try {
      const { code, out } = runGate();
      expect(out).toContain('PASS');
      expect(code).toBe(0);
    } finally {
      rmSync(PROBE, { force: true });
    }
  });

  it('reports the known-dormant modules with their declared reasons', () => {
    // Dormancy must stay visible. If someone silently drops an entry from
    // DORMANT to make the gate green, that is the defect returning.
    const { out } = runGate();
    expect(out).toContain('packages/collab');
    expect(out).toContain('skillTrust.ts');
    // Operator ruling 2026-08-08: collab moved from "DORMANT — decision
    // pending" to INCUBATING, absorbed slice by slice behind
    // TORQCLAW_COLLAB_ENABLED rather than wired wholesale.
    expect(out).toMatch(/INCUBATING/);
    expect(out).toMatch(/TORQCLAW_COLLAB_ENABLED/);
  });

  it('no longer lists the skill pipeline as dormant (Phase 1 wired it)', () => {
    // skill_publisher.py / verified_skill_store.py / runtime_quiescence.py were
    // declared dormant until governed_skills.py wired them into
    // skill_queue.decide(). The gate now reaches them from server.py on its
    // own. If they reappear here, the wiring regressed.
    const { out } = runGate();
    expect(out).not.toContain('skill_publisher.py');
    expect(out).not.toContain('verified_skill_store.py');
  });
});
