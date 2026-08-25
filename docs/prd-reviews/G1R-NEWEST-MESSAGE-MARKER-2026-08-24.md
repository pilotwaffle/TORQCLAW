# G1R Gate-1 Verdict — Newest-message marker micro-slice (2026-08-24)

> Filed verbatim-condensed by the coordinator from the G1R seat's reply. Seat: DISCLOSED SUBSTITUTE, runtime claude-opus-5[1m]; recorded as substitution.

## VERDICT: REJECT — 1 blocking finding (F-1), correctable inside the same grant. Mechanism itself is correct.

**Controlling invariant (G1R's, adopted over the packet's):** the marker must name the event that AUTHORIZED this turn — the claimed trigger (`claimed.identity.channelSeq`, store.ts:384-389) — never whatever is last in a fresh timeline read at assembly time. Repetition byte-identical to the in-window render; absence of target ⇒ omission, never fabrication.

**F-1 (BLOCKING):** "newest message_posted in the window" re-derives turn identity from a live timeline read (autoReplyContext :193/:218) that nothing fences against the claim (dispatcher :485 claims channelSeq; :498 does not pass it). Reachable failures: (1) racing operator message → marker names Q2 under the turn keyed to Q1, Q1 never answered by anyone; (2) self-targeting on the coalesced path (collapse splice pushes the agent's own elision to the END of out — a naive last-entry read lands on it); (3) cross-agent misattribution under OQ-2. Same conflation class the latestChannelSeqAuthor helper (:463-476) was added to kill. REQUIRED: (a) thread `triggerChannelSeq?: number` as 5th param of buildAnchorWindowContext, select by `Number(ev.cursor) === triggerChannelSeq`; (b) FAIL CLOSED — no event with that cursor in the window, or not message_posted ⇒ omit the section entirely, NO newest-fallback; (c) never mark a self-authored event (actor === selfPrincipalId ⇒ omit). The packet's "non-message → use newest and say so" branch and its test (b) are DELETED — that branch is the defect. Bench transfers intact (in the measured shape the trigger WAS newest ⇒ byte-identical output).

**F-2 (RULING — unfreeze):** ONE dispatcher hunk authorized, `autoReplyDispatcher.ts:498` only: add `claimed.identity.channelSeq` as 5th argument to the existing call. No other line — :550 preamble re-DENIED, :780-824 guard still deferred (R-1). `packages/inference/src/ollama.ts`: ZERO diff, no exception.

**F-3:** duplication is honest (existing render is already a labeled lossy projection); marker line MUST be produced by the SAME renderEvent (:247-260), never a parallel format string (mirroring-validator class); export the OPEN and CLOSE banner constants (literals, not a template fn). Residual: model could read the duplicate as two messages — bench evidence against; accepted.
**F-4:** gate on `triggerChannelSeq !== undefined` (strictly more honest than selfPrincipalId; cron has no turn identity ⇒ automatically byte-identical). Obligation-8 source pin survives (cron call site unchanged); T-4 adds a call-site pin for dispatcher :498.
**F-5:** no new injection surface; banner-forgery via message body = pre-existing unescaped-transcript property → residual R-6 (do not escape; would break byte-identity).
**F-6:** subscription renderer exclusion ACCEPTED (actor-blind obligation 7 forbids a [#N] actor line; path unmeasured) — follow-up with its own bench.
**F-7:** no near-dup-guard interaction (guard scoped to the agent's OWN posts); marker raises verbatim operator-quoting likelihood → persona-layer residual R-7.
**F-8:** smallest-change confirmed refuted twice over (pointer-only measured inferior on torq-ai-v5 AND preamble-only is a denied frozen-file edit).
**F-9 → R-8:** on channels busier than WINDOW_EVENT_COUNT=40 between trigger and dispatch, the trigger leaves the window ⇒ honest omission ⇒ feature degrades silently under load. Follow-up with Buzz mechanic-#1 swap-in.

## Test obligations (packet (a)/(c)/(d)/(e) survive; (b) deleted)
- T-1: marker names the event with cursor === triggerChannelSeq, byte-identical to the in-window line (compare by string-extraction, never test-side re-formatting).
- T-2 (load-bearing): trigger at S, newer operator post at S+1 seeded BEFORE the build ⇒ marker names S; S+1's text absent from the banner. Must FAIL against a newest-implementation.
- T-3: trigger resolves to self-authored ⇒ section omitted; the collapsed self-elision at the end of out is never marked.
- T-4: keep cron source pin; ADD dispatcher :498 call-site pin (four-then-five args); cron ctx.text byte-identical pre/post on a trailing-message fixture.
- T-5: three omission cases — trigger outside window / trigger non-message_posted / zero message_posted — each asserts OMISSION, no fallback.
- T-6: deletion probe flips T-1 AND T-2 RED, proven by running reverted source.
- T-7: full regression; dispatcher = exactly THREE hunks total (two pre-existing + this one); ollama.ts zero.
- T-8: rebuild gateway dist and verify by CONTENT before any live claim (Finding C: three seats bitten).
- AC-2 (live Paris-class turn) = post-merge acceptance, operator-witnessed; not satisfiable by a desk seat.

## Boundary
Permitted: autoReplyContext.ts (signature + parts composition :280-293 + two exported banner constants + doc comment; renderEvent-produced line) · dispatcher :498 one hunk · tests (new file or extend collapse-live-shape; greeting-loop extended ONLY for T-4's added pin). Prohibited: everything else previously frozen/prohibited; no fallback-to-newest; no paraphrase; no weakening existing tests.

## Residuals
R-1, R-3, R-5 unchanged · R-6 banner forgery (pre-existing class) · R-7 quoting likelihood (persona layer) · R-8 busy-channel silent degradation (follow-up).

**Re-gate condition:** file the corrected packet (F-1's three corrections) before Builder starts.
