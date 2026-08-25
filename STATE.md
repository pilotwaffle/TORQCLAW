# TORQCLAW — Program STATE

Single-file program state, updated only after meaningful progress with tests + independent verifier passing. Detailed history lives in `docs/prd-reviews/*` and the per-project memory index.

_Last updated: 2026-08-25 (master @ ac50e92: doctor provider-dial PR #64; CI credential fix + branch sync PR #63 — **first green CI since 08-20**; **Rooms Phase 0 merged e5dee38 via PR #62**; trigger-marker PR #61 with **AC-2 LIVE PASS ("Answer: 8", 17s)**; collapse fix PR #60; channels UX PR #59. Also live, non-repo: CLIProxyAPI primary restored + Startup-folder autostart — median turn 123.6s → ~5-40s)_

## SHIPPED 2026-08-25: Trigger-identity NEWEST MESSAGE marker — merged 0a6c5a1 via PR #61 (2383547 code + bcedc55 docs) — **AC-2 LIVE ACCEPTANCE PASSED**

**The reply-quality gap is CLOSED with runtime proof:** post-restart live turn — novel question ("how many legs does a spider have?") → TORQ AI posted "**Answer: 8**" in 17s, turn completed, correct target. Root cause had been that the window render never named the triggering event: llama-class models answered the anchor block's stale instruction; torq-ai-v5 emitted nondeterministic boilerplate (bench: 3/3 models answer correctly once the trigger is repeated in a labeled terminal section — Buzz mechanic #3, `docs/BUZZ-MECHANICS-SURVEY-2026-08-24.md`).
- **Design as gated:** marker carries TURN IDENTITY (claimed trigger seq threaded via one authorized dispatcher hunk at :498, matched by exact cursor in autoReplyContext) — G1R's F-1 killed the "newest in window" variant (racing/self/cross-agent misattribution). Fail-closed omission on every miss; renderEvent-produced (byte-identity by construction); exported banner literals; cron byte-identical.
- **Gates:** G1R REJECT → v1.1 amendment → verify 7/7 PASS (collapsed-away hazard proven unreachable; stash integrity confirmed) → G2A APPROVE hash-bound with 10 own dist-level probes green incl. the direct racing-message proof (P7). **C-1 evidence corrections mandated and landed:** both prior packets misdescribed the collab-c2-flag-off-identity flake (builder "deterministic", verifier "4/4 green"); G2A measured ~1/3 pass on slice AND 0/3 on baseline — chronically flaky, causally independent → **separate flaky-test ticket recommended**.
- **Residuals:** R-6 banner forgery (pre-existing unescaped-transcript class; real trigger holds terminal position) · R-7 quoting likelihood (persona layer) · R-8 busy-channel honest omission (follow-up = Buzz mechanic-#1 own-reply swap-in) · R-9 T-4 pin .match() first-occurrence latent · prior R-1/R-3/R-5 carried.
- Process: five slices shipped this cycle (PRs #58-#61 + state commits); the gates caught real defects at every station tonight — G1D's false persona diagnosis, G1R's self-contradictory T-3, G2A's B-1 ordering regression, G1R's F-1 turn-identity conflation, and G2A's C-1 double evidence correction (against builder AND verifier).

Follow-up queue: flaky-ticket collab-c2-flag-off-identity · Finding C dist-freshness harness guard · B-FOLLOWUP-2 subscription guard (G1R-shaped: extract + share) · Buzz parity checks (burst→one-reply; own-newest swap-in; session affinity) · engine time-to-fail watchdog (~90s retry budget on a dead chain primary; gateway-side, gated). (Rooms rebase item REMOVED 2026-08-25: stale at birth — e72e26d was already based on 0a6c5a1 and merged as e5dee38 via PR #62.)

## SHIPPED 2026-08-24: Collapse live-defect fix — merged to origin/master aeeefe1 via PR #60 (commits cc1a9d2 code + df337b6 docs)

**The operator-reported defect (agents answer every hello with silence) is FIXED and live-proven.** PR #59's collapse only merged CONSECUTIVE self-posts; live traffic alternates operator↔agent, so agents saw ~7 copies of their own greeting, imitated them, and the commit guard suppressed every reply. Fix: `collapseSelfRuns` per-actor kept-reference survives interleaving (G1R correction (a)) + elision spliced to the CURRENT position (G2A round-1 B-1: the in-place write rendered a non-monotonic timeline `[1,14,3,5…]`). Zero dispatcher hunks; predicate/thresholds byte-identical.
- **Live acceptance on the restarted stack:** the elision marker renders in the real dispatched prompt (`[#551] … posted 6 earlier replies — elided (most recent shown)`, exact count, correct timeline position); a novel question got a POSTED reply in 3.3s (turn completed, not suppressed). **Residual disclosed:** reply *quality* on torq-ai-v5 is weak on flat-transcript prompts (answered a fragment, not "Paris") — model-quality/prompt-format lane, not plumbing; same model answers correctly via role-structured direct chat. Guard suppressions since the fix were verified TRUE duplicates (model re-emitting its own prior reply verbatim).
- **Gate record** (`docs/prd-reviews/*-COLLAPSE-FIX-2026-08-24.md` + `G1D/G1R-CHANNELS-LIVE-DEFECTS`): G1R REJECT round 1 **falsified the packet's D-A** (persona ALREADY reaches local models as a system-role message via `ollama.ts:332-338`; the probe had measured the contractually-untrusted `payload.prompt` — closed NOT-A-DEFECT by T-1 against the real transport, "measure the artifact" class inverted) · G1R delta ACCEPT-AS-RESIDUAL **R-5** (order-inverted same-word-set self-restatement elides in exact self-chain adjacency; channel record intact; commit guard second line; T-7 constant-parity pin load-bearing) · verify PASS + delta PASS (all probes byte-clean) · G2A round 1 REJECT (B-1) → bounded correction + T-9 order-monotonicity RED-proven → fresh G2A round 2 **APPROVE zero blockers** (477 tests/0 failures at the audit seat).
- **Open follow-ups:** Finding C — tests importing `packages/*/dist/*` lack a freshness guard (bit three seats; file harness ticket) · B-FOLLOWUP-2 subscription-branch output guard (deferred by G1R; intended form = extract the inlined guard into autoReplyContext and share) · model-quality/prompt-format for local channel agents (see `docs/BUZZ-MECHANICS-SURVEY-2026-08-24.md` — Buzz parity map: ack-ban persona language APPLIED to TORQ AI rev 14 via UPDATE_AGENT_PROFILE; parity checks queued: burst→one-reply, own-newest-reply swap-in when outside window, per-channel session affinity; Rooms-lane inputs: 👀/💬 reactions, typing, harness-computed reply anchors).

## SHIPPED 2026-08-24: Channels agent-UX slice (Items A, B+C, D) — merged to origin/master 24d188a via PR #59 (commits 7f315e3 code + 463e084 docs)

**22 code paths + 6 governance docs; +3,653/−50 vs origin/master, zero file deletions.**
- **Item A (Builder P):** greeting-loop fixed — anchor window includes the agent's own collapsed runs (`collapseSelfRuns` + `selfPrincipalId`); commit-time near-duplicate guard resolves `no_post` with persisted `resolution_note='duplicate_suppressed'` (accounted, no retry). Additive migration `20260824_008` (collab count 13→14). Dispatcher unfrozen for exactly 2 hunks, counted at verify and G2A.
- **Items B+C (Builder Q):** `SET_LOCAL_AGENT_AUTOSTART` (operator + live delegate, ollama-local only, in-transaction guards, one terminal event); operator-only `configurationReadiness` on LIST_AGENTS from the exported `runtimeProfileAllowsAutomaticTurn`; AgentsPanel enable / Test connection / honest Live-Parked badge. Member payload key-set unchanged (6 keys).
- **Item D (Builder D):** `ADD_CHANNEL_MEMBER`/`REMOVE_CHANNEL_MEMBER` thin call-only wraps; named authz arms in BOTH blocks (ND-4 fail-open closed — `authorizeOperator` tail is ALLOW); ChannelsPanel add-agent picker + per-agent remove; human principals unrepresentable at the store.
- Gates: independent verify PASS all items + G2A **APPROVE zero blockers**, both hash-bound and committed-blob-verified (`docs/prd-reviews/{VERIFY,G2A}-CHANNELS-SLICE-2026-08-24.md`). Suite 2574/1 skipped/1 load-flake (green isolated); typecheck 14/14; contracts byte-deterministic; reachability PASS; deletion audit clean.
- Follow-ups filed (non-blocking): B-FOLLOWUP-1 seat-lattice behavioral pin (bounded, Builder); B-FOLLOWUP-2 subscription-path output guard (needs its own G1R unfreeze — route via G1D). Residuals R-1..R-7 recorded in the G2A verdict; R-3 (`authorizeOperator` fail-open default) remains the standing hardening item; R-5 (read-only fork brief violated by a crashed agent — harness-lane control gap).
- Process: ~15 transport drops across builders/verifier/G2A, all recovered by resume-with-disk-verification; verifier corrected the diff baseline (branch tip ≠ base; audit = `git diff HEAD`); P's evidence packet filed post-hoc (disclosed) to discharge C-2.

Still uncommitted (concurrent-session WIP, report-only): dispatch.ts failover hunk (verifier O-2: echoes `req.payload.prompt` into ERROR payload — needs privacy review in its owning lane before commit), friendly.ts + test, hermesAttempt.ts cap + failover test, .claude/settings.json, .claude/agents/README.md. Operator-owned untracked files preserved untouched.

Next: operator wake-up review of PR #59 in the console; Rooms UI lane (GPT, `E:\TorqClaw-worktrees\rooms-ui`) should now rebase onto 24d188a; B-FOLLOWUP-1/2; AUTH-005 landing; OQ-4 record; operator-owned: OQ-8 already ruled operator-only.

## SHIPPED 2026-08-24: Cleanup + docs-truth slice — merged to origin/master 8209d30 via PR #58 (commit 1ff87fa)

**26 files, +1320/−98.** Closed:
- ignoredKinds → RESULT telemetry; frame.id fail-closed (string|number) on ACP reverse requests.
- Portable adapter version pin: `TORQCLAW_ACP_ADAPTER_PIN=1` opt-in hard-fail / resolvable assert 0.64.2 / named skip — pin DORMANT in CI until opt-in set.
- listChannelMembers kind column-sourced (operator→human); Python web-search gate truthy parity ({1,true,yes,on} trimmed, default OFF).
- `pnpm lint` self-describing exit-0; cron NB-2 title + NB-4 promptHint + NB-1 poison-router test.
- PRD-007 header v1.0 S1–S7 SHIPPED + §3/§9 ledger reconciled (OQ-4 ratification STILL OWED; OQ-5 RULED model-side; F1/F2 RESOLVED-on-master on static evidence; coalescing-race test design filed, Gate-1-scoped).
- FOLLOWUPS: doctor CLOSED; e2e token ruling ratifies CONDITIONAL launcher contract; CI-red cause UNKNOWN; ESLint adoption filed.

Withdrawn (uncommitted concurrent-session WIP, report-only): dispatch.ts failover-payload hunk; friendly.ts safe-export section + tests/friendly.test.ts; hermesAttempt.ts 2K→64K cap + tests/failover/mcp-contract.test.ts; .claude/settings.json; .claude/agents/README.md.

Gates: full vitest 2587–2593/1 skipped (sole red = documented cold-start flake, 6/6 warm); pytest 532/1/11 main repo, clean-worktree 531/1 + env-artifact test_no_vendor_modification (worktree submodule checkout collision, named); typecheck 14/14 uncached; build --force 8/8; contracts OK; reachability PASS; clean-worktree proof on 1ff87fa.

Seats: G1D fable-5; Builders sonnet-5 (M/N/D/O); G1R designated Opus 5 REJECT→resolved (5 of 13 items already fixed on master — stale-ledger lesson); verifier ×2 + G2A-substitute ×2 (Opus 5; REJECT on CI-red pin → delta APPROVE).

Process events: Builder M disclosed one prohibited `git checkout --` (restored byte-clean); five undeclared concurrent-session files caught by the verifier and withdrawn. Live gateway kill attributed to dev-up.mjs tree-kill, NOT the test suite.

Next: channels slice Gate 1 RESOLVED (Builder P Item A in flight; Builder Q Items B/C queued). Operator-owned open: OQ-4 ratification, OQ-8 (willRespond §2a extension, new), AUTH-005 landing, web-search CI pin opt-in.

## SHIPPED: PRD-007 Phase 1 + ACP continuation — Agent Model Conversational Dispatch with GLM-5.3

**Status: COMPLETE, INDEPENDENTLY VERIFIED, G2A-APPROVED (round 4 APPROVE), MERGED AND PUSHED to origin/master as 4252a6a (PR #53) and 962d6bf (PR #54) on 2026-08-23.** Commit `962d6bf` = merge of PR #54 (GLM-5.3 alias binding + ACP client fixes); prior PR #53 = `4252a6a` (Windows spawn + S1–S7 base).

Main outcomes (PR #53 + #54):
- **Hermes `failed: True`** → `failed` attempt field (HermesTaskFailedError + FailoverReason mapping + kind derivation + approval-blocked telemetry wrap). Terminal ERROR on kimi-sub-primary exhaustion, zero RESULT fallback.
- **Lease predicate** `resolveAgentTurn` gate: session resume binds exactly once per agent-scoped task. A-3c (two-agent STOP) passes on live dist and real DB rows.
- **Windows npm-shim spawn** `claude-agent-acp` → `resolveSpawnTarget()` parses .cmd entry point, spawns `node <path>`. spawnError + 8s readiness timeout.
- **GLM-5.3 alias binding endpoint_bound** (PR #54): ACP client alias union + env isolation proof (CLAUDE_CONFIG_DIR + cwd isolation zai-only, defense in depth). First live GLM-5.3 turn GLM53_OK; zai readiness connected/glm-5.3/endpoint_bound. Operator granted OQ-2 in own words 2026-08-23.
- **Members roster** with server role/kind labels. Working-now overlay {principalId, displayName, working, since} co-members only, read-time from collab_agent_turns, live push with per-delivery revalidation (trigger-only dispatcher).
- **ACP client defects fixed fail-closed** (PR #54): benign session/update kinds allowlist (never throw); consumed-content credential scan (raw-line SECRET regex matching "token"); agent→client reverse requests denied; benign kinds during handshake/pin crash→-32601 for fs/terminal.
- **LIST_CHANNEL_MEMBERS** shipped with Members roster and dispatcher integration.
- **Web search gated default OFF** on both LOCAL_EDGE and FRONTIER tiers (TORQCLAW_WEB_SEARCH_ENABLED=unset → registry strips `research__web_search`); gate behavior verified live boot real dist.
- **PRD-007 S1–S7 ALL SHIPPED** (PR #53 + #54); OQ-3 closed (agent task contract); OQ-2 granted operator-wording.

Tests verified: vitest 170 files 2568/1 passed (2 load-sensitive collab-build-lock, failover-controller-timeout untouched, green in isolation); Python 518/1 passed; typecheck 14/14 uncached; `pnpm build --force` 8/8; contracts 8 schemas; reachability PASS; vendor submodule clean; pre-merge deletion audit zero whole-file deletions.

Final G2A verdict: **APPROVE zero conditions** (independent Opus 5, fourth round). Earlier rounds rejected real defects; all corrected before approval.

Operator-owned untracked files left in tree: `.claude/agents/*.md` + modified `.claude/agents/README.md`; `ops/skill-staging/**` (chief-of-staff, thecraighewitt); unrelated docs (TORQ-VIS-002, visualizer, clawed.jpg).

Open / follow-ups (G2A non-blocking): ignoredKinds diagnostic-only (overclaims in doc); frame.id type validation; T-6 as adapter-version pin; kind-from-role guard; `pnpm lint` vacuous; TRUTHY vs "1" web_search gate; N-2..N-5 from earlier G1R; S4 human-task presence NOT granted/not built; web-search egress (operator-owned, stays OFF).

## SHIPPED: PRD-1 Profile Conformance Suite — full handoff executed, merged, pushed, CI green

**Landed on operator authorization 2026-08-15, three commits on origin/master:**
`069f556b` (merge of the G2A-approved 8-file C4 delta onto the operator's line, zero
overlap, audited SHAs preserved) · `e60587c` (C4-DEF-2 part 1: AC-10A helper anchored
to in-tree `tsconfig.base.json` + containment guard + regression test — fixed the CI
red the defect itself predicted) · `09ca3f0` (C4-DEF-2 part 2: `tests/tsconfig.json`
transform anchor, independent-Opus-reviewed spec + 7 conditions, dual-regime proof —
host suite baseline-conformant, CI green). **C4-DEF-2 fully closed.** Follow-up spec +
review record live in `docs/prd-reviews/PRD-1-FOLLOWUPS-SPEC*.md`. Dormant by trigger:
verifier-v4 (next base-arm verify), F1 residue check (next auditor revision).

**Status: G2A APPROVE, zero conditions, 2026-08-15** (audit
`E:\tmp\torqclaw-prd1-phasec-exec-20260815Z\final\G2A-AUDIT-20260815.md`, sha256
`02136706…`; G2A role filled on claude-opus-5 — Opus 4.8 not invocable this session, stated
in the audit). All 16 items of `docs/prd-reviews/PRD-1-CLAUDE-HANDOFF-2026-08-14.md` closed
with on-disk evidence; independent verifier passed the packet READY_FOR_G2A (74 checks, 0
material defects) before the audit.

- **Candidate delta:** exactly 8 added files at commit `7261617…` (branchless, worktree-
  protected). **Not committed to any branch, not merged, not pushed** — operator-reserved.
- **Sealed-container record:** offline provisioning proven; better-sqlite3 rebuilt
  byte-identical to the accepted artifact in both arms; argon2 KDF native end-to-end; the
  **eight PRD-1 mutations 8/8 relevant RED** in-container (three-run record: fail-closed
  discovery STOP → a-2 mount falsified → 8/8 under ruled in-tree mount). Canonical
  conformance proven on retained 2026-08-14 host runs per **LIMITATION FINDING PC-1**, which
  travels with the record permanently.
- **Verifier:** K1 `verify-run` PASS with zero relief (2/100/102 files, 2/1895/1897 tests,
  36/36 inventory). verifier-v3 `verify-base` mode proven defective (never load-bearing);
  **verifier-v4 filed**.
- **Defects surfaced by the sealed lane (filed, not fixed in-run):** C4-DEF-1 (`it.each`
  titles) and C4-DEF-2 widened (out-of-tree tsconfig ascent — helper `findConfigFile` AND
  vite/tsconfck transform layer; hygiene finding PC-2 + addendum carried).
- **Operator decisions pending:** R-3 retroactive acknowledgment; F1 auditor-residue
  obligation; KBN-1 PYTHONHASHSEED mandate; C4-DEF-1/2 + verifier-v4 fix authorization;
  held-container `b22ce32d…` disposition (Docker Desktop engine restarts start its
  `/bin/true` — benign, receipted); merge/push/cleanup of the Phase C worktrees, containers,
  and volumes (all retained, create-only).
- Evidence root: `E:\tmp\torqclaw-prd1-phasec-exec-20260815Z\` — reading entry point
  `final\PHASE-C-EVIDENCE-PACKET-20260815.md`.

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
