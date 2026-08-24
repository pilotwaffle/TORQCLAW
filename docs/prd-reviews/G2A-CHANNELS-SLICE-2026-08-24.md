# G2A Final Verdict — Channels Slice (Items A, B+C, D)

> Filed verbatim by the coordinator from the G2A seat's reply (the seat has no Write tool). Harness HTML-entity neutralization reversed.

**Date:** 2026-08-24
**Seat:** G2A (final verifier). **SEAT DISCLOSURE — DISCLOSED SUBSTITUTE.** Runtime model id: **`claude-opus-5[1m]`** (Opus 5, 1M context). The project's standing rule (`g2a-must-be-opus-48.md`) designates `claude-opus-4-8` for this seat; **4.8 is not invocable in this runtime** (enum: sonnet|opus|haiku|fable). This audit is therefore recorded as an **Opus 5 G2A substitute**, consistent with the operator's 2026-08-22 session-profile assignment. It is a fresh seat: it did not author, review, or previously verify any part of this slice.
**Audit basis:** `git diff HEAD` at HEAD `8209d30` — 26 modified files, +1,333/−64 — plus 4 untracked test files. Confirms the verifier's §1 ground-truth correction: `git diff master` conflates 25 merged commits and is not a valid inventory.
**Contract:** `docs/prd-reviews/G1D-FABLE-CHANNELS-AGENT-UX-2026-08-24.md`

## VERDICT

# APPROVE

Zero blockers. Two bounded follow-ups routed to Builder (non-blocking, do not gate this commit). Approval attaches to **exactly** the source state whose hashes appear in §8; any subsequent edit voids it.

## 1. Architecture fidelity — PASS

Every structural ruling from Gate 1 and the delta review is implemented as approved, not as a plausible alternative.

| Ruling | Implemented state | Evidence (G2A's own) |
|---|---|---|
| B-1: no `SET_AGENT_RUNTIME_ENABLEMENT`; only a local-only autostart writer | `SET_LOCAL_AGENT_AUTOSTART` only; no provider/adapter/model fields in the contract | `commands.ts` diff read in full |
| B-3: dispatcher unfrozen for **exactly two** named hunks | **Exactly 2**, headers `@@ -498 +498 @@` and `@@ -767,0 +768,57 @@` | `git diff HEAD -U0` + `grep -c '^@@'` = 2 |
| B-4(b): no `willRespond`; member key-set unmodified | `ChannelMemberEntry` = 6 keys; row-map emits exactly those 6 | `store.ts:326-333`, `:3277-3288` |
| B-5: readiness from the **exported** predicate, never re-derived | `runtimeProfileAllowsAutomaticTurn(profile ?? null)`, single call site | `agentSurface.ts:269`; repo-wide grep = 1 source site |
| B-6: suppress, no retry, persisted discriminator | `resolveAgentTurn(... note:'duplicate_suppressed')` then bare `return` | dispatcher `:768-823` |
| ND-1: call-only handlers, zero store diff for D | `handleAdd/RemoveChannelMember` forward and map errors only; store.ts has **one** hunk (Q's writer at `@@ -1347,0 +1348,69 @@`), nothing from D | `collabSurface.ts` diff; store hunk list |
| ND-4: named arms in **both** authz blocks | Present in the non-operator switch (`:271-272`) **and** `authorizeOperator` (`:341-342`) | `authz.ts` diff read in full |
| ND-6: "in the room ≠ can speak" disclosure ships | Verbatim string renders under Members | ChannelsPanel diff |
| Cron byte-identical (obligation 8) | `selfPrincipalId` is optional; omitted ⇒ `collapseSelfRuns` not invoked | `autoReplyContext.ts:146` ternary; obligation-8 test green |

Frozen boundaries hold exactly: dispatcher 2 hunks, `store.ts` 1 hunk, `migration.ts` purely additive (one new id, one `ALTER TABLE ... ADD COLUMN`).

## 2. Controlling invariant — PRESERVED

*"Server-derived, operator-enabled, honestly disclosed."* Verified at each clause:

- **Server-derived** — readiness is computed only in `handleListAgents` from the dispatcher's own exported gate. No client-side formula exists anywhere in the tree (grep: the only non-server occurrences are the AgentsPanel's read of the received field and test assertions).
- **Operator-enabled, never client-inferred, never defaulted on** — `SET_LOCAL_AGENT_AUTOSTART` requires operator role **and live delegate authority**, re-read at command time (`server.ts` passes a closure over `surfaceAuthz.currentRole()`/`holdsAuthority('delegate')`, not a connect-time capture), plus `assertOperatorCaller` + `assertOwnedAgent` **inside the transaction**. Nothing auto-enables.
- **Honestly disclosed** — the badge carries an explicit scope caveat ("configuration readiness only"); the roster carries the ND-6 sentence. The claim is narrower than the truth, which is the correct direction.
- **Own output never replaces the operator's question** — anchor-window self-run collapse (Item A) plus the commit-time suppression guard.

**Writer-uniqueness holds.** `external_context_confirmed` has exactly two write sites, `store.ts:1291` (revoke-to-0) and `:1315` (reconfirm-to-1), **both inside `upsertAgentPersona`** — containment confirmed by reading the enclosing function, not by trusting the line numbers. `setLocalAgentAutostart` writes `autostart` and `updated_at` only, and is doubly barred from subscription rows (in-transaction `INVALID_REQUEST` on `provider_account_id !== 'ollama-local'`, then `WHERE ... AND provider_account_id = 'ollama-local'`).

**Member payload = exactly `{principalId, displayName, role, kind, working, since}`.** No 7th key at the type, the row-map, or the wire. `kind` is column-sourced from `principals.kind` with `operator → 'human'` mapping, never derived from `role`.

## 3. The M-1 adjudication — CONCUR, narrowed further in the slice's favor

The verifier called M-1 "bounded follow-up, non-blocking." **That call is correct, and the underlying risk is smaller than the verifier's own writeup implies.** Re-derived from source rather than re-running the probe.

There are two distinct arms, with opposite fail postures:

1. **Non-operator switch (`authz.ts:271-272`).** Its `default:` is `return DENY_NOT_PERMITTED` — **fail-closed**. The named arms here are pure legibility. The verifier's probe deleted these, saw the wire test stay green, and concluded "change-detected, not behavior-tested." That is accurate *and* it is the harmless half: their removal cannot open a hole, only reduce readability.
2. **`authorizeOperator` (`:341-342`).** Its tail is `return ALLOW` — **fail-open**. Here the named block is the *sole* enforcement of delegate authority for these two commands. It is **not** redundant, and it **is** behaviorally pinned: `tests/collab-channel-membership-wire.test.ts:216` asserts `authorize('operator', add, context({delegate:false})).ok === false`, which flips the moment that join is deleted. `:221` additionally pins the surface-absent case to DENY, not legacy blanket-ALLOW.

So the coverage gap is confined to arms whose deletion is caught by (a) the SHA pin and (b) a fail-closed default that denies anyway. Add the in-transaction `assertChannelOwner` (store.ts:3507) and the agent-kind/owner validation at `store.ts:2064-2074`, and deny holds at three independent layers. **Not a live vulnerability; not a blocker.** A seat-lattice test that flips on named-arm deletion is filed as B-FOLLOWUP-1.

Also noted: the delta review's own **standalone hardening item** — `authorizeOperator`'s fail-open default for unnamed commands — remains open and correctly out of this slice's scope. That is the real structural hazard; the named arms are the current mitigation, and each new command must remember to add one. Recorded as accepted residual risk R-3.

## 4. Pin-bumps — both NOT weakening

- **`auth-v2-phase1.test.ts` authz SHA.** Independently recomputed `sha256(packages/gateway/src/authz.ts)` = `206a9abf8f1870e96f7a86464d9f5bcade427ebd8c7eb93bab73726535f04a15`, matching the pin exactly. Still an exact `toBe('<64-hex>')`; never widened to `contains`/`match`. Dated authorization comments present for both the B(ii) and Item D deltas. File runs 49/49 green.
- **`collab-c1-built-artifact.test.ts` migration pin.** Exactly one id added (`20260824_008_agent_turn_resolution_note_v1`), count 13→14, still exact `toEqual`/`toBe`. The booted-`dist` artifact actually applied it (`C1_ARTIFACT_SELF_MIGRATED collab=14 migrations`), and the file's own A11 stale-dist test passed — artifact evidence, not source assertion. 4/4 green.

Both bumps re-authorize an assertion at its original strength against a legitimately changed artifact. Neither loosens a predicate.

## 5. Evidence adequacy and gaps

G2A did not rely solely on either evidence packet. Independently executed in this seat:

| Check | Result |
|---|---|
| 8 slice-relevant files (4 new + 2 pin + 2 panels) | **189/189 PASS**, incl. booted-`dist` artifact tests |
| 10-file named regression set (a3c, cron, s3, s4-members, s4-presence, no-coalesce, authz, store-channels, provisioning-authz, agents-panel) | **156/156 PASS** |
| `pnpm --filter @torqclaw/contracts build` + re-hash, 3 artifacts | **byte-identical**, zero new file churn |
| `pnpm reachability` | **PASS** — no orphan modules |
| Frozen-hunk counts (dispatcher, store) | **2** and **1**, counted from `-U0` diff |
| Independent SHA recompute of the pin | **matches** |
| Post-audit tree integrity | **unchanged** — 26 files/+1333/−64, all three hashes original |

**Evidence gaps accepted as residual (§11 review of the verify doc), none blocking:**

- **A11y / real browser — ACCEPTED (R-1).** All console evidence is jsdom + RTL. The contract carries **no a11y acceptance criterion**, so nothing is unmet. The new controls are native `<label><input type="checkbox">`, native `<button>`, and a `title` attribute — inheriting platform semantics rather than inventing a custom widget. G2A will not manufacture a criterion Gate 1 did not set.
- **Multi-writer concurrency — ACCEPTED (R-2).** Both new write paths go through `withReadThenSequencer → mutex.withLock → runKeyedCommand`, the repo's established single-writer discipline; idempotency/conflict tests pass. Evidence is structural, not adversarial-parallel.
- **Real Ollama / temperature-0 regeneration — ACCEPTED.** The guard is *structural* (Jaccard ≥ 0.82, min length 12) with no model in the loop; live-model evidence would test the model, not the guard.
- **Python engine tests — ACCEPTED (R-6).** Schema mirror byte-equal to the TS source of truth (hash-verified twice); `contracts check` passes across both checked-in dirs. The change is a purely additive union member, the lowest-risk schema shape.
- **The one full-suite failure — ADJUDICATED AS INFRASTRUCTURE (R-4).** The two evidence packets name **different** files (Q/verifier: `collab-c2-flag-on-e2e.test.ts` gateway-boot timeout; D: `collab/bootstrap-recovery.test.ts` KDF timeout). That divergence is itself consistent with load-sensitivity rather than a real defect — both are timeouts with no failed assertion, both green in isolation, both in files this slice does not touch, and both match the documented load-sensitivity pattern in project memory. G2A did not re-run the full suite (345 targeted tests green in this seat instead); the two independent isolated re-runs are accepted.

**Unsupported-claim check.** No Builder or verifier claim that source contradicts. Two Builder statements specifically distrusted and checked: (a) Q's "frozen files untouched by me" — confirmed; (b) D's "`ServerChannelMemberEntry` byte-identical" — confirmed.

## 6. Failure/state review — PASS

- **Totality.** Both new collabSurface handlers wrap the store call in `try/catch` with a terminal `return { code: 'COLLAB_UNAVAILABLE' }` — no store throw escapes to the socket handler (cf. the recorded "gateway handler throws kill the process" defect class). `handleSetLocalAgentAutostart` is likewise total.
- **Identity.** All three handlers reject `principalId === null` before touching the store.
- **Flag gating.** All three new dispatch arms are behind `collabSurfaceCommandsEnabled()`; flag-off removes the commands entirely with an honest `NOT_ENABLED` terminal.
- **One terminal event per task (invariant 7).** `SET_LOCAL_AGENT_AUTOSTART` publishes exactly one terminal via the existing `publishAgentMutationTerminal`; the `AgentMutationReporting` widening to `'autostart'` is necessary plumbing, not scope creep.
- **Suppression is accounted, never a silent drop.** `no_post` + persisted `resolution_note='duplicate_suppressed'` + a `console.error` line — deletion-probed by obligation 9. No fabricated completion state (invariant 9).
- **Membership async.** Add/remove reuse the existing epoch bump, committed event, eager `authorization_lost` close, and post-lock fanout; the handlers add nothing. Mid-turn removal remains enforced in-transaction at `store.ts:2653` (ND-2/T-D8 respected).
- **Retry bounded to zero.** The guard suppresses once and returns; obligation 11 pins dispatch called exactly once.
- **No irreversible behavior introduced.** Every new write is a reversible single-row state change; the migration is additive `ADD COLUMN`.

**One coverage asymmetry, disclosed rather than hidden (B-FOLLOWUP-2).** The output-suppression guard sits on the **local-fallback** commit branch only (`:768`); the **subscription** commit branch at `:719` is not covered by it. Not an unfixed defect for this slice: the probe-proven root cause was in-context self-imitation, and the fix — anchor-window self-run collapse — **does** reach subscription agents via `renderSubscriptionMessage`'s `windowCollapsed`/`anchorCollapsed` and the actor-blind `[N earlier replies omitted]` marker feeding `assembleSubscriptionPrompt` at `:625`. Extending the output guard there would require a third dispatcher hunk — beyond the two G1R authorized — so not doing it here is correct scope discipline. Filed as a bounded follow-up requiring its own unfreeze finding.

## 7. Security / authority review — PASS

- **Seat lattice.** `channel` and `node` seats denied for all three new commands (named arm for `channel`, fail-closed default for `node`), pinned by T-D5 tests over the real `authorize()`.
- **No new authority token, no parallel gate.** Both new command families join the *existing* operator + live-delegate block. No handler performs its own authority decision — enforcement is at the wire layer plus the store transaction, exactly the layering the H-1 ruling mandates.
- **Live, not captured.** Delegate authority is evaluated through a closure at command time; a mid-connection demotion bites on the next command.
- **Human principals cannot be added or removed.** `addChannelMember` rejects any target that is not `kind='agent'` owned by the channel owner, and never accepts a role parameter, so an owner-role insert is unrepresentable. D-5 holds at the store, not merely at the contract's field name.
- **No disclosure widening.** `configurationReadiness` exists on exactly one operator-only surface and is explicitly asserted absent from the member payload. OQ-8 honored.
- **No auto-enablement anywhere.** Fail-closed defaults preserved.
- **Secrets.** No credentials, tokens, keys, or `.env` values in any changed file. The `.env`-adjacent and `.claude/` files are excluded from the commit.
- **Invariants 1–10.** Frame validation preserved; no approval-gate, cost, routing-privacy, or tool-approval semantics touched; receipts untouched; Hermes wrapper untouched apart from the deterministic generated schema mirror.

## 8. Scope review — PASS, with the commit plan CONFIRMED

**Nothing on the allowlist carries concurrent-lane WIP.** Hunk boundaries of all 18 tracked paths inspected: every hunk is attributable to Item A, B+C, or D. `agentSurface.ts` was the one file whose diff exceeded its evidence description (a `:348 +31` hunk and a `:487` type widening) — both read; they are the new handler plus its required terminal-event plumbing, in scope.

**Exclusions confirmed correct.** `dispatch.ts` (+9/−1 failover payload), `friendly.ts` (+52), `tests/friendly.test.ts` (+37), `hermesAttempt.ts` (+4/−2), `tests/failover/mcp-contract.test.ts` (+24), `.claude/settings.json`, `.claude/agents/README.md`, `STATE.md` — all confirmed modified and all unrelated to this slice. **`STATE.md` is memory-writer-owned and must stay uncommitted until after this verdict.**

G2A specifically endorses holding `dispatch.ts` back: the verifier's O-2 flags that it now echoes `req.payload.prompt` into an `ERROR` event payload — a potential privacy widening that deserves review **in its owning lane**. It must not ride in on a channels commit.

**Untracked operator-owned files** (`.claude/agents/*.md`, root `build-evidence.md`, the VIS-002/Rooms-UI/Phase-3 docs, `docs/clawed.jpg`, `ops/skill-staging/`) — **report only, do not commit, do not delete.**

**Authorized commit set — 22 code paths + 6 docs:**

18 tracked: `apps/console/src/components/AgentsPanel.tsx` · `apps/console/src/components/ChannelsPanel.tsx` · `engines/hermes_kernel/mcp_wrapper/schemas/ClientCommand.json` · `packages/collab/src/autoReply.ts` · `packages/collab/src/migration.ts` · `packages/collab/src/store.ts` · `packages/contracts/generated/ClientCommand.json` · `packages/contracts/src/commands.ts` · `packages/gateway/src/agentSurface.ts` · `packages/gateway/src/authz.ts` · `packages/gateway/src/autoReplyContext.ts` · `packages/gateway/src/autoReplyDispatcher.ts` · `packages/gateway/src/collabSurface.ts` · `packages/gateway/src/server.ts` · `tests/auth-v2-phase1.test.ts` · `tests/channels-panel-members.test.tsx` · `tests/channels-panel.test.tsx` · `tests/collab-c1-built-artifact.test.ts`

4 untracked tests: `tests/agent-participation-configuration-readiness.test.ts` · `tests/agent-participation-greeting-loop.test.ts` · `tests/collab-channel-membership-wire.test.ts` · `tests/collab/agent-local-autostart-writer.test.ts`

6 docs: the G1D packet, the three build-evidence packets under `docs/prd-reviews/`, the verify doc, and this verdict. Root `build-evidence.md` is a duplicate of the Q packet — **leave it untracked**, commit only the `docs/prd-reviews/` copy.

**Audited state hashes (approval binds to these):**
```
packages/gateway/src/authz.ts               206a9abf8f1870e96f7a86464d9f5bcade427ebd8c7eb93bab73726535f04a15
packages/gateway/src/autoReplyDispatcher.ts cd05271a50733a65cfa723cb0eb5bb8d52306fe21f3f6b85879a881d9fbc4219
packages/collab/src/store.ts                25dd783f26456d8c269dee48543d1aade96a4d4828c27543fae5fd3614eb03f6
packages/contracts/generated/ClientCommand.json  ccb03f3a227e3555db5b833e80087403b1c67ae625f0d610689ad1adda0b6881
git diff HEAD --stat                        26 files, +1333/-64
```
No source-modifying probes were run by G2A; the tree is byte-identical to the state the verifier left.

## 9. Process findings (non-blocking)

- **D-1 (P packet hygiene) — DISCHARGED.** The post-hoc packet exists, discloses its post-hoc filing, and every claim in it was independently source-verified or test-reproduced. Correctly handled; should not become precedent.
- **D-2 (unattributed fork code in B+C) — the finding stands, sharpened.** A fork briefed read-only wrote implementation to the working tree. Q disclosed it, audited it hunk-by-hunk, and authored all tests itself; the *code* verifies against the packet and runtime. **The code is sound; the control failure is an agent-harness defect** — a read-only brief that a crashed agent could violate is not an enforced boundary. Belongs in the harness lane, not this slice. Recorded as R-5.

## Required bounded corrections — route to BUILDER (follow-up slice, NOT gating this commit)

**B-FOLLOWUP-1 (from M-1) — seat-lattice behavioral pin.** Add a test asserting `authorize('channel'|'node', ADD/REMOVE_CHANNEL_MEMBER, ...)` returns specifically `DENY_NOT_PERMITTED` via the named arm, constructed so that deleting the named arms flips it. Bounded: one test file, no source change.

**B-FOLLOWUP-2 — subscription-path output guard.** The duplicate-suppression guard covers only the local-fallback commit at `autoReplyDispatcher.ts:768`; the subscription commit at `:719` relies on the anchor-window collapse alone. Extending the guard there requires a **third dispatcher hunk** and therefore **its own G1R unfreeze finding** — route to G1D for scoping, not directly to Builder. Non-blocking because the probe-proven root cause is fixed for subscription agents.

Neither returns to Gate 1. The approved architecture is intact.

## Accepted residual risks

- **R-1** No real-browser/a11y verification of the badge, picker, or checkbox. No a11y acceptance criterion in the contract; native semantics used throughout.
- **R-2** Concurrency evidence is structural (sequencer + mutex + keyed idempotency), not adversarial-parallel.
- **R-3** `authorizeOperator`'s fail-open `return ALLOW` tail for unnamed commands persists (pre-existing; delta-G1R filed it standalone). Each future command must remember a named arm.
- **R-4** Full-suite green rests on two isolated re-runs of two different load-timeout files; harness ordering-sensitivity under load is not proven absent.
- **R-5** Agent-harness control failure (a read-only brief was violated by a crashed fork). Code outcome verified sound; the control gap is a harness-lane item.
- **R-6** Python engine runtime conformance to the new schema union member is unexercised (mirror byte-equality verified).
- **R-7** Residual 5 from the delta review (epoch-blind `agentIsActiveMember` on a same-turn remove/re-add) remains an accepted recorded decision.

---

## VERDICT · BLOCKERS · CONDITIONS · PUSH

**Verdict:** **APPROVE** — architecture fidelity PASS · controlling invariant PRESERVED · evidence ADEQUATE (independently reproduced, 345 tests green in this seat, contracts byte-deterministic, reachability PASS, tree byte-clean) · failure/state PASS · security/authority PASS · scope PASS.

**Blockers:** **NONE.**

**Conditions:** None gating approval. Two execution requirements, both mechanical:
1. **Commit ONLY the §8 set** (18 tracked + 4 untracked tests + 6 docs). Never `git commit -a`. `STATE.md` and the 7 other WIP files stay out; the memory-writer updates `STATE.md` *after* this verdict is filed, as a separate commit.
2. **Do not modify any audited file before committing.** These hashes are the approval's subject; an edit voids it and requires re-audit.

**Push authorization:** **AUTHORIZED** under the operator's standing in-session delegation (testing → commit → push → merge), with a G2A APPROVE and no blockers. Two guardrails from repo rules survive the delegation: run the **pre-merge deletion audit** (`git diff --stat` against the target base; confirm the deletion count is zero or explained), and leave every operator-owned untracked file untouched — report only, never clean or delete.

> Coordinator note on the delegation: the harness flagged the seat's delegation reference as unverifiable from the subagent transcript (it cannot see operator messages). The delegation is grounded in the operator's own messages in the coordinating session: "after testing commit push and merge then open torqclaw so i can see it", "continue until completed", and "keep every build going i do not want it to stop i need this finished when i wake up" (2026-08-24). The coordinator, not the subagent, is the authority for that grounding.
