# G2A Gate-2 Verdict — Channels collapse-fix slice (2026-08-24) — ROUND 1

> Filed verbatim by the coordinator from the G2A seat's reply (seat has no Write tool). Seat: DISCLOSED SUBSTITUTE, runtime claude-opus-5[1m] (Opus 4.8 not invocable); recorded as substitution per the operator's 2026-08-22 session profile.

## VERDICT: REJECT — one blocking defect (B-1), introduced by this slice, undisclosed by both evidence packets

**B-1 (BLOCKING):** `autoReplyContext.ts:145` writes the elision entry IN PLACE at the FIRST self-post's index while storing the MOST RECENT event. Pre-fix that was harmless (reference was always the immediately-preceding slot); with the reference surviving interleaving, the write target is arbitrarily far back — the rendered timeline becomes non-monotonic in exactly the alternating live shape: cursors `1, 14, 3, 5, 7, 9, 11, 13` (measured through the real renderer with the dist-exported predicate; discrimination probe shows PRE-fix monotonic on both shapes, POST-fix non-monotonic on the alternating shape → regression, not inherited). Consequences: (1) the model is told the agent's reply preceded six operator questions it actually answered after; (2) the "earlier replies" marker asserts chronology it cannot prove (§2a-honesty class G1R already ruled on); (3) the actor-blind subscription render is worse — the agent's participation strands at the top above four apparently-unanswered operator questions, a plausible re-trigger for the loop-by-amnesia failure mode this module exists to prevent; (4) violates G1D D-B "preserving event order otherwise" and G1R delta (iii) "in order" on their face. T-4's indices assertion (:386-389) checks operator messages only against each other, so it passes with the defect live.

**Required bounded correction (Builder, inside the existing grant — no Gate 1 return):** on a near-duplicate hit, REMOVE the entry at `lastSelfIndex`, PUSH the new elision entry at the current position, set `lastSelfIndex = out.length - 1`; marker count must still accumulate (`priorCollapsed + 1`); anchor/window blocks stay independent. **New obligation T-9 (order monotonicity):** over the T-4 shape, rendered `[#N]` cursors strictly increasing AND the surviving self-representative renders after every operator message that preceded it in real time — RED against the current state (verified RED by this seat), GREEN after. Re-run T-3..T-6, greeting-loop, 5-file named set. Correct the BUILD-EVIDENCE `20000);` miscount (claims three occurrences; actual FIVE — :139/:337/:398/:428/:476). Fresh G2A on the corrected source.

## Non-blocking findings
- **N-1 (MEDIUM):** evidence-packet miscount above — unsupported claim class; direction harmless; the Finding-A fix itself independently confirmed genuinely one token (T-1 439ms this seat) and ruled NOT to require a full re-verify.
- **N-2 (LOW):** brief said 10 tests; file has 9.
- **N-3 (record):** a distinct self-post between two identical greetings resets the reference → both greetings survive; conservative, consistent with 6b; commit guard is the second line. Record beside R-5.
- **N-4:** Finding C (dist-freshness) confirmed real, harness-wide; dist verified fresh this pass so today's greens are honest.

## Clean (audited PASS)
Grant compliance byte-exact (prohibited regions identical; diff confined to collapseSelfRuns + doc comment; dispatcher + ollama.ts zero diff — T-8 discharged). T-1/T-2 pass, D-A correctly closed NOT-A-DEFECT (real executeLocalEdge, fetch-only stub, persona in role:'system', absent from user message). T-4/T-5/T-6 non-tautological (pre-fix 7 greetings no marker / post-fix 0 verbatim + exact-count marker). T-7 pass (load-bearing for R-5). Delta-ruling fidelity exact (R-5 reproduced as ruled; nothing weakened). This seat executed: new file 9/9, named set 49/49. Scope clean; security/authority: no defects found in what was examined.

## Residuals (conditional on B-1 fix)
R-1, R-2, R-3, R-5, N-3, N-4/Finding C, Finding B (s4-presence load flake), AC-1/AC-2-as-literal unproven at desk seats.

## Commit/push
DO NOT COMMIT the code pair while B-1 is open. After B-1 + T-9: code commit = autoReplyContext.ts + the test file; docs commit = the five gate docs; explicit paths only. Approval attaches only to the audited state; fresh G2A required on the corrected source.

---

# ROUND 2 — G2A Gate-2 Verdict (fresh seat, 2026-08-24)

> Filed verbatim by the coordinator. Seat: DISCLOSED SUBSTITUTE, runtime claude-opus-5[1m]; fresh, no round-1 involvement. Audited state: HEAD 3361b75 + autoReplyContext.ts (52+/21-) + tests/agent-participation-collapse-live-shape.test.ts (10 entries: 9 assertions + 1 teardown, N-7).

## VERDICT: APPROVE — zero blockers

- **B-1 CLOSED, independently re-measured:** splice/push/advance at autoReplyContext.ts:152-156; own pre/post probe reproduced round-1's exact signature (PRE cursors [1,14,3,5,7,9,11,13] non-monotonic → POST [1,3,5,7,9,11,13,14] monotonic, markerCount honest). Splice-safety verified (lastSelfIndex sole retained index, reassigned same path; out length invariant → anchor/window/totalKnown unaffected); five edge shapes probed clean (reference reset, non-message interleave, two looping agents, single/empty).
- **Round-1 conditions all discharged:** fix inside grant; T-9 RED-proven (verifier + this seat); miscount corrected dated-not-silent (20000); = 6 reproduced); fresh G2A = this seat.
- **T-4 assertion change: CONCUR — correction of an erroneous assertion, not a weakening.** The old assertion was false for the shape's real chronology (newest event = 7th greeting) and passed only on the B-1 bug; the replacement is strictly harder under correct code. Greeting-loop byte zero-diff, obligation 6b intact.
- **Grant compliance PASS on final bytes:** diff confined to collapseSelfRuns + doc comment; prohibited regions byte-identical; dispatcher/ollama/authz zero-diff (T-8).
- **Executed this seat:** collapse file 10/10; named set 59/59; broad sweep 46 files / 477 tests / 0 failures (s4-presence flake did not recur); typecheck --force 14/14; dist rebuilt + content-verified before probing.
- **New non-blocking:** N-5 (T-4's marker index uses first-match search inside Math.max — can only tighten, cosmetic; T-9 is the strong form) · N-6 (T-5 is a surrogate deletion probe via omitted selfPrincipalId — proves the parameter, not the call site) · N-7 (test count = 9 + teardown).
- **Residuals:** R-1, R-2, R-3, R-5 (T-7 parity pin load-bearing), N-3, Finding C (dist-freshness harness class — FILE THE FOLLOW-UP; bit three seats), Finding B (did not recur), **AC-1/AC-2-as-literal remain runtime-unverified — one live channel turn recommended as post-merge acceptance before declaring the UX defect closed.**

## Conditions
(1) approval voids on any byte change; (2) rebuild @torqclaw/gateway dist before pre-push runs; (3) file the Finding C follow-up; (4) disclose the open AC-1 live-turn acceptance to the operator; (5) explicit-path staging only, never -A/-a; push/merge operator-owned — **RECOMMEND PUSH once the operator authorizes**, two commits (code, then docs).
