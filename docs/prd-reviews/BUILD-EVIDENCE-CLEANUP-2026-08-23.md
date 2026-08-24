# Builder Evidence Packet — Item C items 8/9/10/13 (Builder N scope)

**Contract:** `docs/prd-reviews/G1D-FABLE-CLEANUP-DOCS-TRUTH-2026-08-23.md`, Item C items 8, 9, 10, 13,
as amended by the G1D resolution (B-3, B-6, NB-3, NB-6) and test obligations T-7/T-8.
**Base:** `origin/master @ a3c6180`, branch `phase1-server-owned-authority`.
**Builder:** Claude Sonnet 5 (implementer only — did not design, did not self-approve).

## Objective (one sentence)

Widen the Python `TORQCLAW_WEB_SEARCH_ENABLED` gate to TS truthy parity, make `pnpm lint`
honestly self-describing instead of vacuously green, and close the cron NB-1/NB-2/NB-4
non-blockers exactly as filed — nothing beyond what was filed, no behavior change outside
each item's own boundary.

## Scope

- Item 10: Python truthy parity (`server.py`) + T-7 parametrized test + 2 mirroring TS comments
  (comment-only, no TS code change).
- Item 9 reduced (B-6): `pnpm lint` self-describing, no ESLint, + T-8 test.
- Items 8+13 cron NB-1/NB-2/NB-4: discovery-first (NB-6), then bounded fixes with no
  `autoReplyDispatcher.ts` change (frozen file — confirmed untouched throughout).
- FOLLOWUPS append: ESLint-adoption task block at the true end of the file (append-only,
  Builder D owns the rest of `docs/**`).

**Excluded (per assignment):** `subscriptionAcpRuntime.ts`, `subscriptionAgentRuntime.ts`,
`dispatch.ts`, `packages/collab/src/store.ts`, `tests/agent-participation-{a3c,s3,s4-*}.test.ts`,
`tests/subscription-*.test.ts` (Builder M); `docs/**` and `README.md` other than the one
FOLLOWUPS append (Builder D). Verified untouched by me — see "Scope discipline" below.

## Controlling invariant

Every fix closes a *recorded* gap exactly as filed — no behavior change beyond the filed
defect, no test weakened, fail-closed direction preserved everywhere. Widen Python, never
narrow TS (G2A's standing direction on item 10). `autoReplyDispatcher.ts` stays frozen this
slice — confirmed: neither NB-1, NB-2, nor NB-4 required touching it; both NB-4 code changes
live in `packages/collab/src/cron.ts` and `packages/gateway/src/cronDispatcher.ts` only.

## What changed

### Item 10 — Python truthy parity

- `engines/hermes_kernel/mcp_wrapper/server.py:293` (approx): gate widened from
  `os.environ.get(...) == "1"` to `(os.environ.get(...) or "").strip().lower() in
  {"1","true","yes","on"}` — same truthy set as TS's `collabSurface.ts` `TRUTHY` constant,
  same trim-then-lowercase-then-membership-check shape as `(env ?? '').trim().toLowerCase()`
  then `TRUTHY.has(...)`.
- `packages/gateway/src/collabSurface.ts` (webSearchEnabled doc block, ~line 118) and
  `packages/gateway/src/server.ts` (~line 1150): comment-only edits updating the mirrored
  Python gate text to match the new Python source exactly. Grep-verified these are the ONLY
  two locations in `packages/` that quote the Python gate text — the task description's
  "THREE comments" enumerated two distinct file locations plus a restatement of one of them
  as "the webSearchEnabled doc block"; both actual occurrences are fixed.
- No TS code changed in either file — comment-only, confirmed by reading the diff.

### Item 9 reduced (B-6) — honest lint gate

- New `ops/lint-not-configured.mjs`: prints
  `lint not configured — no ESLint in this repo; see docs/FOLLOWUPS-CI-E2E-GATES.md (ESLint adoption task)`
  and exits 0.
- `package.json`: `"lint": "turbo run lint"` → `"lint": "node ops/lint-not-configured.mjs"`.
- No ESLint dependency, config, or per-package script added anywhere.

### Items 8+13 — cron NB-1/NB-2/NB-4 (see Discovery Report below for full disposition)

- **NB-2** (test title fix): renamed the test in `tests/agent-participation-cron.test.ts`
  from `'FALSIFIABILITY: with dispatch() unreplaced (no override)...'` (which overclaimed —
  its own comment admitted the override stayed installed) to a title describing what the
  assertions actually prove (the claim mechanism is real; a stranger agent is refused at wake).
- **NB-4** (recovered run drops promptHint):
  - `packages/collab/src/cron.ts`: `StrandedScheduleRun` gained a `promptHint: string | null`
    field; `findStrandedScheduleRuns`'s SELECT now `JOIN`s `collab_agent_schedules` and
    projects `s.prompt_hint AS promptHint`.
  - `packages/gateway/src/cronDispatcher.ts:406`: `recoverStrandedScheduleRuns` now calls
    `runScheduledTurn(..., run.promptHint)` instead of a hardcoded `null`.
- **NB-1** (poison-router FRONTIER test): new permanent behavioral test in
  `tests/agent-participation-cron.test.ts` reproducing G2A's own verifier-owned probe
  (previously "since removed," per `docs/prd-reviews/VERIFY-OPUS-CRON.md` §3): monkey-patches
  `router.evaluateRequest` on the exact module instance the built `cronDispatcher.js` imports
  to always return `tier: 'FRONTIER'`, fires a real due schedule through `tickSchedules()`,
  captures the diag object at the `setCronDispatchForTest` seam, and asserts the tier reaching
  dispatch is still `OLLAMA_LOCAL` — with a positive control proving the poison is live, and a
  verified restore in `finally` (byte-identity check plus reinstallation of the standard
  capturing override every other test in the describe block depends on).
- Extracted `installStandardDispatchOverride()` helper so the NB-1 test can cleanly restore
  the `beforeAll`-installed override afterward (previously inlined only in `beforeAll`).

### FOLLOWUPS append (docs/FOLLOWUPS-CI-E2E-GATES.md)

Appended `## ESLint adoption (filed 2026-08-23)` at the true end of the file (verified current
end-of-file before appending, since Builder D was concurrently editing this doc): scoped
package list (first-party TS workspace packages, vendored hermes-agent excluded),
correctness-only rule set (no stylistic churn), findings-owner = operator, acceptance
criteria for the follow-up task itself.

## Files changed (mine only — verified via `git status --short` against the excluded-file list)

- `engines/hermes_kernel/mcp_wrapper/server.py`
- `engines/hermes_kernel/tests/test_server_runtime.py`
- `package.json`
- `ops/lint-not-configured.mjs` (new)
- `tests/lint-gate-honesty.test.ts` (new)
- `packages/collab/src/cron.ts`
- `packages/gateway/src/cronDispatcher.ts`
- `packages/gateway/src/collabSurface.ts` (comment-only)
- `packages/gateway/src/server.ts` (comment-only)
- `tests/agent-participation-cron.test.ts`
- `docs/FOLLOWUPS-CI-E2E-GATES.md` (append-only, one section)

## Tests added/changed

- `engines/hermes_kernel/tests/test_server_runtime.py`: added
  `test_web_search_flag_truthy_parity_enabled` (parametrized:
  `"1","true","TRUE","yes","on"," 1 "`), `test_web_search_flag_truthy_parity_disabled`
  (parametrized: `"","0","false","no","off","2","nope"`), and
  `test_web_search_flag_truthy_parity_unset` — T-7.
- `tests/lint-gate-honesty.test.ts` (new): T-8 — asserts `pnpm lint` exits 0 and stdout
  contains `lint not configured`; also checks the underlying script in isolation and that
  `package.json` no longer routes through `turbo run lint`.
- `tests/agent-participation-cron.test.ts`:
  - Renamed the NB-2 test (see above).
  - Added `NB-4 ... findStrandedScheduleRuns joins the OWNING schedule's promptHint` (RED
    reproduced against the pre-fix SELECT).
  - Added `NB-4: recoverStrandedScheduleRuns passes the stranded run's OWN promptHint, never
    a hardcoded null` (source-level pin, RED reproduced against the pre-fix call site).
  - Added `NB-1 ...: the FRONTIER fence survives a POISONED router` (behavioral, permanent).

## Discovery report — cron NB-1/NB-2/NB-4 (NB-6 discipline: discovery before writing)

Read `docs/FOLLOWUPS-CI-E2E-GATES.md:81-85` (as it existed on `a3c6180`) and
`docs/prd-reviews/G2A-OPUS48-CRON.md` (the full audit these non-blockers were filed from),
then inspected `tests/agent-participation-cron.test.ts` and
`packages/collab/src/cron.ts` / `packages/gateway/src/cronDispatcher.ts` on `a3c6180`.

| Item | Filed description | Disposition | Evidence |
|---|---|---|---|
| **NB-2** | "FALSIFIABILITY title" — the test titled `FALSIFIABILITY: with dispatch() unreplaced (no override)...` doesn't do what its title says. | **real-and-bounded, test-title-only.** Confirmed: the test's own comment admits the `setCronDispatchForTest` override is never removed (removing it would hang on a real Ollama call). The assertion inside (claim mechanism is real; a membership-less stranger is refused at wake) is sound and unchanged. | Read `tests/agent-participation-cron.test.ts:663` on `a3c6180`; G2A's own N-2 note in `G2A-OPUS48-CRON.md` confirms the same finding. |
| **NB-4** | "recovered run drops promptHint" — `recoverStrandedScheduleRuns` passes `null` for `promptHint` (`cronDispatcher.ts:406`), silently dropping the operator's note on exactly the turn that already failed once. | **real-and-bounded, no dispatcher-source change needed.** Confirmed at `cronDispatcher.ts:406` on `a3c6180`: `runScheduledTurn(store, db, run.scheduleId, run.fireSeq, run.channelId, run.agentPrincipalId, null)`. The fix requires only (a) joining `collab_agent_schedules.prompt_hint` into `findStrandedScheduleRuns`'s SELECT in `packages/collab/src/cron.ts`, and (b) passing `run.promptHint` instead of the literal `null` at the cited call site in `cronDispatcher.ts`. Neither touches `autoReplyDispatcher.ts`. | RED quotes below. |
| **NB-1** | "commit G1R's poison-router FRONTIER test" — G2A's own probe (monkey-patch the built router dist's `evaluateRequest` to FRONTIER, fire a schedule, capture the diag at the dispatch seam) was "verifier-owned, since removed" and should be committed as a permanent test. | **matches filed description; not previously committed uncommitted anywhere** (checked `git status --short` on the relevant files at session start — clean; grepped `tests/` for `poison`/`OLLAMA_LOCAL`/`frontierGrantFenced` — no cron-specific poison-router test existed, only the unrelated `tests/frontier-grant-fence-unconditional.test.ts`, which tests a different fence (`frontierGrantFenced` in `dispatch.ts`) via a different mechanism). Implemented as a source-level (not built-dist-text-mutation) equivalent: `cronDispatcher.ts` already exports a source-level test seam (`setCronDispatchForTest`) and imports `router` as a mutable singleton instance, so monkey-patching `router.evaluateRequest` directly (rather than hand-editing the compiled `.js`) reproduces the identical property (router computes FRONTIER; the diag reaching dispatch is still `OLLAMA_LOCAL`) without the restore-from-string risk of text-patching a dist file. | RED not applicable in the same before/after sense (this is a new test, not a fix to existing behavior) — instead verified the positive control (`poisoned.tier === 'FRONTIER'`) fires and the assertion is load-bearing by confirming it exercises the real spread-then-override fence at `cronDispatcher.ts:286`. |

No item required a design change or touched `autoReplyDispatcher.ts`. No item is deferred as
RETURN_TO_GATE_1.

## RED-first evidence

### NB-4, test 1 (SELECT-join), reproduced against the pre-fix `cron.ts` on `a3c6180`:

```
THE LOAD-BEARING ASSERTION: promptHint must be joined in, not dropped: expected undefined to be 'NB-4 operator note'

- Expected: "NB-4 operator note"
+ Received: undefined
```

### NB-4, test 2 (source-level pin on `cronDispatcher.ts`), reproduced against the pre-fix call site:

```
NB-4 REGRESSION: recoverStrandedScheduleRuns must pass run.promptHint, not a hardcoded null: expected 'null' to be 'run.promptHint'

Expected: "run.promptHint"
Received: "null"
```

Both REDs were captured by temporarily reverting `packages/collab/src/cron.ts` and
`packages/gateway/src/cronDispatcher.ts` to their exact `a3c6180` (pre-fix) content, force
rebuilding (`turbo run build --filter=@torqclaw/gateway... --force`, 6/6 tasks green), and
running `npx vitest run tests/agent-participation-cron.test.ts -t "NB-4"`. Both fixed files
were then restored from a verified backup and **byte-diffed against that backup
(`diff` reported zero differences for both files)** before rebuilding and re-confirming GREEN.

## Commands + actual results

```
cd engines/hermes_kernel && uv run pytest tests/test_server_runtime.py -q
→ 62 passed in ~9-11s

cd engines/hermes_kernel && uv run pytest tests -q
→ 532 passed, 1 skipped, 11 deselected in 184.57s

pnpm lint
→ stdout: "lint not configured — no ESLint in this repo; see docs/FOLLOWUPS-CI-E2E-GATES.md (ESLint adoption task)"
→ exit code 0

node node_modules/turbo/bin/turbo run build --filter=@torqclaw/gateway... --force
→ 6/6 tasks successful (contracts, collab, router, bridge, inference, gateway)

npx vitest run tests/agent-participation-cron.test.ts tests/lint-gate-honesty.test.ts
→ Test Files: 2 passed (2); Tests: 19 passed (19)

node node_modules/turbo/bin/turbo run typecheck --force
→ 14/14 tasks successful across 9 packages (bridge, channel-http, collab, console,
  contracts, gateway, hermes-kernel [python stub], inference, router)
```

Full repo-wide `pnpm test` (entire vitest suite) and `pnpm build` (entire turbo build) were
NOT run standalone in this session because Builder M's concurrent edits to
`subscriptionAcpRuntime.ts`, `store.ts`, `dispatch.ts`, and several `subscription-*`/
`agent-participation-{a3c,s4}` test files were in flight throughout — running the full suite
against a mid-edit sibling tree would not produce meaningful pass/fail evidence attributable
to my changes. The targeted commands above (narrow cron test file, my new test files, full
Python suite, full typecheck, force builds of every package on the dependency path my changes
touch) cover every file I changed and every test I added or modified.

## Scope discipline (verified)

`git status --short` on Builder M's excluded files
(`subscriptionAcpRuntime.ts`, `subscriptionAgentRuntime.ts`, `dispatch.ts`, `store.ts`,
`tests/agent-participation-{a3c,s3,s4-*}.test.ts`, `tests/subscription-*.test.ts`) shows
modifications — all from Builder M's concurrent work, none from me (confirmed by reviewing
only the diffs I authored via Edit/Write calls in this session). `docs/PRD-MAP.md` and other
`docs/**`/`README.md` changes are Builder D's; my only docs edit is the one authorized
append to `docs/FOLLOWUPS-CI-E2E-GATES.md`, made at the verified true end of the file.

## Runtime/browser/a11y evidence

Not applicable — this slice is server/Python/test-infrastructure only (Python flag gate,
lint script, cron dispatcher internals, test files). No UI, no browser-rendered surface.

## Known limitations

- Item 10's Python `.strip()` vs TS's `.trim()` are not byte-identical across the full Unicode
  whitespace class (TS's `String.prototype.trim` strips a slightly broader set than Python's
  `str.strip()` with no arguments) — for the bounded ASCII flag values this gate actually sees
  (`"1"`, `"true"`, etc., optionally with ordinary spaces), the practical behavior is identical
  and T-7's `" 1 "` case is covered. Not treated as a defect; noted for completeness.
- NB-1's implementation mutates the router singleton's method directly rather than patching
  the compiled `.js` file's text (G2A's original one-off probe). This is a deliberate,
  equivalent, and more robust adaptation of the same property for a **permanent** test (no
  string-patch/restore risk against a shared dist file other test workers may be reading
  concurrently) — flagged explicitly rather than silently substituted.
- The FOLLOWUPS append assumes Builder D does not concurrently append to the same end-of-file
  region; the true end-of-file was re-verified immediately before the edit (line 113 at time
  of edit), consistent with the append-only carve-out in my instructions.

## Deviations from the packet

None beyond the one disclosed adaptation (NB-1's mutation target: live singleton method vs.
dist file text) noted above, which preserves the exact behavioral property specified and adds
robustness. No item's scope was broadened. No test was weakened or deleted.

## Status: READY_FOR_INDEPENDENT_VERIFICATION
