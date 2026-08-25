# Independent Verification — Trigger-keyed newest-message marker (2026-08-24)

> Filed verbatim-condensed by the coordinator from the verifier's reply. Seat: DISCLOSED SUBSTITUTE, runtime claude-opus-5[1m]; independent verification only, not Gate 2.

## VERDICT: READY_FOR_G2A — all 7 items PASS, no blocking defect.

| # | Item | Result |
|---|---|---|
| 1 | Scope/boundary: autoReplyContext +55/-0; dispatcher +1/-1 (ONE hunk by -U0); ollama/cron/store/collabSurface zero-diff | PASS |
| 2 | Stash/pop integrity: WIP diffs intact, operator untracked present, no residue; stash list historic only | PASS |
| 3 | Collapsed-away hazard: UNREACHABLE — collapse requires actor===self (:142-144), marker requires actor!==self (:341); disjoint. Probe B (trigger genuinely collapsed → NO banner) + Probe C (interleaved operator trigger → banner has exactly 1 in-window twin, byte-identity holds) executed against real dist | PASS |
| 4 | Independent execution: marker 13/13 · greeting-loop 8/8 · collapse 10/10 · config-readiness 13/13 · membership-wire 19/19 · typecheck 14/14 · FULL SUITE (default config incl. failover) 2663 passed / 1 skipped / 0 failed, 182/182 files | PASS |
| 5 | collab-c2-flag-off-identity: **PRE-EXISTING FLAKY, causally independent** — **[C-1 correction, G2A-mandated 2026-08-24: this row originally said "ENVIRONMENT (transient) — 4/4 green"; the verifier's 4 runs happened to pass, but G2A's six executed runs measured 1P/2F on the slice tree and 0/3 on the stashed baseline — the test is chronically flaky (~1/3 pass), not transient-green]**; zero slice symbols in the file; failure = live-classifier identity swap (LOCAL_LLM/0.9 vs DEFAULT/0.3) flipping between halves of one run. NOT slice-caused. Separate flaky-test ticket recommended | PASS (causation), corrected (characterization) |
| 6 | RED validity: Probe A reproduced T-2's discrimination on real store data (shipped banner names trigger S; a genuine newest-selector lands on racing S+1); Probe D (trigger past WINDOW_EVENT_COUNT → no banner, fails closed, R-8 path proven); Probe E (obligation-8 byte-identity: 4-arg / explicit-undefined / no-self all marker-free); T-6 byte-clean (sha-asserted source+dist, no residue) | PASS |
| 7 | T-8 dist by content: banners dist/autoReplyContext.js:30-31, 5th param :195, raw-list match :301, dispatcher :390 | PASS |

## Discrepancies (all LOW/INFO)
1. LOW — evidence packet line 61 calls the c2 failure "deterministic"; it is not (4/4 pass). Conclusion unaffected; wording to fix.
2. LOW — suite-count delta explained by scope (builder excluded tests/failover; verifier ran default config): 2663/0 fail on the full default run.
3. LOW (latent) — T-4 pin uses .match() (first occurrence); correct today (single call site), silently re-targets if a call is added above :498.
4. INFO — the in-file "T-2 RED PROOF" test is indirect (re-derives newest line and asserts difference); verifier's Probe A supplies the direct executed evidence.

## Tree note
An 8th modified operator-WIP file appeared: repo CLAUDE.md (+5, token-accounting process edit) — report-only, EXCLUDE from commits alongside the known 7.

## Commit-safe list (slice only)
packages/gateway/src/autoReplyContext.ts · packages/gateway/src/autoReplyDispatcher.ts · tests/agent-participation-trigger-marker.test.ts (new) · tests/agent-participation-greeting-loop.test.ts (+18 T-4 pin) · + the slice docs (G1D/G1R/BUILD-EVIDENCE/this file/G2A verdict when filed). Explicit paths only.

## Unverified at this seat
AC-2 live Paris-class turn (post-merge, operator-witnessed — the slice's actual purpose remains runtime-unproven; the 3/3 bench is G1D/builder-produced) · R-8 frequency under production load (code path proven fail-closed).
