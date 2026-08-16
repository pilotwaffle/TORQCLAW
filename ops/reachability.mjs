#!/usr/bin/env node
/**
 * TORQCLAW reachability gate.
 *
 * Fails when a substantial source module cannot be reached from any real
 * program entry point.
 *
 * WHY THIS EXISTS
 * ---------------
 * The recurring defect in this repo is not weak code -- it is strong code
 * wired to nothing. A module gets designed, reviewed, implemented, tested,
 * adversarially verified, and merged, and then no running program can reach
 * it. The tests pass because they test the MODULE; nothing tests the CLAIM
 * that the module is part of the system. Four separate subsystems reached
 * production in that state (~9,200 lines).
 *
 * A plain "is anything importing this?" check is not enough: two orphaned
 * modules that import each other would both look reachable. So this walks
 * the import graph TRANSITIVELY from declared entry points. A module counts
 * as live only if a real program can actually get to it.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not judge quality, coverage, or whether the wiring is correct --
 * only whether a path exists. Dormant-by-design code is legitimate; it just
 * has to say so out loud in DORMANT below, which is the point: the decision
 * becomes explicit and reviewable instead of silent.
 *
 * Usage:  node ops/reachability.mjs [--json]
 * Exit:   0 all reachable (or dormant-and-declared), 1 orphans found.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const rel = (p) => relative(ROOT, p).split('\\').join('/');

/** Real program entry points. Everything live must be reachable from one. */
const ENTRY_POINTS = [
  // Long-running programs
  'packages/gateway/src/server.ts',
  'packages/channel-http/src/server.ts',
  'apps/console/src/app/page.tsx',
  'engines/hermes_kernel/mcp_wrapper/server.py',
  // Build/CI scripts invoked directly by package.json scripts. These are
  // real entry points -- `pnpm contracts:check` runs check-schemas.ts -- so
  // omitting them would report CI tooling as dead code.
  'packages/contracts/scripts/check-schemas.ts',
  'packages/contracts/scripts/emit-schemas.ts',
];

/**
 * Modules that are deliberately not wired yet, with the reason and the
 * ticket that will wire them. This list is the feature, not a workaround:
 * an orphan must be a stated decision rather than an accident.
 *
 * Adding an entry here should be a reviewed act. Removing one when the
 * module gets wired is how the debt actually gets paid down.
 */
const DORMANT = {
  // AUTH-005 Phase 2A is deliberately offline/inert. These modules are
  // reached only by scripts/auth-phase2a-offline.mjs (an explicit operator
  // entrypoint), never by server/storage/sessions or another live helper.
  'packages/gateway/src/authIdentityMigration.ts': 'AUTH-005 Phase 2A Gate 1: offline state migration only; standalone CLI entrypoint.',
  'packages/gateway/src/authReconciliationDiagnostic.ts': 'AUTH-005 Phase 2A Gate 1: non-authoritative offline evidence only; standalone CLI entrypoint.',
  'packages/collab/src/authIdentityMigration.ts': 'AUTH-005 Phase 2A Gate 1: offline collab migration only; standalone CLI entrypoint.',
  // packages/gateway/src/skillTrust.ts was listed here (Ed25519 skill
  // signing, pre-loaded for Phase 4, zero production importers) until P4-2
  // DELETED it outright rather than wiring it: PRD-TCLAW-REMOTE-SKILL-
  // SOURCES-005 R-1 ports its MODEL, not its lines, into a new Python trust
  // engine (engines/hermes_kernel/mcp_wrapper/skill_trust.py) colocated
  // with the install authority, so the process that installs is the
  // process that verifies -- an IPC verdict crossing from the gateway to
  // the kernel would be a claim, not proof, the same defect
  // governed_skills._already_active_and_published's provenance-sidecar
  // comment documents at process scale. Reintroducing this entry (or the
  // file) turns tests/reachability.test.ts's inverted skillTrust.ts
  // expectation red -- that inversion is the deletion probe (DP-8).
  //
  // verified_skill_store.py, skill_publisher.py and runtime_quiescence.py were
  // listed here until Phase 1 wired them through governed_skills.py into
  // skill_queue.decide(). They are now transitively reachable from
  // mcp_wrapper/server.py, so the gate finds them on its own -- which is the
  // intended lifecycle for every entry in this map.
  //
  // packages/collab was listed here (INCUBATING — SELECTIVE INTEGRATION
  // REQUIRED, operator ruling 2026-08-08) until slice C0.1 gave it a real
  // runtime entry point: packages/gateway/src/server.ts now transitively
  // imports it via collabIdentity.ts's verifySurfaceCredential (connect-path
  // identity derivation from a verified surface credential). The gate finds
  // it reachable on its own now -- exactly the intended lifecycle this
  // comment block describes for every entry here.
  //
  // C1 (surface identity) has since landed and is likewise reachable on its
  // own: server.ts -> collabIdentity.ts -> surfaceGate.ts ->
  // surfaceSecurity.ts, plus collab's surfaces.ts / surfaceStore.ts. The
  // connect path runs the §2.6 ordered resume gate, collab.db self-migrates
  // at first open, and authz.ts intersects operator authority with the
  // presenting surface (H-1).
  //
  // This still does NOT mean collab is fully wired: TORQCLAW_COLLAB_ENABLED
  // defaults off, and C2 (approval broker), C3 (channels) and C4 (task
  // rooms) remain future slices.
};

/** Only flag modules with real substance; tiny helpers are noise. */
const MIN_LINES = 150;

const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.next', '__pycache__', '.git', 'vendor',
  'coverage', '.turbo', 'scratchpad', 'graphify-out', 'graphify-product',
  'graphify-vendor', '.torq-console-publish', '.torq-console-worktree',
]);

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js|py)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/** Extract import targets from TS/JS source. */
function tsImports(src) {
  const out = [];
  const patterns = [
    /(?:^|\n)\s*import\s+[^'"]*from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+[^'"]*from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,   // dynamic import (failover.ts uses these)
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
  }
  return out;
}

/** Extract relative import targets from Python source. */
function pyImports(src) {
  const out = [];
  let m;
  const fromRe = /(?:^|\n)\s*from\s+\.(\w+)\s+import/g;
  while ((m = fromRe.exec(src)) !== null) out.push(m[1]);
  const impRe = /(?:^|\n)\s*from\s+\.\s+import\s+([^\n#]+)/g;
  while ((m = impRe.exec(src)) !== null) {
    for (const part of m[1].split(',')) {
      const nm = part.trim().split(/\s+as\s+/)[0].trim();
      if (nm) out.push(nm);
    }
  }
  const modRe = /(?:^|\n)\s*(?:import|from)\s+mcp_wrapper\.(\w+)/g;
  while ((m = modRe.exec(src)) !== null) out.push(m[1]);
  return out;
}

/** Map a workspace package name to the file that is its public surface. */
function packageEntry(pkgName) {
  const dir = pkgName.replace('@torqclaw/', 'packages/');
  for (const cand of ['src/index.ts', 'src/server.ts', 'src/engine.ts']) {
    const p = join(ROOT, dir, cand);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Next.js path aliases (apps/console/tsconfig.json: "@/*" -> "./src/*").
 *  Without this the console's entire component tree looks unreachable, which
 *  would make the gate cry wolf -- worse than having no gate. */
function resolveAlias(spec) {
  if (!spec.startsWith('@/')) return null;
  const base = join(ROOT, 'apps/console/src', spec.slice(2));
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

function resolveTs(spec, fromFile) {
  if (spec.startsWith('@torqclaw/')) return packageEntry(spec);
  if (spec.startsWith('@/')) return resolveAlias(spec);
  if (!spec.startsWith('.')) return null;                 // external dep
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ''));
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), `${base}.mjs`, `${base}.js`]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

function resolvePy(mod, fromFile) {
  const p = join(dirname(fromFile), `${mod}.py`);
  return existsSync(p) ? p : null;
}

// ── Walk the graph from every entry point ────────────────────────────────
const reachable = new Set();
const queue = [];

for (const ep of ENTRY_POINTS) {
  const full = join(ROOT, ep);
  if (existsSync(full)) queue.push(full);
  else console.warn(`[reachability] WARNING entry point missing: ${ep}`);
}

while (queue.length) {
  const file = queue.pop();
  const key = rel(file);
  if (reachable.has(key)) continue;
  reachable.add(key);

  let src;
  try { src = readFileSync(file, 'utf8'); } catch { continue; }

  const isPy = file.endsWith('.py');
  const specs = isPy ? pyImports(src) : tsImports(src);
  for (const spec of specs) {
    const target = isPy ? resolvePy(spec, file) : resolveTs(spec, file);
    if (target && !reachable.has(rel(target))) queue.push(target);
  }
}

// ── Find substantial modules that never got reached ──────────────────────
const SCAN_ROOTS = ['packages', 'apps/console/src', 'engines/hermes_kernel/mcp_wrapper'];
const orphans = [];

for (const root of SCAN_ROOTS) {
  const dir = join(ROOT, root);
  if (!existsSync(dir)) continue;
  for (const file of walk(dir)) {
    const key = rel(file);
    if (reachable.has(key)) continue;
    if (/[.\-](test|spec)\.[tj]sx?$/.test(key) || /(^|\/)tests?\//.test(key)) continue;
    if (/(^|\/)test_[^/]+\.py$/.test(key)) continue;

    let lines = 0;
    try { lines = readFileSync(file, 'utf8').split('\n').length; } catch { continue; }
    if (lines < MIN_LINES) continue;

    const declared = Object.keys(DORMANT).find((d) => key === d || key.startsWith(`${d}/`));
    orphans.push({ file: key, lines, dormant: declared ?? null, reason: declared ? DORMANT[declared] : null });
  }
}

const undeclared = orphans.filter((o) => !o.dormant);
const declared = orphans.filter((o) => o.dormant);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ reachable: reachable.size, undeclared, declared }, null, 2));
} else {
  console.log(`[reachability] ${reachable.size} modules reachable from ${ENTRY_POINTS.length} entry points\n`);
  if (declared.length) {
    const byGroup = new Map();
    for (const o of declared) {
      if (!byGroup.has(o.dormant)) byGroup.set(o.dormant, { lines: 0, files: 0 });
      const g = byGroup.get(o.dormant);
      g.lines += o.lines; g.files += 1;
    }
    console.log(`Dormant by declaration (${declared.length} files):`);
    for (const [name, g] of byGroup) {
      console.log(`  - ${name}  (${g.files} file(s), ${g.lines} lines)`);
      console.log(`      ${DORMANT[name]}`);
    }
    console.log('');
  }
  if (undeclared.length) {
    console.error(`FAIL: ${undeclared.length} substantial module(s) unreachable and NOT declared dormant:\n`);
    for (const o of undeclared.sort((a, b) => b.lines - a.lines)) {
      console.error(`  ${o.file}  (${o.lines} lines)`);
    }
    console.error(
      '\nA module no program can reach is not shipped, however well tested.\n' +
      'Either wire it to an entry point, or add it to DORMANT in ops/reachability.mjs\n' +
      'with the reason and the ticket that will wire it.',
    );
  } else {
    console.log('PASS: every substantial module is reachable or declared dormant.');
  }
}

process.exit(undeclared.length ? 1 : 0);
