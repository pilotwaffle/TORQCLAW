# G1D Implementation Packet — T4 fix + PRD-007 S7 closure (2026-08-22)

**Author:** Claude Fable 5 (G1D, `claude-fable-5`) · **Branch:** `phase1-server-owned-authority` @ `fa836c9` + operator WIP (146 dirty paths)
**Profile:** session-scoped Claude-only governed routing profile (operator, 2026-08-22).
**Seat availability (probed):** `fable`=G1D · `sonnet`=Builder · `opus`→`claude-opus-5`=G2A · `haiku`=memory writer.
**Opus 4.7 and Opus 4.8 are NOT invocable.** G1R and Independent Verifier seats are filled by *fresh, separate `claude-opus-5` threads* and are recorded as **substitutions** — not as 4.7/4.8 work. Operator may reject this at any gate.

---

## Item A — FRONTIER retry-exhaustion misclassified as success (live defect T4)

### Objective
A Hermes provider failure after retry exhaustion must surface as a **failed attempt** so the failover cascade advances to the next provider, and must never be emitted as a `RESULT` whose text is an error message.

### Existing system (verified this session, file:line)
- Vendored `conversation_loop.py:3203-3216` returns `{final_response: "API call failed after N retries: …", completed: False, failed: True, error, failure_reason}` — **no exception**.
- `mcp_wrapper/hermes_runner.py:706` only checks `final_response` is a string; `:722` returns `{result, telemetry}` and **drops `failed`/`failure_reason`/`error`**. This is the single line where the structured signal is lost.
- `mcp_wrapper/server.py:113-157` calls `task_store.complete()` / emits `code:"completed"` whenever `run_hermes_sync` returns normally.
- `failover_runtime.py:371-379` maps `state==completed` → `kind:"result"`; `bridge/hermesAttempt.ts:668` and `gateway/failover.ts:423` trust `kind` and return success before failover-advance logic at `:432-439`.
- Live reproduction 2026-08-22: `kimi-sub-primary` 3/3 failures → `RESULT` frame, `failoverEnabled:true`, cascade never advanced.

### Controlling invariant
**A Hermes return with `failed: True` is a failed attempt, never a completed task.** Classification uses the structured field only — no English-text matching anywhere.

### Scope (Builder may change)
- `engines/hermes_kernel/mcp_wrapper/hermes_runner.py` (tracked-clean): after the `result` mapping check, detect `result.get("failed") is True`; return a distinguishable failure (raise a typed exception that `normalize_provider_failure()` already maps, carrying `failure_reason`, or add a `failed`/`failureReason` field — Builder picks the one that requires the smallest `server.py` branch and say why).
- `engines/hermes_kernel/mcp_wrapper/server.py` `run_hermes_loop` (tracked-modified WIP — additive branch only): route the failed case to `task_store.fail(...)` with a `normalizedFailure` whose retryability derives from `failure_reason` (`rate_limit`/transport → retryable; `billing`/auth → not).
- `engines/hermes_kernel/tests/test_server_runtime.py` (tracked-modified — additive test only): regression test that fakes `agent.run_conversation()` returning the failed dict and asserts the task is **failed**, never completed, and the emitted observation is not `kind:"result"`.

### Non-scope / prohibited
- No edits to `vendor/hermes-agent/**` (invariant 10).
- No text sniffing in gateway/bridge TS; no changes to `failover.ts`, `hermesAttempt.ts`, `dispatch.ts` (already correct once fed the right `kind`).
- No change to spend/`costSource` semantics.

### Failure behavior / state
- On `failed: True`: task state `failed`, observation `kind != result`, terminal outcome per existing failover contract; one terminal event per task (invariant 7) preserved because emission stays in `dispatch.ts`.

### Acceptance criteria
- **A-T4-1** Python regression test red before / green after.
- **A-T4-2** `uv run pytest engines/hermes_kernel/tests` green; `pnpm test` (TS) unchanged.
- **A-T4-3** Live: re-run the T4 prompt on the real stack; observe either a successor-provider `SYSTEM` attempt after the Kimi failure or an `ERROR` terminal — **never** a `RESULT` with error text. Evidence = harness event stream.

### Rollback
Single-file revert of `hermes_runner.py` + the additive `server.py` branch.

---

## Item B — PRD-007 S7: subscription-model agents as channel participants (closure of the operator WIP)

### Objective (operator ruling 2026-08-22)
"All agent models in TorqClaw operate like `E:\torq-buzz` — same plan for bots and chat channels — under TorqClaw governance." The uncommitted working tree *is* this slice: `agentSurface.ts` (agent CRUD over the ws), `subscription*.ts` (ACP runtimes: grok/kimi/qwen/zai), `AgentsPanel.tsx`, `ops/bootstrap-agent.mjs`, `reclaimStrandedAgentTurn` lease token, plus ~15 new tests. It was built outside this session; it is green on this tree (full suite 2485/1 skipped, typecheck 14/14, reachability PASS — run 2026-08-22).

### Existing system
S1/S2/S3/S5/S6 committed; **S3 A3-c proven live** (`ba7caea`) and G1R-approved with zero blockers (`3cb29ad`); G2A for S3 was owed only because 4.8 was unrunnable. S4 blocked on OQ-2 (operator). Non-blocking F1/F2 from `3cb29ad` open.

### Controlling invariant
**Speech is free; action is approved; identity is server-derived.** An agent model (any provider, subscription or API) may post in a channel it is an active member of without approval; every write-capable tool it invokes remains argument-bound and operator-approved (`admitToolCall` exact-action fence, flag-independent per `a676736`); no client frame can choose an agent's principal, provider, or grants. The exact-model pin for subscription runtimes **fails closed** (`ACP_MODEL_MISMATCH` → `unavailable`) until the operator rules the alias question.

### Scope for this session
1. **No new product code in S7** beyond Item A and what G2A returns as bounded corrections. The Builder's job for S7 is: (a) partition the dirty tree into reviewable commits by slice; (b) run the full gate set on the final tree (`pnpm build --force`-equivalent rebuild, full suite, typecheck, lint, contracts check, reachability, Python tests); (c) boot the real gateway with `TORQCLAW_COLLAB_ENABLED=1 TORQCLAW_AGENT_PARTICIPATION=1 TORQCLAW_AGENT_AUTOREPLY=1` and reproduce the A3-c conversation (two agents, one human post → three committed `collab_events` rows, turns `completed`/`no_post`, never `terminated`) and the STOP control, on the *final* tree.
2. Docs: reconcile PRD-007 §9 OQ-3 against `84bfda3`'s restart-persistence proof (mark closed with the cited evidence, or reopen); record F1/F2 disposition as *filed, non-blocking*.

### Non-scope / prohibited (renewed Gate 1 required)
- S4 working overlay (OQ-2 unruled). Members-only half is **not** in this session.
- Relaxing `exactModelConfig` / alias trust for zai (operator ruling pending).
- Any change to approval semantics, `authz.ts` short-circuits, path scoping, or credential storage.
- Any turn cap on auto-reply (R-2).

### Acceptance criteria
- **A-S7-1** Final tree: all gates green with exact counts recorded.
- **A-S7-2** A3-c live reproduction on the final tree with DB-row evidence (not mocked).
- **A-S7-3** STOP: channel-scoped STOP halts the next dispatch on the live gateway.
- **A-S7-4** Fail-closed proofs hold on the final tree: registration-fail-closed (`bf028af`), flag-independent fence (`a676736`), no-profile-admits-collab_write probe (`ba7caea`).
- **A-S7-5** Commit partition contains no operator file outside the slice, no secrets, no `.torqclaw/` state.

### Operator stop conditions
- Push and merge are **explicitly authorized by the operator for this session** ("after testing commit push and merge"). Merge to `master` proceeds **only** if the pre-merge deletion audit (`git diff --stat master...HEAD`) shows zero unexplained deletions; otherwise stop and report.
- Any G2A `REJECT` stops the commit.

### Required tests
Full suite, Python suite, typecheck, lint, build, contracts check, reachability, plus the two live reproductions (T4, A3-c/STOP).

### Rollback
Branch commits are revertible individually; nothing force-pushed.

---

## G1D resolution of G1R findings (Gate 1 round 1 — G1R seat: `claude-opus-5` substitute for Opus 4.7, verdict REJECT)

| # | Disposition | Ruling |
|---|---|---|
| B-1 | **ACCEPTED (a)** | Item A objective is narrowed to: *a `failed:True` Hermes return is emitted as exactly one terminal `ERROR` (`kind != result`) and never as a `RESULT`.* The cascade-advance clause is **deleted**; post-dispatch retryability is diagnostic only. A-T4-3 is rewritten to the single outcome (T-A6). `decideTransition`'s `pre_dispatch` gate is containment, not a bug — untouched. |
| B-2 | **ACCEPTED** | `_finish_internal_observation` must derive `kind` (`"result"` iff `code == "completed"`, else `"failure"`), never hardcode it. Added to scope with T-A1 (RED first). |
| B-3 | **ACCEPTED** | Fix the unwrapped telemetry at `server.py:131-134` to `{"normalizedFailure": …}` in the same commit, with T-A5. |
| B-4 | **ACCEPTED** | Builder implements a **total** mapping over every vendor `FailoverReason` value into the ledger's allowlisted vocabulary with an explicit default, and T-A2 asserts totality. **G1D ruling on `billing`:** map to `terminal/engine_failure`, **not** `budget/budget_exceeded` — the `budget` class is reserved for TorqClaw's own `maxCostUsd` enforcement; a provider-side billing refusal is not our budget. No new codes may be added to the ledger allowlists. |
| B-5 | **ACCEPTED** | `.gitignore` hardening is the **first commit**. `git add -A` / `.` / `-u` are prohibited for the rest of the session; every commit is an explicit path list; every remaining `??` path is classified before commit. `.runtime/`, `.qwen/`, `.playwright-mcp/`, logs, screenshots, `.bak` files: **report only**, never committed, never deleted. |
| B-6 | **ACCEPTED — bounded S7 product code AUTHORIZED** | `resolveAgentTurn` gains `AND recovery_lease_token IS ?`, returns the changes count, and recovery-path call sites assert it. This is inside the approved S3 architecture (the same fencing token `commitAgentTurnOutput` already honors at `store.ts:2545`), so it is a bounded correction, not a redesign. T-B1 RED first. Without it A-S7-2's restart leg would be unclaimable. |
| N-1 | **Partitioned, flagged** | `web_search` / `agent_reach_doctor` registration + `keyless_web_search.py` / `agent_reach_probe.py` are operator-authored WIP with network egress. They go in **their own commit**, clearly labeled, so the operator can revert it independently; they are **not** counted as S7 and CLAUDE.md §6 approval is recorded as **operator-owned, pending explicit confirmation**. |
| N-2..N-5, N-7 | Filed | Recorded as open, non-blocking; N-7 → Builder prefers `finish_observation` over unconditional `task_store.fail` where reachable. |

Accepted residual risks 1–6 from the G1R record are adopted verbatim. Gate 1 is **resolved**; implementation may begin under the boundaries above.
