# G1D Packet — Channels live defects: persona never reaches local agents; self-run collapse ineffective on alternating conversations

**Date:** 2026-08-24 · **G1D:** Fable 5 (coordinator) · **Status:** v1.1 — G1R REJECT resolved by amendment below; build authorized under the G1R grant list

> **AMENDMENT v1.1 (G1D resolution of the G1R REJECT — `G1R-CHANNELS-LIVE-DEFECTS-2026-08-24.md`):**
> - **D-A is WITHDRAWN** pending T-1. G1R falsified its root cause: persona reaches the local model as a dedicated system-role message (`ollama.ts:278/:332-338`, envelope set at `autoReplyDispatcher.ts:664`, verified in built dist); `payload.prompt` contractually excludes persona. The §"Proposed scope" item 2 (dispatcher :550 hunk) is DELETED — **zero dispatcher hunks this slice**. If Builder's T-1 finds the persona system message absent, STOP and report the mechanism; that is a NEW packet, not an in-slice fix.
> - **D-B is respecified as G1R correction (a):** keep run-collapse semantics, but the per-actor "last kept self-post" reference SURVIVES interleaving (other actors' messages / non-message events no longer reset it); collapse only on `looksLikeNearDuplicateOfOwnRecent` hits against that reference. Constants, predicate function, ANCHOR/WINDOW counts, subscription renderer, and the `selfPrincipalId ?` ternaries are all PROHIBITED edits.
> - Test obligations are G1R's **T-1..T-8** (they supersede this packet's AC-2/AC-4 as protection; AC-1/AC-3 stand, re-proven via T-4).
> - B-FOLLOWUP-2 DEFERRED per G1R (accepted residual R-1). B-FOLLOWUP-1 (seat-lattice pin) proceeds in this slice as a test-only rider (NB-3). NB-1 doc-comment rider on `autoReplyDispatcher.ts:549` is NOT authorized (it would be a third hunk in a frozen file; folded into the future B-FOLLOWUP-2 slice instead).
**Parent:** `G1D-FABLE-CHANNELS-AGENT-UX-2026-08-24.md` (shipped PR #59, G2A APPROVE). This packet covers post-ship LIVE defects found during the operator-reported latency/silence investigation, plus G2A's two filed follow-ups.
**Operator authority:** "investigate and make the correct corrections" (2026-08-24, after the canned-greeting recording).

## Live evidence (all from the running stack, 2026-08-24 ~14:00Z)

1. Operator probe task `98e3a321-f349-41bf-ae97-c61bafe68566` (state.db, tier OLLAMA_LOCAL): the dispatcher's assembled prompt contains **no persona/system directives** — only the harness preamble (:550) + channel context — and its RECENT window shows **seven uncollapsed copies** of the agent's own "I'm ready to assist!" post, no elision marker. Model output = that same greeting; the Item-A guard suppressed it (`resolution_note='duplicate_suppressed'`, turn resolved in 3.4–8.1s). Net UX: the agent is **silent** on every message.
2. Turn row confirms `persona_revision=13` was snapshotted (envelope pipeline works) — the content just never enters the local prompt.
3. Discriminating probe: raw `POST /api/chat` to ollama torq-ai-v5 with the SAME directives + question → answered `"34"` in 5.7s. Model and persona are fine; the prompt assembly is the defect.
4. `collapseSelfRuns` (autoReplyContext.ts) collapses only **consecutive** self-messages: `runStart` resets to −1 on ANY interleaving event. Real channel traffic strictly alternates operator↔agent, so the collapse never fires live. The shipped RED→GREEN tests used consecutive self-posts — function proven, artifact-path behavior not. ("Liveness is not readiness" class; record in memory.)

## Defects

**D-A (P1): persona directives are never injected into the local-fallback prompt.** `autoReplyDispatcher.ts:550` builds `prompt` from preamble + `contextText` only. `claimed.personaEnvelope` (content + revision + sha) is in scope a few lines below (:575, used for subscription binding checks). Subscription agents get persona via `assembleSubscriptionPrompt(personaContent, channelContext)` (:210); local agents get nothing.

**D-B (P1): self-run collapse predicate mismatches the real defect shape.** Adjacent-run collapse cannot help an alternating conversation. The window must collapse near-duplicate posts by the SAME agent across the whole window (keep the most recent representative + `[N earlier replies omitted]` marker), regardless of interleaving — same `looksLikeNearDuplicateOfOwnRecent` predicate, applied window-wide per actor, preserving event order otherwise.

**Riders (from G2A verdict, non-blocking there):**
- **B-FOLLOWUP-1:** seat-lattice test pinning the named authz arms (flips when arms deleted). Test-only.
- **B-FOLLOWUP-2:** duplicate-suppression guard exists only on the local-fallback commit branch (:768); the subscription commit (:719) relies on window collapse alone. Needs its own unfreeze finding — G1R rules here whether to include or defer.

## Proposed scope

1. `packages/gateway/src/autoReplyContext.ts` (NOT frozen): change `collapseSelfRuns` to window-wide per-actor near-duplicate collapse; keep the marker actor-blind; cron path must stay byte-identical when `selfPrincipalId` omitted (obligation 8 preserved).
2. `packages/gateway/src/autoReplyDispatcher.ts` (FROZEN — G1R must grant **one new named hunk**): include the persona directives in the local-fallback prompt at :550, sourced from `claimed.personaEnvelope` (the SAME envelope the turn row snapshots — never a second read), placed as an explicit persona block ahead of the untrusted channel context (mirror `assembleSubscriptionPrompt`'s trust-labeling discipline).
3. Tests: (a) live-shape regression — ALTERNATING operator/agent window with repeated near-identical agent posts must render collapsed with marker; (b) local-fallback prompt contains persona directives (assert via dispatched request payload, the state.db-visible artifact — measure the artifact, not the bench); (c) B-FOLLOWUP-1 seat-lattice pin; (d) existing greeting-loop suite stays green.
4. NON-scope: no store/migration changes; no member-payload changes; no new commands; guard threshold constants unchanged.

## Controlling invariant
An agent's own prior output must never displace the operator's newest message as the effective instruction — enforced at BOTH ends: the prompt the model sees (persona + collapsed window) and the commit gate (existing guard). The persona snapshot bound to the turn row must be the same bytes the model was prompted with.

## Failure behavior
Persona-injection failure (missing envelope) must fail the turn honestly (existing resolve paths), never post un-personified output silently. Collapse must never drop the operator's messages or the agent's most recent representative.

## Acceptance criteria
- AC-1: live-shape probe — alternating window, agent answers the newest question (raw-model parity: same question that returns "34" directly must return "34" through the dispatcher path on a temp channel or scripted engine).
- AC-2: dispatched request payload (state.db `request_json.payload.prompt`) contains the persona directives block.
- AC-3: collapse renders ≤1 representative of near-duplicate self-posts per window with an elision marker; operator messages all preserved.
- AC-4: cron path byte-identical when `selfPrincipalId` omitted.
- AC-5: dispatcher diff vs PR #59 state = exactly the ONE newly-granted hunk (if B-FOLLOWUP-2 is included, G1R must name it as a second hunk explicitly).
- AC-6: full greeting-loop + configuration-readiness + membership-wire suites green; auth pin re-bumped only if authz changes (none expected).

## Rollback
Revert the two files to PR #59 state; migration-free, data-free.
