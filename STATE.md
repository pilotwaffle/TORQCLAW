# TORQCLAW — Program STATE

Single-file program state, updated only after meaningful progress with tests + independent verifier passing. Detailed history lives in `docs/prd-reviews/*` and the per-project memory index.

_Last updated: 2026-08-13._

## LOCAL ONLY: AUTH-005 Phase 1 downgrade-fence/foundation — completed, verified, SOL G2A approved

**Status as of 2026-08-13:** AUTH-005 Phase 1 is **COMPLETED + VERIFIED + SOL G2A APPROVED** on local branch `codex/auth-v2-005` only. It is **unmerged, unpushed, and inactive**. Baseline: `c2850f5ac755444d42b930034de536938f31ae22`.

**Controlling invariant:** every accepted V2 connection has exactly one immutable, server-produced `AuthenticatedCaller`; wire fields may only assert equality and can never create, select, widen, or transfer authority.

Main outcome: the downgrade-fence/foundation landed without V2 activation. V2 definitions are gateway-local and inert; current runtime remains V1 marker only. No V2_FINAL/cutover/credential/certificate/deploy work was authorized.

Final evidence recorded by fresh verifier/adjudicator:

- Focused Phase 1 suite plus mutants: **81/81**.
- Full suite: **1823/1823** from verifier.
- Contracts: **8** passing.
- Reachability: **111** passing.
- Gateway/root build and typecheck passed.
- Protected paths had no deletions.

Actual thread/model roles: Terra G1D `auth_prd_c2850_g1d`; fresh Sol G1R `auth005_phase1_g1r_fresh` and `schema_collision`; Luna Builder `auth005_luna_qualification`; final fresh GPT-5.5 verifier `auth005_phase1_evidence_r8` returned READY_FOR_G2A; final fresh Sol G2A `auth005_phase1_g2a_r5` returned APPROVE. Earlier G2A rounds rejected real defects, and those defects were corrected before approval.

Remaining operator actions: review the local commit; merge/push separately if approved; later Phase 2+ work needs a new bounded sequence. V2_FINAL, cutover, credentials, certificate work, and deploy remain unauthorized. Phase 4 worktree cleanup is unsafe until submodule metadata and unique-file classification are complete. PR #45 and PR #68 were not merged or acted on here and are out of scope for this change.

## LOCAL ONLY: AUTH-005 Phase 2A offline identity reconciliation — completed, verified, SOL G2A approved

**Status as of 2026-08-13:** AUTH-005 Phase 2A is **COMPLETED + VERIFIED + SOL G2A APPROVED** on local branch `codex/auth-v2-005` only. It is **unmerged, unpushed, inert, and not shipped**. Phase 1 commit `37667e9` and the Phase 2A Gate 1 design commit `29f435d` remain based on public baseline `c2850f5ac755444d42b930034de536938f31ae22`.

**Controlling invariant:** Phase 2A may only perform explicit offline, strictly additive, exact-schema migrations and write non-authoritative reconciliation diagnostics. It cannot create an `AuthenticatedCaller`, bind or resume a session, grant authority, activate V2, repair ambiguous state, or enter the live gateway import graph.

Main outcome: exact c2850f5 collab and gateway foundations are validated before and again inside the relevant `BEGIN IMMEDIATE` intervals; executable ordered migration manifests are independently golden-pinned; partial, malformed, downgrade, catalog, ledger, TEMP, revision-affinity, and cross-database recovery cases fail closed. The offline CLI closes the collab handle before opening the state transaction and exposes only an opt-in, bounded, identifier-free stdout trace. Reconciliation output is explicitly non-authoritative.

Final evidence from the fresh independent verifier and fresh isolated G2A:

- Focused Phase 1 + Phase 2A + mutant + reachability gate: **127/127** from the final verifier; prior correction gate **124/124**.
- Full suite: **1861/1861** on the verifier's longer retry. Sol G2A observed **1860/1861** because the known load-sensitive failover timeout exceeded 30 seconds; its isolated rerun passed **7/7**.
- Workspace typecheck: **14/14** tasks; contracts: **8** schemas; reachability: **111** live modules plus exactly **3** reviewed dormant Phase 2A modules; Graphify fitness passed.
- Literal gateway program golden independently recomputed to **2050 UTF-8 bytes / 4100 hex characters**, SHA-256 `b0fc3b85b8851a1f3f79615f0270e056c4fdd3992e1d89973250dbf9506b0028`.
- Protected server, session, authorization, C1/C2, Phase 4, Hermes, contracts/generated, and console paths had zero Phase 2A changes.

Actual model/thread roles: Terra G1D/orchestrator `/root`; Sol G1R `/root/auth005_phase2a_g1r`; Luna correction Builders `/root/auth005_phase2a_builder_r2`, `/root/auth005_phase2a_builder_r4`, and `/root/auth005_phase2a_builder_r5`; final fresh GPT-5.5 verifier `/root/auth005_phase2a_verifier_final6` returned `READY_FOR_G2A`; final fresh isolated Sol G2A `/root/auth005_phase2a_g2a_final5` returned `APPROVE`. Earlier isolated G2A rounds rejected incomplete foundation validation, self-derived evidence, missing migration matrices, unsafe trace-file authority, and fixture-exclusion precedence; each was corrected and freshly re-verified before final approval.

Accepted limitations: the named-mutant gate is the repository's executable source-sentinel approach rather than an external mutation framework; `--offline` is an explicit operator assertion rather than proof that production processes are stopped; Phase 2A modules remain intentionally dormant until a later authorized cutover phase.

Remaining operator actions: review the local Phase 2A commit, then separately authorize any rebase/merge or push. Phase 2B+, live caller/session wiring, browser authentication, credential and certificate provisioning, cutover, real-database operational runs, deployment, and release remain unauthorized.

## SHIPPED: GS-COORD — coordinated governed skill activation

**Status: G2A-APPROVED (round 3), MERGED (`c824bcd`, `--no-ff`) and PUSHED to
`origin/master` on operator authorization 2026-08-09.** Merged tree verified at
**303 passed / 1 skipped** with `pnpm reachability` PASS before the push.

> **Pre-push deletion audit — a real hazard was caught.** `gs-coord-work` branched
> from `da688c0`, which predates the docs commits on master. Merging it unrebased
> would have **deleted 4,769 lines**, including `tests/reachability.test.ts` and the
> collab gateway harness. Rebased first (`eaa6632` → `57a65d9`), after which the
> merge deleted **zero files**: 11 touched (10 modified, 1 added), vendor and the
> submodule pin untouched, 0 deletions versus `origin/master`.
>
> Three test functions showed as removed lines. They are the four re-specified
> tests G1R cleared in round 1, **renamed to invert their assertions toward the
> frozen ruling** (reconcile "recovers"/"resumes" → "discards"). The audit-capacity
> guard was independently re-verified as still pinned by
> `pytest.raises(SkillAuditCapacityError)`, and the replacement asserts strictly
> more than the test it replaced. Rising test counts would have masked a genuine
> loss here — check names, not totals.

- 10 modified + `test_activation_coordinator_wiring.py` (new, 917). Nothing outside
  `engines/hermes_kernel/`; `vendor/` and the submodule pin untouched.
- Python suite: **303 passed, 1 skipped** on merged master (302/2 in the worktree,
  where one environment-conditional test skips; master baseline was 277/1).
- **Three adversarial rounds.** G1R round 1 REJECTED (3 blockers + 2 gaps beyond the nine
  original defects); G2A round 2 REJECTED (3 blockers); G2A round 3 **APPROVED**. Every
  verdict was reproduced independently by the orchestrator before routing onward — twice
  the Builder's sabotage table asserted coverage that deletion disproved.
- **Every control closed by deletion probe**, not by assertion. Six gates enforced as hard
  aborts: exactly-once mutation, green ≥302 baseline, nonzero exit after deletion, the
  failing test named, trap-based restore on abort, byte-exact restore asserted by md5 plus
  a final suite equal to baseline. Probe harness distinguishes CLOSED / OPEN / **INVALID**
  (red without a named test) so a structural break cannot bank as a caught deletion.
- **The decisive measurement:** reachability instrumentation on the distinct-error raise
  went **0 hits → 2 hits** between rounds 2 and 3, with all three `revert_activation` calls
  returning `reverted: True` and non-`None` `previous`.
- **Adjudicated, recorded, deliberately unenforced:** the `_commit()` ordering change
  (`commit_holder["previous"]` now assigned *after* `activate()` returns) is correct but
  reverting it leaves the suite green. G2A's differential harness measured the observable
  end state **identical** under both orderings — round 2's extra `revert_activation` was a
  genuine no-op against a commit that never landed. Round 2's ordering was a test-vacuity
  defect, **not** a correctness defect. The code comment records the negative result and
  warns against pinning it with an end-state assertion, which would pass either way.
- Full spec, all nine defects, frozen operator rulings, and the environment traps:
  **`docs/HANDOFF-GS-COORD.md`** (committed `5963426`).
- Harness state: `.torq/artifacts/status/harness_status.json`. Verdicts:
  `.torq/artifacts/03_verifier/g2a_gs_coord_r3.md` (+ r1, r2, and the G1D r2/r3 probes).
- Sequence: **GS-COORD ✅ → GS-ACCEPT → soak → C1 runtime.** C1/C2 *design* may proceed in
  parallel (PRD-004); the C1/C2 **runtime build remains unauthorized**.
- Standing rule, unchanged: G2A approval is verification authority, **not** publication
  authority. Merging and pushing each require explicit operator approval.

## RUN: GS-ACCEPT — CONDITIONAL PASS, 13 of 15 steps

**Ran 2026-08-10 against merged master. 8 passed, 2 xfailed** (both xfails are recorded
findings, not hidden failures). Unit gate unaffected: 303 passed, 1 skipped, 10
deselected. Harness: `engines/hermes_kernel/tests/acceptance/test_gs_accept.py`.
Report: `.torq/artifacts/03_verifier/gs_accept_r1.md`.

**Steps 7–8 and 12–13 — the ones no unit test substitutes for — PASS.** A real `AIAgent`
boots, publication lands in the real resolved `external_dirs` path with the exact
approved bytes, the skill appears in the **real rendered system prompt**
(`build_skills_system_prompt()`, the function the model's turn consumes), and governed
state survives a full restart because it is durable rather than memoised.

> **F-1 — BLOCKING. Governed rollback does not exist end to end.**
> `store.rollback()` moves governance to the prior digest but does **not** re-publish the
> prior projection. Measured: governed-active is v1 while the rendered prompt still
> carries the v2 body. The operator sees "rolled back"; the model keeps reading the
> reverted content.
>
> And `store.rollback()` has **no production caller** — not `governed_skills`, not the
> gateway, not the console. `governed_skills.py:328` calls the governed path
> "rollback-capable". That is the [[unenforced-claim-pattern]] again: the capability
> exists as a method and is reachable from no operator surface. Step 9 is not satisfiable
> today.

> **F-2 — minor.** An empty skill body publishes as a 0-byte `SKILL.md`; validation bounds
> package size from above but has no lower bound. Pinned with `xfail(strict=True)` so
> fixing it forces the gap to be closed deliberately.

**Governed skills stay default-off.** F-1 means an operator cannot undo a bad skill
through any shipped surface, and the failure is silent because governance reports success.
That is a worse failure mode than the activation defects GS-COORD fixed.

## ACTIVE (resume here): GS-ROLLBACK — proposed, not yet scoped

Governed rollback routed through `ActivationCoordinator` with the same transactional
guarantees as activation — publish the prior projection, invalidate, commit, verify —
plus an operator surface that actually calls it. Scope it the way GS-COORD was scoped:
G1R before build, G2A after, deletion probes for every control.

Revised sequence: **GS-COORD ✅ → GS-ACCEPT ✅(conditional) → GS-ROLLBACK → re-run
GS-ACCEPT → soak → default-on → C1 runtime → Phase 4.**

## SHIPPED: C0.1 - Authenticated Identity Transport

**Status: COMPLETED, VERIFIED, G2A-APPROVED by GPT-5.6 Sol High — and now MERGED AND PUSHED.**

> **CORRECTION 2026-08-09.** This block previously read "operator-gated, and UNCOMMITTED.
> No operator-controlled action is authorized" and stated "GitHub contains baseline only;
> C0.1 is local worktree." Both were true when written and are now false: the operator
> merged C0.1 via **PR #44**, landing as **`af52430`** on `origin/master`
> (`846e691 feat(gateway): add authenticated identity transport`). Anyone resuming from
> the previous text would plan against a false premise, so it is corrected rather than
> appended to. The G2A record and the accepted residual risks below are unchanged and
> still apply.

- Local branch: `master`. `origin/master` is now `5963426` = `af52430` (C0.1 merge) + a
  docs-only commit. C0.1 is on GitHub, not a local worktree.
- Controlling invariant: resume binding is gateway-derived only from a successfully verified surface credential; client `principalId`/`surfaceId` cannot influence it.
- Predecessor truth: the earlier Claude/Fable/Sonnet/Opus G1R/Builder checkpoint was accepted as predecessor evidence. It is not OpenAI Terra/Luna/Sol evidence.
- Actual OpenAI threads:
  - GPT-5.6 Terra High `019fe6e0-8c1a-7731-8dbd-6dd65b8ba461`: resumption G1D/orchestration and two bounded correction authorizations; no implementation.
  - GPT-5.5 `019fe6ea-8dbd-7053-8f29-42fa746958e7`: independent verifier `RETURN_TO_BUILDER`.
  - GPT-5.6 Luna High `019fe720-53fa-76a2-a7a8-7396d36a8598`: bounded Builder corrections and evidence; no self-approval.
  - GPT-5.5 `019fe747-bc2a-7a62-b4a5-597a3e76d2b4`: independent verification `BLOCKED` on unbounded concurrency evidence, leading to test-only correction.
  - GPT-5.5 `019fe7bc-76c1-7250-813d-966e158648de`: fresh final independent verifier `READY_FOR_G2A`.
  - GPT-5.6 Sol High `019fe7e9-1223-7383-88a5-0a420b6de375`: fresh isolated G2A `APPROVE`.
- Final independent evidence: gateway typecheck PASS; forced uncached dependency build PASS `6/6`, `0` cached; contracts check PASS `8` schemas in `2` dirs; reachability PASS `94` modules from `6` entry points; lock suite PASS `6/6`; focused final PASS `158/158` across `9` files; full suite PASS `1519/1519` across `77` files; GPT-5.5 `READY_FOR_G2A`; Sol G2A `APPROVE`.
- Key outcomes: server-derived on-wire identity; dead `frame as any` removed; cross-principal resume fails closed with no fallback/no crash; exact indistinguishable `AUTH_FAILED` wire triple; test pepper removed from production runtime and confined to guarded preload; stale-dist evidence repaired; bounded cross-process build-lock recovery and cleanup tests.
- Accepted residual risks: legacy unbound bearer-resume; bound sessions can be stranded by flag-off rollback; no immediate live-socket revocation; `surfaceId=credentialId` stand-in; same-principal cross-credential resume; `WindowsCredentialManagerStore` unimplemented and production surface auth fails closed; operation-count is not wall-clock timing proof; dirty-worktree authorship is not Git-provable.
- PRD-004 prior `APPROVE` remains void due C0-1 false-baseline discovery. Next product step is an operator-authorized decision on committing C0.1, then resume PRD-004 `REVISE-PRD #3`; C1/C2 build remains unauthorized.
- Operator retains commit, push, merge, deploy, flag enablement, secret provisioning, provider configuration, release, and PRD resumption decisions.
- Preserve unrelated operator files and existing history.
## Governed-learning / integration program — SHIPPED (2026-08-07..09)

All on public `origin/master`. Verified SHAs and subjects:

| Commit | What |
|---|---|
| `22cadca` | `feat(skills)`: external_dirs publication adapter (P2-1a) |
| `1fda702` | `fix(channel-http)`: fail closed on an unauthenticated network bind |
| `97cacaa` | `ci(reachability)`: fail the build on undeclared orphan modules |
| `39098a8` | `feat(skills)`: wire the governed pipeline to the live approval path (Phase 1) |
| `da688c0` | `feat(gateway)`: C0 principal identity bridge (`TORQCLAW_COLLAB_ENABLED`) |
| `5963426` | `docs`: GS-COORD handoff, the C1/C2 PRD, and its linter |

**What drove this program.** An inventory found ~9,200 lines that had passed design
review, implementation, adversarial verification and a merge gate while being reachable
by **no running program**: `packages/collab` (6,956), `verified_skill_store.py` (998),
`skillTrust.ts` (661), `skill_publisher.py` (557). The process was working at every step
except the last, and nothing in CI noticed.

**The structural fix is `ops/reachability.mjs`** (`pnpm reachability`, wired into CI
before `typecheck`). It walks the import graph *transitively* from real entry points and
fails the build when a module ≥150 lines is unreachable and not explicitly declared
dormant. Dormancy stays legal but must be declared with a reason. Phase 1 then wired
1,555 lines of the skill pipeline in, and the gate confirmed it by dropping those modules
from `DORMANT` on its own.

**Two defects were found in this program's own output**, both recorded because the
pattern recurs:
- P2-1a shipped that morning was itself a new instance — its publish-time check was
  verified against the real loader *function* while the live server used `skill_queue.py`
  (83 lines, no digests).
- The channel-http fix **passed 14 unit tests while the real binary still served
  unauthenticated traffic on a routable address** — `dist/` was stale and `tsc` had
  exited 0 without emitting. Caught only by booting the actual binary.

**Standing principle:** *Reachability proves code is live. Invariant-path tests prove the
correct control is live on the correct operation.* Green units alone are insufficient —
now normative in PRD-004 §13 as well.

**Operator ruling 2026-08-08** — `packages/collab` is **INCUBATING**, absorbed slice by
slice behind `TORQCLAW_COLLAB_ENABLED` (default off), never wired wholesale: it carries
its own sessions/events/audit/channel model and a one-step switch-on would stand up a
second authority beside the gateway. **The gateway remains the execution authority.**
Order: C0 (done) → C1 → C2 → C3 → C4.

## Collaboration program

### Substrate (PRD-TCLAW-COLLABORATION-SUBSTRATE-001, v0.14 normative) — SHIPPED
Five slices built, each G1D→G1R→Builder→G2A, all G2A-approved and on public `origin/master`:
- Slice 0 contract `1c48ca5` · Slice 1 identity `9beef09` · Slice 2 channels `9d6e2e7` · Slice 3 live/concurrency `95277ba` · Slice 5 headless rollback+benchmark `0f3505c` (pushed 2026-08-08, fast-forward).
- §19 DoD satisfied for the HEADLESS subset only. Owed to a separate gateway/UI effort: operator UI (WCAG 2.2 AA), real socket adapter + backpressure, six-flag startup validator, real Windows Credential Manager adapter, real data-destroying restore impl, connect-path timing fixture, full-slice G1R with UI.

### Gateway integration (incubating, behind `TORQCLAW_COLLAB_ENABLED`, default off)
Operator ruling 2026-08-08: absorb `packages/collab` slice by slice; gateway stays EXECUTION AUTHORITY, collab supplies IDENTITY. Order: C0 → C1 surface identity → C2 approval broker → C3 channels → C4 task rooms.
- **C0 principal bridge - DONE `da688c0`** (baseline on `origin/master`). C0.1 is the local, uncommitted authenticated identity transport work described above; no GitHub update occurred.

## Active item: PRD-TCLAW-COLLAB-GATEWAY-004 (C1 Surface Identity + C2 Approval Broker)

**Status: PRIOR APPROVE VOID due C0-1 false-baseline discovery; C0.1 is separate local work only. C1/C2 build remains unauthorized.**

- Artifact: `docs/prd-reviews/PRD-TCLAW-COLLAB-GATEWAY-004.md` (revised per operator REVISE-PRD #2, six enforceability fixes).
- Consistency pre-gate: `scripts/lint_collab_gateway_prd.py` → **PASS 67/0**, deterministic/locale-hardened (forces UTF-8 stdio — fixed a real bug where Windows cp1252 garbled the CT-2 `∈` literal into a false FAIL; re-verified PASS under forced cp1252). Report: `docs/prd-reviews/PRD-TCLAW-COLLAB-GATEWAY-004-CONSISTENCY-REPORT.md`.
- Independent verifier (G1R): **APPROVE-PRD** twice — first pass 8/8 operator contract, then again after operator REVISE-PRD #2 graded all six fixes PASS, four frozen rulings undisturbed, new-defect sweep clean, linter determinism adequate.
- History: draft → G1R REVISE-PRD (2 freeze-blocking OQs + H-1 + apply-seam) → operator froze CT-2/H-1/OQ-4/Property-10 + identity≠capability≠AUTHORITY → revised (8-item list) → G1R REVISE-PRD on one matrix cell (§4) → fixed → G1R APPROVE-PRD → **OPERATOR REVISE-PRD #2** (six defects the linter + G1R had BOTH missed: §10 linter rejecting its own PRD; §4 authority-pointing-at-capability_json; missing authority-store schema + operator-kind discriminator; §7 absolute-acceptance wording; context_hash byte-serialization) → six fixes applied (new `surface_authorities` table gateway-owned + `surfaces.surface_role` operator-kind discriminator + `CTXHASH_V1` length-prefix serializer) + linter locale-hardened → **independent-verifier APPROVE-PRD**. Lesson recorded: literal-linter + semantic-G1R can BOTH pass a PRD whose security rule is not mechanically enforceable against the actual schema — the operator's own read caught it.
- Frozen rulings: `~/.claude/projects/E--TorqClaw/memory/collab-gateway-004-rulings.md` (CT-2 `approve`=operator-surface-only authority; H-1 subordinate the authz.ts:100 operator short-circuit; OQ-4 context_hash 10-input frozen set; Property-10 C2-synchronous / C3-deferred).
- Open questions remaining (all defer-safe, fail-closed defaults): OQ-1 residual (fine-grained execution-capability vocabulary), OQ-2 (surface transfer), OQ-3 (session-grant primitive), OQ-5 (TTL value), OQ-6 (socket-close on revocation).

### FROZEN GATE SEQUENCE - where we are and what's next
`C0.1 completed and verified -> Sol G2A APPROVE -> operator decision on commit -> resume PRD-004 REVISE-PRD #3`

- C0.1 is completed, independently verified, G2A-approved by Sol, operator-gated, and uncommitted.
- No approval beyond Sol G2A exists. No operator-controlled action is authorized.
- PRD-004 prior APPROVE remains void due C0-1 false-baseline discovery. C1/C2 build remains unauthorized.
## Standing process rules (hard-won)
- Verify the artifact, not the unit test: boot the built `dist`/binary before claiming a control is enforced (stale-`dist` once hid an open auth hole while 14 unit tests passed).
- Green general gate is necessary, not sufficient — every security property needs a property-specific adversarial proof (three-proofs bar: unit + reachability + built-artifact).
- Baseline test count is LOCAL 1498 TS at/after `da688c0`, not the README's stale 991.
- Repo is PUBLIC; push/merge are operator-gated; structured Edit tools only (no PowerShell `$1` regex replacement).
- Two full-suite load-flakes (harness 1M-UUID determinism; failover controller-timeout) pass in isolation — suite-scaling starvation, re-run isolated before calling a regression.
