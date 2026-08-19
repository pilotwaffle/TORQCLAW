# G1R INDEPENDENT VERIFICATION — cron: scheduled autonomous agent turns

**Seat disclosure.** I am the INDEPENDENT VERIFIER (G1R seat) for this review. The routing
profile names **Opus 5** for this seat and I **am** `claude-opus-5`. **No substitution
occurred.** Fresh thread, no authoring context.

- **Repo:** `E:\TorqClaw` · **Branch:** `phase1-server-owned-authority` · **HEAD:** `80d411c`
- **Target:** `80d411c` — *cron: scheduled autonomous agent turns* · **Diff range:** `1f5b094..80d411c`
- **Binding prior ruling read in full:** `docs/prd-reviews/G1R-OPUS-AGENT-PARTICIPATION-007-GATE1.md`
  §2A (§2A.1–§2A.6), plus blockers **B-7** and **B-8**.
- **Tree state:** clean at start and at finish. Every probe restored; `git diff` empty (verified).

---

## VERDICT: **APPROVE_WITH_CONDITIONS**

**Two blockers, neither of which touches the load-bearing authority properties.** The three
things this slice most had to get right — wake-time authority re-evaluation, the FRONTIER
fence, and B-8's third state — are **genuinely and behaviorally correct**, proven here by
execution against the built artifact with the guard removed, not by reading the source.

Both blockers are in the *honesty* layer that §2A.5(e) makes binding, not the authority layer:

- **B-C1** — `handleCreateSchedule` is **not total**: a store throw escapes into an async
  socket handler with no outer try/catch and **no `unhandledRejection` net anywhere in the
  repo**. Reproduced: `SqliteError: no such table: collab_autoreply_stop` escaped the function.
  Its two sibling handlers return `COLLAB_UNAVAILABLE` under the identical condition. **This
  kills the gateway process.**
- **B-C2** — an **archived channel** produces `state='no_post', refusal_reason=NULL` —
  byte-identical to the agent legitimately choosing silence. Reproduced by execution. This is
  precisely the silent-skip class B-8 forbids, and because nothing ever deactivates a schedule,
  it **re-fires forever against a dead channel**, burning a model call each time.

Neither blocker permits an unauthorized action. Both are one-line-class fixes. **I am not
softening this: the security core earned approval. The honesty core did not, yet.**

---

## 1. Gate results — all run by me, after a forced clean build

The build trap was respected: `rm -rf packages/*/dist packages/*/tsconfig.tsbuildinfo` then
`pnpm build --force` (exit **0**) before every dist-dependent probe.

| Gate | Result |
|---|---|
| `pnpm build --force` (after full dist wipe) | **PASS** (exit 0) |
| Targeted suite (6 files, incl. cron / a3c / s3 / auth-v2-phase1 / **auth-v2-phase2a** / collab-c1-built-artifact) | **PASS — 104/104** |
| `npx vitest run` (full suite) | **2262 passed · 1 failed · 1 skipped (131 files)** |
| The one failure | `tests/failover/controller-timeout.test.ts` — **the known flake I was told not to chase.** No other failure. |
| `npx tsc --noEmit -p packages/collab/tsconfig.json` | **PASS** (exit 0) |
| `npx tsc --noEmit -p packages/gateway/tsconfig.json` | **PASS** (exit 0) |
| `npx tsc --noEmit -p packages/contracts/tsconfig.json` | **PASS** (exit 0) |
| `pnpm reachability` | **PASS** — 130 modules reachable, 3 declared dormant, zero orphans |
| `tests/collab-c1-built-artifact.test.ts` isolated | **PASS — 4/4** (run inside the targeted suite, not under full-suite parallelism) |
| `tests/auth-v2-phase2a.test.ts` | **PASS — 24/24** (frozen contract holds) |

---

## 2. A — Wake-time authority. **COMPLETE for every input the ruling names.**

`assertScheduleStillAuthorized` (`packages/collab/src/cron.ts:263-288`) re-reads, live, per fire:

| Input | Re-read at wake? | Verified how |
|---|---|---|
| `collab_autoreply_stop` scope=`global` | **YES** (`:267-268`) | executed, both directions |
| `collab_autoreply_stop` scope=`channel` | **YES** (`:269-272`) | executed, both directions |
| `collab_members.state = 'active'` | **YES** (`:284`) | executed + **dist mutation → RED** |
| `principals.kind = 'agent'` | **YES** (`:285`) | executed |
| `principals.status = 'active'` | **YES** (`:286`) | executed |

**It takes no cached field from the schedule row except the ids needed to look state up.** I
confirmed by reading the SQL: the only bound parameters are `channelId` and `agentPrincipalId`.
The January-schedule/June-fire scenario is refused at wake — the shipped test proves it by
creating the schedule while the agent is a member, revoking, then ticking
(`membership-inactive`), and I re-verified the primitive independently.

**It is a strict SUPERSET of `resolveEligibleAgents`** (`autoReply.ts:65-85`), which checks
`m.state='active' AND p.kind='agent' AND p.status='active'` — cron adds both STOP scopes.
Cron's wake check is **stricter than auto-reply's**, as §2A demands.

**Recovery does NOT bypass it — verified.** `recoverStrandedScheduleRuns`
(`cronDispatcher.ts:394-403`) calls the identical function before re-dispatch and resolves
`terminated` with the refusal reason on failure. A crash is not a bypass.

### 2.1 Authority inputs NOT re-checked at wake — and my judgment on each

| Not re-checked | Real hole? | Reasoning |
|---|---|---|
| **Channel archived state** | **YES — B-C2 below.** | Not an *authorization* hole (the substrate refuses the write with `COLLAB_CHANNEL_ARCHIVED`, verified by execution) but a **B-8 honesty hole**: the run records `no_post`. See §4. |
| **Credential validity** | **NO.** | A scheduled turn mints its own session (`mintCronTurnSession`) and carries **no credential**; `principals.status='active'` is the live authority ground truth, and it *is* re-read. There is no stored credential to go stale. |
| **Profile delegation** | **NO.** | Resolved fresh every fire via `resolveProfile(...)` at `cronDispatcher.ts:224-229`, and `predictTools` is re-derived per fire — never cached on the schedule row. `admitToolCall` additionally re-reads live delegation at the tool seam. |
| **Channel epoch** | **NO.** | Cron re-reads `collab_members.state` directly, which is what an epoch bump manifests as for membership purposes; `assertChannelVisible` re-checks independently inside the post path. |
| **Membership epoch / `rejoined_seq`** | **NO.** | Both govern *cursor visibility*, not authority to act; context assembly goes through the store's own visibility path. |
| **`created_by_principal_id` (the operator who made the schedule)** | **Non-blocking observation.** | If the *creating operator* is later revoked, the schedule keeps firing. Defensible — the schedule's authority derives from the **agent's** live membership, not the creator's, and the field is documented as audit-only. But an operator revoking a rogue colleague's account may reasonably expect their schedules to stop. Worth a future ruling; **not blocking**, because the agent-side authority chain is fully live. |

**`wakeTimeAuthorityComplete: true`** for every input §2A.5(d) names.

---

## 3. B — The FRONTIER fence. **PINNED. Verified BEHAVIORALLY, not structurally.**

The shipped test is source-text only (`agent-participation-cron.test.ts:126-137`) — and the
brief is right that **structural tests are weak**. So I proved the property by execution.

**My probe (verifier-owned, since removed):** I monkey-patched
`router.evaluateRequest` **on the built router dist that the built gateway dist imports** to
return `tier: 'FRONTIER'` for every request, then fired a real schedule through
`tickSchedules()` on the built `cronDispatcher.js`, capturing the actual `diag` object arriving
at the dispatch seam.

```
POSITIVE CONTROL: router.evaluateRequest(...).tier === 'FRONTIER'   ✓ (poison confirmed live)
OBSERVED at the dispatch seam:                    'OLLAMA_LOCAL'    ✓
expect(observedTiers).not.toContain('FRONTIER')                     ✓  PASS
```

**With the router forced to FRONTIER, the tier that reached dispatch was still LOCAL_EDGE.**
The fence at `cronDispatcher.ts:286` is a spread-then-override
(`{ ...router.evaluateRequest(request), tier: 'OLLAMA_LOCAL' }`), so the router's tier is
overwritten *after* the spread and cannot win.

**Paths audited for any FRONTIER reach — all closed:**
- **Config / env:** no flag is consulted between `evaluateRequest` and the override. `diag.tier`
  is a literal.
- **Router override:** defeated by construction, proven above.
- **Re-minted request:** cron builds its `GatewayRequest` inline with `grantedTools: []`
  hardcoded (`:266`). It never re-mints from a C2 approval decision, so the re-mint path that
  could carry a different tier is not reachable from here.
- **Failover:** cron does not call the failover controller; it calls `dispatch(req, diag)`
  directly with the pinned diag.
- **Recovery:** `recoverStrandedScheduleRuns` funnels into the **same** `runScheduledTurn`, so
  it inherits the same pinned line. There is no second dispatch path.
- **`frontierGrantFenced` was NOT relaxed** — `dispatch.ts` is untouched by this diff (verified
  against `git diff 1f5b094..80d411c`, which lists no `dispatch.ts` change). The prior ruling
  predicted the implementer would be tempted; **the implementer was not.** Credit where due.

**`frontierFencePinned: true`.**

---

## 4. C — B-8, the deviation, and the third state

### 4.1 The deviation is SOUND, and better than the brief's own instruction

The builder was told to widen the approval TTL; it instead read `dispatch.ts`'s own
`telemetry_json.blockedOn` off the real task row and resolved to `blocked_awaiting_approval`
immediately. **I judge this the superior choice, and I would have ruled the same way.**

Widening the TTL only for schedule-originated approvals requires plumbing *caller provenance*
into `dispatch.ts` / `registerApprovalC2` — a change to the security-critical shared approval
path, riding inside a feature ticket. The deviation avoids that entirely and satisfies B-8
part 2 (the binding half) **at fire time**, independent of whatever the TTL does later. The
module documents this reasoning explicitly at `cronDispatcher.ts:62-87`, which is exactly the
kind of stated-and-reasoned decision §2A.5(b) asked a cron slice to make rather than inherit
silently.

Note this leaves B-8 **part 1** (a longer TTL / non-expiring pending state) unimplemented and
**explicitly deferred with reasons**. Part 1 was worded as a design decision for the cron PRD
("this is a design decision… but no cron slice may ship without ruling it"). **It has now been
ruled, in writing, with a rationale.** I accept that as discharging part 1's *ruling*
obligation. The operator should know the practical consequence: **a cron approval still expires
in 15 minutes and no one will answer it at 03:15** — but the schedule run row already told the
truth at 03:00, so nothing is silent.

### 4.2 Is there a race? **NO — proven by the storage layer.**

The concern is that the run resolves before `dispatch` writes `blockedOn`. It cannot:

- `taskStore.complete()` (`events.ts:157-164`) writes **`state='completed'` and
  `telemetry_json` in ONE atomic UPDATE.**
- `runDispatchAndWait` (`cronDispatcher.ts:319-331`) polls
  `SELECT state, telemetry_json` — **both columns in one SELECT** — and returns only when
  `state !== 'running'`.

So the poller cannot observe the completed state without simultaneously observing the telemetry
written by the same UPDATE. **There is no window.** This is a genuinely careful piece of
design and it is not accidental — the dispatcher reads the same row it already polls.

### 4.3 The claimed RED — **REPRODUCED**

I mutated the **built dist** (`packages/gateway/dist/cronDispatcher.js:259`), replacing
`const blockedOn = readBlockedOn(...)` with `const blockedOn = null`, then ran the shipped
third-state test:

```
AssertionError: THE LOAD-BEARING ASSERTION: the third, explicitly distinguishable state:
  expected 'no_post' to be 'blocked_awaiting_approval'
Expected: "blocked_awaiting_approval"
Received: "no_post"        ← the exact silent skip B-8 forbids
```

**The test fails against unfixed code.** Dist restored and verified byte-identical.

### 4.4 The fallback question — gated tool, `blockedOn` ABSENT

If a tool is gated but `blockedOn` is absent, `readBlockedOn` returns `null` and the run falls
through to `no_post` (assuming no post committed) — **the silent skip**. How reachable is this?
`dispatch.ts:357` writes `blockedOn` unconditionally on the `ToolApprovalRequired` branch, and
that is the only branch that gates a tool. So within `dispatch`, absent-`blockedOn`-with-gating
is not reachable. **However**, the same fall-through is what B-C2 exercises via a different
cause (see below), which demonstrates the fall-through is not merely theoretical — it is the
default for every unmodeled refusal. **`readBlockedOn` returning null should not be a silent
success path.** See B-C2's suggested fix.

**`b8DeviationSound: true`.**

---

## 5. D — STOP coverage. **VERIFIED, with positive controls.**

No new STOP command was needed because `assertScheduleStillAuthorized` reads the **same**
`collab_autoreply_stop` table `SET_AUTOREPLY_STOP` writes. I verified each leg:

| Scenario | Result | Positive control |
|---|---|---|
| STOP **channel**-scoped, set before wake | `terminated` / `stop-channel`, **zero posts** | Same schedule fires and **completes** once cleared, exactly one new post |
| STOP **global** | `terminated` / `stop-global` | Cleared → `ok: true` |
| STOP set **mid-flight** | Covered: the fire is claimed, then authority is re-read *after* the claim and *before* any dispatch (`cronDispatcher.ts:162-175`); and a **second** `assertScheduleStillAuthorized` runs post-dispatch (`:306`) before any `no_post` is recorded | Both directions executed |
| STOP **surviving restart** | Durable — `collab_autoreply_stop` is a table, not memory; S3 already ships this and cron reads the same rows. The check is per-fire, so a restarted process re-reads it on the next tick. | The channel/global tests above re-read from a fresh connection |

**`stopCoversCron: true`.**

---

## 6. E — Idempotency and concurrency. **The disclosed gap: I tested it. It HOLDS.**

The builder disclosed it did **not** test multi-gateway-instance racing. I did, using **two
independent `better-sqlite3` connections to the same file** — the real multi-process shape.

| Probe | Result |
|---|---|
| Two independent connections claim the **same** `expectedFireSeq` | **Exactly ONE wins** (the other returns `null`) |
| Duplicate `recordScheduleRunDispatched` at same `(schedule_id, fire_seq)` | **Refused** (PK), positive control passes first |
| Crash between claim and dispatch → `findStrandedScheduleRuns` | Stranded run **found**; after resolution it is **immune to a second sweep** (zero rows) — no double-fire |
| `resolveScheduleRun` against an already-terminal row | **Never overwrites** (`completed` survived an attempted `terminated`, `refusal_reason` stayed NULL) |

The optimistic-concurrency UPDATE (`cron.ts:163-169`) pins **both** `next_fire_seq = expected`
**and** `state = 'active'` in the WHERE clause, checking `changes !== 1`. That is a correct
single-statement CAS — the same shape `admitToolCall`'s consume-UPDATE uses. **It holds.**

**Crash-between-claim-and-dispatch does not double-fire:** the claim advances the watermark
first, and the recovery sweep operates on `state='dispatched'` rows guarded by
`WHERE state='dispatched'` on every write. A resolved row is invisible to the sweep (proven).

**`idempotencyHolds: true`.**

---

## 7. F — The ticker. **No storm, no starvation. Bounded drift.**

- **Twice in one interval?** **No.** `claimScheduleFire` advances `next_fire_seq` *and* sets
  `next_fire_at = now + intervalSeconds` in the same atomic UPDATE. The 15s tick re-reads
  `next_fire_at <= now`, so a schedule just fired is not due for ≥60s (migration
  `CHECK(interval_seconds >= 60)`). Four ticks pass before it is due again.
- **Drift across restarts?** Bounded and **forward-only**. `next_fire_at` is anchored to
  *actual fire time*, not to an ideal schedule, so error never compounds into early firing —
  each interval is ≥ the configured one, plus up to 15s of poll granularity.
- **Sustained restarts — starve or storm?** **Neither.** `next_fire_at` is durable, so a
  schedule that was due during hours of downtime fires **exactly once** on the next tick after
  boot (a single row, a single claim), then re-anchors. There is no missed-interval backfill
  loop and therefore no thundering herd. Conversely a schedule cannot starve: the due query is
  `next_fire_at <= now ORDER BY next_fire_at ASC` with an index on `(state, next_fire_at)`.
- `unref()` is correct — the ticker alone never holds the process open.
- **Ordering note (non-blocking):** `tickSchedules` `await`s each schedule's turn **serially**
  inside the loop. With many due schedules and a slow model, one tick can exceed 15s and
  overlap the next. That is *safe* (the claim CAS refuses the duplicate) but means the return
  value's "claimed this tick" can interleave. No correctness impact.

---

## 8. G — Frozen contracts. **The authz arms GRANT NOTHING. Verified.**

- **`authz.ts`:** the three new cases (`CREATE_SCHEDULE`, `SET_SCHEDULE_STATE`,
  `LIST_SCHEDULES`) are appended to the **`role === 'channel'` deny cascade**, falling through
  to `return DENY_NOT_PERMITTED` (`authz.ts:225-235`). Role `node` denies everything except
  `POST_CHANNEL_MESSAGE` (unchanged). For `operator`, the three actions are **not** given a new
  arm — they fall to `authorizeOperator`'s pre-existing terminal `return ALLOW`, byte-identical
  to every other non-`APPROVE_TOOL`/`APPROVE_SKILL` operator command. **No new grant, no new
  authority token, no widening of the `approve` seam.** `auth-v2-phase2a` **passes (24/24)**,
  so the SHA pin is satisfied.
- **Migration ordering claim HOLDS.** `runAgentCronMigration(handle)` is invoked **last** in
  `migrateCollabDb` (`collabIdentity.ts:167`), after `runSurfaceIdentityMigration` (which
  contains `assertShippedCollabLedger`'s exactly-two-row check) has already run. The new id
  `20260818_002_agent_cron_v1` therefore cannot be in `collab_schema_migrations` when that check
  executes. `collab-c1-built-artifact` (migration-count pin) **passes 4/4 isolated**, and
  `auth-v2-phase1` passes 49/49.
- Migration is strictly additive (`CREATE TABLE IF NOT EXISTS` ×2, two indexes), idempotent
  (early-return on existing ledger row), and transactional (`BEGIN EXCLUSIVE` / ROLLBACK).

**`authzGrantsNothing: true`.**

---

## 9. H — A6/T-9 on the three new wire commands

### 9.1 Validator citations (consuming validator, `file:line`, enclosing branch, defaults)

All three are arms of the `ClientCommandSchema` discriminated union
(`packages/contracts/src/commands.ts:231-268`), parsed **before** authz at
`server.ts:399` (`authorize(role!, cmd.data, …)`), i.e. no unvalidated field reaches a handler.

| Field | Validator (`file:line`) | Enclosing branch | Default | Reachable to a throw? |
|---|---|---|---|---|
| `CREATE_SCHEDULE.channelId` | `commands.ts:247` `z.string().min(1)` | `action: z.literal('CREATE_SCHEDULE')` | none (required) | **No** — bound as a SQL parameter |
| `CREATE_SCHEDULE.agentPrincipalId` | `commands.ts:248` `z.string().min(1)` | same | none (required) | **No** |
| `CREATE_SCHEDULE.intervalSeconds` | `commands.ts:249` `z.number().int().min(60).max(604800)` | same | none (required) | **No** — the `min(60)` floor **matches** the migration's `CHECK(interval_seconds >= 60)`, so the raw SQLite CHECK violation is unreachable. Verified at both bounds (60 and 604800): both returned cleanly. |
| `CREATE_SCHEDULE.promptHint` | `commands.ts:250` `z.string().max(2000).optional()` | same | `?? null` at `cronScheduleHandler.ts:54` | **No** — tested at 2000 chars, with emoji, NUL, quotes and a SQL-injection payload: no throw, parameter-bound |
| `CREATE_SCHEDULE.idempotencyKey` | `commands.ts:251` `z.uuid()` | same | none (required) | **No** — *and see observation N-3: it is accepted but never used* |
| `SET_SCHEDULE_STATE.scheduleId` | `commands.ts:261` `z.string().min(1)` | `action: z.literal('SET_SCHEDULE_STATE')` | none | **No** — unknown id → `COLLAB_NOT_FOUND` |
| `SET_SCHEDULE_STATE.state` | `commands.ts:262` `z.enum(['active','stopped'])` | same | none | **No** — enum matches the migration CHECK exactly |
| `LIST_SCHEDULES.channelId` | `commands.ts:266` `z.string().min(1)` | `action: z.literal('LIST_SCHEDULES')` | none | **No** |

### 9.2 **Can any admitted input cause a throw? YES — and it kills the process. (B-C1)**

Not via a *field value*, but via the **db handle**, which is the other admitted input.
`handleCreateSchedule` calls `assertScheduleStillAuthorized(db, …)` at
`cronScheduleHandler.ts:43` — **outside its own `try{}`, which does not start until line 47.**

I executed this. Against a collab-core-migrated-but-not-autoreply-migrated handle:

```
THROW_PROBE_CREATE_UNMIGRATED {"threw":"no such table: collab_autoreply_stop","returned":"NOT-RETURNED"}
  → handleCreateSchedule THREW; it did not return.
THROW_PROBE (siblings, same db):
  handleSetScheduleState → {"code":"COLLAB_UNAVAILABLE"}   (total ✓)
  handleListSchedules    → {"code":"COLLAB_UNAVAILABLE"}   (total ✓)
```

**The asymmetry is the tell**: the two handlers whose store call sits *inside* the try are
total; the one whose store call sits *outside* is not.

**Why it is reachable in production, not a test artifact:** `migrateCollabDb`
(`collabIdentity.ts:168-170`) wraps the entire migration sequence in
`catch { /* fail closed: an unmigrated DB authenticates nobody */ }` — it **swallows every
migration error and still returns a usable handle.** If `runAgentAutoreplyMigration` or
`runAgentCronMigration` fails for any reason (partial prior migration, transient lock, disk
error, an upgrade from a DB state where an earlier migration in the chain throws), the gateway
boots, `getCollabDbForAutoReply()` returns **non-null**, and the first operator
`CREATE_SCHEDULE` throws. The comment's "authenticates nobody" is true of *auth*; it is **not**
true of this handle, which is handed to cron regardless.

**Why the throw is fatal:** it escapes into `socket.on('message', async (raw) => { … })`
(`server.ts:228`), whose only `try` wraps `JSON.parse` (`:230-233`). The `switch` containing
the three cron arms (`:798-830`) is **not** inside any try. An async listener rejection with
**no `process.on('unhandledRejection')` anywhere in `packages/` or `ops/`** (I grepped: only
three *comments* mentioning its absence, in `autoReplyDispatcher.ts:183`, `:529`, and
`cronDispatcher.ts:186`) terminates the process.

The cron *dispatcher* correctly guards its own await (`cronDispatcher.ts:184-190`), citing this
exact hazard. **The handler did not carry the same discipline across.**

### 9.3 `promptHint` — **inert as to capability; it is instruction text**

I traced every consumer (`grep` across `packages/`): `promptHint` reaches exactly one place —
`cronDispatcher.ts:245`, rendered into the prompt string as
`"Schedule note (operator-authored, not a command from any message): …"`.

It **cannot** influence:
- `requiredTools` — derived solely from `predictTools(taskType, effectiveProfile, agentPrincipalId)` (`:230`)
- `effectiveProfile` — `resolveProfile` with fixed `'agent_conversation'`, `operatorAuthorized: false` (`:224-229`)
- `taskType` — hardcoded `'SUMMARIZATION'` (`:223`)
- `grantedTools` — hardcoded `[]` (`:266`)
- routing — the tier is pinned (§3)

So **a schedule cannot become a stored authorization.** It is a trigger, as §2A.5(d) requires.

**Honest qualification:** `promptHint` *is* text the model reads and may act on, so it is a
**stored instruction** in the ordinary-language sense — it just cannot widen *capability*. That
is acceptable because the command is **operator-seat-only** (§8) and unreachable from any
collab tool or message content. I record it as inert **in the sense that matters** — it moves no
authority — and flag the nuance so nobody later reads "inert" as "the model ignores it."

**`promptHintIsInert: true`** (capability-inert; operator-authored instruction text by design).

---

## 10. THE PATTERN — nine prior instances of a test passing with and without its guard

I assessed **every** new test in this diff for falsifiability against unfixed code.

| Test | Fails against unfixed code? | Evidence |
|---|---|---|
| `claimScheduleFire` idempotency (`:149`) | **YES** | Asserts `null` on replay; without the CAS it returns a seq. Positive control in-test. |
| `claimScheduleFire` stopped-schedule (`:177`) | **YES** | Drop `state='active'` from the WHERE and the attack claim succeeds. Positive control present. |
| `assertScheduleStillAuthorized` 4-attack matrix (`:200`) | **YES** | Each attack has an in-test positive control restoring `ok:true`. |
| **Dist mutation, membership check (`:252`)** | **YES — by construction** | It *is* the falsification: neuters `memberState !== 'active'` in the built artifact and asserts the RED, then proves restoration. Best test in the file. |
| E2E fire-and-post (`:414`) | **YES** | Asserts a **committed `collab_events` row**, not an emitted frame. |
| STOP channel-scope (`:441`) | **YES** | Asserts `terminated`/`stop-channel` **and** zero new posts, with a clear-STOP positive control that must complete. |
| Membership-revoked-at-wake (`:474`) | **YES** | Revocation happens *after* creation; positive control restores and completes. |
| **THE THIRD STATE (`:508`)** | **YES — I reproduced the RED myself** | See §4.3. |
| **FRONTIER fence, structural (`:126`)** | **Weakly.** | A source-text regex. It would catch a reorder, but it asserts *text*, not behavior; a refactor preserving semantics could fail it, and a semantically-broken build that kept the text could pass it. **I supplied the missing behavioral proof (§3) and it passed** — so the property is verified, but by *me*, not by the committed suite. **Recommend converting to the behavioral form (N-1).** |
| `FALSIFIABILITY` (`:530`) | **Misnamed, but real** | Its title claims "with dispatch() unreplaced… DISPATCHES for real"; its own comment (`:531-535`) admits it does **not** remove the override. What it actually proves — a never-member agent yields `membership-not-found` and zero posts — is a genuine, falsifiable wake-time assertion. **The assertion is sound; the title overclaims.** (N-2) |

**No test in this diff passes vacuously.** **None drives a replica** — every one imports the
**built dist** (`packages/collab/dist`, `packages/gateway/dist`, `packages/bridge/dist`) via
`pathToFileURL`, with `ensureGatewayBuild()` in `beforeAll`. The only seam replaced is
`dispatch()` itself, matching A3-c's already-approved discipline; the profile resolver, tool
prediction, bridge `executeTool`, admission, and substrate writes are all real.

**`testsThatPassAgainstUnfixedCode: []`** — with the qualification recorded above that the
FRONTIER structural test is *weak* rather than vacuous, and is now backed by my behavioral proof.

---

## 11. BLOCKERS

### B-C1 — `handleCreateSchedule` is not total; the throw is process-fatal

- **Detail.** `assertScheduleStillAuthorized(db, …)` is called at `cronScheduleHandler.ts:43`,
  **outside** the `try {` that begins at `:47`. Its first statement selects from
  `collab_autoreply_stop`. If the handle is resolved but that table is absent (or any store
  error occurs), the `SqliteError` escapes the handler. `handleSetScheduleState` and
  `handleListSchedules` place their store calls *inside* their try blocks and correctly return
  `COLLAB_UNAVAILABLE` under the identical condition — the asymmetry is the defect.
- **Reproduced.** `THROW_PROBE_CREATE_UNMIGRATED {"threw":"no such table: collab_autoreply_stop","returned":"NOT-RETURNED"}` while both siblings returned `{"code":"COLLAB_UNAVAILABLE"}`.
- **Failure scenario.** `migrateCollabDb` (`collabIdentity.ts:168`) swallows **all** migration
  errors in a bare `catch {}` and still returns the handle. A gateway that boots after a
  partially-applied or lock-interrupted migration therefore has a non-null
  `getCollabDbForAutoReply()`. The operator issues `CREATE_SCHEDULE`. The throw escapes into
  `socket.on('message', async …)` (`server.ts:228`), whose only `try` wraps `JSON.parse`
  (`:230-233`) — the `switch` is unguarded. With **no `unhandledRejection` handler anywhere in
  the repo** (verified by grep; only three comments noting its absence), **the gateway process
  dies.** An operator trying to *create* a schedule takes down the gateway — and on this slice,
  the same class of unguarded store call is what a 03:00 operator-absent environment can least
  afford to discover.
- **Suggested fix.** Move the `assertScheduleStillAuthorized` call **inside** the existing
  `try {}` at `cronScheduleHandler.ts:47` (returning `COLLAB_NOT_FOUND` on `!authz.ok` as
  today, and letting the existing `catch` return `COLLAB_UNAVAILABLE` on a throw). One-line
  scope change. **Additionally recommended (defence in depth, not required for this blocker):**
  wrap the `switch` in `server.ts`'s message handler in a try/catch, or install a
  `process.on('unhandledRejection')` net — the absence of one is now load-bearing for three
  separate modules and is documented only in comments.

### B-C2 — an archived channel resolves to `no_post`: the silent skip B-8 forbids, on an infinite loop

- **Detail.** Channel `state='archived'` is **not** among the wake-time authority inputs. The
  fire is claimed, the model runs, and the post is correctly refused by the substrate
  (`CHANNEL_ARCHIVED`, `store.ts:1454-1456`) — but `countAgentPostsSince` returns 0,
  `assertScheduleStillAuthorized` still returns `ok:true` (it does not read channel state), and
  the run is recorded `state='no_post', refusal_reason=NULL`.
- **Reproduced by execution.**
  `ARCHIVED_PROBE_RESULT {"run":{"state":"no_post","refusal_reason":null},"refusals":["COLLAB_CHANNEL_ARCHIVED: Channel is archived"]}`
  The gateway *knew* the exact reason and recorded none of it.
- **Failure scenario.** An operator archives a channel. Every schedule targeting it keeps
  firing — nothing in this slice ever deactivates a schedule (I grepped: `setScheduleState` is
  never called from `cronDispatcher.ts`). Each fire burns a real model call, assembles context,
  and records `no_post` — **byte-identical to the agent legitimately choosing silence (A3-f).**
  The operator reviewing `collab_agent_schedule_runs` sees a healthy schedule quietly declining
  to speak, forever, at 60-second granularity. This is precisely §2A.5(e)'s *"failure
  indistinguishable from a legitimate outcome"* and B-8's *"never a bare 'completed', never
  nothing at all"* — applied to the run record rather than to the approval. It is also the
  general shape of the fall-through noted in §4.4: **`no_post` is the default for every
  refusal the dispatcher does not explicitly model.**
- **Suggested fix.** Two options, either sufficient; the first is smaller.
  1. Add channel state to `assertScheduleStillAuthorized`: join `collab_channels` and return
     `{ ok:false, reason:'channel-archived' }` when `state='archived'`. The run then resolves
     `terminated`/`channel-archived` through the path that already exists, and — because the
     refusal is now first-class — a follow-up slice can cheaply auto-stop such schedules.
  2. Make `no_post` provable rather than residual: record it only when the turn produced no
     tool refusal, and otherwise resolve `terminated` with the observed reason.
  **Strongly recommended alongside either:** treat "schedule refused N consecutive times for a
  structural reason" as grounds to set `state='stopped'`, so a dead channel cannot pin a
  schedule in an infinite no-op loop.

---

## 12. Non-blocking observations

- **N-1.** The FRONTIER fence's committed test is source-text only (`:126-137`). It passed my
  behavioral probe, but the *suite* does not carry that proof. Recommend adding the
  poison-the-router probe (capture `diag.tier` at the `setCronDispatchForTest` seam with
  `router.evaluateRequest` forced to FRONTIER) as a permanent test. Low cost, high value: it is
  the property the prior ruling was most worried about being quietly relaxed later.
- **N-2.** The test named `FALSIFIABILITY: with dispatch() unreplaced…` does not do what its
  title says (its own comment says so). The assertion inside is sound. **Rename it** — a title
  that overclaims is the same comment-vs-code drift class this program has repeatedly flagged
  (and which `autoReplyDispatcher.ts:199-203` was itself corrected for).
- **N-3.** `CREATE_SCHEDULE.idempotencyKey` is validated (`z.uuid()`) and passed to
  `handleCreateSchedule` (`server.ts:812`, `cronScheduleHandler.ts:30`) — and then **never
  used**. `createSchedule` mints its own `randomUUID()` id. A retried CREATE therefore creates a
  **second schedule**, doubling the fire rate, with no duplicate detection. Not a security
  hole, but the field's presence implies a guarantee that does not exist. Either honor it (key
  the insert on it) or drop it from the contract.
- **N-4.** `recoverStrandedScheduleRuns` passes `null` for `promptHint`
  (`cronDispatcher.ts:406`), so a recovered run silently loses its operator note and runs a
  subtly different turn than the one that was stranded. Cheap fix: read the hint from
  `collab_agent_schedules` in `findStrandedScheduleRuns`.
- **N-5.** `recoverStrandedScheduleRuns` is **not** flag-gated on `agentCronEnabled()`
  (unlike `tickSchedules`, which gates on its first line). Boot recovery will re-dispatch
  stranded runs even with `TORQCLAW_AGENT_CRON` off. This is arguably *correct* (it mirrors
  B-7's flag-independent-recovery ruling, and `recoverStrandedAgentTurns` behaves the same way),
  but it means **turning the flag off does not stop a stranded run from executing once at next
  boot.** Worth an explicit decision rather than an implicit one.
- **N-6.** `created_by_principal_id` is never re-validated at wake (see §2.1). Defensible as
  designed; flagging for a future ruling.
- **N-7.** `tickSchedules` awaits each turn serially; a tick can overlap the next under load.
  Safe (the CAS refuses duplicates) but worth knowing.

---

## 13. Summary judgment

**The hard parts are right, and they were verified by execution.** Wake-time authority is a
strict superset of auto-reply's and refuses from live state on every input the binding ruling
named — proven by a dist mutation that turned it RED. The FRONTIER fence survived a poisoned
router. B-8's third state is real, race-free by storage-layer construction, and its claimed RED
reproduced exactly. The multi-process claim race the builder disclosed as untested **holds**
under two independent connections. STOP reaches cron through the same table, both scopes, with
positive controls. The frozen contracts grant nothing new and their pins still pass. `dispatch.ts`
was not touched, so `frontierGrantFenced` was not relaxed — the temptation the prior ruling
predicted was resisted.

**What is wrong is the honesty layer, and on this slice that is not a minor category.** A
schedule fires with certainty nobody is watching, so the run record *is* the operator's only
witness. One handler can kill the gateway on a reachable store error, and one refusal class
records silence where it knows the reason. Both are small, local fixes — and both must land
before this runs unattended.

**Verdict: APPROVE_WITH_CONDITIONS. Clear B-C1 and B-C2, then this earns the ship.**

*Verified by execution, not by reading — G1R (Opus 5), against `80d411c` on a forced clean
build. Tree restored clean; no source modified.*
