# G1R VERIFICATION — `ba7caea` collab_write structural fix + `agent_conversation` profile

**Seat:** G1R (independent verifier)
**Model:** claude-opus-5 — the routing profile names Opus 5 for this seat and this verification was performed by Opus 5. **No substitution.**
**Repo:** E:\TorqClaw · branch `phase1-server-owned-authority` · HEAD `ba7caea` · range `8dfa98f..ba7caea`
**Binding input:** `docs/prd-reviews/G1R-OPUS-COLLAB-WRITE-PROFILE-RULING.md`
**Authoring context:** none. Fresh thread. Every load-bearing claim below was verified by **execution**, not by reading the builder's assertions.

---

## VERDICT: **APPROVE WITH NON-BLOCKING FINDINGS**

The ruling's PRIMARY deliverable — the loud pre-dispatch assertion — is **real, wired, and
proven by row-level execution evidence**. The SECONDARY deliverable — the `agent_conversation`
profile — matches the ruled shape exactly, and its containment boundary is **load-bearing as
claimed, proven by mutation**. The RESERVED registry **is a genuine compile gate** (TS2741
reproduced). A3-c is **not** one of the eight vacuous guards: it goes RED against unfixed code.

Three non-blocking findings are recorded below. None of them re-opens the defect this commit
closes; all three are pre-existing or cosmetic. **No blockers.**

---

## A. Is the loud assertion REAL, and can it still resolve `'no_post'`?

**REAL. It can never resolve `'no_post'`. Proven by execution and by direct row inspection.**

**Probe:** stripped `'collab_write'` from `agent_conversation.allowedSideEffects` in
`packages/contracts/src/profile.ts`, then `rm -rf packages/*/dist packages/*/tsconfig.tsbuildinfo`
+ `pnpm build --force` (cache bypassed — see the BUILD TRAP note below), then ran A3-c.

**Row evidence, quoted verbatim from `collab_agent_turns` in the failure payload — not inferred
from an error string:**

```
turns=[{"agentPrincipalId":"259719c0-...","channelSeq":1,"triggerEventId":"7a082f7d-...","state":"terminated"},
       {"agentPrincipalId":"26c92841-...","channelSeq":1,"triggerEventId":"7a082f7d-...","state":"terminated"}]
observedRefusals=[]
```

Both turns `'terminated'`. **Zero `'no_post'` rows.** `observedRefusals=[]` proves the model was
never invoked — the assertion fired *before* the `GatewayRequest` was minted, exactly as §5A/§9C
require, so it is **T-2-clean by placement**: there is no model transcript for the
`needed`/`provided` detail to leak into.

Operator-facing log fired with the full ruled payload:

```
[gateway] agent turn cannot post: 'collab__post_message' not admitted by effective profile
'agent_conversation' (needed side-effect 'collab_write'; profile provides [none])
-- agentPrincipalId=... channelId=... channelSeq=1
```

`needed` and `provided` both present. Operator sink only.

**Hunt for a residual silent path — none found for the assertion's own row.** Verified against
source:

- `resolveAgentTurn` (`packages/collab/src/autoReply.ts:147-155`) is a compare-and-set:
  `... WHERE ... AND state = 'dispatched'`. Once the §5A path writes `'terminated'`, **every**
  later resolve against that PK is a 0-row no-op. It cannot be downgraded to `'no_post'`.
- `findStrandedAgentTurns` (`autoReply.ts:178-193`) filters `WHERE state = 'dispatched'`, and
  `reclaimStrandedAgentTurn` (`:203-214`) carries the same guard and sets only `dispatched_at`,
  never `state`. **A §5A-terminated row is permanently immune to the recovery sweep.**
- Exactly **one** production writer of `'no_post'` exists repo-wide:
  `autoReplyDispatcher.ts:382` (the A3-f branch). No second, unguarded writer.

---

## B. The try/catch wrap — does it re-silence?

**The premise is TRUE and the wrap does NOT re-silence.**

**Premise verified:** a repo-wide grep for `unhandledRejection|uncaughtException` across
`packages/`, `ops/`, `apps/` (excluding `dist/` and Next.js build chunks) returns **exactly one
first-party hit — the explanatory comment in `autoReplyDispatcher.ts` itself.** There is
genuinely no net. A bare throw from `runAgentTurn` would kill the gateway process. The wrap is
necessary, not defensive padding.

**It does not re-silence, for a structural reason:** the turn is resolved `'terminated'` at
`:294` **before** the throw at `:301`. The DB row is already correct and durable regardless of
who catches. The catch only prevents process death; it cannot affect the recorded state.

**What an operator actually sees:** two `console.error` lines per failed turn — the detailed
`needed`/`provided` line from inside `runAgentTurn`, plus the generic net's
`[gateway] agent turn failed unexpectedly (...)`. Both observed in the Attack A run.

**Is the turn left `'dispatched'` and strandable?** **No.** Confirmed `'terminated'` in the row
dump above. Not strandable (sweep filters on `'dispatched'`).

---

## C. The RESERVED registry — genuine compile gate?

**YES. Proven by adding a temp enum member.**

**Probe:** added `'PROBE_G1R_temp_class'` to `SideEffectClassSchema` with no
`SIDE_EFFECT_ADMISSION` entry. `npx tsc --noEmit -p packages/contracts/tsconfig.json`:

```
packages/contracts/src/profile.ts(191,14): error TS2741: Property 'PROBE_G1R_temp_class' is
missing in type '{ none: ...; collab_write: "agent_conversation"[]; }' but required in type
'Record<"none" | ... | "PROBE_G1R_temp_class", ... | "INTENTIONALLY_UNADMITTED">'.
```

**The gate is real.** Note the mechanism is the `Record<SideEffectClass, ...>` *type annotation*,
not a `satisfies` clause — the doc comment's phrase "the `satisfies Record<...>` below is
exhaustive" is imprecise about its own mechanism, but the behavior is correct.

**Is the runtime validator vacuous?** **No — it fired for real.** Under the Attack A mutation:

```
Error: SIDE_EFFECT_ADMISSION drift: claims 'agent_conversation' admits 'collab_write' but it does not
```

That is the map being checked against `BUILT_IN_PROFILE_DEFINITIONS`, exactly as §9C's caveat
demands. It is a gate, not a second lying copy.

**Is `browser_mutation` quietly granted to make something green?** **No.** It remains
`'INTENTIONALLY_UNADMITTED'` with a RESERVED-BY-DEFECT comment, and no profile's
`allowedSideEffects` contains it. `network_send` and capability `send` likewise RESERVED. The
privilege-escalation-pump failure mode the ruling warned about **did not occur**.

---

## D. Is `allowedNamespaces: ['collab']` the containment boundary?

**YES — proven by mutating the real profile and calling the real resolver.**

**Probe:** set `allowedNamespaces: ['*']` on `agent_conversation`, rebuilt contracts (forced),
and called the production `resolveEffectiveProfile('agent_conversation', tools)`:

```
PROBE_D_RESULT=["collab__post_message","filesystem__read_file","websearch__search"]
```

With `['collab']` the same call admits **only** the collab tools. **The containment analysis in
the ruling is correct**: widening the namespace list instantly turns this profile into
`read_only` + collab-write. The profile is exactly as permissive as documented, no more.

> **METHOD NOTE — the stale-dist trap reproduced live.** My first run of this probe returned
> `[]` because `vitest.config.ts:42` aliases `@torqclaw/contracts` to `packages/contracts/**dist**/index.js`.
> I had edited `src` without rebuilding, so the probe silently read the *unmutated* profile and
> would have reported the containment analysis as WRONG. Only after
> `rm -rf packages/contracts/dist && pnpm --filter @torqclaw/contracts build --force` did the
> real result appear. **Additionally: `pnpm build` reported `FULL TURBO — 8 cached, 8 total`
> after I deleted `dist/`, restoring artifacts from the turbo cache without running `tsc`.**
> For content-identical source this is sound, but **every mutation probe in this tree must use
> `pnpm build --force`, not `pnpm build`** — deleting `dist/` alone is not sufficient. This is a
> second, sharper edge on the recorded build trap and is recorded here for the next seat.

---

## E. Escalation — is `agent_conversation` reachable from ordinary submission?

**NOT REACHABLE. All three of the ruling's independent facts verified.**

1. **Wire contract cannot express it.** `grep -c "profileId\|effectiveProfile\|requestedProfile"
   packages/contracts/src/commands.ts` → **0**. No field exists.
2. **Ordinary path passes only `taskType`.** `enrich.ts:37`:
   `resolveProfile({ taskType: cls.taskType })`. No `requestedProfile`.
3. **`DEFAULT_PROFILE_BY_TASK` excludes it** for all five `TaskType`s
   (`profileResolver.ts:9-15`), pinned by ESCALATION INVARIANT 1 over `TaskTypeSchema.options`.

**Additional surfaces I attacked, all closed:**

- **Only two `resolveProfile` callers exist repo-wide** (`enrich.ts:37`,
  `autoReplyDispatcher.ts:268`). Verified by grep across `packages/`, `apps/`, `ops/`.
- **`mintGrantedRequest`** (`dispatch.ts:104`) re-parses the *original* request JSON — it
  inherits the already-resolved profile and cannot elevate it.
- **Fail-closed backstop confirmed by execution**: under the Attack A mutation, ESCALATION
  INVARIANT 2 (`requestedProfile:'agent_conversation'` from `sessionDefaultProfile:'read_only'`)
  changed relation from `incomparable` to `stricter` and **stopped throwing** — proving that test
  is a live guard on the real lattice, not a string match.

---

## F. Did A3-c's inversion weaken the test?

**Assertion 1: STRENGTHENED, not weakened. Assertion 2: narrowed, with a real but pre-existing
blind spot.**

**Assertion 1 is strictly stronger than before.** The loop at `:456-460` now asserts that
**every** turn — including coalesced follow-ups — is `'completed'` or `'no_post'` and **never**
`'terminated'`. Previously it asserted the opposite (`['no_post','terminated']`). It also adds
`completedAgentIds` equality, defeating the vacuous-hold case the comment names. **It went RED
under the Attack A mutation** — it is a real guard.

The wait-helper change (`rows.length >= count` → `rows.length >= count && resolvedEnough`) makes
the helper wait for *settlement* rather than returning on a post that landed a beat before its
own `resolveAgentTurn`. That is a **flake fix that tightens**, not loosens: it can only make the
test wait longer and observe more state.

**Assertion 2's coalesced exclusion — the claimed rationale is FACTUALLY CORRECT, and it exposes
a pre-existing gap.** Verified at source: the coalesced follow-up in `dispatchOneTurn`'s
`finally` (`:199-210`) calls `dispatchOneTurn` **directly for the same `agentPrincipalId`**,
bypassing `resolveEligibleAgents` entirely. The no-self-reply invariant is enforced *structurally*
by `resolveEligibleAgents`' SQL (`autoReply.ts:80`: `AND m.principal_id != ?`), which the
coalesced path never consults. So a coalesced row genuinely *can* carry a `channelSeq` whose
author is the same agent, and it is not a self-reply in the meaningful sense.

**Does the exclusion create a blind spot where a GENUINE self-reply would pass?** **Yes, but a
narrow and pre-existing one.** If the coalesced path ever *did* produce a true self-reply, this
assertion would no longer see it. However:
- The block's own comment claims it will "re-resolve eligibility"; **the code does not**. That
  comment is inaccurate and predates this commit.
- The exclusion is honest about what it is doing and states its reason at length.
- **This is a pre-existing S3 defect, not introduced by `ba7caea`.** Recorded as Finding 1.

---

## G. Cascade bounds

**THE BOUNDS HOLD. Loud, not silent — but noisier than the header claims.**

**Mechanism, verified:**
- `claimAgentTurn` (`autoReply.ts:101-118`) relies on the PK
  `(channel_id, agent_principal_id, channel_seq)`; a duplicate triple returns `false` and no
  second turn dispatches.
- `dirty` is consumed (`dirty.delete(key)` at `:200`) *before* the recursive dispatch, so a
  single coalesced follow-up is granted per in-flight turn.
- Channel seqs only advance when a post commits, so a cascade with no posts cannot manufacture
  new PKs indefinitely.
- STOP is re-checked at `:204` before every coalesced dispatch — verified green by A3-c
  ASSERTION 4 and by `agent-participation-s3.test.ts`'s A3-e (a STOPPED channel produces no
  second-agent post).
- **Crash mid-cascade:** a `'dispatched'` row ages past the grace window and
  `recoverStrandedAgentTurns` re-dispatches it exactly once; the `WHERE state='dispatched'`
  guard makes an already-resolved row immune to replay.

**Worst case, N agents:** each committed post triggers at most (N−1) eligible agents, each
claiming at most one row per distinct seq. Bounded by (posts × agents). With scripts exhausted
the agents resolve `'no_post'` and the cascade dies — observed in the green A3-c run.

**The one real hazard (Finding 2):** on a *deterministic* policy failure, the `finally` block
still runs, so the failing turn is re-dispatched under a **new** PK
`(channelId, agentPrincipalId, latestChannelSeq)` with a synthetic `coalesced:<uuid>` trigger.
**I observed this empirically in the Attack A run** — the assertion fired at `channelSeq=1` for
both agents *and again* at `channelSeq=4` for both agents: four `'terminated'` rows from one
human post. Each lap is loud (a `console.error` per lap), so nothing goes silent, but the
file header's anti-storm claim 4 ("a turn that fails does not silently retry", `:33-34`) is
violated in spirit: the failure *does* retry, under a different row identity, with await-recursion
depth growing per lap. Under sustained inbound traffic this is a log-flood and row-churn hazard.

---

## THE PATTERN — tests that pass identically against unfixed code

Method: applied the Attack A mutation (strip `collab_write`) and recorded which of the diff's
new/changed tests went RED. Result: **6 failed / 38 passed** across the three profile test files.

**Went RED (real guards, mutation-sensitive):**
- A3-c ASSERTION 1 INVERTED — the primary end-to-end proof
- `falsifiability probe 1` (profile admits `collab__post_message`)
- `falsifiability probe 2` (namespace containment, current profile)
- `ESCALATION INVARIANT 2` (fails closed without operator authority)
- `agent_conversation is incomparable to read_only`
- `every SideEffectClass is admitted ... or explicitly RESERVED` (the drift detector)
- `AC-1 exact manifest` (the frozen golden — fired deliberately, was **updated not relaxed**;
  the hardcoded five-name `toEqual` list survives, `toContain` was NOT substituted)

**Did NOT fail under that mutation.** Most test *different* invariants, so insensitivity is
expected and correct (`scopes` presence, `approvalRequirements` inertness, ESCALATION INVARIANT 1
and its positive control, the dispatcher both-ids pattern, `CAPABILITY_ADMISSION`). **Two are
genuinely weak and are named here:**

1. **`DETECTOR PROOF: a hand-edited map claiming an unadmitted class IS admitted must be caught`
   — VACUOUS AS WRITTEN.** Proven by execution: the test constructs `lyingMap` and then
   **never passes it to `assertSideEffectAdmissionMap`**. It loops and asserts that
   `browser_research` does not admit `browser_mutation` — a fact the *very next test* already
   asserts. The planted lie never reaches the detector. My probe instrumented the shipped test
   body and confirmed `VAC_DETECTOR_INVOKED=false`.
   **Mitigating and decisive:** the detector *itself* is real — it produced the exact drift error
   under Attack A. And `assertSideEffectAdmissionMap`'s signature accepts only `definitions`, so
   the lie **cannot** be injected without a signature change. This is a **mislabeled, redundant
   test, not a broken guard.** Recorded as Finding 3.

2. **`falsifiability probe 2b` (widened-namespace counterfactual) — a mirroring validator.** It
   reimplements the namespace × capability × side-effect conjunction **inline** rather than
   calling `resolveEffectiveProfile`. It therefore proves a property of the test's own copy of
   the logic, not of production. **This is the exact "mirroring-validator" failure mode the
   ruling names at §5A.** It is not load-bearing, because **I verified the real property by
   mutation against the real resolver** (Attack D above) — but the shipped test does not.

**Does any new test drive a REPLICA rather than the real path?** Only probe 2b (above). A3-c
drives the real dispatcher, real `claimAgentTurn`/idempotency/STOP machinery, and the real
profile-gated `bridge.executeTool` against `packages/*/dist/`; only `dispatch()` is seamed, which
the file header documents honestly.

---

## Gate results — all run by me, after a forced clean rebuild

| Gate | Result |
|---|---|
| `rm -rf packages/*/dist packages/*/tsconfig.tsbuildinfo` + `pnpm build --force` | **PASS** (8/8, 0 cached) |
| `pnpm --filter @torqclaw/contracts check` | **PASS** — `OK — 8 schemas match source of truth in 2 checked-in dirs` (Python boundary gated) |
| `npx vitest run` (targeted 6 files) | **PASS 76/76** |
| `npx vitest run` (full suite) | **2251 passed / 1 skipped / 2 failed (130 files)** — both failures are known/reproduced flakes, see below |
| `npx tsc --noEmit -p packages/contracts/tsconfig.json` | **PASS** (clean) |
| `npx tsc --noEmit -p packages/bridge/tsconfig.json` | **PASS** (clean) |
| `npx tsc --noEmit -p packages/gateway/tsconfig.json` | **PASS** (clean) |
| `pnpm reachability` | **PASS** — `every substantial module is reachable or declared dormant` |

**The 2 full-suite failures — both flakes, neither chased as a regression:**
- `tests/failover/controller-timeout.test.ts` — the pre-declared known flake. Not chased.
- `tests/collab-c1-built-artifact.test.ts` (A11 stale-dist probe) — **I re-ran it in isolation:
  4/4 PASS.** It boots a real gateway process and is load-sensitive under full-suite
  parallelism, same class as the known flake. Not a regression from this commit.

---

## Findings (all NON-BLOCKING)

### Finding 1 — the coalesced follow-up bypasses `resolveEligibleAgents` (PRE-EXISTING)
`dispatchOneTurn`'s `finally` (`autoReplyDispatcher.ts:199-210`) re-dispatches for the same
`agentPrincipalId` without consulting `resolveEligibleAgents`, whose SQL (`autoReply.ts:80`) is
the **only structural enforcement** of the no-self-reply invariant. The block's own comment
claims it will "re-resolve eligibility"; the code does not. A3-c ASSERTION 2 now *excludes*
coalesced rows, which is honest about the mechanism but means the invariant is unasserted on
that path.
**Not introduced by `ba7caea`** — the bypass predates it; this commit only documents it.
**Suggested fix:** call `resolveEligibleAgents(db, channelId, <author of latestSeq>, latestSeq)`
in the `finally` and dispatch only if `agentPrincipalId` is still eligible; then drop the
exclusion from ASSERTION 2. Alternatively correct the comment to state the truth.

### Finding 2 — a deterministic policy failure retries under a new PK (log-flood / row-churn)
Because the `finally` runs after the `catch`, a §5A-terminated turn is re-dispatched at
`latestChannelSeq` under a new `coalesced:<uuid>` PK, hits the same deterministic condition, and
throws again. **Observed empirically** in the Attack A run (4 terminated rows, seqs 1 and 4, from
one human post). Every lap is loud, so this is **not** a silent-failure regression — it is a
noise/churn hazard that contradicts the header's anti-storm claim 4.
**Suggested fix:** skip the coalesced follow-up when the preceding turn threw (e.g. set a local
`failed` flag in the `catch` and guard the `if (dirty.has(key))` on it), so a *structural*
failure terminates the cascade instead of re-entering it.

### Finding 3 — `DETECTOR PROOF` never invokes the detector (cosmetic)
The `lyingMap` is constructed and then never passed to `assertSideEffectAdmissionMap`; the test
asserts a fact already covered by the next test. **The detector itself is proven real** (it fired
under Attack A with the exact drift message), so no guard is missing — the test is mislabeled and
redundant.
**Suggested fix:** widen `assertSideEffectAdmissionMap` to accept an optional map override, then
`expect(() => assertSideEffectAdmissionMap(BUILT_IN_PROFILE_DEFINITIONS, lyingMap)).toThrow(/drift/)`.
Same for `falsifiability probe 2b`: call `resolveEffectiveProfile` against a locally-widened
definition instead of reimplementing the conjunction inline.

---

## Ruling conformance — §10 checklist

| # | Required change | Status |
|---|---|---|
| 1 | `scopes: { path:'none', network:'none' }` | **MET** — present, parses, pinned |
| 2 | Named `agent_conversation` | **MET** |
| 3 | Both `requestedProfile` AND `sessionDefaultProfile` | **MET** — `:268-273`; verified the incomparable-throw is avoided |
| 4 | Keep `taskType='SUMMARIZATION'`, comment the prefix-routing reason | **MET** — comment states it explicitly |
| 5 | Loud dispatch-time precondition assertion | **MET — PRIMARY, proven by execution** |
| 6 | Update (not relax) golden + `declared` list + doc table | **MET** — five-name `toEqual` retained, `baseCommit` bumped to `8dfa98f`, doc row added; `PINNED_BASE` updated in lockstep |
| 7 | Two escalation-invariant tests | **MET** (INVARIANT 1 + positive control; INVARIANT 2) |
| 8 | Invert, do not delete, A3-c assertion 1 | **MET** — inverted, THE FINDING retained as history |
| 9 | Comment namespace + approval rationale into the definition | **MET** — verbatim from the ruling |
| 10 | `terminal_power` explicitly deferred | **PARTIAL** — not re-stated in this diff; the ruling itself carries the deferral. Cosmetic. |
| 11 | Reachability test + RESERVED registry as ONE artifact, validated | **MET** — compile gate proven (TS2741); runtime validator proven (drift error). Caveat: Finding 3. |
| 12 | Forced clean rebuild before dist-dependent verification | **MET** — and sharpened: `pnpm build` alone hits the **turbo cache** even after `rm -rf dist`. Use `--force`. |

---

## Restoration

Four source mutations were applied and **all four reverted**:
1. `allowedSideEffects: ['none','collab_write']` → `['none']` (Attack A) — restored
2. `'PROBE_G1R_temp_class'` added to `SideEffectClassSchema` (Attack C) — restored
3. `allowedNamespaces: ['collab']` → `['*']` (Attack D) — restored
4. Three temporary probe test files under `tests/helpers/` — deleted

All edits used structured `Edit`/`Write` only. **No PowerShell `-replace`. No `python3`** (it
does not exist on this host). `packages/contracts/src/profile.ts` was backed up to scratchpad
before the first mutation and restored from that copy.

Final state verified:
```
git status --porcelain -uno   → (empty)
git diff --stat               → (empty)
ls tests/helpers/ | grep -i probe → (empty)
```

**Tree restored clean. No source modified. No commits. No pushes.**

---

*G1R (claude-opus-5). Verification by execution. Operator approval required before any merge,
commit, or push.*
