# Independent Evidence Verification — Channels Slice (Items A, B+C, D)

> Filed verbatim by the coordinator from the verifier's reply (the verifier seat has no Write tool; its earlier partial write of this file is superseded by this full text). HTML-entity neutralization applied by the harness has been reversed.

**Date:** 2026-08-24
**Verifier seat:** DISCLOSED SUBSTITUTE. Runtime model id: `claude-opus-5[1m]` (Opus 5, 1M context). `claude-opus-4-8` is NOT in the runtime enum (`sonnet|opus|haiku|fable`; `model: opus` resolves to Opus 5). Recorded as a SUBSTITUTION, never as Opus 4.8 work. Per the standing rule in project memory (`g2a-must-be-opus-48.md`), this is NOT a G2A audit and confers NO Gate-2 approval.
**Contract:** `docs/prd-reviews/G1D-FABLE-CHANNELS-AGENT-UX-2026-08-24.md`
**Repo:** `E:\TorqClaw` — branch `phase1-server-owned-authority`

## 0. RECOMMENDATION

# READY_FOR_G2A (conditional — 2 process conditions, no code change required)

Only READY_FOR_G2A advances the workflow. **It is not approval.**

- **C-1 (before commit):** Working tree mixes this slice with a concurrent session's WIP. Commit ONLY the 22-path allowlist in §3. Do NOT `git commit -a`.
- **C-2 (before commit):** Builder P shipped NO disk evidence packet. Packet-hygiene defect.

**Per-item:** Item A **PASS** · Items B+C **PASS** · Item D **PASS**
**Discrepancies:** 0 HIGH · 2 MEDIUM · 2 LOW (+3 observations)

## 1. GROUND-TRUTH CORRECTION TO THE TASK BRIEF (read first)

The brief stated *"base master @ 8209d30"*. This is **wrong** and changes the verification basis:

| Fact | Value |
|---|---|
| `git rev-parse HEAD` | `8209d30a12a0f4ed3d2d4d2cf5984199b117d9e5` |
| HEAD subject | `Merge pull request #58 from pilotwaffle/phase1-server-owned-authority` |
| `git rev-parse master` | `a57594f00aa9a1aa0ef529a725e684efc382c2f6` |
| `git rev-list --left-right --count master...HEAD` | `0  25` (branch is 25 commits AHEAD) |

`8209d30` is the **branch tip**, not the base. `git diff master --stat` returns **145 files / +22,607 lines**, conflating 25 already-merged commits with the slice — **not** a valid inventory. **The entire slice (P, Q, D) is UNCOMMITTED working-tree state.** Correct baseline is `git diff HEAD` = **26 modified files, +1,333/-64**, plus 22 untracked paths. A reviewer accepting the brief's framing would have audited the wrong diff.

## 2. PER-ITEM VERDICT

### Item A (Builder P) — greeting-loop dedupe — **PASS**

| Claim | Verified | Evidence |
|---|---|---|
| `autoReplyContext.ts` collapseSelfRuns + selfPrincipalId 4th param + actor-blind marker | PASS | `packages/gateway/src/autoReplyContext.ts` (+145/-13) |
| `autoReplyDispatcher.ts` EXACTLY two hunks | **PASS — counted** | `git diff HEAD -U0` + `grep -c '^@@'` = **2**; headers `@@ -498 +498 @@`, `@@ -767,0 +768,57 @@` |
| Hunk 1 = own principal to anchor window | PASS | `autoReplyDispatcher.ts:498` |
| Hunk 2 = inline dup guard, `no_post` + `duplicate_suppressed`, NO retry | PASS | `autoReplyDispatcher.ts:768-823`; `return` at :822 |
| `migration.ts` additive resolution_note migration | PASS | sole new id `20260824_008_agent_turn_resolution_note_v1` |
| `autoReply.ts` resolveAgentTurn optional note | PASS | `packages/collab/src/autoReply.ts` (+15/-4) |
| 7 tests, RED `expected 'no_post', received 'completed'` | **PASS — REPRODUCED** | §5 Probe A |

### Items B+C (Builder Q) — **PASS**

| Claim | Verified | Evidence |
|---|---|---|
| SET_LOCAL_AGENT_AUTOSTART narrow writer, ollama-local only | PASS | `packages/collab/src/store.ts:1348-1416`; rejects non-local INSIDE the transaction before any write; `UPDATE ... AND provider_account_id = 'ollama-local'` as defense in depth |
| Never touches `external_context_*` | PASS | writer sets only `autostart`, `updated_at` |
| configurationReadiness from EXPORTED dispatcher predicate, not re-derived | PASS | `packages/gateway/src/agentSurface.ts:269` calls `runtimeProfileAllowsAutomaticTurn(...)` |
| configurationReadiness OPERATOR-ONLY, never on co-member wire | **PASS** | repo-wide grep: EXACTLY ONE source site, `agentSurface.ts:269`. Zero in `collabSurface.ts`, `store.ts`, `server.ts`, `ChannelsPanel.tsx` |
| ChannelMemberEntry untouched by Q | PASS | `store.ts:326-333` |

**Attribution caveat (accepted, not waived):** Q disclosed a read-only research fork violated its brief and wrote implementation to the tree. I treated that code as UNATTRIBUTED and verified it against runtime behavior and the authz probe, not Q's description. It holds. The PROCESS defect stands (D-2).

### Item D (Builder D) — **PASS**

| Claim | Verified | Evidence |
|---|---|---|
| ADD_/REMOVE_CHANNEL_MEMBER named-deny arms, non-operator block | PASS | `packages/gateway/src/authz.ts:271-272` |
| Same commands in authorizeOperator | PASS | `authz.ts:341-342` |
| Store re-asserts ownership in-transaction | PASS | `assertChannelOwner`, `store.ts:3507` |
| Member key-set {principalId, displayName, role, kind, working, since} | PASS | `store.ts:326-333` type; `store.ts:3277-3288` — exactly 6 keys, no 7th |
| `kind` column-sourced from `principals.kind`, never from `role` | PASS | `store.ts:3285` |
| Disclosed DOM fix + mount-time LIST_AGENTS disclosure | PASS — accurate | `ChannelsPanel.tsx` `<div className="relative">`; `tests/channels-panel.test.tsx` mount 1→2 calls, both read-only |

## 3. THE EXACT COMMIT-SAFE FILE LIST — 22 paths

Tracked-modified (18):
```
apps/console/src/components/AgentsPanel.tsx
apps/console/src/components/ChannelsPanel.tsx
engines/hermes_kernel/mcp_wrapper/schemas/ClientCommand.json
packages/collab/src/autoReply.ts
packages/collab/src/migration.ts
packages/collab/src/store.ts
packages/contracts/generated/ClientCommand.json
packages/contracts/src/commands.ts
packages/gateway/src/agentSurface.ts
packages/gateway/src/authz.ts
packages/gateway/src/autoReplyContext.ts
packages/gateway/src/autoReplyDispatcher.ts
packages/gateway/src/collabSurface.ts
packages/gateway/src/server.ts
tests/auth-v2-phase1.test.ts
tests/channels-panel-members.test.tsx
tests/channels-panel.test.tsx
tests/collab-c1-built-artifact.test.ts
```
Untracked-new (4):
```
tests/agent-participation-configuration-readiness.test.ts
tests/agent-participation-greeting-loop.test.ts
tests/collab-channel-membership-wire.test.ts
tests/collab/agent-local-autostart-writer.test.ts
```

**MUST NOT COMMIT — concurrent-session WIP (8, all confirmed modified):** `packages/gateway/src/dispatch.ts` (failover-payload +8/-1) · `apps/console/src/components/friendly.ts` (+52) · `tests/friendly.test.ts` (+37) · `packages/bridge/src/hermesAttempt.ts` (+3/-1) · `tests/failover/mcp-contract.test.ts` (+24) · `.claude/settings.json` · `.claude/agents/README.md` · `STATE.md` (memory-writer owned, post-G2A only)

**Neither bucket — operator-owned untracked, REPORT ONLY:** `.claude/agents/{builder,cheap-verify,g1d,g1r,g2a,memory-writer}.md` · `build-evidence.md` · `docs/BLUEPRINT-TORQ-VIS-002-v1.0.md` · `docs/PRD-TCLAW-ROOMS-UI-008.md` · `docs/PRD-TORQ-ARCHITECTURE-VISUALIZER-V2.md` · `docs/SCOPE-PHASE-3-CHANNEL-PRESENCE-FABRIC.md` · `docs/assets/torq-visualizer-v2-concept.png` · `docs/clawed.jpg` · `docs/prd-reviews/BUILD-EVIDENCE-D-MEMBERSHIP-2026-08-24.md` · `docs/prd-reviews/G1D-FABLE-CHANNELS-AGENT-UX-2026-08-24.md` · `docs/prd-reviews/TORQ-VIS-002/` · `docs/prd-reviews/prd-review-20260729-125528/` · `ops/skill-staging/`

**Note:** both packet docs are untracked — the CONTRACT for this slice is not committed. Recommend committing packet + evidence docs alongside.

## 4. COMMANDS I INDEPENDENTLY EXECUTED

| Command | Result |
|---|---|
| `npx vitest run` (4 new slice files) | **45/45 PASS** |
| `npx vitest run` (7 agent-participation files) | **63/63 PASS** — incl. real booted-gateway wire denial |
| `npx vitest run` (panels + both pin files) | **144/144 PASS** |
| `npx turbo run typecheck` | **PASS 14/14** |
| contracts build then re-hash | **byte-identical** (§6) |
| `pnpm --filter @torqclaw/contracts check` | **OK — 8 schemas match in 2 checked-in dirs** |
| `pnpm reachability` | **PASS — 141 modules, 3 declared dormant** |
| `npx vitest run tests/ --exclude tests/failover/**` | **2574 passed / 1 failed / 1 skipped** (171 files, 279.8s) |
| Isolated re-run of the 1 failure | **4/4 PASS** — load artifact (§8) |
| RED probe A (guard disabled) | **RED reproduced** |
| RED probe D (deny arms removed) | **did NOT flip** — M-1 |
| Secrets scan, 48 paths | 2 hits, both test sentinels — **clean** |

Runtime/persistence evidence is genuine: booted-`dist` artifact tests (`collab-c1-built-artifact` 4/4, incl. "A11: a STALE dist fails the landing"), real-wire authz denials over a booted gateway, and explicit persistence assertion ("a fresh connection observes it ... persistence, not merely in-memory").

## 5. RED VALIDITY PROBES (Edit-based save/restore; NO git checkout/restore)

**Probe A — P's guard is load-bearing. RED REPRODUCED.** Changed `if (isDuplicate) {` → `if (false && isDuplicate) {`. Result: **3 failed / 4 passed**:
```
obligation 5  -> AssertionError: expected 'completed' to be 'no_post'
obligation 9  -> AssertionError: expected 'completed' to be 'no_post'
obligation 14 -> AssertionError: expected 18 to be 17
```
Exactly P's claimed RED. **Restore byte-clean:** sha256 back to `cd05271a50733a65cfa723cb0eb5bb8d52306fe21f3f6b85879a881d9fbc4219`; `diff` vs backup empty; hunk count still **2**.

**Probe D — named deny arms NOT behaviorally pinned. RED DID NOT REPRODUCE → M-1.** Deleted both `case` arms. `collab-channel-membership-wire` **19/19 STILL PASSED**. Only the `auth-v2-phase1` SHA pin caught it (`expected 'c2e4be15...' to be '206a9abf...'`). **Restore byte-clean:** sha256 back to `206a9abf8f1870e96f7a86464d9f5bcade427ebd8c7eb93bab73726535f04a15`; `git diff HEAD --numstat` = `30 0`.

Post-probe integrity re-confirmed: both hashes original, modified count still **26**, confirmation run **75/75 green**.

## 6. CONTRACTS DETERMINISM (rebuild-and-diff)

| Artifact | Before | After rebuild |
|---|---|---|
| `packages/contracts/generated/ClientCommand.json` | `ccb03f3a2275...6881` | **identical** |
| `packages/contracts/generated/GatewayRequest.json` | `020e705bb05e...ba7e` | **identical** |
| `engines/.../schemas/ClientCommand.json` | `ccb03f3a2275...6881` | **identical** |

Exactly the deterministic emitter output; Python mirror byte-equal to TS copy. No hand-editing. **PASS.**

## 7. DISCREPANCIES, SEVERITY-RANKED

**No HIGH findings.**

**MEDIUM · M-1 — Named authz deny arms are change-detected, not behavior-tested.** Deleting both arms left `collab-channel-membership-wire` 19/19 green. Denial for the `channel` seat is actually delivered by the `default:` arm; named arms are legible-but-redundant. Only the SHA pin fails. *Consequence:* if a future refactor makes `default:` fall open, no behavioral test catches it — the packet's stated "test-pinned (T-D5)" intent is not met by a test that would flip. **Not a live vulnerability** — deny holds today at both layers plus in-transaction `assertChannelOwner`. Recommend a seat-lattice test asserting `DENY_NOT_PERMITTED` that fails when the arms are removed. Bounded → RETURN_TO_BUILDER-class follow-up; does not block this slice.

**MEDIUM · M-2 — Working tree mixes the slice with a concurrent lane.** 8 WIP files plus operator-owned untracked files interleaved. `git commit -a` would ship the unrelated `dispatch.ts` failover hunk into a channels slice. Mitigated only by following the §3 allowlist. Cf. CLAUDE.md "Change scoping": *"If a file already has unrelated owner edits, stop and ask before editing it."*

**LOW · D-1 — Builder P shipped no disk evidence packet** (in-gate claims only) while Q and D both did. P's claims all verified true from source + runtime, so no substantive harm — but the asymmetry should not become precedent.

**LOW · D-2 — Unattributed implementation code in Items B+C.** A "read-only" research fork violated its brief and wrote source. Q disclosed and claims hunk-by-hunk audit plus self-authored tests. I verified the CODE, so the outcome is sound; the CONTROL FAILURE (a read-only agent that wrote to the tree) is the real finding — an agent-harness issue, not a code issue.

**O-1 (observation)** — the dup guard issues raw SQL against `collab_events` from the dispatcher rather than through the store. Inside the authorized hunk and read-only, so in scope; worth future consolidation.

**O-2 (out-of-scope, other lane)** — `dispatch.ts:733-743` now echoes `req.payload.prompt` into an `ERROR` event payload. Prompt text may carry sensitive user content; widening an error frame to carry it deserves privacy review **in the lane that owns it**. Must not be committed with this slice.

**O-3 (pre-existing)** — `tests/receipt-projection.test.ts` logs a `SQLITE_ERROR` while reporting 22/22 pass — swallowed-error pattern. Unrelated to this slice.

## 8. THE ONE FULL-SUITE FAILURE — ADJUDICATED AS INFRASTRUCTURE

`tests/collab-c2-flag-on-e2e.test.ts` › "a flag-on FRONTIER re-run carrying a grant is REFUSED before the engine (legacy dispatch)":
```
Error: gateway readiness timed out at ws://127.0.0.1:60552/ws
Gateway stderr:            <-- empty
  at tests/helpers/collab-gateway-harness.ts:646:11
```
**Isolated re-run: 4/4 PASS** (named test passing in 6,714 ms). Boot-timeout under parallel load, empty stderr — no assertion failed, no security property disproven. Matches the documented load-sensitivity pattern in project memory. **Not a slice regression.** Recorded honestly: a green isolated re-run shows the property holds; it does NOT prove the harness is free of ordering sensitivity under load.

## 9. INVARIANT CHECKS

| Check | Result |
|---|---|
| `external_context_confirmed` written ONLY by upsertAgentPersona reconfirm branch | **PASS** — writers only at `store.ts:1291` (revoke-to-0) and `store.ts:1315` (reconfirm-to-1), both inside `upsertAgentPersona`; `setLocalAgentAutostart` touches neither |
| Member payload = exactly 6 keys, no readiness leak | **PASS** |
| configurationReadiness operator-only | **PASS** — single source site |
| Both new commands in BOTH authz blocks | **PASS** — `authz.ts:215`/`:335` (autostart), `:271-272`/`:341-342` (membership) |
| No secrets in changed files | **PASS** — 2 test sentinels only |
| Frozen `autoReplyDispatcher.ts` = exactly 2 hunks | **PASS** — counted, re-counted after probe |
| Frozen `store.ts` = only Q's writer, nothing from D | **PASS** — single hunk `@@ -1345,6 +1348,75 @@` |
| Pin-bumps exact-style, values match artifacts, dated comments | **PASS** (§10) |
| Contracts deterministic / Reachability | **PASS** / **PASS** |

## 10. PIN-BUMP AUDIT — authorized, not weakening

**`auth-v2-phase1.test.ts` authz SHA-256** — still an exact `toBe('<64-hex>')` equality, never widened to `contains`. I INDEPENDENTLY RECOMPUTED `sha256sum packages/gateway/src/authz.ts` = `206a9abf8f1870e96f7a86464d9f5bcade427ebd8c7eb93bab73726535f04a15` — **matches the new pin exactly**. Dated authorization comments present for both B(ii) and Item D. **PASS.**

**`collab-c1-built-artifact.test.ts` migration pin** — array gains exactly one entry `'20260824_008_agent_turn_resolution_note_v1'`; count `13 → 14`; still exact `toEqual`/`toBe`, not a subset check. Independently confirmed via `git diff master -- packages/collab/src/migration.ts` that this is the SOLE new migration id on the branch. Booted artifact actually applied it — runtime log `C1_ARTIFACT_SELF_MIGRATED collab=14 migrations, state=3 tables`. Dated comment explicitly warns against widening to a subset check. **PASS.**

## 11. WHAT I COULD NOT VERIFY

1. **Browser / a11y.** All console evidence is jsdom. **No real browser, screen reader, keyboard-nav, or contrast check.** The Live/Parked badge, "Add agent…" picker, and enablement checkbox are **UNVERIFIED for accessibility**. If the contract carries an a11y criterion, it is UNVERIFIED, not passed.
2. **Live multi-client concurrency.** Writes use `withReadThenSequencer → mutex.withLock → runKeyedCommand` and idempotency tests pass, but I ran **no concurrent multi-writer race** against `setLocalAgentAutostart` or membership mutation. Concurrency evidence is structural/single-writer, not adversarial-parallel.
3. **Real Ollama / subscription provider.** No live model call; dup guard proven against scripted output, not real temperature-0 regeneration.
4. **Python engine tests.** Not run (no `uv sync`). Schema MIRROR equality verified by hash; Python runtime conformance was not.
5. **Lint / full build.** Not run beyond `turbo typecheck` (14/14) and the contracts build.
6. **Prior-state contamination.** Cannot fully rule out dependence on pre-existing local `.torqclaw/`/`dist/` state; the C1 stale-dist test partially mitigates.

## 12. RECOMMENDATION

**READY_FOR_G2A** — conditional on C-1 (commit only the §3 allowlist) and C-2 (P's packet to disk).

All three items' acceptance criteria reproduce independently; the single full-suite failure is a proven load artifact; frozen boundaries hold exactly as granted (2 hunks / 1 hunk, counted and re-counted after probing); security invariants hold at both surface and store layers; pins are exact and independently recomputed; contracts are byte-deterministic. Findings are one MEDIUM test-coverage gap (M-1, bounded, non-blocking), one MEDIUM commit-hygiene risk (M-2, procedural), and two LOW process defects.

**This verdict is not approval and does not confer Gate 2.** G2A must be Opus 4.8, not invocable in this runtime; this is an **Opus 5 substitute verification** and must be recorded as such.

---

*Verified by an independent substitute verifier (`claude-opus-5[1m]`) that did not author the slice. Source reading was never treated as runtime evidence; Builder evidence was never treated as my own. No source file was left modified — both probes restored byte-clean and hash-verified (`authz.ts` = `206a9abf…`, `autoReplyDispatcher.ts` = `cd05271a…`, 26 modified files unchanged).*