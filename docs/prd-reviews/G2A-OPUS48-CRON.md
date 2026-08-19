# G2A Final Audit — cron: scheduled autonomous agent turns

**Seat:** G2A final verifier.
**Model:** `claude-opus-4-8`. CLAUDE.md §2 names Claude Opus 4.8 for this seat and I *am* Opus 4.8 — **no substitution applies.**
**Scope:** `1f5b094..87630dd` — `80d411c` (the slice) + `87630dd` (G1R's two blocker fixes). The user-supplied range supersedes the brief's printed `1f5b094..80d411c`.
**G1R verdict read:** `docs/prd-reviews/VERIFY-OPUS-CRON.md` (APPROVE_WITH_CONDITIONS — B-C1, B-C2). Not deferred to: both fixes re-attacked by me with my own mutations in my own worktree.
**Date:** 2026-08-18. **Method:** clean worktree at `87630dd` (`.g2a-cron-wt`, removed afterward), forced clean build, two falsifiability probes reproduced from source mutations. All restored; `git status` clean.

---

## VERDICT: **APPROVE WITH CONDITIONS** — one condition (C-1, promoted from G1R's N-3), five notes

The security core is as strong as G1R found it: wake-time authority is a strict superset of auto-reply's and re-reads live state on every fire; the FRONTIER fence is a literal override no path reaches around; B-8's third state is race-free by storage-layer construction; STOP reaches cron through the same table in both scopes; the multi-process claim race the builder disclosed as untested holds (G1R tested it with two real connections). Both blocker fixes are correct and **I watched each fail when reverted**. On the honesty layer — the layer that matters most on a slice whose whole risk is that nobody is watching — I found one more instance of the program's signature defect, and it is a condition, not a note.

---

## C-1 (condition) — `CREATE_SCHEDULE.idempotencyKey` is validated, threaded, and **never used**

`commands.ts:251` validates it (`z.uuid()`), `server.ts` passes it to `handleCreateSchedule` (`cronScheduleHandler.ts:30`), and the handler **never passes it to `createSchedule`**, which mints its own `randomUUID()` id (`cron.ts:67+`). G1R rated this N-3, non-blocking. I promote it, on this slice specifically:

- **The retry pattern already exists in this repo and this client.** S3's composer retries a failed send with the **same** idempotencyKey — that is what the field is *for* (B-3). A console or client applying the same discipline to `CREATE_SCHEDULE` after a dropped socket or a timeout gets **two schedules**, not one safe retry.
- **The blast radius is durable and unattended.** Two identical schedules means two fires per interval, two model calls, and — because each run mints its own turn idempotency — potentially two posts per interval from one agent, indefinitely, with nothing surfacing the duplication. A schedule is the one entity in this program whose mistakes *persist and re-fire*.
- **The field's presence implies a guarantee the code does not honor.** That is the exact shape this program has now caught ten times: the contract says the protection exists; nothing enforces it.

**Fix (either):** honor it — key the schedule insert on the idempotency key (unique index + ON CONFLICT no-op, returning the existing schedule on replay, the house pattern) — or drop the field from the contract so no client believes the guarantee exists. Honoring it is strictly better and matches the store's own `runKeyedCommand` discipline.

## Both G1R blockers — fixes verified by re-running the attacks myself

**B-C1 (process-fatal throw).** The authz call is now inside the try (`cronScheduleHandler.ts:60`). My probe: moved it back outside, root-forced rebuild, ran the suite:

```
FAIL … G1R B-C1: handleCreateSchedule is TOTAL …
AssertionError: B-C1 REGRESSION: handleCreateSchedule THREW. With no unhandledRejection net
this escapes into the async socket handler and kills the gateway process …
Tests  1 failed | 11 passed (12)
```

Restored, rebuilt, 12/12. G1R's reachability analysis (migrateCollabDb's bare `catch{}` returns a usable handle after a partial migration) is verified by reading — the throw path was production-reachable, not a test artifact, and the fix removes it. I also echo G1R's defence-in-depth recommendation: three modules now rely on the *absence* of an `unhandledRejection` net being known; that absence is still documented only in comments.

**B-C2 (archived channel silent no-op).** `assertScheduleStillAuthorized` now joins `collab_channels` and refuses `channel-archived` through the existing terminated path (`cron.ts:303`). My probe: removed the check, root-forced rebuild:

```
FAIL … G1R B-C2: an ARCHIVED channel is refused AT WAKE with a reason …
AssertionError: B-C2 REGRESSION: an archived channel resolved to the SILENT residual …
  expected 'no_post' to be 'terminated'
Tests  1 failed | 11 passed (12)
```

The exact silent residual B-8 forbids, reproduced against unfixed code. Restored, rebuilt, 12/12.

## The authority layer — verified, with my division of labor stated honestly

- **Wake-time authority:** I verified the SQL at source — `assertScheduleStillAuthorized` binds only the two ids and re-reads both STOP scopes, membership state, principal kind/status, and now channel state, live per fire; recovery calls the identical function. The stale-inputs hunt: G1R's table is correct — no credential exists to go stale (turns mint their own session), profile delegation is resolved fresh per fire, epochs govern visibility not authority. The one input I'd add to G1R's N-6 framing: `created_by_principal_id` is audit-only *by design* and the agent-side chain is fully live, so I agree it is a future-ruling item, not a defect.
- **FRONTIER fence:** spread-then-override literal (`cronDispatcher.ts:286`), `dispatch.ts` untouched (so `frontierGrantFenced` is not relaxed), every reach path (config, router override, re-mint, failover, recovery) closed by construction. G1R supplied the behavioral proof (poisoned router dist → `OLLAMA_LOCAL` still reaches the seam); I verified the fence line and the reach analysis at source and rely on G1R's execution for the poison run itself — flagged honestly rather than re-claimed. The committed test for it is source-text only; see NB-1.
- **B-8 deviation:** sound, and better than the brief. Race-freedom verified at source: `taskStore.complete` writes `state` + `telemetry_json` in **one UPDATE** (`events.ts:157-164`); `runDispatchAndWait` selects both columns in **one SELECT** and returns only when `state !== 'running'` — no window. The RED G1R reproduced (`expected 'no_post' to be 'blocked_awaiting_approval'`) is pinned by a committed test that fails against unfixed code. B-8 part 1 (TTL) is ruled-and-deferred in writing, which discharges the ruling obligation; the practical consequence (a 03:15 approval expires unanswered) is honestly stated.
- **STOP:** same table, both scopes, mid-flight re-reads (pre-dispatch at `:162-175` and post-dispatch at `:306`), durable across restart — with positive controls in the shipped tests, green in my runs.
- **Idempotency/concurrency/ticker:** single-statement CAS pins both `next_fire_seq` and `state='active'`; PK on `(schedule_id, fire_seq)`; crash-between-claim-and-dispatch strands into a sweep that cannot double-fire (G1R proved two-connection racing holds); crash between the CAS and the run-row insert loses at most one fire — the safe direction. The ticker cannot double-fire within an interval (watermark advances in the same UPDATE), drift is forward-only, and downtime produces exactly one catch-up fire, no herd.

**`promptHint`:** capability-inert, verified by tracing every consumer — it reaches only the prompt string, framed as operator-authored note; it cannot touch `requiredTools`, the profile, the tier, or `grantedTools`. G1R's qualification is correct and worth repeating: it *is* stored instruction text the model reads — inert in the sense that matters (it moves no authority), not in the sense that the model ignores it.

## Non-blocking notes

- **NB-1 (G1R N-1):** the FRONTIER fence's committed test is source-text only. G1R's poison-the-router probe should be committed as a permanent behavioral test — it is the property a future cron implementer will be most tempted to relax.
- **NB-2 (G1R N-2):** the test titled `FALSIFIABILITY: with dispatch() unreplaced…` does not do what its title says (its own comment admits the override stays). The assertion inside is sound; the title overclaims — rename it.
- **NB-3 (G1R §4.4 residual):** `no_post` remains the default for *unmodeled mid-turn* refusals (a transient `COLLAB_UNAVAILABLE` from `executeTool` leaves `refusal_reason` NULL). Every *permanent structural* case is now first-class at wake (STOP, membership, principal, archived). The residual is transient by nature and self-correcting on the next fire, but G1R's option-2 (record `no_post` only when no tool refusal was observed) is the right eventual shape.
- **NB-4 (G1R N-4):** a recovered stranded run passes `promptHint: null` (`cronDispatcher.ts:406`), silently dropping the operator's note on exactly the turn that already failed once. Read it from `collab_agent_schedules` in `findStrandedScheduleRuns`.
- **NB-5 (G1R N-5):** `recoverStrandedScheduleRuns` is not flag-gated on `agentCronEnabled()` — a stranded run fires once at next boot even with cron off. Arguably correct (mirrors B-7's flag-independent recovery); should be an explicit decision, not an implicit one.

## Trap variant discovered during this audit (for the next seat)

`pnpm --filter @torqclaw/collab build --force` passes `--force` **to tsc**, which rejects it (`error TS5093: Compiler option '--force' may only be used with '--build'`) and **emits nothing** — with output redirected, a restore build silently no-ops and leaves a *mutated* dist in place while the source is clean. It happened to me mid-audit and was caught only by a dist grep. **Only the root-level `pnpm build --force` (turbo) is safe.** Every mutation probe here was verified twice: once against the harness-rebuilt dist (which is how the REDs are valid despite my initially broken rebuild), once after a confirmed-good root-forced rebuild.

## Gate results — all my own runs, clean worktree at `87630dd`

| gate | result |
|---|---|
| `rm -rf packages/*/dist` + `pnpm build --force` (root, turbo) | PASS |
| Named 6-file set (cron, a3c, s3, auth-v2-phase1, auth-v2-phase2a, c1-built-artifact) | PASS — **106/106** (cron 12/12) |
| `npx vitest run` (full suite) | 2260 passed / 1 skipped / 5 failed — **all 5 in `tests/failover/*`** (controller-timeout ×4, receipt-export ×1); both files pass **9/9 on warm re-run** in the same worktree. Cold-load contention on the known flake class. **Zero range-attributable failures.** |
| `tsc --noEmit` collab / gateway / contracts | PASS ×3 (exit 0) |
| `pnpm reachability` | PASS |
| `git diff --stat 1f5b094..87630dd` | 16 files + the verdict docs; all in scope |

## Tree state afterward

Both probe mutations restored, dist rebuilt and grep-verified, worktree removed. Main tree untouched. This verdict is the only file created.

---

**Bottom line:** the slice that acts with certainty nobody is watching gets the authority layer right — provably, under mutation, on the real artifact. Ship it with C-1 closed: on a durable, self-refiring entity, an idempotency field that lies is not a nit. Everything else G1R flagged is honestly scoped, and its two blockers are verifiably dead.
