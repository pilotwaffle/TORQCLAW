# G1D Packet — Newest-message marker in the channel window render (micro-slice)

**Date:** 2026-08-24 · **G1D:** Fable 5 (coordinator) · **Status:** v1.1 — G1R REJECT (F-1) resolved by this amendment; build authorized under the G1R boundary (`G1R-NEWEST-MESSAGE-MARKER-2026-08-24.md`)

> **AMENDMENT v1.1 (G1D resolution of G1R F-1 — the marker must carry TURN IDENTITY, not timeline position):**
> - The marker event is selected by **`triggerChannelSeq`** (the claimed trigger, `claimed.identity.channelSeq`), threaded as a new optional 5th parameter of `buildAnchorWindowContext` and matched by `Number(ev.cursor) === triggerChannelSeq`. "Newest message_posted in the window" is WITHDRAWN — it was a second source of truth for turn identity (racing-operator / self-targeting / cross-agent misattribution failures, G1R F-1).
> - **Fail closed:** trigger cursor absent from the window, or matched event not a `message_posted`, or matched event self-authored (`actorPrincipalId === selfPrincipalId`) ⇒ **omit the section entirely.** No newest-fallback of any kind. §Scope item 1's "use the newest message_posted and say so" branch and test (b) are DELETED.
> - **Gating:** the section renders iff `triggerChannelSeq !== undefined` (cron passes none ⇒ automatically byte-identical; obligation-8 preserved).
> - **Render discipline:** the repeated line is produced by the SAME `renderEvent` function (never a parallel format string); the OPEN/CLOSE banners are exported string constants.
> - **Dispatcher:** exactly ONE authorized hunk — `autoReplyDispatcher.ts:498` gains `claimed.identity.channelSeq` as the 5th argument (G1R F-2 ruling). Everything else in that file stays frozen; `ollama.ts` zero diff.
> - Tests = G1R's T-1..T-8 (superseding the packet's list); AC-2 live turn remains post-merge, operator-witnessed. New residuals R-6/R-7/R-8 recorded in the verdict.
**Parent context:** post-PR#60 reply-QUALITY gap (`docs/BUZZ-MECHANICS-SURVEY-2026-08-24.md`; memory `channels-agent-defects.md` "LAST-GAP DIAGNOSIS"). Operator: "Research and find out what the best way to proceed" — this packet is the research output.

## The defect (bench-proven, all evidence executed today against the real live prompt from state.db)

The fallback prompt's preamble says "the context below already includes the triggering human message" but never marks WHICH event is the trigger. Consequences measured on the exact live prompt (6,807 chars, 44 events, persona rev 14, temp 0, num_ctx 8192):
- `torq-ai-v5`: answers the newest question when it emits fully, but emission is nondeterministic (temp-0 prompt-cache sensitivity — live emitted only a 72-char tail line; replay of identical bytes → full correct answer; truncation ruled out by code audit of ollama.ts `done()`, failover.ts passthrough, and the result write).
- `llama3.1:8b` / `torq-local`: reliable and fast (0.9–1.5s) but **answer the WRONG message** — both grabbed the anchor block's old "sort these words" instruction instead of the newest question.

## The fix (Buzz mechanic #3, bench-validated 3/3)

Append an explicitly labeled final section repeating the newest `message_posted` event:

```
--- NEWEST MESSAGE — this is the message you are responding to ---
[#560] <actor> (message_posted): <text>
--- END NEWEST MESSAGE ---
```

**Bench (exact live prompt + this section, temp 0):** torq-ai-v5 → "PARIS" (10.7s) · torq-local → "Paris." (12.8s) · llama3.1:8b → "Paris." (0.9s). A weaker pointer-only variant also worked but torq-ai-v5 padded with stale re-answers; the full repeated section is the clean winner. Buzz provenance: scope always derived from the LAST batch event, rendered as a separate final `[Buzz event]` section with the full structural record (`queue.rs:1412-1423, 1081-1147`).

## Scope

1. `packages/gateway/src/autoReplyContext.ts` (**NOT frozen**): in the window render (`buildAnchorWindowContext` output composition), append the NEWEST MESSAGE section repeating the final `message_posted` event of the recent window, verbatim, same `[#N]` line format. If the newest event is not a `message_posted` (e.g., member change), use the newest `message_posted` and say so in the label. Section text is a named exported constant so tests pin it.
2. Tests (new file or extend `agent-participation-collapse-live-shape.test.ts`): (a) marker present and repeats the newest message verbatim + correct `[#N]`; (b) when the newest event is a non-message, the newest message_posted is used; (c) cron path byte-identical when `selfPrincipalId`/agent path absent — decide at G1R whether the section is agent-turn-only or universal (G1D proposal: agent-turn-only, keyed off the same `selfPrincipalId` presence that gates collapse, so cron/obligation-8 stays byte-identical); (d) deletion probe — removing the section flips the test; (e) existing 10 collapse tests stay green.

## Non-scope
- NO dispatcher edits (preamble string unchanged; the section rides inside contextText).
- NO model change, NO persona change, NO threshold/predicate change, NO subscription renderer change unless G1R rules the section should also serve subscription text (G1D proposal: fallback path only this slice; subscription agents get it as a follow-up if wanted — their renderer is actor-blind and differently shaped).
- NO new commands, contracts, store, or migration changes.

## Controlling invariant
The newest operator-visible message must be unambiguously identified to the model as the thing being answered, by repetition in a labeled terminal section — the model must never have to infer the target from position alone. The repeated text must be byte-identical to the in-window rendering of that event (no paraphrase, no summarization).

## Failure behavior
If the window has no `message_posted` at all, omit the section entirely (render unchanged) — never fabricate a target.

## Acceptance criteria
- AC-1: unit — section renders per spec on the live 44-event shape (fixture reproducing today's channel).
- AC-2: live — post a novel question to build-room after ship; the posted reply answers it (the "Paris-class" check).
- AC-3: cron/obligation-8 byte-identity preserved (if agent-turn-only gating adopted).
- AC-4: full regression: collapse suite, greeting-loop, configuration-readiness, membership-wire green; dispatcher/ollama zero-diff.

## Risks
- Duplicated newest message adds ~1 event of tokens (negligible: window ≈1.7K of 8192).
- A model could answer the newest message twice — mitigated by the existing near-dup guard and the persona's no-repeat directive.
- R-5-class residual unchanged.

## Rollback
Single-file revert; no data, no migration.
