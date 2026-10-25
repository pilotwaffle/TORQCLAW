# Verification — T-TCLAW-CONSOLE-REVIEW-01 Slice 1

Date: 2026-10-24 America/Chicago. Builder implementation of approved build spec v2; independent G2A acceptance remains pending.

## Outcome and provenance

Private USER_PROMPT/RESULT events now carry sensitive metadata, private tasks skip episodic storage, and default context recall excludes marked turns. Private callers explicitly retain private continuity. Approval-required failover blocks now end as terminal/approval_blocked with a validated tool identifier and local-retry recovery; resilience-fence rejections remain uncertain.

Repo: E:\TORQCLAW. Branch: `fix/tclaw-console-review-01-slice-1`. Pin and current HEAD: `25b17f1d379e8f7825f0bce2b57084214dcd3b71`. Changes are in the working tree, including three new test files and this document. No commit, push, merge, release or deployment was made. CLAUDE.md section 2 requires operator approval before a high-risk commit. Both telemetry allowlists are included in this same review bundle and must be committed together when authorized.

Evidence directory: `E:\TORQ-CONSOLE\.torq\v5\artifacts\02_build`. Full logs are verbatim; command inventory: `s1_v2_commands.md`. User direction authorizes harness evidence and status writes separately from product implementation.

## Baseline at the pin

Reused the baseline explicitly adopted by spec v2:

```text
pnpm test
 Test Files  2 failed | 189 passed (191)
      Tests  2 failed | 2747 passed | 1 skipped (2750)
   Start at  18:34:31
   Duration  298.25s (transform 3.05s, setup 0ms, collect 29.52s, tests 504.28s, environment 14.35s, prepare 14.93s)

pnpm typecheck
 Tasks:    14 successful, 14 total
Cached:    9 cached, 14 total
  Time:    37.118s

uv run pytest (cwd engines/hermes_kernel)
========== 532 passed, 1 skipped, 11 deselected in 128.46s (0:02:08) ==========
```

Logs: `s1_baseline_vitest.log`, `s1_baseline_typecheck.log`, `s1_baseline_pytest.log`.
The only baseline failures were:
- `room-job foundation > admits only the bounded room-job command shapes at the public contract boundary`
- `room-job execution intent > admits facts/start without accepting any internal run, target, tool, or delivery fields`

Both had `expected false to be true`. After baseline typecheck, the one isolated rerun (`s1_baseline_isolated.log`) reported:

```text
 Test Files  2 passed (2)
      Tests  12 passed (12)
   Start at  18:40:35
   Duration  1.31s (transform 466ms, setup 0ms, collect 648ms, tests 1.00s, environment 0ms, prepare 150ms)
```

## Final post-change triple

```text
pnpm test
 Test Files  194 passed (194)
      Tests  2757 passed | 1 skipped (2758)
   Start at  18:59:53
   Duration  279.94s (transform 3.12s, setup 0ms, collect 28.91s, tests 467.16s, environment 10.01s, prepare 21.21s)

pnpm typecheck
 Tasks:    14 successful, 14 total
Cached:    10 cached, 14 total
  Time:    4.53s

uv run pytest (cwd engines/hermes_kernel)
========== 535 passed, 1 skipped, 11 deselected in 140.80s (0:02:20) ==========
```

Logs: `s1_v2_full_vitest.log`, `s1_v2_typecheck.log`, `s1_v2_full_pytest_final.log`. Zero final failures; no new skips. The two baseline-flaky files passed in the full run (7 + 5 tests), so no exception or post-change isolated retry was used. Typecheck uses Turbo caching; the changed bridge/gateway checks executed. Its Python package prints "python engine: skipped"; the actual Python verification is pytest, not that placeholder.

Additional checks: focused Vitest 11/11; built gateway dependency set 6/6; Python approval-hook/runtime group 112/112 after compatibility correction; product graph rebuild exit 0, fitness PASS, smoke PASS. Graph update warned about zero-node files, a missing optional SQL parser, and skipped oversized HTML visualization; these are graph coverage limits, not claimed runtime coverage.

## Per-test pin and post-change evidence

The proposed tests were present while production remained at the pin. Authoritative pin logs are `s1_v2_pin_vitest_final.log` and `s1_v2_pin_pytest_corrected.log`. They show:

```text
 Test Files  4 failed (4)
      Tests  6 failed | 5 passed (11)
   Duration  5.91s (transform 473ms, setup 0ms, collect 1.49s, tests 4.71s, environment 1ms, prepare 255ms)
================= 3 failed, 1 passed, 85 deselected in 2.30s ==================
```

The five passing Vitest cases comprise the two named preservation cases and three existing sessions-memory tests. The actual named ledger pytest below passed under the product test tree; the old external premise probe was not substituted for it.

| Test | Class | Pin evidence (failing assertion or preserved behavior) | After |
|---|---|---|---|
| private_prompt_and_result_excluded_from_context_window | DEFECT | `not to contain 'PRIVATE-PROMPT-MARKER'` and RESULT marker failed for default/false; true retained all markers | PASS |
| non_private_task_still_stores_and_recalls | PRESERVATION | PASSED: events and episode recalled, true/default equal | PASS |
| private_task_stores_no_episode | DEFECT | episode/FTS counts expected 0, received 1; `expected {} to match object { sensitive: true }`; default recalled private marker | PASS |
| non_private_task_stores_episode_and_unmarked_result | PRESERVATION | PASSED: episode exists and RESULT has no sensitive key | PASS |
| submit_prompt_marks_user_prompt_sensitive_and_leaves_non_private_null | MIXED | private row sensitive null instead of 1; non-private metadata NULL assertion passed | PASS |
| failover_blocked_tool_terminal_error_carries_blockedOn | DEFECT | expected error telemetry to contain blockedOn write_file, received failover-only telemetry | PASS |
| failover_blocked_tool_emits_terminal_error_with_blockedOn | DEFECT | message was `Execution failed: failover approval_blocked.`; no blockedOn/RETRY_LOCAL; task error was FAILOVER prefix | PASS |
| failover_observation_rejects_unapproved_blocked_tool_telemetry | MIXED | invalid-name message was `telemetry is not normalized`, expected `blockedOn is invalid`; unknown blockedArgs rejection passed | PASS |
| test_approval_blocked_resilience_observation_is_terminal_approval_blocked | DEFECT | `('side_effect_uncertainty', 'uncertain', 'cancelled_uncertain', None)` instead of `('terminal', 'approval_blocked', 'failed', 'write_file')` | PASS |
| test_safe_telemetry_passes_blockedOn_and_drops_blockedArgs | MIXED | output lacked blockedOn; raw args/reason and invalid names already dropped | PASS |
| test_ledger_rejects_approval_blocked_under_side_effect_uncertainty | PRESERVATION | PASSED: wrong pair raises LedgerError, terminal pair accepted | PASS |
| test_resilience_fence_rejection_is_not_reclassified_as_approval_blocked | MIXED | fence half passed unchanged; approval half yielded `(None, 'side_effect_uncertainty', 'uncertain', 'cancelled_uncertain')` | PASS |

Post-change named results: `s1_v2_green_focused_vitest_final.log` (11 passed, 17.84s), `s1_v2_green_focused_pytest.log` (4 passed, 85 deselected, 2.71s), and `s1_v2_python_compatibility.log` (112 passed, 8.07s, includes all four named Python tests on final code). Final full suites include every named test.

The controller seam runs the actual controller with a stub attempt and real Python ledger operations. It seeds an internal failure observation for the ledger's finalization evidence requirement, asserts one attempt, no provider transition, engine failure source, TERMINAL status and no active tuple. The dispatch seam proves its dynamic-import mock was called, one ERROR, zero approval events/rows, failed task and failed receipt. The USER_PROMPT test boots freshly built gateway code and inspects the real temporary SQLite event rows.

## Tests changed, with justification

Only the pre-existing T-A5 test changed expectations: `test_approval_blocked_resilience_observation_is_side_effect_uncertainty` became `test_approval_blocked_resilience_observation_is_terminal_approval_blocked`. The approval hook blocks before tool execution, so this particular refusal has no uncertain tool side effect. The old assertion described the D2 defect, not an invariant. The new test requires terminal/approval_blocked, outcome failed, safe blockedOn and no blockedArgs. Its docstring records this reason. All other pre-existing assertions remain unchanged.

Initial pin runs exposed fixture mistakes (missing router diagnostic reason, missing synthetic provider credential, missing internal finalization evidence, wrong receipt-column name). Only fixture setup was corrected; logs remain under `s1_v2_pin_*.log`. The first post-change gateway build failed TS2339 because telemetry inference excluded blockedOn; an explicit Record type fixed production typing. The first full Python run had two legacy hook shape failures (2 failed, 533 passed, 1 skipped, 11 deselected); production now preserves legacy return shape and all tests remain intact. These failed runs are retained, not counted as passes.

## Invariant and source checks

- I1-I4: tests exercise marked and NULL metadata, default/false exclusion, private continuity, episode/FTS omission, ordinary storage and emitted-only RESULT marking. taskStore.complete telemetry is unchanged.
- I5: unchanged `tests/router.test.ts:7`, "RULE 1: privacy override forces LOCAL_EDGE even when score would be high", asserts LOCAL_EDGE and PRIVACY_OVERRIDE. The existing cloud-preference privacy check at lines 183-187 also remains. All 81 router tests passed.
- I6/I6a/I6b: validated tool-name projection, controller and dispatch tests above; actual hook/runner/server path differentiates approval from rejected durable fence. Invalid identifiers fail closed. Python fullmatch and TypeScript whole-match equality both reject trailing newlines.
- I7: `failover_runtime.py:296-307` normalizes through the unchanged AttemptLedger; `374-391` returns failed for class terminal and cancelled_uncertain only for side_effect_uncertainty. `attempt_ledger.py:80` already allows approval_blocked under terminal.
- I8/I9: diff against the pin is empty for attempt_ledger.py, every tests/failover file, frontier-grant-fence-unconditional.test.ts, spend-caps.test.ts and receipt-projection.test.ts. Full Vitest reports all these passing. Contracts, router, console, vendor, baseline-flaky files and test_approval_hook.py are also unchanged. Static evidence: `s1_v2_static.log`.
- Console read-only check: `apps/console/src/components/friendly.ts:75-76` produces "Something went wrong: This cloud task tried to use ...". `TorqTerminal.tsx:1906-1913` displays "run on this machine" when recovery contains RETRY_LOCAL and meta.prompt is present. No console change or live UI click was performed.
- No new approval-registration calls, flag, schema, migration, raw provider output or raw arguments cross the resilience boundary. Existing legacy registration sites remain at dispatch.ts:507-508.

## Scope and diff

Requested command `git diff 25b17f1 HEAD --stat` produced no output because the implementation is uncommitted under the owner-approval rule. The substantive audit target is the working tree plus the four new files, not the empty HEAD diff.

`git diff 25b17f1 --stat` before this new document:

```text
 engines/hermes_kernel/mcp_wrapper/approval_hook.py |  4 +-
 .../hermes_kernel/mcp_wrapper/failover_runtime.py  |  5 +-
 engines/hermes_kernel/mcp_wrapper/hermes_runner.py |  2 +
 engines/hermes_kernel/mcp_wrapper/server.py        | 60 +++++++-------
 .../hermes_kernel/tests/test_failover_runtime.py   | 25 +++++-
 engines/hermes_kernel/tests/test_server_runtime.py | 92 ++++++++++++++++++----
 packages/bridge/src/hermesAttempt.ts               |  3 +-
 packages/gateway/src/dispatch.ts                   | 29 +++++--
 packages/gateway/src/enrich.ts                     |  2 +-
 packages/gateway/src/failover.ts                   |  5 +-
 packages/gateway/src/server.ts                     |  3 +-
 packages/gateway/src/sessions.ts                   | 13 ++-
 tests/sessions-memory.test.ts                      | 34 ++++++++
 13 files changed, 217 insertions(+), 60 deletions(-)
```

New files: `tests/failover-blocked-tool.test.ts` (148 lines), `tests/private-task-memory.test.ts` (53), `tests/private-prompt-mark.test.ts` (41), and this verification document. No whole file was deleted. Removed lines are scoped replacements, chiefly the stale server classification/comment and authorized T-A5 expectations. Operator-owned untracked agent definitions, .tmp, build-evidence, other docs/assets/reviews, ops staging and screenshots were left untouched.

## Implementation interpretations

1. Preserve the exact legacy hook return shape: approval_required is attached only for resilience-active tasks; the runner copies blockedReason only when present. Both resilience producer reasons remain explicit. This preserves the unchanged legacy hook tests and the non-goal concerning legacy behavior.
2. If a synthetic approval_blocked exception has no identifier, the message uses "a write tool" but omits metadata.blockedOn. Persisting that fallback string would violate I6b's no-space grammar. Valid engine observations always provide the validated name.
3. The branch is delivered uncommitted for G2A review, respecting the high-risk owner commit gate; the two boundary changes remain one review bundle.

## Known Limitations

1. R6: historical unmarked events/episodes are not retroactively classified or deleted. The specified operator remedy `FORGET_SESSION` clears episodes and FTS recall; source at sessions.ts:179-180 shows it does not erase historical USER_PROMPT/RESULT events. It is therefore not a full transcript scrub; a fresh session avoids old Tier-1 history.
2. Legacy cloud lane card-then-refusal behavior remains. Candidate follow-on: "legacy lane parity with Option A".
3. Option C (a FRONTIER grant protocol) is out of scope.
4. Startup recovery still emits generic "failover approval_blocked" (pin failover.ts:666-671, current :674); this is a follow-on. Private routing excludes private tasks from that path.
5. Amended operator runbook, not executed against the live stack: one write-tool task on the cloud lane, confirm task ends with named-tool error and Retry locally chip; click it and confirm local re-run raises normal Allow card. Existing UI label is "run on this machine".

## Accounting and confidence

Declared builder budget: 45,000 tokens. Seat: Codex, GPT-6 family per injected system instructions; exact serving model ID unavailable. Input tokens: unavailable; output tokens: unavailable; total tokens: unavailable. **token usage unavailable**: the tool/runtime interface exposes no provider token counters for this seat. Cost USD: unavailable. No subagents used.

Builder confidence: 94% that the scoped acceptance behavior is met, based on tests-first defect evidence, preservation checks, complete post-change suites, source/diff review and real temporary gateway/ledger seams. Remaining uncertainty is the unexecuted operator live-cloud/UI runbook and independent G2A review. This document is not a G2A pass.

