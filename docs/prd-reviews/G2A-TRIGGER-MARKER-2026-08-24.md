# G2A Gate-2 Verdict — Trigger-keyed newest-message marker (2026-08-24)

> Filed verbatim-condensed by the coordinator from the G2A seat's reply. Seat: DISCLOSED SUBSTITUTE, runtime claude-opus-5[1m] (Opus 4.8 non-invocable; recorded per the operator's 2026-08-22 session profile). Fresh seat; did not author, review, build, or verify this slice.

## VERDICT: APPROVE — approval hash-bound to:
```
autoReplyContext.ts    1892b48f54db4ad29400c96b70657d37eb8241cc3e9b0f9ddcbc5a24f5192802
autoReplyDispatcher.ts cef5789e43fd6a0431efe3bfd435708615e33cd3d0db7c3e0b84f4529d60c3d4
trigger-marker.test.ts edf700485b2c1e949f99492bc26865c9284325e50cc3ebf57b28a603b0f986ff
greeting-loop.test.ts  a213ecab1d19338633ac534af74d55c868da89262c34f1ca2a73212ffa099082
```
Any further source change voids it.

## Findings (condensed)
- **Architecture fidelity PASS:** selection `Number(ev.cursor)===triggerChannelSeq` at :341 from the claim; renderEvent-produced line (byte-identity by construction); exported literal banners (:34-35); gate `triggerChannelSeq !== undefined`.
- **Boundary PASS:** dispatcher exactly 1 hunk (:498, -U0 count 1); :550 and :780-824 byte-identical; ollama/cron/collab zero-diff; only two call sites repo-wide, both accounted.
- **Invariant HELD — 10 independent dist-level probes all PASS** (rebuilt --force first): operator-trigger-amid-collapse (twin present) · self-trigger omitted · non-message omitted · absent-cursor omitted (R-8) · anchor-only omitted · cross-agent renders · **P7: racing S+1 seeded — banner names S** (F-1 closed, direct proof) · cron 4-arg ≡ explicit-undefined, marker-free (obligation 8) · subscriptionText marker-free actor-blind (obligation 7) · exactly one terminal OPEN/CLOSE. **No fallback branch exists** (grep-swept).
- **Disjointness VERIFIED** and doubly safe: collapse requires actor===self, marker requires !==; and renderEvent-on-raw would preserve byte-identity for any non-elided entry regardless.
- **Failure/state PASS:** degenerate inputs (non-string text, empty payload, NaN/-1/0/1.5 seqs) — no throw, fail closed (gateway-throw-kills-process class checked). Read-only consumer of the claim; no persistence/async surface.
- **Security PASS:** R-6 probed — a forged banner mid-transcript cannot displace the real trigger's terminal position; escaping stays unauthorized (byte-identity). Obligation-7 actor-blindness preserved.
- **C-1 (MANDATORY, docs-only, landed pre-commit):** both prior packets misdescribed the collab-c2-flag-off-identity failure — Builder "deterministic", verifier "4/4 green/transient". G2A executed 6 runs: slice tree 1P/2F, stashed baseline 0P/3F — **chronically flaky (~1/3 pass), causally independent** (zero slice symbols; classifier-identity swap flipping mid-run). Invariant 9 / §6 honesty: both lines corrected with dated notes. No re-verify needed (zero source bytes).
- **R-9 (new, LOW latent):** T-4 pin uses .match() (first occurrence) — correct today (single call site), silently re-targets if a call is added above :498.

## Residuals
R-6 (banner forgery, pre-existing class) · R-7 (quoting likelihood, persona layer) · R-8 (busy-channel honest omission; follow-up = Buzz mechanic #1 swap-in) · R-9 · R-1/R-3/R-5 carried · **collab-c2-flag-off-identity chronic flake → separate ticket recommended (live false-signal generator)**.

## Conditions
C-1 lands before the docs commit (DONE, dated notes in both packets) · operator authorization for commit/merge/push (grounding = coordinator's record of the standing in-session delegation) · **AC-2 stays OPEN: the live Paris-class turn is operator-witnessed post-merge — the slice's purpose is runtime-unproven until it happens; the 3/3 bench is supporting, not confirming** · pre-merge deletion audit · rebuild gateway dist before any live claim (four seats bitten by stale dist) · explicit per-file git add; CLAUDE.md (+5 operator WIP) and all other WIP/untracked operator files excluded.

## Commit plan (confirmed)
Code: autoReplyContext.ts · autoReplyDispatcher.ts · tests/agent-participation-trigger-marker.test.ts · tests/agent-participation-greeting-loop.test.ts. Docs: G1D + G1R + BUILD-EVIDENCE (C-1) + VERIFY (C-1) + this verdict.

**PUSH RECOMMENDATION:** push after C-1 (done) on operator authorization; code is sound — "I would ship it"; file the flaky-test ticket separately.
