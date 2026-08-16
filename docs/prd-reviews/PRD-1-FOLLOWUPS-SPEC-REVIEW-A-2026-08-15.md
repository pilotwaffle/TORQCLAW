# G1R REVIEW — PRD-1 Follow-ups Spec, Section A (C4-DEF-2 part 2, transform-layer anchoring)

**Role:** G1R — fresh, independent design reviewer, TORQCLAW governed chain. Not the spec's author (G1D), not the Builder, not G2A. No stake in the prior C4/Phase-C executor decisions.
**Model identity:** the session's `opus` alias resolves to **claude-opus-5** (stated as given by the harness; alias resolution is not independently verifiable from inside the session).
**Date:** 2026-08-15.
**Posture:** read-only everywhere. **This file is the single authorized write.** Verified absent before writing (`ls` → "No such file or directory"). No repo file, test, helper, config, or receipt was edited. No git state changed (only `rev-parse`, `ls-files`). No docker. Two throwaway probe scripts were written to the session scratchpad (outside the repo) and are not repo artifacts.
**Subject:** section **A** only. Sections B–E read as context; not adjudicated here.

**Inputs read in full:**
- `docs/prd-reviews/PRD-1-FOLLOWUPS-SPEC-2026-08-15.md` (the spec under review)
- `E:\tmp\torqclaw-prd1-phasec-exec-20260815Z\receipts\OPUS-RULING-P4-DELTA-20260815.md` (authority; D3.d, D3.e, N-1, N-2, D1.e, PART 4)
- Live code at worktree HEAD **`e60587c0c482b9c49938aae21006b61545aa5b28`**: `vitest.config.ts`, `tsconfig.base.json`, `tests/helpers/profile-conformance.ts`, `tests/profile-conformance-caller-audit.test.ts`, `packages/inference/tsconfig.json`, `packages/gateway/tsconfig.json`, `apps/console/tsconfig.json`, `.github/workflows/ci.yml`, `package.json`
- **Vite's own transform source**, decompiled dist: `node_modules/.pnpm/vite@5.4.21_.../vite/dist/node/chunks/dep-BK3b2jBa.js` lines **19165–19230** (`transformWithEsbuild`) and **19428–19449** (`loadTsconfigJsonForFile`). This is the authority for Q1 and Q2 and I read it rather than relying on documentation memory.
- Executed probes against the repo's own installed `esbuild@0.21.5` to observe actual emitted code per regime.

**Pinned toolchain (verified, not assumed):** `vite@5.4.21`, `vitest@2.1.9`, `esbuild@0.21.5`, `typescript@^5.5.0`.

---

## DISPOSITION IN ONE LINE

**APPROVE WITH CONDITIONS.** Option 1 is the correct mechanism and the fix is sound — but the spec contains **one factual defect (D-1: the stated rejection ground for Option 2 is wrong as written)** and **one blocking build defect the spec does not mention at all (D-2: adding `tests/tsconfig.json` breaks an existing, already-shipped assertion at `tests/profile-conformance-caller-audit.test.ts:68-69`, which asserts that exact file is absent).** D-2 will turn AC-A1 red on the first run if the Builder implements the spec as written. Both are cheap to cure; neither changes the chosen option. Seven conditions below.

---

## PART 1 — VERIFIED FACTS

Every load-bearing claim in section A re-derived independently this session.

| # | Claim (source) | Verdict | Evidence I derived myself |
|---|---|---|---|
| 1 | Worktree HEAD is `e60587c` | **CONFIRMED** | `git rev-parse HEAD` → `e60587c0c482b9c49938aae21006b61545aa5b28` |
| 2 | No `tsconfig.json` at repo root; none anywhere under `tests/` | **CONFIRMED** | `git ls-files \| grep tsconfig` and `find . -name "tsconfig*.json" -not -path "*/node_modules/*"` both return the **same 9 paths**: 8 package/app configs + `tsconfig.base.json`. No root config, nothing under `tests/`, and **no untracked tsconfig** either (the `find` and `git ls-files` sets are identical) |
| 3 | N-1: `packages/*/src` already transforms under base options via per-package configs extending the base | **CONFIRMED** | `packages/inference/tsconfig.json` and `packages/gateway/tsconfig.json` are byte-identical: `{"extends":"../../tsconfig.base.json","compilerOptions":{"outDir":"dist","rootDir":"src"},"include":["src"]}`. `apps/console/tsconfig.json` also extends the base but **overrides** `module:ESNext`, `moduleResolution:Bundler`, `jsx:preserve`, `isolatedModules:true` |
| 4 | N-2: `vitest.config.ts` pins `esbuild: { jsx: 'automatic' }` | **CONFIRMED** | `vitest.config.ts:48-50`, with the explanatory comment at lines 42-47. Also confirmed `test.include: ['tests/**/*.test.{ts,tsx}']`, `environment:'node'` |
| 5 | `tsconfig.base.json` is compilerOptions-only — no `references`/`include`/`files`/`extends` | **CONFIRMED** | Read in full: 14 lines, single top-level key `compilerOptions`, exactly the 10 options the task named |
| 6 | Spec's Option-2 rejection ground: "tsconfigRaw overrides discovered config for **everything** vite transforms, including `packages/*/src`" | **REFUTED as stated — see D-1** | Vite `dep-BK3b2jBa.js:19202-19205`: `const compilerOptions = { ...compilerOptionsForFile, ...tsconfigRaw?.compilerOptions }`. This is a **per-field shallow merge**, not a wholesale override. Fields the discovered config sets and `tsconfigRaw` does *not* set **survive**. A `tsconfigRaw` of `{compilerOptions:{target:'ES2022'}}` overrides only `target` |
| 7 | The transform ascent is real and reaches all of `tests/**` | **CONFIRMED** | `dep-BK3b2jBa.js:19193-19194` — for `loader==='ts'\|'tsx'`, vite calls `loadTsconfigJsonForFile(filename)` → tsconfck `parse()` with `ignoreNodeModules:true` (line 19428-19436). tsconfck ascends from the file; with no config under `tests/` and none at the repo root, it walks past the repo. The delta ruling's a-2 falsification (`TSConfckParseError … /tsconfig.node.json ENOENT` under `vite:esbuild`) is the live proof this ascent is load-bearing |
| 8 | Vite reads only a **whitelist** of tsconfig fields for transform | **CONFIRMED — and this is decisive for Q2** | `dep-BK3b2jBa.js:19179-19191`, verbatim, exactly 11 fields: `alwaysStrict`, `experimentalDecorators`, `importsNotUsedAsValues`, `jsx`, `jsxFactory`, `jsxFragmentFactory`, `jsxImportSource`, `preserveValueImports`, `target`, `useDefineForClassFields`, `verbatimModuleSyntax`. Line 19196-19200 copies **only** these from the loaded tsconfig |
| 9 | Therefore `module`, `moduleResolution`, `strict`, `noUncheckedIndexedAccess`, `esModuleInterop`, `skipLibCheck`, `declaration`, `sourceMap`, `forceConsistentCasingInFileNames` **never reach the transform** | **CONFIRMED** | None of the 9 appears in the whitelist at 19179-19191. **This retires the delta ruling's D1.e residual risk**, which named `moduleResolution: NodeNext` as "the axis most capable of changing behavior" — it is in fact inert at the transform layer. (D1.e was a correctly-hedged inference; I am upgrading it to a fact in the narrower transform scope.) |
| 10 | `jsx` is unreachable from any tsconfig when `esbuild.jsx` is set | **CONFIRMED** | `dep-BK3b2jBa.js:19209-19213`: `options.jsx && (compilerOptions.jsx = void 0)`. N-2 verified in source, not just by comment |
| 11 | Of the 11 whitelisted fields, `tsconfig.base.json` sets exactly **one**: `target: ES2022` | **CONFIRMED** | Cross-referencing fact 5 against fact 8. The base sets no `useDefineForClassFields`, no `verbatimModuleSyntax`, no `importsNotUsedAsValues`, no `experimentalDecorators`, no `alwaysStrict`, no `preserveValueImports`, no jsx fields |
| 12 | Vite forces `useDefineForClassFields = false` **only when both it and `target` are undefined** | **CONFIRMED** | `dep-BK3b2jBa.js:19206-19208`: `if (compilerOptions.useDefineForClassFields === void 0 && compilerOptions.target === void 0) compilerOptions.useDefineForClassFields = false;`. **Setting `target` alone silently flips uDCF to esbuild's target-derived default (true for ES2022).** This is the one real behavior axis and the spec does not mention it |
| 13 | Spec's characterization of the host regime (ES2020/bundler + uDCF + isolatedModules) | **CONFIRMED as to effect, imprecise as to mechanism** | Only `target:ES2020` and `useDefineForClassFields:true` survive the whitelist. `moduleResolution:bundler` and `isolatedModules` are filtered out. `jsx:react-jsx` is zeroed by fact 10. So the host's *effective* transform delta is `{target:ES2020, useDefineForClassFields:true}` |
| 14 | CI has no ancestor tsconfig | **CONFIRMED** | `.github/workflows/ci.yml`: `runs-on: ubuntu-latest`, `actions/checkout@v7` → `/home/runner/work/TORQCLAW/TORQCLAW`. Nothing above it carries a tsconfig. `pnpm test` at ci.yml line 64. CI's effective test-transform options today are therefore `{useDefineForClassFields:false}` (fact 12) |
| 15 | `tests/**` contains `.tsx` files (so jsx is genuinely in scope) | **CONFIRMED** | 7 files: `approvals-panel`, `cost-panel`, `receipts-panel`, `torq-terminal-{busy-suppression,live-affordances,preview,route-chip}`. All covered by the `esbuild.jsx` pin (fact 10) — unaffected either way |
| 16 | **`tests/profile-conformance-caller-audit.test.ts:68-69` asserts `tests/tsconfig.json` DOES NOT EXIST** | **CONFIRMED — this is D-2, the blocking defect** | Verbatim: `expect(() => resolveAuditTsconfig(join(REPO_ROOT, 'tests'))).toThrow(/in-tree tsconfig is absent/);`. `resolveAuditTsconfig` (helper lines 174-183) defaults `configFile='tsconfig.base.json'`, so this probes `tests/tsconfig.base.json` — **not** `tests/tsconfig.json`. See D-2 for the full analysis: the assertion survives the literal spec, but only by accident, and it is now actively misleading |
| 17 | Exactly one subclass exists in `tests/**` | **CONFIRMED** | `grep -rn "class [A-Za-z]* extends" tests/` → **one hit**: `tests/readiness.test.ts:89` `class FakeChild extends EventEmitter { exitCode: number \| null = null; unref = vi.fn(); }` |
| 18 | The uDCF flip is behaviorally observable in principle | **CONFIRMED by execution** | Probe: a subclass field shadowing a base-class **accessor** yields `set:child` under SET semantics vs `child` under DEFINE semantics. Real divergence, not theoretical |
| 19 | …but **not** for any class actually in `tests/**` | **CONFIRMED by execution** | Probe against `EventEmitter`: `FakeChild` with DEFINE semantics gives `exitCode → null`, `unref() → 'mock'`, `typeof fc.on === 'function'`, and `emit`/`on` round-trip correctly. `EventEmitter.prototype` defines no accessor for `exitCode` or `unref`, so there is nothing to shadow. `SeededPRNG`/`FakeClock`/`FifoLock`/`Thing` are all base classes — uDCF is a no-op for a class with no accessor-bearing ancestor |
| 20 | Under Option 1, host and proposed regimes emit **identical** code | **CONFIRMED by execution** | esbuild@0.21.5 `transformSync` on a `FakeChild`/`SeededPRNG` fixture: `{target:'ES2020',uDCF:true}` and `{target:'ES2022'}` produce byte-identical class output (`exitCode = null; unref = 2;` / `seed;`). **The change is a no-op on the host.** CI is the only regime that moves |
| 21 | Spec's claim "this converges the test tree onto the repo baseline" | **CONFIRMED** | Probe simulating vite's merge: `packages/*/src` → `{target:'ES2022'}`; `tests/**` under Option 1 → `{target:'ES2022'}`. Identical. Convergence is real |
| 22 | `pnpm test` = `vitest run`; no separate tests tsconfig consumed by typecheck | **CONFIRMED** | `package.json`; `pnpm typecheck` (ci.yml:53) is `turbo run typecheck` over packages, which do not include `tests/` |

**One claim REFUTED (fact 6), one blocking omission found (fact 16). Everything else CONFIRMED.**

---

## PART 2 — ANSWERS

### Q1 — Is Option 1 the right mechanism vs Option 2?

**YES, Option 1 is correct and I endorse it — but the spec's stated reason for rejecting Option 2 is factually wrong, and must be replaced before this text becomes the record.**

**The spec's ground is refuted.** Section A says tsconfigRaw "overrides discovered config for **everything** vite transforms, including `packages/*/src` files that today correctly resolve their own per-package configs." Vite's actual code (`dep-BK3b2jBa.js:19202-19205`) is:

```js
const compilerOptions = {
  ...compilerOptionsForFile,      // whitelisted fields from the DISCOVERED tsconfig
  ...tsconfigRaw?.compilerOptions // the pin — merged per-field, on top
};
```

That is a **shallow per-field merge**, not a replacement. `compilerOptionsForFile` is still computed (line 19193-19201) and still consulted; only the specific keys `tsconfigRaw` names are overridden. A pin of `{compilerOptions:{target:'ES2022'}}` would override `target` and nothing else. And since `tsconfig.base.json` sets exactly one whitelisted field — `target: ES2022` (fact 11) — a minimal Option 2 pin would leave `packages/*/src` **bit-for-bit unchanged**, because those files already resolve `target: ES2022` from their own configs. I verified this by simulating the merge: under Option 2, `packages/*/src` → `{"target":"ES2022"}`; under Option 1, `packages/*/src` → `{"target":"ES2022"}`. **Identical.** The spec's asserted harm does not occur.

So the rejection ground as written is wrong, and if the Builder or a later reader relies on it they will hold a false model of vite. It must be corrected (**C-1**).

**Option 1 nonetheless wins, on four grounds the spec did not state.** I re-decided rather than rubber-stamping, and the conclusion holds:

1. **Structural vs. behavioral guarantee.** Option 1 makes the ascent *terminate inside the repository* — tsconfck finds `tests/tsconfig.json` and stops. Option 2 leaves the ascent running and merely overwrites some of its output. Under Option 2 the drive-root scaffold is **still parsed** on every host run, so the a-2 failure mode (a *dangling reference* in an ancestor config raising `TSConfckParseError` before any option merge happens) remains live. That error is thrown at line 19441-19448 and propagates — it kills collection regardless of what `tsconfigRaw` says. **Option 2 does not close the proven failure mode; Option 1 does.** This is the strongest ground and it is the one the delta ruling D3.e actually asked for ("so vite/tsconfck cannot ascend past the repository").
2. **Non-whitelisted-field leakage.** Option 2 would need to enumerate every whitelisted field the ancestor might set, forever. An ancestor setting `experimentalDecorators` or `verbatimModuleSyntax` would still leak through a `target`-only pin. Option 1 is immune by construction — the ancestor is never reached.
3. **Blast radius.** Option 2 touches a config that governs every transformed file in the repo. Option 1 touches only files under `tests/`, by nearest-wins. Smallest correct change (CLAUDE.md §4 change-scoping) favors Option 1.
4. **Declarative and greppable.** A `tests/tsconfig.json` is discoverable by the same `find`/`git ls-files` inventory that proves fact 2. A `tsconfigRaw` literal buried in `vitest.config.ts` is not.

**Net: right answer, wrong reason.** Fix the reason.

---

### Q2 — Is the expected behavior shift correctly characterized?

**Partially. The direction is right and the conclusion is right, but the mechanism is stated at the wrong level of abstraction, and the one axis that actually moves is not named.**

The spec says `tests/**` moves to "the repo's own ES2022/NodeNext everywhere." That over-describes the change. Vite passes esbuild only the **11 whitelisted fields** (fact 8). Walking the task's list of `tsconfig.base.json` options against that whitelist:

| Option in `tsconfig.base.json` | Does esbuild consume it for **transform**? | Assessment |
|---|---|---|
| `target: ES2022` | **YES** — whitelisted | **The only axis that moves.** Sets syntax-lowering level, and — critically — suppresses vite's `useDefineForClassFields=false` fallback (fact 12) |
| `module: NodeNext` | **NO** — not whitelisted | Inert. Vitest/vite own module handling; not read from tsconfig for transform |
| `moduleResolution: NodeNext` | **NO** — not whitelisted | Inert. **This retires the delta ruling's D1.e concern**, which named this as the highest-risk axis. It cannot reach the transform at all |
| `strict` | **NO** | Inert (type-check only; esbuild does not type-check) |
| `noUncheckedIndexedAccess` | **NO** | Inert (type-check only) |
| `esModuleInterop` | **NO** | Inert at the transform layer in this path |
| `skipLibCheck` | **NO** | Inert (type-check only) |
| `declaration` | **NO** | Inert (emit-only; vite does not emit .d.ts here) |
| `sourceMap` | **NO** | Inert — vite hardcodes `sourcemap: true` at line 19221 |
| `forceConsistentCasingInFileNames` | **NO** | Inert (resolution/type-check only) |
| `useDefineForClassFields` | **not set by base** — but its *default* changes | **The real risk.** See below |
| `verbatimModuleSyntax` | **not set by base** | Absent → no effect. Would matter if added later (**C-6**) |
| `importsNotUsedAsValues` | **not set by base** | Absent → no effect |
| `jsx` | **not set by base**, and zeroed anyway | Unreachable (fact 10). Spec is right that jsx is unaffected — and I verified the mechanism in source, not just the comment |

**The one axis that actually moves — and the spec does not name it.** Vite forces `useDefineForClassFields = false` **only when both uDCF and `target` are undefined** (fact 12). Today in CI, `tests/**` discovers no config → both undefined → **uDCF is forced `false`** (SET semantics). Under Option 1, `tests/**` discovers `target: ES2022` → the guard no longer fires → **uDCF falls through to esbuild's target-derived default, which is `true` for ES2022** (DEFINE semantics). So the real, precise shift is:

- **Host:** `{target:ES2020, uDCF:true}` → `{target:ES2022, uDCF:true(implied)}`. Class-field emit **byte-identical** (verified, fact 20). Effectively a no-op.
- **CI:** `{uDCF:false}` → `{target:ES2022, uDCF:true(implied)}`. **Class-field semantics change from SET to DEFINE.**

**Is that dangerous here? No — and I verified it rather than reasoning about it.** DEFINE-vs-SET only diverges observably when a subclass field shadows an accessor on an ancestor prototype; my probe reproduced exactly that divergence (`set:child` vs `child`, fact 18). But `tests/**` contains **exactly one** subclass: `FakeChild extends EventEmitter` (fact 17), and `EventEmitter.prototype` defines no accessor for `exitCode` or `unref`. Executing the DEFINE-semantics version confirmed correct behavior on all four observables (fact 19). Every other class in `tests/**` (`SeededPRNG`, `FakeClock`, `FifoLock`, `Thing`) is a base class, where uDCF is a no-op.

Second-order note: uDCF `true` also emits bare `seed;` declarations for declared-but-uninitialized fields (fact 20), which under DEFINE semantics initialize to `undefined` **before** the constructor body runs. For `SeededPRNG`/`FakeClock` the constructor assigns immediately after, so the transient `undefined` is unobservable. Safe.

**Verdict on Q2:** the conclusion ("this is convergence, not perturbation") is **correct and now proven rather than inferred** — but the spec must state the actual mechanism (`target` is the only field consumed; the consequence is a uDCF default flip in CI only), because a reader who believes "NodeNext module resolution now applies to tests" holds a false model and will mis-triage the next transform bug. That is **C-2**.

---

### Q3 — Is the regression-test design sufficient?

**Nearly. Three of the four assertions I want are in the spec; I am adding two, and one of them is mandatory because the spec's plan collides with existing shipped code.**

The proposed assertions — file exists, `extends` resolves to the in-tree base, no `references` key — are all well-chosen. `extends`-resolves-in-tree is the right anchor (it is what makes the file load-bearing rather than decorative), and no-`references` is directly earned by the a-2 falsification. Keep all three.

**On the shadowing question you raised: nearest-wins does NOT make it moot, but the risk is upward, not downward.** tsconfck ascends from the *file*, so a config in `tests/collab/` or `tests/helpers/` would shadow `tests/tsconfig.json` for files in those directories. Fact 2 confirms none exists today and none is untracked. But the assertion the spec proposes only proves `tests/tsconfig.json` exists — it would not catch someone later adding `tests/collab/tsconfig.json`. Since `tests/` has 6 subdirectories (`collab`, `failover`, `failover/fixtures`, `fixtures`, `helpers`, `resilience`), I want the negative asserted: **no `tsconfig*.json` anywhere under `tests/` except `tests/tsconfig.json` itself** (**C-4**). That is the assertion that actually guarantees uniform transform conditions across the test tree, and it is 3 lines.

Asserting "no tsconfig between `tests/` and the repo root" is **moot** — that region is just the repo root, and the whole point of the fix is that the ascent stops at `tests/` before reaching it. Don't add it. But **do** assert the repo root still has no `tsconfig.json` if you want the ascent-termination story complete; I regard that as optional and would not block on it.

**D-2 — THE BLOCKING DEFECT. The spec's plan collides with an already-shipped assertion, and the spec does not mention it.**

`tests/profile-conformance-caller-audit.test.ts:68-69`, live at `e60587c`:

```ts
expect(() => resolveAuditTsconfig(join(REPO_ROOT, 'tests')))
  .toThrow(/in-tree tsconfig is absent/);
```

This is the part-1 fix's own regression test, and it asserts that a tsconfig lookup rooted at `tests/` **fails because no config is there**. The spec proposes to put a config there.

**It happens not to break — but only by accident, and the accident is fragile.** `resolveAuditTsconfig` (helper:174) has signature `(root, configFile = 'tsconfig.base.json')`. Called as `resolveAuditTsconfig(join(REPO_ROOT,'tests'))` it probes `tests/tsconfig.base.**base**.json` — i.e. `tests/tsconfig.base.json`, **not** `tests/tsconfig.json`. So creating `tests/tsconfig.json` leaves the throw intact and the test green.

That is a coincidence of the default parameter, not a designed invariant, and it leaves the suite in a genuinely bad state: **a test that reads as "there is no tsconfig under tests/" while a `tests/tsconfig.json` sits next to it.** The next reader — human or model — will either (a) believe no config exists under `tests/` and mis-diagnose a transform issue, or (b) "fix" the now-confusing assertion and delete the guard. Both are real costs, and this is precisely the *unenforced-claim / misleading-assertion* pattern this repo has been bitten by before.

**Cure (C-3, mandatory):** in the same commit, update that assertion so its meaning is explicit and correct. Either pass the filename explicitly —

```ts
expect(() => resolveAuditTsconfig(join(REPO_ROOT, 'tests'), 'tsconfig.base.json'))
  .toThrow(/in-tree tsconfig is absent/);
```

— or point the negative probe at a directory that will remain genuinely config-free (e.g. `tests/fixtures`). I prefer the explicit-filename form: it preserves the original intent (the *base* config is not under `tests/`), makes the coincidence into a stated contract, and costs one argument. **Do not delete the assertion.**

I want to be precise about severity: **this is not a test that will fail.** It is a test that will silently become misleading. I am still treating it as blocking, because shipping a knowingly-misleading assertion alongside the artifact that makes it misleading is worse than the transform defect being fixed.

---

### Q4 — Are the acceptance criteria right?

**AC-A1 through AC-A4 are well-formed and I accept all four.** Specifically:

- **AC-A1** correctly recognizes the host is the regime *with* the scaffold on the ascent, and pre-authorizes the `tests/collab/fanout-unit.test.ts` C1 flake isolation rerun — consistent with the known load-sensitivity. Good.
- **AC-A2**'s "push only after AC-A1" ordering is right, and CI is the genuinely novel regime (fact 20: the host is a no-op; **CI is where the uDCF flip actually lands**). AC-A2 is therefore the *primary* proof, not the secondary one — worth stating.
- **AC-A3**'s temporary-mutation proof is the correct discipline (spec-presence ≠ execution, per the section-B lesson) and I endorse requiring restore-before-commit.
- **AC-A4** pinning conformance at 37/37 with unchanged S-1 inventory is the right invariant, and it is well-founded: the AC-10A inventory runs through `ts.createProgram` with explicit `rootNames` and options parsed from `tsconfig.base.json` (helper:191-193), a path entirely independent of vite's transform. Adding `tests/tsconfig.json` cannot reach it.

**Two missing ACs, both cheap:**

- **AC-A5 (add, mandatory — C-5):** `pnpm typecheck` and `pnpm build` still pass. `tests/tsconfig.json` with no `include`/`files` defaults to including **every file under `tests/`** for any tool that consumes it as a project. Nothing in the current pipeline does (`turbo run typecheck` covers packages only, fact 22), so I expect this to be a no-op — but "I expect" is not "verified," and a new tsconfig that silently defines a 100+-file project is exactly the kind of thing that surfaces two weeks later in an IDE or a future `tsc -b`. One command each; prove it.
- **AC-A6 (add, mandatory — C-4 companion):** the negative-space assertion from Q3 — no `tsconfig*.json` under `tests/` other than `tests/tsconfig.json` — is green.

**One AC I considered and rejected:** requiring a byte-diff of transform output before/after. Disproportionate — fact 20 already establishes host-identity by direct execution, and AC-A1/AC-A2 green across both regimes is the stronger empirical statement.

---

### Q5 — Conditions on the build

Enumerated as **C-1 … C-7** in the verdict below. In summary: correct the Option-2 rejection ground (C-1) and the behavior-shift description (C-2) in the spec text; repair the colliding assertion (C-3); add the two assertions (C-4) and the two ACs (C-5, plus C-4's AC-A6); hold the file to byte-exactness (C-6); and fix the verification order (C-7).

---

## VERDICT — **APPROVE_WITH_CONDITIONS**

Option 1 is the right mechanism, the fix shape satisfies delta-ruling D3.e, the acceptance criteria are sound, and the risk is genuinely low — lower than the spec itself argues, and now proven by execution rather than inferred. Two defects must be cured first. Neither changes the design.

### Conditions

**C-1 (spec text; blocking as a record defect).** Replace section A's Option-2 rejection ground. The claim "tsconfigRaw overrides discovered config for **everything** vite transforms, including `packages/*/src`" is **false**: vite merges per-field (`dep-BK3b2jBa.js:19202-19205`), and a `target`-only pin would leave `packages/*/src` unchanged. Substitute the correct and stronger ground: **Option 2 leaves the ancestor ascent live, so it does not close the proven a-2 failure mode (a dangling `references` in an ancestor raises `TSConfckParseError` before any option merge and kills collection); Option 1 terminates the ascent inside the repository, which is what D3.e requires.** Secondary grounds: non-whitelisted-field leakage, blast radius, greppability.

**C-2 (spec text; blocking as a record defect).** Restate the behavior shift at the correct level. Vite passes esbuild only 11 whitelisted fields (`dep-BK3b2jBa.js:19179-19191`); of `tsconfig.base.json`'s ten options, **only `target: ES2022` is consumed** — `module`/`moduleResolution`/`strict`/`noUncheckedIndexedAccess`/`esModuleInterop`/`skipLibCheck`/`declaration`/`sourceMap`/`forceConsistentCasingInFileNames` are all inert at the transform layer. The single real consequence is that supplying `target` suppresses vite's `useDefineForClassFields=false` fallback (line 19206-19208), so **CI's class-field emit moves from SET to DEFINE semantics** (the host already used DEFINE and is byte-unchanged). Record that the only subclass in `tests/**` is `FakeChild extends EventEmitter`, which has no accessor to shadow, and that this was verified by executing the DEFINE-semantics emit. Also record that this **retires delta-ruling D1.e's `moduleResolution: NodeNext` residual risk**, which cannot reach the transform.

**C-3 (code; BLOCKING).** In the same commit that adds `tests/tsconfig.json`, repair `tests/profile-conformance-caller-audit.test.ts:68-69` so it does not become a silently-misleading assertion. Preferred form: pass the config filename explicitly — `resolveAuditTsconfig(join(REPO_ROOT,'tests'), 'tsconfig.base.json')` — preserving the original intent and making the default-parameter coincidence into a stated contract. **Do not delete the assertion**, and do not weaken it to accommodate the new file.

**C-4 (code).** Add to the regression test, alongside the spec's three assertions: **no `tsconfig*.json` exists anywhere under `tests/` other than `tests/tsconfig.json` itself.** Nearest-wins makes a config in `tests/collab/` or `tests/helpers/` a real shadowing hazard; this is the assertion that guarantees uniform transform conditions across the test tree. Do **not** add an assertion about configs between `tests/` and the repo root — that region is empty by construction and the assertion would be noise.

**C-5 (acceptance).** Add **AC-A5**: `pnpm typecheck` and `pnpm build` green. A tsconfig with no `include`/`files` defines a project over all of `tests/`; I expect no consumer today, but that must be verified, not assumed. Add **AC-A6**: C-4's negative-space assertion green.

**C-6 (artifact).** `tests/tsconfig.json` must be exactly `{ "extends": "../tsconfig.base.json" }` and nothing else — **no `references`** (a-2's proven killer), **no `include`/`files`** (avoids defining a project), **no `compilerOptions`** (any addition would be a second, undeclared transform regime for tests). Written with `Write`, never a shell replacement pipeline (CLAUDE.md §4). If a future need arises to set a whitelisted field (`verbatimModuleSyntax`, `experimentalDecorators`, `useDefineForClassFields`), that is a **new review**, not an in-flight edit.

**C-7 (verification order).** Run in this order, and stop on the first failure rather than proceeding: (1) AC-A3 mutation proof **first**, while the tree is small and the mutation trivially reversible — restore and confirm `git status --porcelain` clean before continuing; (2) AC-A4 conformance 37/37; (3) AC-A5 typecheck + build; (4) AC-A1 host full suite, with the `fanout-unit` C1 flake isolated before being called a regression; (5) operator approval; (6) push; (7) AC-A2 CI. **Commit separation:** the `tests/tsconfig.json` + regression test + C-3 assertion repair are one coherent commit (they are mutually dependent); the C-1/C-2 spec-text corrections may ride along or go separately, but must not be omitted.

---

## THE ONE FACT THAT WOULD FLIP THIS

**If any class in `tests/**` — or any class in a `packages/*/src` module that a test constructs and then observes field-assignment side effects on — declares a field that shadows an accessor (`get`/`set`) defined on an ancestor prototype, then the CI-side `useDefineForClassFields` flip from `false` to `true` changes runtime behavior and this approval is wrong.** I checked `tests/**` exhaustively: exactly one subclass, `FakeChild extends EventEmitter`, with no accessor to shadow, verified by executing the DEFINE-semantics emit. I did **not** exhaustively audit `packages/*/src` for accessor-shadowing — but I do not need to, because those files already transform under `target: ES2022` today (fact 3/fact 21) and are unchanged by this fix. The exposure is confined to code that (a) lives under `tests/`, (b) is a subclass, and (c) shadows an accessor. Only condition (b) is met, once, and (c) fails. **If AC-A2 (CI) goes red on a class-related assertion, this is the first place to look** — not the tsconfig itself.

Secondarily: if `pnpm typecheck` or `pnpm build` turns out to consume `tests/tsconfig.json` as a project (AC-A5 red), the no-`include` choice becomes wrong and the file needs `"include": []` or an explicit scope — which is a **return to review**, not an in-flight fix, since `include` interacts with the a-2 lesson.

---

## CONFIDENCE

**Facts** (read or executed by me this session): vite 5.4.21's `transformWithEsbuild` whitelist of 11 fields and its per-field merge order; the `useDefineForClassFields` fallback guard and its exact condition; the `options.jsx` zeroing; `loadTsconfigJsonForFile`'s tsconfck ascent with `ignoreNodeModules:true`; `tsconfig.base.json`'s full content and single-key structure; the complete 9-entry tsconfig inventory with tracked and untracked sets identical; the three per-package config bodies; `vitest.config.ts`'s jsx pin and test include glob; the caller-audit test's four assertions including the `tests`-absence probe at :68-69; `resolveAuditTsconfig`'s default parameter; the 7 `.tsx` test files; the single `extends` subclass in `tests/`; CI's ubuntu runner and `pnpm test` step; the pinned toolchain versions; and the executed esbuild emit comparison across three regimes plus the DEFINE/SET divergence and `FakeChild` behavior probes.

**Inferences:** that no consumer of `tests/tsconfig.json` as a *project* exists today (strong — `turbo run typecheck` covers packages only — but **not executed**, which is exactly why AC-A5 is a condition rather than an assertion); that the full suite will be green under the new regime (strong, resting on the whitelist analysis plus the executed class-field probes, but **not proven** until AC-A1/AC-A2 run — this is what the ACs are for).

**Judgments:** electing Option 1 on grounds different from the spec's; treating the misleading-assertion collision (D-2) as blocking despite it not failing; declining the root-ascent assertion as moot while requiring the `tests/`-subtree negative; requiring AC-A5; and ordering AC-A3 first in the verification sequence.

**Nothing in this review weakens any gate, test, or acceptance criterion.** C-3 repairs an assertion's precision without reducing its strength; C-4, C-5, and AC-A6 add coverage. The chosen mechanism is unchanged from the spec. The design is approved; the record and two lines of test code need correction first.
