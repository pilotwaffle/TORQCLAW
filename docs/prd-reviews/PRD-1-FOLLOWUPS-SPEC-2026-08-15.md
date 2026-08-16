# PRD-1 Follow-ups — Implementation Spec (post-ship)

2026-08-15, authored by G1D after the PRD-1 Profile Conformance Suite shipped
(merge `069f556b` + hotfix `e60587c`, master CI green). Covers everything left open
at ship time. Authority sources: `OPUS-RULING-P4-TSCONFIG-20260815.md` (R4),
`OPUS-RULING-P4-DELTA-20260815.md` (D3.e), `V3-VERIFY-BASE-DEFECT-RECEIPT.md`,
`TRACKED-OBLIGATION-F1` — all in the Phase C evidence root
`E:\tmp\torqclaw-prd1-phasec-exec-20260815Z\` (or the orchestrator-evidence root for F1).

---

## A. C4-DEF-2 part 2 — transform-layer anchoring (the one real build item)

**Problem (proven).** vite/tsconfck ascends from the repo root when picking esbuild
transform options for any test file with no nearer tsconfig. The C4 helper fix
(`e60587c`) closed the *compiler-API* ascent only. The *transform* ascent remains:
on the dev host, `tests/**` transforms under the drive-root Vite scaffold pair
(`E:\tsconfig.json` + `E:\tsconfig.node.json`); in CI and sealed containers it falls
back to vitest defaults. Two regimes, neither declared in-repo.

**Fix (delta ruling D3.e, design choice made here).**

- **Chosen: Option 1 — add `tests/tsconfig.json`** containing exactly:
  `{ "extends": "../tsconfig.base.json" }` — no `references`, no `include`/`files`
  (the a-2 falsification proved dangling `references` break suite collection in
  hermetic environments; keep the file reference-free by construction).
- **Rejected: Option 2 — `esbuild.tsconfigRaw` pin in `vitest.config.ts`.** (Ground
  corrected per review 2026-08-15: vite merges tsconfigRaw **per-field** over the
  discovered config — `{...compilerOptionsForFile, ...tsconfigRaw?.compilerOptions}` —
  so a target-only pin would leave `packages/*/src` bit-identical; the original
  wholesale-override claim was wrong.) The correct and stronger rejection ground:
  **Option 2 leaves the ancestor ascent live** and therefore does NOT close the proven
  a-2 failure mode — a dangling `references` in an ancestor tsconfig raises
  `TSConfckParseError` during collection **before** any option merge happens. Option 1
  terminates the ascent inside the repository, which is what delta-ruling D3.e requires.
- **Regression test** (extend `tests/profile-conformance-caller-audit.test.ts` or a
  small new spec): assert `tests/tsconfig.json` exists, `extends` resolves to the
  in-tree `tsconfig.base.json`, and the parsed JSON has **no `references` key**.
  Presence of this file is the structural guarantee tsconfck cannot ascend past the
  repository for the test tree; the assertion makes its removal a loud failure.

**Expected behavior shift, stated at the correct level (per review 2026-08-15, from
vite 5.4.21's actual transform source).** Vite passes esbuild only 11 whitelisted
tsconfig fields; of `tsconfig.base.json`'s ten options **only `target: ES2022` is
consumed** — module, moduleResolution, strict, noUncheckedIndexedAccess,
esModuleInterop, skipLibCheck, declaration, sourceMap, and
forceConsistentCasingInFileNames are all inert at the transform layer. This retires
delta-ruling D1.e's `moduleResolution: NodeNext` residual risk: it cannot reach the
transform. The single real consequence: supplying `target` suppresses vite's
`useDefineForClassFields=false` fallback, moving **CI's** class-field emit from SET to
DEFINE semantics (the host already used DEFINE via the scaffold and is byte-unchanged).
Reviewed as harmless here: `tests/**` contains exactly one subclass
(`FakeChild extends EventEmitter`) with no accessor to shadow. `jsx` stays pinned by
`vitest.config.ts` (`esbuild: { jsx: 'automatic' }`) and is unaffected.

**Acceptance criteria.**
1. AC-A1: full TS suite green **on the host** (scaffold pair present on the ascent) —
   `pnpm test`, with the known load-sensitive `tests/collab/fanout-unit.test.ts` C1
   probe re-run isolated before being called a regression.
2. AC-A2: full TS suite green **in CI** (no ancestor config exists) — the hermetic
   regime proof. Push only after AC-A1.
3. AC-A3: the regression test fails if `tests/tsconfig.json` is deleted or gains a
   `references` key (verify by temporary local mutation, restore before commit).
4. AC-A4: the four conformance files stay 37/37 with unchanged inventory values
   (S-1 pinned expectations).

**Gate path (governed chain).** Suite-wide transform change = Standard-tier with
behavior change → fresh independent Opus (G1R role) reviews this spec section before
build; Builder implements; the dual-regime green (AC-A1 + AC-A2) is the verification;
operator approves the push. Estimated size: 1 new 1-line file + ~15-line test +
two full-suite runs.

## B. Verifier v4 (spec exists; build is dormant until needed)

Per `V3-VERIFY-BASE-DEFECT-RECEIPT.md`: v3's `need()` path-resolves numeric flags →
`verify-base` dies on all inputs. v4 = new file (never an in-place edit of the
byte-frozen v3, sha `786e2c34…`): typed `needNum()` for numeric options, carries the
defect receipt in its header, and its acceptance gate must **execute every shipped
mode** (the conformance-audit lesson: spec-presence in a diff is not execution).
**Trigger:** only when a base-arm verification is next wanted. No standing priority.

## C. F1 — auditor residue check (spec exists; dormant until auditor revision)

Per `TRACKED-OBLIGATION-F1`: the next auditor revision must adopt the path-anchored
*rejecting* residue check. Binds at the next auditor change, not before.

## D. Operator decision register (decisions, not builds — ~10 minutes of rulings)

| ID | Decision | Where it lives |
|---|---|---|
| R-3 | Retroactive acknowledgment of the offline-toolchain binding | `manifest\OFFLINE-TOOLCHAIN-BINDING-MANIFEST.{md,json}` `r3Disposition: PENDING_OPERATOR` |
| KBN-1 | Adopt `PYTHONHASHSEED=0` as a standing mandate for every future gyp invocation | tracked in orchestrator-evidence; text ready |
| Held container | Disposition of `b22ce32d…` given the proven engine-restart /bin/true behavior | `receipts\held-container-state-anomaly-20260815.txt` |
| Cleanup | Keep/delete enumeration for Phase C worktrees, containers, volumes + the landing worktree | I produce the full inventory on request; nothing deleted until each line is marked |

## E. Housekeeping (2 minutes, mechanical)

- `STATE.md` truth-up in the main tree ("not merged" → shipped @ `e60587c`) — blocked
  while this session is worktree-isolated; done immediately on worktree exit, or a
  one-line operator edit.
- Local `master` ref lags at `9324cbc` — held by worktree `E:\tmp\torqclaw-auth005-merge`;
  `git -C E:\tmp\torqclaw-auth005-merge pull` (or remove that worktree) fixes it.
  `origin/master` is authoritative meanwhile.

## Sequencing recommendation

1. **A** on your word (the hermeticity completion — the only item with real code).
2. **E** opportunistically (next worktree exit).
3. **D** whenever you have ten minutes — none blocks anything.
4. **B**/**C** stay dormant on their named triggers.
