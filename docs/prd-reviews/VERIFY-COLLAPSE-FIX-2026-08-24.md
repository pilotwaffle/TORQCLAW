# Independent Verification — Channels collapse-fix slice (2026-08-24)

> Filed verbatim by the coordinator from the verifier's reply (seat has no Write tool). Seat: DISCLOSED SUBSTITUTE, runtime claude-opus-5[1m] (Opus 4.8 not invocable); independent verification only, not a G2A seat.

## VERDICT: READY_FOR_G2A (2 non-blocking findings)

| # | Check | Result |
|---|---|---|
| 1 | Scope (8-file tree = 7 known concurrent-WIP + autoReplyContext.ts 42+/21-; dispatcher/ollama/authz zero-diff) | PASS |
| 2 | Prohibited edits absent (byte-level region diff vs HEAD: constants :25/:26/:36/:44, predicate :66-79, renderer, both ternaries — identical; diff confined to collapseSelfRuns + doc comment) | PASS |
| 3 | greeting-loop unweakened (zero-diff; 6b DISTINCT_A/B intact :486-516, 7/7) | PASS |
| 4 | Independent execution (new file 9/9 warm; named set 58/58; typecheck re-forced uncached 6/6; full suite 2583/1 failed/1 skipped — the 1 = s4-presence boot flake, 12/12 isolated) | PASS |
| 5 | RED validity (reverted only the behavioral line: T-4 RED `expected 7 to be <= 1`, T-6 RED, T-3 residual flipped — not a tautology; restored sha b4886c97 byte-match) | PASS (stronger than claimed) |
| 6 | T-1 substance (real executeLocalEdge, real envelope plumbing, fetch-only stub, asserts persona in role:'system' and ABSENT from user message; D-A correctly closed NOT-A-DEFECT) | PASS |
| 7 | Both disclosures (T-3 hostile pair elides w/ marker + operator preserved, superseded by the delta ACCEPT-AS-RESIDUAL; rider deletion-sensitivity probe-verified — authz named-arm deletion flips the source pin; restored 206a9abf byte-match) | PASS |

## Findings
- **A — MEDIUM (fix before commit):** T-1 cold-start flaky — dynamic import of ollama inside a default-5s test body (first cold run timed out at 8260ms; warm 346ms). One-token fix: `, 20000` at test:139. CI would flap without it.
- **B — LOW:** full-suite single failure = `agent-participation-s4-presence` T-10a gateway-boot timeout under load; 12/12 isolated. Known load-sensitivity class; not a slice regression.
- **C — INFORMATIONAL (pre-existing class, file follow-up):** collapse tests T-3..T-6 import `packages/gateway/dist/*.js` with no freshness guard; verifier proved stale-dist can flip them both ways, rebuilt from src, re-confirmed GREEN. "Verify the artifact" class — harness-wide follow-up, not this slice.

## Commit-safe list (THIS slice)
packages/gateway/src/autoReplyContext.ts · tests/agent-participation-collapse-live-shape.test.ts · docs/prd-reviews/BUILD-EVIDENCE-COLLAPSE-FIX-2026-08-24.md · docs/prd-reviews/G1D-FABLE-CHANNELS-LIVE-DEFECTS-2026-08-24.md · docs/prd-reviews/G1R-CHANNELS-LIVE-DEFECTS-2026-08-24.md (+ this file + the G2A verdict when filed). Do NOT stage the 7 concurrent-WIP files or other untracked operator files; explicit `git add` paths only.

## Unverified at this seat
AC-1 raw-model parity through the live dispatcher (needs live stack turn; scripted-engine proxy is the substitute) · AC-2 as the literal state.db artifact (T-2 transport-level assert is the sound substitute) · operator sanction of the .claude WIP (reported only).

## Deltas vs Builder claims
All confirmed except: cold T-1 timeout not disclosed (Finding A); Builder's full-suite zero-failures not reproduced under load (Finding B, flake); Builder's typecheck was cache-hit (re-forced uncached by verifier, still green).

---

# DELTA VERIFICATION — Round 2 (B-1 correction), same seat, 2026-08-24

## VERDICT: DELTA PASS — all 5 items, no new discrepancies.

1. **Scope PASS** — round-1→round-2 delta confined to the near-duplicate-hit branch (`out.splice(lastSelfIndex,1)` + `out.push({elisionOf: ev, collapsedCount: priorCollapsed+1})` + `lastSelfIndex = out.length-1`) plus its comment; prohibited regions re-diffed byte-identical; dispatcher/ollama/authz still zero-diff; tree still 8 files (7 concurrent-WIP + the one authorized).
2. **Execution PASS** — new file 10/10 incl. T-9; greeting-loop 7/7 zero-diff (6a/6b/7/8 intact). T-9 substance genuine: real channel DB + real buildAnchorWindowContext; strictly-increasing [#N] cursors (regex + pairwise toBeGreaterThan) AND representative-after-all-7-operator-messages, over the live alternating shape.
3. **T-9 RED validity PASS (strong)** — reverting only the splice/push/advance reproduced the exact B-1 signature: `got [1,2,...,11,24,13,15,17,19,21,23] (violation at index 12): expected 13 to be greater than 24`; T-4 also RED. Restored byte-clean (sha b88840a0 match), dist rebuilt, 10/10 GREEN. T-9 discriminates the round-2 fix specifically.
4. **T-4 assertion: CORRECTION OF AN ERRONEOUS ASSERTION, not a weakening.** The shape's newest event is the 7th greeting, not an operator message; the original assertion passed only because B-1 manufactured its condition. Replacement (`max(lastGreetingIndex,lastElisionMarkerIndex) > lastOperatorIndex`) is the chronologically true invariant and strictly harder under correct code. Coverage increased.
5. **Miscount fix PASS** — dated inline correction preserving the original wrong claim (evidence doc :411), superseded by the Round-2 addendum; independently reproduced `grep -c "20000);"` = 6 at :139/:337/:410/:485/:515/:563.

Round-1 Finding A RESOLVED (T-1 timeout in place). Finding C (dist freshness) unchanged, still-open harness-class — it bit again this round (rebuild required before probe and restore). AC-1/AC-2-as-literal remain runtime-unverified at this seat. **READY_FOR_G2A.** Working tree left exactly as found (autoReplyContext.ts sha b88840a0, authz.ts sha 206a9abf).
