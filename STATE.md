# TORQCLAW — Program STATE

Single-file program state, updated only after meaningful progress with tests + independent verifier passing. Detailed history lives in `docs/prd-reviews/*` and the per-project memory index.

_Last updated: 2026-08-09 (C0.1 final G2A; operator-gated)._

## ACTIVE (resume here): C0.1 - Authenticated Identity Transport

**Status: COMPLETED, VERIFIED, G2A-APPROVED by GPT-5.6 Sol High, operator-gated, and UNCOMMITTED. No operator-controlled action is authorized.**

- Local branch: `master`. Before the final uncommitted candidate, local HEAD and fetched `origin/master` remained `da688c0a6ca72f14e554e6fa09af7b75e4f565cb`, ahead/behind `0/0`. GitHub contains baseline only; C0.1 is local worktree.
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
