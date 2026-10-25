# Verification — T-TCLAW-CONSOLE-REVIEW-01 Slice 2

Date: 2026-10-24. Authority: TORQ V5 `01_design/build_spec.md`, its six binding G1R amendments, and the operator's builder instruction. Build complete for G2A audit; this document is not independent acceptance.

## Pin and branch

- Repository: `E:/TORQCLAW`.
- Branch: `fix/tclaw-console-review-01-slice-2`.
- Pin and current HEAD: `fd270d93f663632a657dcfd122d322c8b0bd8c5c` (PR #67 merge, Slice 1).
- Slice 2 changes are uncommitted. No Slice 2 commit, push, merge, release, or live-stack operation was performed.

## What changed

Implemented the five approved console feedback fixes: invalid custom budgets are rejected inline (including the browser's native invalid-input path and local/cloud recovery actions); unsent tool/skill decisions stay actionable with a retry note; raw gateway control errors become schema-validated, local ERROR rows without changing the cursor, busy state, or active task; connected quiet sockets show idle/stale labels instead of reconnecting; and the third route state reads cloud ok with the exact approved tooltip. Backend routing, approvals, spend enforcement, contracts, reconnect behavior, ring size, and presence helpers are unchanged.

| Path | Action | Purpose |
|---|---|---|
| `apps/console/src/components/TorqTerminal.tsx` | modify | C1 budget guard and native invalid-input feedback; C2 truthful decision state; C4 status badge; C5 route label |
| `apps/console/src/components/useGatewayStream.ts` | modify | C3 schema-validated local control-error construction and append |
| `apps/console/src/components/friendly.ts` | modify | C3 separate marker-exact busy-neutral predicate |
| `tests/torq-terminal-budget-gate.test.tsx` | create | C1 budget rejection, recovery guards, positive budget, pure helper |
| `tests/torq-terminal-decision-send.test.tsx` | create | C2 unsent tool and skill decisions remain actionable |
| `tests/gateway-stream-control-error.test.ts` | create | C3 event shape, JSON edge cases, unchanged classification |
| `tests/torq-terminal-control-error-row.test.tsx` | create | C3 busy/anchor preservation and unmarked/truthy-marker negative controls |
| `tests/torq-terminal-route-label.test.tsx` | create | C5 exact label/tooltip/cycle and CLOUD_OK recovery preservation |
| `tests/torq-terminal-control-error-wire.test.tsx` | create | C3 real WebSocket → hook → terminal path, cursor and warning preservation |
| `tests/torq-terminal-sync-state.test.tsx` | modify | C4 idle/busy connected stale cases and preserved header cases |
| `tests/torq-terminal-presence.test.tsx` | modify | C4 approved stale-label assertion update |
| `docs/VERIFICATION-TCLAW-CONSOLE-REVIEW-01-S2.md` | create | Pin, exact case classification, results, limits, operator runbook and accounting |

## Baseline and final results

The first command after branch checkout was `pnpm test`. That initial pin run was NOT green: 194 files, 1 failed / 2756 passed / 1 skipped; `private-prompt-mark.test.ts` timed out at 30000 ms. The unchanged isolated case then passed (1/1). A complete pin rerun with the proposed tests still present produced exactly the 11 expected console defect failures, 2758 passes and one skip across 200 files, with no unexpected failures. Pin typecheck passed 14/14 (14 cached). The room-job flake exception was not invoked.

The first post-change full run had one different unexpected failure: `agent-participation-s4-presence.test.ts` timed out waiting 20000 ms for its test gateway. Its 12 cases passed unchanged in isolation. Both the failing test and its gateway harness match the pin; the same presence suite passed in both pin runs. These timeouts are disclosed rather than waived. No timeout, test assertion, worker setting, or backend source was changed to address them. Resource contention is only an unconfirmed hypothesis. The final default `pnpm test` passed all 200 files with 2769 passed and the same one skipped test.

### First pin baseline

```text
 Test Files  1 failed | 193 passed (194)
      Tests  1 failed | 2756 passed | 1 skipped (2758)
   Start at  19:47:58
   Duration  456.66s (transform 7.36s, setup 0ms, collect 82.13s, tests 660.76s, environment 10.63s, prepare 31.84s)
```

### Full pin rerun with proposed tests present

```text
 Test Files  8 failed | 192 passed (200)
      Tests  11 failed | 2758 passed | 1 skipped (2770)
   Start at  19:56:30
   Duration  279.53s (transform 4.10s, setup 0ms, collect 36.74s, tests 444.96s, environment 24.34s, prepare 16.63s)
```

### Final exact test files at pinned production

```text
 Test Files  8 failed (8)
      Tests  11 failed | 12 passed (23)
   Start at  20:17:18
   Duration  4.86s (transform 392ms, setup 0ms, collect 2.47s, tests 1.38s, environment 3.04s, prepare 556ms)
```

### Final focused cases

```text
 Test Files  8 passed (8)
      Tests  23 passed (23)
   Start at  20:12:04
   Duration  5.03s (transform 429ms, setup 0ms, collect 2.66s, tests 1.38s, environment 3.16s, prepare 537ms)
```

### Final full suite

```text
 Test Files  200 passed (200)
      Tests  2769 passed | 1 skipped (2770)
   Start at  20:12:19
   Duration  270.39s (transform 3.25s, setup 0ms, collect 29.23s, tests 453.41s, environment 12.39s, prepare 14.01s)
```

### Pin typecheck

```text
 Tasks:    14 successful, 14 total
Cached:    14 cached, 14 total
  Time:    3.964s >>> FULL TURBO
```

### Final typecheck

```text
 Tasks:    14 successful, 14 total
Cached:    13 cached, 14 total
  Time:    34.583s 
```

Final typecheck: 14/14 tasks; 13 cached and the changed console typecheck executed. Task cards: 8/8 in isolation. Graph build exited 0; fitness PASS; all smoke tests passed. Nonfatal graph warnings: zero-node files, missing optional SQL parser, and HTML visualization skipped for graph size. No dependencies were installed to silence them. No direct engine pytest run was required or performed.

## Exact test classification

The eight target files contain **23 actual cases: 11 DEFECT and 12 PRESERVATION**. The spec explicitly requires 16 of those cases (11 DEFECT, 5 PRESERVATION); seven are unchanged companion cases. Six new files add 11 cases, and sync-state adds one net case: **12 net new cases**. There are no MIXED cases and no new skips. Every row below has a separate exact `it(...)` name. The final pin and final focused logs prove each row individually.

| File | Exact `it(...)` name | Class | Pin | Final patch | Required |
|---|---|---|---|---|---|
| `tests/torq-terminal-presence.test.tsx` | stale while a task should be producing events -> the stale badge calls stream.reconnect | DEFECT | RED | GREEN | yes |
| `tests/torq-terminal-presence.test.tsx` | idle + connected + fresh -> CONNECTED, no badge, M:SS synced readout | PRESERVATION | GREEN | GREEN | companion |
| `tests/torq-terminal-presence.test.tsx` | disconnected -> CONNECTED is replaced by the RECONNECTING… badge | PRESERVATION | GREEN | GREEN | companion |
| `tests/torq-terminal-presence.test.tsx` | busy task renders tier / lock / budget-remaining from the wire | PRESERVATION | GREEN | GREEN | companion |
| `tests/torq-terminal-presence.test.tsx` | no presence card when idle (no task to be present about) | PRESERVATION | GREEN | GREEN | companion |
| `tests/torq-terminal-sync-state.test.tsx` | green CONNECTED when connected and data is fresh | PRESERVATION | GREEN | GREEN | yes |
| `tests/torq-terminal-sync-state.test.tsx` | idle_connected_socket_is_not_labelled_reconnecting | DEFECT | RED | GREEN | yes |
| `tests/torq-terminal-sync-state.test.tsx` | busy_connected_stale_shows_stale_not_reconnecting | DEFECT | RED | GREEN | yes |
| `tests/torq-terminal-sync-state.test.tsx` | disconnected -> the badge replaces CONNECTED (error state, no green lie) | PRESERVATION | GREEN | GREEN | yes |
| `tests/torq-terminal-sync-state.test.tsx` | shows SESSION BUDGET label, dash value before any frame, and a working refresh | PRESERVATION | GREEN | GREEN | companion |
| `tests/torq-terminal-sync-state.test.tsx` | renders kernel-recorded totals as $X.XX / $Y.YY once a frame lands | PRESERVATION | GREEN | GREEN | companion |
| `tests/torq-terminal-sync-state.test.tsx` | synced readout uses M:SS | PRESERVATION | GREEN | GREEN | companion |
| `tests/torq-terminal-decision-send.test.tsx` | approval_decision_not_marked_when_send_fails | DEFECT | RED | GREEN | yes |
| `tests/torq-terminal-decision-send.test.tsx` | skill_decision_not_marked_when_send_fails | DEFECT | RED | GREEN | yes |
| `tests/torq-terminal-budget-gate.test.tsx` | custom_budget_zero_is_rejected_visibly | DEFECT | RED | GREEN | yes |
| `tests/torq-terminal-budget-gate.test.tsx` | custom_budget_positive_submits_with_maxCostUsd | PRESERVATION | GREEN | GREEN | yes |
| `tests/torq-terminal-budget-gate.test.tsx` | custom_budget_problem_is_pure | DEFECT | RED | GREEN | yes |
| `tests/torq-terminal-control-error-row.test.tsx` | control_error_line_does_not_flip_busy_or_anchor | DEFECT | RED | GREEN | yes |
| `tests/torq-terminal-control-error-wire.test.tsx` | control_error_frame_renders_visible_line | DEFECT | RED | GREEN | yes |
| `tests/gateway-stream-control-error.test.ts` | control_error_event_shape | DEFECT | RED | GREEN | yes |
| `tests/gateway-stream-control-error.test.ts` | classify_gateway_frame_unchanged | PRESERVATION | GREEN | GREEN | yes |
| `tests/torq-terminal-route-label.test.tsx` | route_chip_third_state_reads_cloud_ok | DEFECT | RED | GREEN | yes |
| `tests/torq-terminal-route-label.test.tsx` | resend_cloud_still_sends_CLOUD_OK | PRESERVATION | GREEN | GREEN | yes |

Pin defect evidence: zero budgets send/no inline note; absent exported helpers; false decision sends still mark approved; raw control frames are dropped; marked requestless errors incorrectly hide stop; new stale labels and cloud-ok label are absent. The final budget case also asserts that a negative native number input raises the same inline note. All final tests stayed present while only the three production files were temporarily restored to the pin. Complete pin evidence: `s2_pin_final_complete.log`; restoration evidence: `s2_restored_hashes.log` matches `s2_pre_reproof_hashes.log` exactly for all 11 implementation/test files.

## Acceptance and preservation evidence

| Invariant | Evidence |
|---|---|
| I1 | Pure finite-positive helper, mounted budget/recovery tests, native invalid-input check; buildJudgment and PREVIEW_ROUTE logic unchanged |
| I2 | Stable false→true mocks; buttons retained on false; note cleared and decision rendered on true; both tool and skill commands checked |
| I3 | GatewayEventSchema.parse; UUID id; validated stored session or nil UUID; missing seq/requestId null; real raw WebSocket test preserves cursor 41 and console.warn |
| I4 | Separate ERROR && gatewayControlError === true predicate; stop still sends CANCEL_TASK for r1; absent, false and string-true markers remain terminal; SYSTEM-only predicate unchanged |
| I5 | Fresh/disconnected/idle-stale/busy-stale cases; reconnect click retained; old copy absent from apps/console/src; presence.ts unchanged |
| I6 | Exact cloud ok label and tooltip; cycle back to AUTO; resend still CLOUD_OK; unchanged task-card suite passes 8/8 |
| I7 | Only the 12 listed owned files; protected backend paths have empty diff; HEAD stays at the pin |
| I8 | Raw, unfiltered Git blob hashes match the pin for the fixture and contracts-fixtures test |

`rg -n GatewayEventSchema apps/console/src` found executable schema validation in useGatewayStream only (other hits are ChannelsPanel comments). Synthetic construction now uses parse; stored-session validation uses the schema field. Protected source/tests (including friendly's existing matrix) were verified with `git hash-object --no-filters` against pin blobs. Functional React state updates preserve immutable decision maps; the budget note uses role=alert. No unrelated React refactor was introduced.

## Scope and changed pins

The literal requested command `git diff fd270d9 HEAD --stat` produced **no output**, because the build is handed off uncommitted. It does not describe the working patch. `git diff fd270d9 --stat` covers five tracked changes; the six new tests and this new document are separately listed above and in the final SHA-256 manifest. The tracked working diff before this untracked document was:

```text
apps/console/src/components/TorqTerminal.tsx    | 74 +++++++++++++++++++------
 apps/console/src/components/friendly.ts         |  5 ++
 apps/console/src/components/useGatewayStream.ts | 26 +++++++++
 tests/torq-terminal-presence.test.tsx           |  5 +-
 tests/torq-terminal-sync-state.test.tsx         | 20 ++++++-
 5 files changed, 109 insertions(+), 21 deletions(-)
```

`git diff --check` passed. The protected-path diff for packages, engines, ops, apps/console/src/app, presence.ts, tests/fixtures and contracts-fixtures was empty. All eight required unchanged console regression files passed in the full suite and have raw-byte equality to the pin. The existing operator-owned untracked agent files, .tmp, planning documents/assets, ops/skill-staging and screenshots were not modified; full inventory is in `s2_final_inventory.log`.

The only pre-existing assertion edits are the approved stale-copy pins:

- `tests/torq-terminal-sync-state.test.tsx`: connected idle is not reconnecting; the old copy asserted a reconnect that was not happening. Retained the busy scenario as its own named case with the truthful stale label.
- `tests/torq-terminal-presence.test.tsx`: a connected busy socket shows stale 30 s+ and remains click-to-reconnect; the old copy incorrectly claimed reconnecting. The file also receives its previously missing trailing newline.

## C1 decision record

Reject zero visibly. `packages/bridge/src/hermes.ts:79` returns without a spend heartbeat or breach when cost is unreportable. Line 89 trips only when provider-reported `costUsd > budget`, after spend; zero is therefore not a reliable no-spend hard cap. The console points to Free (local only), preserves contracts' acceptance of zero, and leaves all backend enforcement unchanged.

## Implementation notes and deviations

No scope expansion or omitted required test. One implementation detail was added to C1: the custom number input's `onInvalid` invokes the shared budget helper, because native `min="0"` validation can prevent `onSubmit` for a negative value. Existing min/max/step constraints remain intact. The same required budget test was strengthened to cover this path; no assertion was removed or relaxed. The final test files were rerun against exactly pinned production files and then the implementation was restored byte-for-byte (SHA-256 check). All final tests remained present during every pin check.

A supplemental final-pin tool response was truncated (`s2_pin_final_tests.log`); it is retained as incomplete diagnostic evidence. The same command was repeated with a sufficient capture limit; `s2_pin_final_complete.log` is the authoritative, complete final-pin evidence. The initial baseline timeout and first post-change timeout required additional unchanged reruns, as described above. No known-flake exception was used.

## Known limitations

G2A independent audit and acceptance are pending. The live stack was not operated or restarted; the operator must restart it before live checks because it was reported to be pre-Slice-1. C3 control-error lines are local and seq-less, are not persisted, and disappear on reload. C5 changes the label only; CLOUD_OK routing behavior remains deferred. An empty prompt returns before the budget guard, by approved design. The quiet busy badge and the task liveness chip can coexist. The two historical timeout causes were not established; both cases passed in the final full run. No direct Python engine pytest suite was run or required (no engines change); the repository's ordinary Vitest suite may launch its existing Python fixtures, and Graphify smoke uses Python.

## Operator live runbook

After the operator restarts the stack:

1. Enter a nonempty task with custom budget `0`: confirm the exact inline message, no submit dispatch, and that editing the budget or selecting Free clears it.
2. Complete a task, wait at least 40 seconds with the socket connected, and confirm `idle 30 s+` instead of RECONNECTING; clicking the badge still forces a reconnect.
3. Cycle ROUTE to its third state and confirm `cloud ok` and tooltip `cloud permitted; the router still decides`; cycle once more back to auto.

## Token accounting

Seat runtime: Codex, GPT-6 family as identified by the system; exact provider runtime model ID unavailable. Declared budget at start: 45,000 tokens. Input tokens: unavailable; output tokens: unavailable; total tokens: unavailable; cost usd: unavailable. Token usage unavailable: the runtime/tool interface exposes no authoritative per-seat usage or billing counters, so no usage or cost is inferred. Graph generation was local AST processing, without a paid model call.

## D-1 refinement (refine_ui) — 2026-10-24

G2A rejected with one MAJOR D-1 routed to refine_ui: the route-chip `title` was unconditionally `cloud permitted; the router still decides`, falsely claiming cloud permission in the `local ▾` and `local (free)` states, and dropping the I6 pin title everywhere. The revision touched exactly the two files the audit named:

- `apps/console/src/components/TorqTerminal.tsx:1262`: the title is now conditional on the same predicate as the label (`controls.budget !== 'free' && effectiveMode === 'CLOUD_OK'`); all other states restore the pin title from `fd270d9` line 1232, byte-identical.
- `tests/torq-terminal-route-label.test.tsx` (`route_chip_third_state_reads_cloud_ok`): assertions added only — `auto ▾` carries the pin title initially and after the third click; `local ▾` carries the pin title and not the cloud-permitted string. The case remains DEFECT-class (RED at the pin, whose third-state label reads `cloud`).

Rerun summaries, verbatim:

`npx vitest run tests/torq-terminal-route-label.test.tsx tests/torq-terminal-route-chip.test.tsx tests/torq-terminal-task-cards.test.tsx tests/torq-terminal-live-affordances.test.tsx`

```text
 Test Files  4 passed (4)
      Tests  48 passed (48)
   Start at  20:50:20
   Duration  3.52s (transform 357ms, setup 0ms, collect 1.63s, tests 1.30s, environment 1.75s, prepare 267ms)
```

`pnpm test`

```text
 Test Files  200 passed (200)
      Tests  2769 passed | 1 skipped (2770)
   Start at  20:50:33
   Duration  262.83s (transform 2.89s, setup 0ms, collect 27.90s, tests 441.73s, environment 11.53s, prepare 13.52s)
```

`pnpm typecheck`

```text
 Tasks:    14 successful, 14 total
Cached:    13 cached, 14 total
  Time:    4.363s
```

The route chip's tooltip is now state-dependent, so the operator runbook step 3 applies to the `cloud ok` state only; in `auto` and `local` the tooltip reads the pin title. New SHA-256 for the two changed files: `TorqTerminal.tsx` `46FE6A09EE26A816415F972EB59DF29129E6CE5D9119C1BD27A63098030C32AB` (123066 bytes), `tests/torq-terminal-route-label.test.tsx` `C19E7C23EDA98D8618E220CD98F950CB5143C47BCA7FBF0319B364107ECD263D` (2607 bytes). `s2_final_manifest.log` is refreshed and remains the hash of record.

## Evidence

Canonical build report and all logs: `E:/TORQ-CONSOLE/.torq/v5/artifacts/02_build/`. The report contains first-20/last-20 excerpts; raw logs preserve complete output except the explicitly labeled superseded truncated capture. Key evidence: `s2_pin_final_complete.log`, `s2_post_final_focused.log`, `s2_post_final_full.log`, `s2_post_typecheck.log`, `s2_task_cards.log`, `s2_protected_raw_hashes.log`, `s2_final_manifest.log`, and `s2_commands.md`.
