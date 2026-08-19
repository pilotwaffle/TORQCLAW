# G2A Final Audit — A3-c green + the structural fix (`ba7caea`)

**Seat:** G2A final verifier.
**Model:** `claude-opus-4-8`. CLAUDE.md §2 names Claude Opus 4.8 for this seat and I *am* Opus 4.8 — **no substitution applies.**
**Scope:** `8dfa98f..ba7caea` (single commit; G1R verdict `3cb29ad` is docs-only).
**G1R verdict read:** `docs/prd-reviews/VERIFY-OPUS-A3C-STRUCTURAL-FIX.md` (APPROVE, zero blockers, three non-blocking findings). Not deferred to — every load-bearing probe re-run by me, in my own worktree, with my own mutations.
**Date:** 2026-08-18. **Method:** clean worktree at `ba7caea` (`.g2a-a3c-wt`, removed afterward), forced clean build (`rm -rf packages/*/dist` + `pnpm build --force`) per the recorded build trap — and I can confirm the trap is real: `--force` is load-bearing, since a cached `pnpm build` would have made every mutation probe here meaningless. Four mutation probes with rebuilds; all restored; `git status` clean afterward.

---

## VERDICT: **APPROVE WITH CONDITIONS** — one condition (C-1, the coalesced-path self-reply bypass), three non-blocking notes

The primary deliverable is real and proven at the right level of evidence: the loud pre-dispatch assertion fires before any model call, terminates the turn row durably, and cannot resolve `'no_post'`. A3-c's inverted assertion is a genuine end-to-end proof — two agents converse through the real dispatcher, real idempotency/STOP machinery, and the real profile-gated `executeTool`. The RESERVED registry is a genuine compile gate. This is the best-constructed slice in the program so far. The one place I part from G1R: its F1 is not just a pre-existing nit — this commit is what makes the loop runnable, and that promotes it to a condition.

---

## The six things the brief ranked, each by execution

### 1. The loud assertion is REAL and cannot resolve `'no_post'` — proven with row-level evidence

My Probe 1: stripped `'collab_write'` from `agent_conversation.allowedSideEffects`, forced rebuild, ran A3-c:

```
FAIL … ASSERTION 1, INVERTED
Error: all 2 expected turn(s) resolved without reaching 3 posts (have 1).
turns=[{…"state":"terminated"},{…"state":"terminated"}] observedRefusals=[]
Tests  1 failed | 4 passed (5)
```

The turn **rows** — inspected directly, not inferred from an error string — are both `'terminated'`, zero `'no_post'`, and `observedRefusals=[]` proves the model was never invoked (assertion fires pre-mint, so it is T-2-clean by placement). Restored; A3-c **5/5 green**, the cascade completing with both agents' committed replies. Structural immunity verified at source: `resolveAgentTurn` is a compare-and-set on `state='dispatched'`, and the stranded-turn sweep filters on the same value, so a `'terminated'` row can never be downgraded or reclaimed. Exactly one `'no_post'` writer exists repo-wide (the A3-f branch).

### 2. The try/catch does NOT re-silence

Verified the ordering in `runAgentTurn`: the turn is resolved `'terminated'` (`autoReplyDispatcher.ts:294`) **before** the throw (`:301`), so the durable row is correct regardless of the catch; the catch only prevents process death — and the premise is true (no `unhandledRejection` net anywhere in `packages/`, grep-verified). The operator sees both the detailed `needed`/`provided` line and the generic net line. The turn is not left `'dispatched'`, so it is not strandable. Sound.

### 3. The RESERVED registry is a genuine compile gate — proven

My Probe 2: added `'PROBE_G2A_temp_class'` to `SideEffectClassSchema` with no map entry:

```
packages/contracts/src/profile.ts(191,14): error TS2741: Property 'PROBE_G2A_temp_class' is
missing in type '{ none: …; collab_write: "agent_conversation"[]; }' but required in type
'Record<"none" | … | "PROBE_G2A_temp_class", …>'.
```

Exact line and error class G1R recorded. The mechanism is the `Record<SideEffectClass, …>` type annotation (the doc comment's "`satisfies`" phrasing is imprecise — cosmetic). And the runtime half is real: my Probe 5 (below) fired the drift error for actual. `browser_mutation`/`network_send`/`send` are all genuinely `INTENTIONALLY_UNADMITTED`, none quietly granted — the privilege-escalation-pump failure mode did not occur.

### 4. The namespace boundary is load-bearing — proven against the real resolver

My Probe 3: `allowedNamespaces: ['collab']` → `['*']`, forced rebuild, called the production `resolveEffectiveProfile('agent_conversation', tools)` from `bridge/dist`:

```
PROBE_D_RESULT=["collab__post_message","collab__read_channel","filesystem__read_file","websearch__search"]
```

Widening instantly turns the profile into `read_only` + collab-write, exactly as the ruling's containment analysis says. With `['collab']` it admits only the collab tools. The profile is precisely as permissive as documented, no more.

### 5. Escalation — not reachable, independently verified

`grep -c "profileId|effectiveProfile|requestedProfile" packages/contracts/src/commands.ts` → **0**. Exactly two `resolveProfile` callers repo-wide (`enrich.ts:37`, `autoReplyDispatcher.ts:268`). `DEFAULT_PROFILE_BY_TASK` (`profileResolver.ts:9-15`) excludes `agent_conversation` for all five `TaskType`s — with the trap the brief named being real: it is `Record<TaskType, ProfileId>`, so exclusion-by-absence compiles silently and only ESCALATION INVARIANT 1 pins it. The dispatcher's own override (requested == session default, `operatorAuthorized: false`) fabricates no authority and never engages the incomparable guard — the ruling's crash-loop trap is avoided exactly as designed.

### 6. A3-c — strengthened, with one named narrowing

Assertion 1's inversion is strictly stronger (terminal-state set flipped from `['no_post','terminated']` to `['completed','no_post']`, plus `completedAgentIds` equality defeating the vacuous-hold case) and goes RED under my Probe 1. The wait-helper change only ever waits *longer* and observes *more* state — a tightening flake fix. Assertion 2's coalesced exclusion is honest about itself — and it is where my one condition lives (C-1 below).

## C-1 (condition) — the coalesced follow-up bypasses the no-self-reply guard, and this commit makes it runnable

**G1R's F1, promoted.** G1R rated this pre-existing and non-blocking and asked whether making the loop runnable promotes it. My answer: yes, to a condition — not a blocker, because it is narrow and bounded, but a condition because it is a *structural* bypass of a *designed structural invariant*, and the loop now runs.

- `dispatchOneTurn`'s `finally` (`autoReplyDispatcher.ts:199-210`) re-dispatches the **same `agentPrincipalId`** on `latestChannelSeq` without consulting `resolveEligibleAgents` — whose SQL (`autoReply.ts:80`, `AND m.principal_id != ?`) is the *only* structural enforcement of no-self-reply. The `finally`'s own comment claims "re-resolve eligibility"; **the code does no such thing.**
- Reachable, not hypothetical: another agent's post sets `dirty` while agent B is in-flight; B's own commit then becomes `latestChannelSeq`; the coalesced dispatch evaluates B against **B's own message**. The model is told "a new message was posted" with its own post as the anchor. That is a self-reply in the only sense the SQL guard exists to prevent — and A3-c's assertion 2, which now excludes coalesced rows, would pass right over it.
- Bounded: dirty is set only by *other* authors' commits, one follow-up per in-flight turn, STOP re-checked at `:204`, PK idempotency holds. Not a storm; a narrow, quiet invariant violation.
- **Fix (one check):** in the `finally`, look up the author of `latestChannelSeq` and skip the coalesced dispatch when it equals `agentPrincipalId`. If the newest message is the agent's own, there is nothing new for it to answer.

## Cascade bounds — hold

Verified the mechanism: PK `(channel_id, agent_principal_id, channel_seq)` idempotency; dirty consumed before the recursive dispatch; seqs advance only on real commits; STOP re-checked before every coalesced dispatch; the stranded sweep re-dispatches exactly once and is immune to resolved rows. Worst case (N agents, rapid posts) is bounded by posts × agents; with scripts/models exhausted the cascade dies to `'no_post'`, observed in the green A3-c run. STOP mid-cascade is covered by A3-e (green in the named set). Crash mid-cascade is covered by the sweep's `state='dispatched'` guard.

## Non-blocking notes

- **NB-1 (G1R's F2) — deterministic-failure retry, loud but mis-described.** On a §5A policy failure the `finally` still re-dispatches under a new PK once per inbound seq — G1R observed four `'terminated'` rows from one post; I confirm the mechanism at source. Bounded by real traffic and loud per lap, but the file header's anti-storm claim 4 ("a turn that fails does not silently retry") is inaccurate: it retries, under a different row identity. Recommend gating the coalesced re-dispatch on turn outcome (skip when the turn terminated by the §5A assertion) — the same one-line region as C-1's fix.
- **NB-2 (G1R's F3) — the "DETECTOR PROOF" test is vacuous as written.** Confirmed by reading (`tests/profile-policy.test.ts:293-312`): `lyingMap` is built and never passed to `assertSideEffectAdmissionMap`; the assertions duplicate the next test. **But the detector itself is real** — my Probe 5 (strip `collab_write`, forced rebuild, run the suite) produced `Error: SIDE_EFFECT_ADMISSION drift: claims 'agent_conversation' admits 'collab_write' but it does not` plus four other REDs, matching G1R's table. Also: probe 2b reimplements the admission conjunction inline (a mirroring validator); the real property is covered by my Probe 3 against the real resolver, so it is redundant, not load-bearing.
- **NB-3 — stale doc pointer.** `profile.ts:184-185` says the admission validators are "called from profile-conformance-runtime.test.ts"; they are actually called from `tests/profile-policy.test.ts:286,290` (I confirmed by running the wrong file first and getting a misleading 18/18 — exactly the class of false comfort this program exists to catch). One-line fix.

## The pattern hunt

Every new/changed test in this diff: A3-c assertion 1 (RED under my mutation), falsifiability probes 1–2, ESCALATION INVARIANT 2, the incomparable test, and the drift detector (all RED under my mutation — 6 files/tests sensitive, matching G1R's table). The two genuinely weak tests are NB-2's pair. **No test drives a replica** — A3-c drives the real dispatcher and real profile-gated `executeTool` against `packages/*/dist`; only `dispatch()` is seamed, honestly documented. Instance-eight pattern: not repeated here.

## Gate results — all my own runs, clean worktree at `ba7caea`

| gate | result |
|---|---|
| `rm -rf packages/*/dist` + `pnpm build --force` | PASS (forced, cache-bypassed — mandatory here, verified) |
| `pnpm --filter @torqclaw/contracts check` | PASS — 8 schemas match |
| Named 6-file set (a3c, s3, s2, profile-policy, conformance ×2) | PASS — **76/76** (A3-c 5/5) |
| `npx vitest run` (full suite) | 2248 passed / 1 skipped / 5 failed — **all environmental**: 2 `tests/failover/*` Python-ledger timeouts (worktree lacks the env; documented class), 3 cold-load timeouts (`agent-participation-s1`, `collab-build-lock`, `ops-bootstrap-operator-live-wire`) that pass **15/15 on warm re-run**. **Zero range-attributable failures.** |
| `tsc --noEmit` contracts / bridge / gateway | PASS ×3 (exit 0) |
| `pnpm reachability` | PASS |
| `git diff --stat 8dfa98f..ba7caea` | 11 files, 558+/58-, all in scope |

## Tree state afterward

All four probe mutations restored (`git status` clean), probe script deleted, worktree removed. Main tree untouched. This verdict is the only file created.

---

**Bottom line:** the commit that makes agents able to converse unsupervised is, as built, honest — the silent-denial defect is closed structurally (loud-by-construction at the only point that can produce the outcome), the profile is exactly as wide as documented, and the loop's storm bounds hold. Approve, with C-1's one-line self-reply guard owed before this runs against real models at any scale, and the NB-1/NB-2/NB-3 cleanups riding with it.
