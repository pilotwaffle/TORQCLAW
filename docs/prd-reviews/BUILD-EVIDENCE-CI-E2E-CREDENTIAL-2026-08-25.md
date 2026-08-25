# Build Evidence — CI e2e-production-launch operator-credential fix (2026-08-25)

## Objective

Fix the red CI job "e2e - production portable launch (synthetic tokens, stub)" by passing the bootstrapped operator credential to the spawned production console via the environment variable it already supports, without weakening the single-use token-file deletion.

## Scope

- `ops/e2e-production-launch.mjs` only (one file, ~6 added lines).
- No product code touched: `apps/console/src/app/page.tsx`, `ops/dev-up.mjs`, and all other files are unmodified by this change.
- No architectural change: the fix uses an authentication path (`TORQCLAW_OPERATOR_CREDENTIAL` env var) that `page.tsx`'s `operatorCredential()` already checks first, before the file fallback.

## Controlling invariant

The single-use operator credential token file must still be deleted immediately after being read into memory (production hygiene: no live credential left on disk). The fix must supply the credential to the spawned console through the already-supported, already-production-sanctioned mechanism (env var), not by weakening or removing the file deletion, and not by inventing a new credential-passing channel.

## What changed

Root cause (confirmed by reading the code before editing):
1. `apps/console/src/app/page.tsx:8-20` (`operatorCredential()`) requires `TORQCLAW_OPERATOR_CREDENTIAL` env OR `<TORQCLAW_DATA_DIR>/operator-credential.token` on disk at server render, else throws `Operator credential unavailable; bootstrap an operator before starting the console` -> Next.js renders this as a 500.
2. `ops/e2e-production-launch.mjs`'s `bootstrapOperatorCredential()` (originally lines 136-153) mints a real operator credential via `ops/bootstrap-operator.mjs`, reads the single-use token file into memory, then `rmSync`'s the file (by design — single-use, no live credential left on disk).
3. The spawn env was built via `sanitizeInheritedEnv` (line 284, before the credential existed) and the child process was spawned at line 293 with that env — nothing ever injected the in-memory credential into `env` afterward. Result: the spawned console had neither the file (deleted) nor the env var, so every request to `/` 500'd, and `waitForRuntime` timed out after 60s waiting for a 200.

Fix: immediately after `const credential = bootstrapOperatorCredential(root, env, dataDir);` (now line 288), added:
```js
env.TORQCLAW_OPERATOR_CREDENTIAL = credential;
```
with an inline comment explaining why this is the correct, already-supported production mechanism, not a test-only shortcut.

Verified `sanitizeInheritedEnv` (lines 44-76) builds and returns a plain JS object via `Object.fromEntries`/`Object.assign` with no allowlist enforcement applied *after* construction — assigning a new key onto the already-built `env` object before it is handed to `spawnImpl` (line 293) is picked up correctly with no further filtering step in between. No allowlist entry was needed.

## Files changed

- `ops/e2e-production-launch.mjs` (+6 lines, 0 removed)
- `docs/prd-reviews/BUILD-EVIDENCE-CI-E2E-CREDENTIAL-2026-08-25.md` (this file, new)

No other files were touched. `git diff --stat` for the change:

```
 ops/e2e-production-launch.mjs | 6 ++++++
 1 file changed, 6 insertions(+)
```

## Tests added/changed

None added or changed. This is a script-level ops fix; the existing `runProductionE2E()` end-to-end flow is the test, and it now exercises the real credential-handoff path that was previously broken.

## Commands + actual results

Preliminary state check (before any edit):
```
$ git branch --show-current
phase1-server-owned-authority
$ git log --oneline -1
65eab79 merge master (Rooms Phase 0, PR #62) into phase1-server-owned-authority
```
Local HEAD was one commit behind the task's stated `aef8e74`. Fetched and fast-forwarded (verified `git merge-base --is-ancestor HEAD origin/phase1-server-owned-authority` was true — pure fast-forward, no merge, no conflicts):
```
$ git pull --ff-only origin phase1-server-owned-authority
Updating 65eab79..aef8e74
Fast-forward
 tests/subscription-runtime.test.ts | 19 +++++++++++++------
 1 file changed, 13 insertions(+), 6 deletions(-)
```

Disclosure: the working tree already contained substantial unrelated modified/untracked content (an in-flight Item B/C channels-agent-UX task, including a stray root-level `build-evidence.md` belonging to that other task). Per repo rules I did not touch, stage, or delete any of it — only `ops/e2e-production-launch.mjs` and this new evidence file under `docs/prd-reviews/` were written.

Port/data-dir safety check before running (to avoid disturbing the operator's running stack on :3000/:18790): `reserveLoopbackPorts()` in the script requests OS-ephemeral ports via `listen({ host: '127.0.0.1', port: 0 })`, and `dataDir` is a fresh `mkdtemp(os.tmpdir()/torqclaw-g1r-*)`. Confirmed no collision is possible.

**RED (unchanged script, before fix):**
```
$ node ops/e2e-production-launch.mjs
...
[console!]  ⨯ Error: Operator credential unavailable; bootstrap an operator before starting the console
    at <unknown> (E:\TorqClaw\apps\console\.next\server\app\page.js:65:142002)
...
stderr tail:
• turbo 2.9.18
[TORQCLAW] Startup failed: Timed out waiting for http://127.0.0.1:60045/ after 60000ms; last failure: HTTP 500
```
Exact match to the diagnosed failure chain.

**Fix applied** (diff above).

**GREEN (fixed script):**
```
$ node ops/e2e-production-launch.mjs
PRODUCTION E2E PASS
```

## Step 3 — probing what else is behind this job

Per instructions: run, report PASS/FAIL honestly, do not fix additional failures. `ops/e2e-approval-cloud.mjs` header was checked first — it is stub-mode / no provider key required (forces the block via an engine seam, not a live cloud call), so it was safe to run.

| Script | Result | First-failure evidence |
| --- | --- | --- |
| `ops/e2e.mjs` | **FAIL** (exit 1) | `>>> [seq=-] ERROR tier=- :: undefined` then `=== E2E FAIL ===` |
| `ops/e2e-approval.mjs` | **FAIL** (exit 1) | `>>> [seq=-] ERROR :: undefined` then `=== E2E FAIL (unexpected ERROR) ===` |
| `ops/e2e-cancel.mjs` | **FAIL** (exit 1) | `>>> [seq=-] ERROR :: undefined` then `=== E2E FAIL (ERROR) ===` |
| `ops/e2e-budget.mjs` | **FAIL** (exit 1) | `>>> [seq=-] ERROR :: undefined` then `=== E2E FAIL (error was not a budget breach) ===` |
| `ops/e2e-channel.mjs` | **FAIL** (exit 1) | HTTP channel booted and accepted the POST, but `>>> HTTP 502 {"ok":false,"error":"task failed","sessionId":""}` then `=== E2E FAIL (no clean RESULT from the channel) ===` |
| `ops/e2e-approval-cloud.mjs` | **FAIL** (exit 1) | `>>> [seq=-] ERROR tier=- :: undefined` then `=== E2E FAIL (unexpected ERROR) ===` |

All six fail at the operator-connect / first-task-submission stage, each surfacing either an `ERROR` event with an empty/`undefined` message or (for the HTTP-channel variant) a 502 with `"error":"task failed"`. This is a distinct, common failure signature across all six, consistent with the task note that "these have not executed in CI since 08-23" — it looks like a separate, pre-existing regression somewhere in the shared gateway/dispatch/engine request path, unrelated to the operator-credential defect this slice fixed (that defect was specific to the production console's server-render path in `page.tsx`, which none of these six stub scripts touch — they talk directly to the gateway/engine over websocket or HTTP, not through the Next.js console). I did not investigate further or attempt a fix, per instructions — this needs its own diagnosis slice.

## Known limitations

- This fix addresses only the credential-handoff defect in `ops/e2e-production-launch.mjs`. It does not address the six step-3 failures above — those are reported only, per instructions, and need their own diagnosis/slice.
- Verified locally on Windows (win32) only; CI runner OS was not independently reproduced here beyond running the same Node script.
- The working tree contains substantial pre-existing, unrelated modified/untracked files (a separate in-flight Item B/C task, plus other untracked docs/assets). These were left untouched and are visible in `git status`; they are not part of this change and are called out here only for transparency, not as something this slice addresses.

## Deviations from the packet

- Local checkout was one commit behind the stated `aef8e74` at task start; fast-forwarded via `git pull --ff-only` before any edits, as instructed.
- No other deviations. Only `ops/e2e-production-launch.mjs` was modified; page.tsx, dev-up.mjs, and all product code were left untouched.

## git diff --stat proving containment

```
$ git diff --stat -- ops/e2e-production-launch.mjs
 ops/e2e-production-launch.mjs | 6 ++++++
 1 file changed, 6 insertions(+)
```
(Full repo `git diff --stat` also shows pre-existing unrelated changes to `.claude/agents/README.md`, `.claude/settings.json`, `CLAUDE.md`, `apps/console/src/components/friendly.ts`, `packages/bridge/src/hermesAttempt.ts`, `packages/gateway/src/dispatch.ts`, `tests/failover/mcp-contract.test.ts`, `tests/friendly.test.ts` — all present in the working tree before this task started, untouched by this change.)

## Status

READY_FOR_INDEPENDENT_VERIFICATION for the CI credential fix (RED reproduced, fix applied, GREEN confirmed, scope contained to one file). The step-3 findings are informational only and do not block this slice — they describe a separate pre-existing defect across six other e2e scripts that requires independent scoping.
