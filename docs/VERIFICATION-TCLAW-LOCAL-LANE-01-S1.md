# Verification - T-TCLAW-LOCAL-LANE-01 Slice 1

## Outcome and provenance

**Revision 2 build complete; independent G2A audit next.** The approved D-6
resolution makes `classifierNote` optional and omits its key when absent.
The three existing exact-shape assertions at `tests/friendly.test.ts:1540`,
`:1547`, and `:1553` now pass unchanged. The 13-file boundary is preserved.
Revision 1's failed full run is retained below as historical evidence.

Builder implementation of the approved answer-first prompt, bounded prose retry,
classifier fallback diagnostics, estimate tooltip, and two prior audit preservation
tests. Independent G2A and the operator's live model evaluation remain required.

- Repository: `E:/TORQCLAW`.
- Branch: `fix/tclaw-local-lane-01-slice-1`.
- Pin and HEAD: `fb421089901061053931dc89aa2e3f09be9a0e89`.
- Authority: `E:/TORQ-CONSOLE/.torq/v5/artifacts/01_design/build_spec.md`,
  `gate1_review.md` (Rev 2 APPROVED_WITH_AMENDMENTS), and `design_questions.md` D-0..D-6.
- No commit/push. No live-stack or Ollama restart. Work is inline, with no subagents.
- Logs: `E:/TORQ-CONSOLE/.torq/v5/artifacts/02_build/ll1_*.log`.
- Runtime: Node v22.19.0, pnpm 9.15.9, Python 3.13.12, pytest 9.1.1.

## Baseline at the pin

`pnpm test` first run, exit 1 (`ll1_baseline_vitest.log`):

```text
 Test Files  2 failed | 198 passed (200)
      Tests  2 failed | 2767 passed | 1 skipped (2770)
```

The two failures were the booted-gateway presence case in
`tests/agent-participation-s4-presence.test.ts` and the non-V1 marker refusal case
in `tests/auth-v2-phase1.test.ts`. Both reached the existing 20-second gateway
readiness timeout, with empty captured gateway stderr. Root cause is unverified;
they are not silently excused as flakes. No test or product code was changed.

The one permitted full `pnpm test` rerun ran after the other baseline checks
finished. It passed, exit 0, in the same log:

```text
 Test Files  200 passed (200)
      Tests  2769 passed | 1 skipped (2770)
BASELINE RUN 2 EXIT: 0
```

`pnpm typecheck`, exit 0 (`ll1_baseline_typecheck.log`):

```text
 Tasks:    14 successful, 14 total
Cached:    14 cached, 14 total
```

`cd engines/hermes_kernel; uv run pytest`, exit 0 (`ll1_baseline_pytest.log`):

```text
========== 535 passed, 1 skipped, 11 deselected in 159.50s (0:02:39) ==========
```

This executed baseline, rather than the spec's historical 532-passed reference,
is authoritative. The zero-failure gate was satisfied before adding tests.

## RED-at-pin evidence

All 18 new tests were written before production edits. The Vitest selection also
included the three existing tests in `failover-blocked-tool.test.ts`.
`ll1_pin_vitest.log` preserves the initial run, an isolated fixture diagnostic,
and the corrected fixture run. After correcting only the mock target described
under Deviations, all files collected; the 11 DEFECT tests failed at their
specified assertions and all six new TypeScript PRESERVATION tests passed.

```text
 Test Files  4 failed | 1 passed (5)
      Tests  11 failed | 9 passed (20)
```

`uv run pytest tests/test_server_runtime.py -k without_blocked_reason -v`, exit 0
(`ll1_pin_pytest.log`):

```text
tests/test_server_runtime.py::test_resilience_block_without_blocked_reason_is_terminal_malformed_response PASSED [100%]
====================== 1 passed, 63 deselected in 2.55s =======================
```

The classification table below records each failing assertion. The absence of
`classifierTimeoutMs` failed only its own test; the file still collected all five
tests. Tests were never stashed, deleted, staged, or weakened to obtain RED.

## Final post-change triple

Current Revision 2 results are in the appended Revision 2 section. The following
Revision 1 results are historical and are not the current acceptance claim.

Focused Vitest regression selection, exit 0 (`ll1_final_vitest.log`):

```text
 Test Files  9 passed (9)
      Tests  71 passed (71)
```

`pnpm typecheck`, exit 0 (`ll1_final_typecheck.log`):

```text
 Tasks:    14 successful, 14 total
Cached:    9 cached, 14 total
```

`cd engines/hermes_kernel; uv run pytest`, exit 0 (`ll1_final_pytest.log`):

```text
========== 536 passed, 1 skipped, 11 deselected in 193.14s (0:03:13) ==========
```

Final full `pnpm test`, exit 1 (`ll1_final_vitest.log`):

```text
 Test Files  1 failed | 203 passed (204)
      Tests  3 failed | 2783 passed | 1 skipped (2787)
FULL FINAL SUITE EXIT: 1
```

All three failures are the exact-shape assertions in `tests/friendly.test.ts`
identified above; the diff is the required added `classifierNote: null` property.
This is a verified deterministic contract-expectation conflict, not an inferred
timing flake. Revision 1's full final gate **FAILED** and the builder returned
the packet to G1D. D-6 subsequently resolved the design conflict; no old test was
edited. All 17 new TypeScript tests and the new Python test passed in Revision 1.

Repository-required generated graph refresh, fitness, and smoke checks all
exited 0. Output is appended to `ll1_final_typecheck.log`:

```text
VERDICT: PASS
=== ALL SMOKE TESTS PASSED ===
```

Graph limitations were reported rather than hidden: 145 source files produced
zero nodes; one SQL file lacks the optional `tree_sitter_sql` parser; HTML was
skipped above its 5,000-node limit; the smoke script accepts the upstream
undirected-update limitation. The refresh was AST-only. No dependency was added,
no semantic extraction or subagent ran, and source/diff/test evidence above is
independent of graph completeness.

## Scope and invariants

Full porcelain comparison against `ll1_baseline_status.log`: 14,350 baseline
entries, 14,363 final entries, no removed/changed baseline entries. Exactly 13
added status entries: eight tracked modifications and five new untracked files.
Existing operator paths remain present with their original status; no operation
in this build targeted their content. Ordinary `git diff` excludes the five new
files and is supporting evidence only.

```text
 M apps/console/src/components/TorqTerminal.tsx
 M apps/console/src/components/friendly.ts
 M engines/hermes_kernel/tests/test_server_runtime.py
 M packages/gateway/src/classifier.ts
 M packages/gateway/src/enrich.ts
 M packages/gateway/src/preview.ts
 M packages/inference/src/ollama.ts
 M tests/failover-blocked-tool.test.ts
?? docs/VERIFICATION-TCLAW-LOCAL-LANE-01-S1.md
?? tests/classifier-fallback-reason.test.ts
?? tests/local-inference-prose-retry.test.ts
?? tests/preview-route-classifier-reason.test.ts
?? tests/torq-terminal-estimate-tooltip.test.tsx
```

`git diff fb42108 --stat`:

```text
 apps/console/src/components/TorqTerminal.tsx       |  1 +
 apps/console/src/components/friendly.ts            | 16 +++++-
 engines/hermes_kernel/tests/test_server_runtime.py | 44 ++++++++++++++++
 packages/gateway/src/classifier.ts                 | 29 +++++++++--
 packages/gateway/src/enrich.ts                     |  4 +-
 packages/gateway/src/preview.ts                    |  9 +++-
 packages/inference/src/ollama.ts                   | 59 ++++++++++++++++++----
 tests/failover-blocked-tool.test.ts                | 15 ++++++
 8 files changed, 160 insertions(+), 17 deletions(-)
```

Verified by byte comparison against `git show fb42108:<path>`:

- Both prose guard functions are byte-identical, and `tests/truncate.test.ts` is
  byte-identical in full.
- The `enrichCommand` returned object is byte-identical, and `fallbackReason`
  does not appear anywhere in `enrich.ts`.
- `git diff fb42108 -- packages/contracts packages/router packages/bridge/src
  engines/hermes_kernel/mcp_wrapper engines/hermes_kernel/vendor` is empty.
- Every existing line in both modified test files remains in original order;
  their tracked diffs contain additions only.
- `git merge-base master HEAD` equals the full pin above.
- Source search shows `derivePreflightEstimate` is the sole constructor of
  `PreflightEstimate`; other sites consume the interface.

The fixed retry prompt never interpolates model output. The retry passes
`undefined` for tools and tool choice, returns from every retry branch, and
never executes a retry response's tool calls. The explicit-workflow preservation
test proves the first request actually sends `tool_choice: 'required'`.

## Per-test classification

Exactly 18 new tests: 11 DEFECT, 7 PRESERVATION. Pin results below refer to the
corrected fixture run. Final focused TypeScript run: all 17 new cases passed.

| File | Exact test name | Class | Pin assertion/result |
|---|---|---|---|
| `tests/local-inference-prose-retry.test.ts` | `plain_question_raw_tool_blob_gets_one_prose_retry` | DEFECT | RED: result text expected `4`, received existing refusal |
| same | `prose_retry_is_bounded_to_one` | DEFECT | RED: expected fetch 2 times, received 1 |
| same | `prose_retry_never_executes_tool_calls` | DEFECT | RED: expected fetch 2 times, received 1 |
| same | `fabricated_tool_run_still_discarded_without_retry` | PRESERVATION | GREEN |
| same | `explicit_workflow_skips_prose_retry` | PRESERVATION | GREEN after mock-resolution correction |
| same | `plain_prose_answer_unchanged_single_call` | PRESERVATION | GREEN |
| same | `system_prompt_contains_answer_first_rule` | DEFECT | RED: system prompt did not contain `FIRST decide whether the request needs a tool` |
| `tests/classifier-fallback-reason.test.ts` | `classifier_timeout_reports_fallback_reason_timeout` | DEFECT | RED: expected `timeout`, received undefined |
| same | `classifier_unreachable_reports_unreachable` | DEFECT | RED: expected `unreachable`, received undefined |
| same | `classifier_bad_schema_reports_bad_response` | DEFECT | RED: expected `bad_response`, received undefined for all three responses |
| same | `classifier_timeout_env_floor_250ms` | DEFECT | RED: expected Any(Function), received undefined |
| same | `classifier_local_llm_has_no_fallback_reason` | PRESERVATION | GREEN |
| `tests/preview-route-classifier-reason.test.ts` | `preview_frame_carries_classifier_method_reason_latency` | DEFECT | RED: expected `unreachable`, received undefined |
| `tests/torq-terminal-estimate-tooltip.test.tsx` | `estimate_chip_tooltip_names_classifier_fallback_reason` | DEFECT | RED: expected title `classifier fell back (timeout, 1510 ms)`, received null |
| same | `estimate_chip_has_no_tooltip_for_local_llm_classification` | PRESERVATION | GREEN |
| same | `derive_preflight_estimate_classifier_note` | DEFECT | RED: expected `classifier fell back (reason unknown, 2 ms)`, received undefined |
| `tests/failover-blocked-tool.test.ts` | `valid_blockedOn_passes_normalizeObservation` | PRESERVATION | GREEN |
| `engines/hermes_kernel/tests/test_server_runtime.py` | `test_resilience_block_without_blocked_reason_is_terminal_malformed_response` | PRESERVATION | GREEN |

## Deviations

1. The supplied root-test `vi.doMock('@torqclaw/bridge')` pattern did not intercept
   the inference workspace's dependency. The explicit workflow preservation test
   failed both in the group and in isolation (first `tool_choice` was undefined).
   `createRequire` from the root test reports `MODULE_NOT_FOUND`, while resolution
   from `packages/inference/src/ollama.ts` yields
   `E:/TorqClaw/packages/bridge/dist/index.js`. Only the mock/importActual/unmock
   target was changed to `../packages/bridge/dist/index.js`; every assertion was
   preserved. The corrected complete pin run has exactly the expected 11 RED
   defects and seven GREEN preservation tests across TypeScript and Python.
2. Baseline full-suite failures and the one clean full rerun are disclosed above.
   No timeouts, test expectations, worker counts, or test selections were relaxed.
3. The current measured Python baseline is 535 passed, not the historical 532.
4. **Revision 1 spec omission, resolved by approved D-6:** an always-present
   `classifierNote: null` broke three exact-shape assertions. G1D rejected the
   proposed fourteenth-file alternative and revised the API: omit the optional
   key when no note exists. Builder implemented that approved design without
   editing `tests/friendly.test.ts` or expanding the 13-file boundary.

## Prior minors closed

**M-1:** A resilience-fence rejection (`blockedReason == 'resilience_rejected'`)
no longer emits the internal `PENDING_APPROVAL` event (`server.py:142-148`);
this is intended: a fence rejection is not an approval request.

**M-2:** The new Python test pins the no-`blockedReason` path to terminal
`malformed_response`, outcome `failed`, without blocked-tool details in telemetry.

**M-3:** The new positive normalization test accepts `write_file`, `mcp:fs/write.v2`,
and a valid 128-character name.

**m-1:** `useGatewayStream.ts:114` uses `crypto.randomUUID()`, which exists only
in secure contexts; over plain http on a non-localhost address the handler throws
after `console.warn`. Known limitation, pre-existing, shared with ChannelsPanel
and AgentsPanel; no code change.

**m-3:** S2 spec AC7 miscounted 'three lines' (actual 6, pre-existing
`const sent = sendCommand` sites); nothing to do, closed.

## Operator runbook - mandatory before merge

OPERATOR TO FILL. Builder did not run or restart the live stack. After restarting
the stack with `torq-local` warm, capture each answer verbatim:

| Prompt | Actual answer |
|---|---|
| what is 2 + 2 | OPERATOR TO FILL |
| explain what a mutex is in two sentences | OPERATOR TO FILL |
| write a haiku about rain | OPERATOR TO FILL |
| summarize: <three-sentence paragraph of your choice> | OPERATOR TO FILL |
| list three uses of a hash map | OPERATOR TO FILL |

Pass: at least four of five answers are plain prose, without tool-call JSON or
refusal text. Record any failure. After an operator-controlled Ollama restart,
capture one cold-classifier estimate tooltip (reason and latency): OPERATOR TO FILL.
Evaluate a tool-needing prompt as well for the prompt-regression risk.

## Token accounting

Builder runtime: GPT-6 / Codex (exact serving model ID is not exposed by this
session). Harness configuration requests `gpt-6-astra`; that is configuration,
not independently verified runtime telemetry. Input tokens, output tokens, and
total tokens: token usage unavailable; the session exposes no usage receipt.
Cost usd: unavailable. Budget target stated: $25; actual spend cannot be measured
or enforced here. No cost or token figures have been fabricated.

## Revision 2 - approved D-6 resume

Cause: Revision 1 added a required, always-present nullable property to objects
whose exact legacy shape is asserted by existing tests. G1D and G1R approved an
optional key that is physically absent when there is no classifier fallback.

The two production edits are `friendly.ts` (optional interface member, an
undefined local, and a conditional spread into both return branches) and
`TorqTerminal.tsx` (direct `title={estimate.classifierNote}`). Test 16 now asserts
`not.toHaveProperty('classifierNote')` and the exact original local estimate
object for LOCAL_LLM and absent enrichment. All other assertions were preserved;
an additional assertion covers the exact AC20 KEYWORD_FALLBACK/2 ms fixture.
Names and counts remain 18 new tests. No reset, stash, branch change, or replay
of the already-established pin baseline was needed.

Before the production correction, the revised focused selection reproduced the
three legacy shape failures and the new absence assertion failure. Afterward,
the prescribed focused command exited 0, including all three unchanged
`tests/friendly.test.ts:1540,1547,1553` assertions:

```text
 Test Files  3 passed (3)
      Tests  222 passed (222)
```

Revision 2 `pnpm typecheck`, exit 0:

```text
 Tasks:    14 successful, 14 total
Cached:    13 cached, 14 total
```

Revision 2 `uv run pytest`, exit 0:

```text
========== 536 passed, 1 skipped, 11 deselected in 144.01s (0:02:24) ==========
```

Revision 2 full `pnpm test`, exit 0:

```text
 Test Files  204 passed (204)
      Tests  2786 passed | 1 skipped (2787)
REVISION 2 FULL FINAL EXIT: 0
```

The full final triple has zero failures. All 18 new tests pass. All runs are
appended under explicit Revision 2 markers in the same evidence logs; earlier
failures remain available. Independent G2A approval and the operator's live
runbook are still outstanding; this is a builder handoff, not merge approval.

Rechecked I1/I5/I6/I10 and the full porcelain delta: both prose guards, truncate
tests, and friendly tests are byte-identical to the pin; protected-path diffs are
empty; enrichment's return object is unchanged with no fallbackReason field;
existing tests only grew. The delta remains exactly 13 paths (8 tracked + 5 new),
with zero removed baseline entries. Graph refresh, fitness, and smoke exited 0.
