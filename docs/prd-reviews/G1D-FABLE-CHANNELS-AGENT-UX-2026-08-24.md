# G1D Packet — Channels agent UX: greeting loop, enablement path, honest roster (2026-08-24)

**Author:** Claude Fable 5 (G1D). **Base:** the merge of `1ff87fa` (pending) onto master. **Seats:** per session profile (G1R/verifier/G2A = fresh `claude-opus-5`, disclosed substitutes; Builders = `claude-sonnet-5`). **Diagnosis of record:** memory `channels-agent-defects.md` + the 2026-08-24 investigation (probe-proven).

## Operator context (verbatim complaint)
"It really looks like a mess because I don't know what agents are already in or how to add an agent. I just tried to talk to any agent and [got the same canned greeting twice]."

## Root causes (verified)
1. **Greeting loop is in-context self-imitation, not context-blindness.** The dispatched prompt for the failing turn contained the triggering message (state.db `tasks.request_json`, seq-550). The 40-event anchor window held 7 near-identical prior self-replies; a clean-context probe of the same model answered the question correctly.
2. **Subscription agents are unactivatable.** `runtimeProfileAllowsAutomaticTurn` (`autoReplyDispatcher.ts:1139-1148`) requires `autostart && externalContextConfirmed`; no ClientCommand/UI writes either column (high-confidence; Builder must complete the writer-grep before building).
3. **The Members roster hides readiness.** `ChannelMemberEntry` = {principalId, displayName, role, kind, working, since} — nothing distinguishes an agent that can respond from one permanently parked.

## Controlling invariant
**An agent's ability to speak in a channel is server-derived, operator-enabled, and honestly disclosed: enablement is an explicit operator action over the wire (never client-inferred, never defaulted on), the roster shows exactly which members can respond, and an agent's own repeated output must never become the context that replaces the operator's question.**

## Scope
### Item A — anchor-window self-dedupe + output guard (greeting loop)
- `packages/gateway/src/autoReplyContext.ts` (`buildAnchorWindowContext`): when assembling the window FOR agent X, collapse X's own prior `message_posted` events beyond the most recent one to a single `[X posted N earlier replies — elided]` marker. Other principals' messages untouched (the conversation itself is the product). Structural, deterministic, no model judgment.
- `packages/inference/src/ollama.ts`: `looksLikeNearDuplicateOfOwnRecent(text, ownRecentTexts)` guard alongside the existing `looksLikeRawToolCall` guards (:232-270): if the generated reply is a near-duplicate (normalized similarity) of the agent's own last N window replies, retry once with an appended anti-repetition instruction; if still duplicate, resolve the turn `no_post` (silence is valid, A3-f) — never post the duplicate. Counted in telemetry.
- **Frozen-file note:** `autoReplyDispatcher.ts` remains frozen from the prior gate; the preamble line ~549 is NOT edited this slice. If G1R judges the two measures above insufficient without a preamble change, that specific edit needs its own explicit unfreeze finding.

### Item B — enablement path (operator-gated, wire-explicit)
- Contracts: `SET_AGENT_RUNTIME_ENABLEMENT { agentPrincipalId, autostart: boolean }` — operator seat ONLY (authz: same class as agent mutations in `agentSurface.ts`; `channel`/`node` denied; NULL principal ⇒ identity required).
- `external_context_confirmed` stays what it is — the runtime-readiness confirmation — and is set ONLY by the existing readiness probe path succeeding (`connected` + fingerprint match), never directly by the command. Builder first completes the writer-grep: if a confirm flow already exists half-wired (agentSurface CONFIRM?), extend it rather than adding a parallel one (G1R must check this).
- AgentsPanel: per-agent enable toggle wired to the command + a "Test connection" action that runs the readiness probe and displays connected/attestation (kimi/qwen/glm show their real readiness).
- Fail-closed defaults preserved: nothing auto-enables; bootstrap keeps `autostart=0` for subscription profiles.

### Item C — honest roster
- `ChannelMemberEntry` gains `willRespond: boolean` (server-derived: agent kind && autostart && (local adapter || externalContextConfirmed) && participation flags on) — computed in `listChannelMembers`, pushed with presence updates when enablement changes.
- ChannelsPanel Members section renders live/parked distinctly (e.g., "· inactive" suffix on parked agents); key-set equality tests updated to the exact new set.

## Non-scope / prohibited
- No change to approval semantics, STOP, anti-storm mechanisms, grants, or `autoReplyDispatcher.ts` source (frozen; Item A works around it).
- No auto-enablement of any agent; no default-on flags; no turn caps (R-2).
- No persona editing, no model changes, no new providers.
- `.claude/**`, `ops/skill-staging/**`, unrelated docs untouched. The five withdrawn concurrent-session changes stay untouched.

## Acceptance criteria
- **A-1** Replaying the build-room scenario (window pre-loaded with 7 self-greetings) yields either a contextual answer or `no_post` — never a posted near-duplicate; RED against current code using the real seq-550 window shape.
- **A-2** Window dedupe: assembled context for agent X contains at most 1 of X's own prior replies + an elision marker; other principals' messages complete.
- **B-1** `SET_AGENT_RUNTIME_ENABLEMENT` flips autostart for the operator seat; `channel`/`node` seats denied; booted-gateway round trip.
- **B-2** A subscription agent with autostart=1 but unconfirmed context still never dispatches (existing gate holds); after a successful readiness probe sets confirmed, it dispatches (integration test with the scripted ACP driver).
- **B-3** Nothing in the slice writes `external_context_confirmed` except the probe-success path.
- **C-1** `listChannelMembers` returns `willRespond` correct across the four combinations (local/subscription × enabled/parked); key-set equality updated; zero `collab_events` writes (A4-c pattern).
- **C-2** Members UI distinguishes live vs parked (component test).
- Full gates green; dispatcher 0-diff; frozen files untouched.

## Failure behavior / async
Enablement is a single-row UPDATE inside the store's transaction discipline; presence/roster pushes ride the existing per-delivery-revalidated fanout; the duplicate-guard retry is bounded to exactly one.

## Rollback
Each item independently revertible; contracts addition is additive.

## Operator stop conditions
Push/merge under the standing in-session authorization; any G2A REJECT stops the commit; enabling any specific agent remains a per-agent operator click, never part of this slice's code.

---

## G1D resolution of G1R findings (round 1 — seat `claude-opus-5[1m]` substitute; verdict REJECT, six blockers, all accepted)

**Root-cause correction accepted:** the packet's "no enablement writer exists" premise was FALSE — `UPDATE_AGENT_PROFILE { reconfirmExternalContext: true }` → `handleUpdateAgentProfile` → `store.upsertAgentPersona` is the complete, tested, operator+delegate-gated writer for BOTH columns, with revoke-on-every-persona-mutation by design. `external_context_confirmed` is **consent bound to an exact runtime+persona snapshot**, not readiness.

| # | Disposition |
|---|---|
| B-1 | **ACCEPTED.** `SET_AGENT_RUNTIME_ENABLEMENT` deleted from scope. Item B re-scoped: (i) AgentsPanel surfaces the EXISTING reconfirm flow as a legible "Enable this agent to respond" affordance with its real precondition shown, plus "Test connection" via the existing `LIST_AGENT_PROVIDERS` readiness path — no contract change; (ii) the one true missing writer — a post-creation autostart toggle for **local (`ollama-local`) agents only** — ships as a narrow extension of the existing keyed-command discipline in `store.ts` (N-5: keyed, idempotent, sequenced — never a bare UPDATE), authz per N-3 (operator + delegate, surface AND store re-assertion). |
| B-2 | **ACCEPTED.** No probe result is ever persisted into `external_context_confirmed` (it is consent; the DB triggers at `migration.ts:935-946` enforce the full binding). B-2's probe clause and B-3 struck; replaced by pinning the EXISTING stale-binding refusal (`autoReplyDispatcher.ts:571-589`) — T-4 of the obligations. Readiness display recomputes live at listing time; nothing persisted. |
| B-3 | **ACCEPTED — unfreeze, explicitly bounded to TWO named hunks** in `autoReplyDispatcher.ts`: (1) the argument list at `:498` gains `selfPrincipalId: agentPrincipalId`; (2) the duplicate-suppression guard insertion at the commit decision (between `completedLocalFallbackText` and `commitAgentTurnFallbackOutput`, ~`:767-770`) per B-6. AC amended: "dispatcher diff is exactly those two hunks, proven by `git diff`." The elision marker is **actor-blind on `subscriptionText`** (`[N earlier replies omitted]`); the cron caller (`cronDispatcher.ts:208`) passes NO selfPrincipalId → byte-identical behavior, pinned by obligation 8. |
| B-4 | **ACCEPTED — option (b).** NO `willRespond` on `ChannelMemberEntry`; the member key-set and its equality tests stay byte-unmodified. The honest live/parked roster ships **operator-only in AgentsPanel** from data `handleListAgents` already returns. Option (a) — extending §2a to co-member-visible enablement state — is recorded as a NEW open operator question (OQ-8) with the audience caveat (co-members include agent principals); not bundled here. |
| B-5 | **ACCEPTED.** The operator-only readiness indicator derives via the EXPORTED `runtimeProfileAllowsAutomaticTurn` ANDed with the channel-scoped gates (`isAutoreplyStopped`, `channelAllowsExternalExport`, participation+autoreply flags) — never a parallel formula; conditions it cannot cover (daily limit) are labeled *configuration readiness*, and the UI label says so. |
| B-6 | **ACCEPTED.** Guard moves to the gateway commit decision (unfreeze hunk 2). Retry **dropped** (temperature-0 makes it futile) — suppress and record. Suppression is persisted-distinguishable from chosen silence: additive `resolution_note` (or equivalent discriminator the Builder proposes) on the turn row, set to `duplicate_suppressed`, deletion-probed (obligation 9). Near-duplicate = reviewable constant + minimum-length floor exempting short acknowledgments (obligation 10 records the honest temperature-0 answer). |
| N-1 | **Adopted.** The narrower collapse: only *mutually near-identical runs* of the agent's own replies are collapsed (targets repetition, never amputates distinct chain-of-work); obligation 6(b) is the amputation test. |
| N-2..N-6 | Recorded; N-5/N-3 folded into B-1's re-scope; N-6 noted in the readiness derivation. |

All 16 G1R test obligations adopted verbatim. Gate 1 **resolved**; build may begin under the corrected boundaries.

---

## Amendment 1 (2026-08-24, operator directive — requires G1R delta review before Item D builds)

**Operator (verbatim):** "I want to be able to move agents into the channel, not have them all in the channel at once. Once they're in the channel, I want them to be able to initiate chats with each other once I say hello. As far as those other suggestions you made, go with what you recommend."

**Rulings recorded by delegation:** OQ-4 — flag names `TORQCLAW_AGENT_PARTICIPATION`/`TORQCLAW_AGENT_AUTOREPLY` **RATIFIED as shipped** (G1D recommendation adopted). OQ-8 — enablement-state roster stays **operator-only** (no co-member disclosure; unchanged from B-4(b)). Stack restart happens at this slice's ship time.

### Item D — curated channel membership (NEW)
**Requirement mapping:** "move agents in" = membership management over the wire; "not all at once" = remove/park members; "initiate chats after my hello" = existing A3-c behavior (proven live), activated by membership (Item D) × enablement (Item B) — no new conversation mechanics.

- **Contracts:** `ADD_CHANNEL_MEMBER { channelId, agentPrincipalId }` and `REMOVE_CHANNEL_MEMBER { channelId, agentPrincipalId }` — operator seat only, same authz class as agent mutations (surface `operator` + delegate authority AND store-side re-assertion; `channel`/`node` denied; NULL principal ⇒ identity required). Agents only — a command can never add/remove a human/operator principal (the operator's own membership is bootstrap-owned).
- **Store:** reuse the EXISTING membership internals (`member_added`/`member_removed` committed events, epoch bump on remove, eager subscription close + `authorization_lost` on remove per the S4/T-1 discipline — cite the exact existing functions; extend-don't-duplicate). Keyed, idempotent, sequenced per the store's command discipline (N-5). Re-add after remove bumps `membership_epoch` (existing semantics preserved).
- **Gateway:** collabSurface handlers on the existing publishOnly pattern; membership changes already fan out as committed events — the roster updates live via the existing paths.
- **Console (ChannelsPanel):** Members section gains an operator-only "Add agent…" picker (choices = agents from `LIST_AGENTS` not already active members) and a per-member remove affordance. No co-member-visible change to the member payload (B-4 stands).
- **Acceptance:** D-1 add → agent appears in Members (server round trip) and can be dispatched-to on the next hello (integration: hello → the newly added enabled agent replies; a NON-member enabled agent does not — exclusion proven). D-2 remove → member gone, its live subscription closed `authorization_lost` with NO intervening committed message needed beyond the removal event itself, presence never delivered post-removal (T-1 pattern), and it is never dispatched again (anti-storm/eligibility respects removal — existing `resolveEligibleAgents` membership predicate, pinned). D-3 idempotency + epoch: double-add no-op; remove/re-add bumps epoch, pre-epoch subscription dead. D-4 authz: `channel`/`node` denied; non-owner operator? (single-operator invariant makes owner==operator; assert store-side owner check anyway). D-5 humans unaffected: command rejects non-agent principals. D-6 zero new disclosure: member payload key-set unchanged.
- **Prohibited:** no auto-membership, no bulk-add, no changes to eligibility/anti-storm/STOP, no human-principal membership mutations, no co-member payload changes.

**Sequencing:** Builder P (Item A) unchanged, in flight. Builder Q builds Items B+C+D together after P (shared store.ts). G1R delta review of THIS amendment gates Item D only.

### G1D disposition of the Item D delta review (APPROVE, `claude-opus-5[1m]` substitute seat)
All findings adopted as binding on the Item D builder:
- **ND-1:** real functions are `addChannelMember` (store.ts:1968-2114) / `removeChannelMember` (:2116-2236) — already keyed/idempotent/sequenced with epoch bump, committed events, eager `authorization_lost` close, post-lock fanout. **Call-only**: thin collabSurface handlers wrap them; any diff inside those functions or `assertChannelOwner` (:3507) is a new G1R finding.
- **ND-2:** mid-turn removal is enforced in-transaction at store.ts:2653 (`COLLAB_NOT_PERMITTED`); the LOCAL-agent case is the load-bearing test (T-D2b, deletion-probed). NO membership guard added at dispatcher :825 — dispatcher stays at Builder P's two hunks (T-D8).
- **ND-3:** picker exclusion is UI-cosmetic, client-computed from LIST_CHANNEL_MEMBERS; correctness rests on store idempotency (:2016-2025). No membership fields in `handleListAgents`.
- **ND-4:** both new actions are added to the NAMED delegate-gated block (authz.ts:312-320) AND the non-operator explicit-deny block (:206-256) — never left to the fail-open default arms (T-D5 pins both). Standalone hardening item filed: `authorizeOperator`'s fail-open default for unnamed commands.
- **ND-5:** D-4 asserts the existing owner guard (store.ts:2148, :3515-3523) — closed question.
- **ND-6:** "in the room ≠ can speak" (commit requires membership AND autostart AND, for subscription, a live binding — store.ts:2650-2661). One disclosure sentence ships in the AgentsPanel/ChannelsPanel copy; D ships in the same batch as B/C.
- Residual 5 (epoch-blind `agentIsActiveMember` on a same-turn remove/re-add) accepted as a recorded decision. T-D1..T-D10 adopted verbatim.
**Builder for Item D starts after Builder Q lands (contracts/commands.ts + authz.ts overlap).**
