# G2A Third-Pass Audit — PRD-TCLAW-COLLAB-PRESENCE-UI-005 S3+S4 (RC-1 pin, NB-RA-3 correction, V-1 fix)

**Seat:** G2A final verifier.
**Model:** `claude-opus-4-8`. CLAUDE.md §2 names Claude Opus 4.8 for this seat and I *am* Opus 4.8 — **no substitution applies.**
**Scope:** `cc95499..dc798b2` — `1776938` (RC-1 pin + NB-RA-3 header correction) and `dc798b2` (V-1 fix). Everything earlier was audited in pass 1 (`G2A-OPUS48-COLLAB-PRESENCE-UI-005-S3.md`) and pass 2 (`...-S3-REAUDIT.md`).
**G1R's S4 verdict read:** `docs/prd-reviews/VERIFY-OPUS-COLLAB-PRESENCE-UI-005-S4.md` (REJECT, blocker V-1). Not deferred to — I re-derived its defect claim and the fix's three load-bearing questions myself.
**Date:** 2026-08-17. **Method:** diff read, two mutation probes re-run against the new pins, independent derivation of the burst-test bound. All mutations restored; `git diff HEAD --stat` empty afterward.

**Framing:** all three fixes were authored by G1D, the party that built the slice and directs the builders, and were reviewed by no one else before this pass. Each was treated as unproven until driven.

---

## VERDICT: **APPROVE**

All three fixes are correct, pinned, and falsifiable. RC-1 is closed by a probe I designed and re-ran myself. NB-RA-3's header is now truthful including the uncomfortable part. V-1 — the blocker G1R found and I missed — is genuinely fixed, its test bound is measured rather than tuned, and routing the ack re-read through the coalescing guard does not drop any legitimately owed re-read. No new defects found in this range. Two standing non-blocking items (NB-RA-1, NB-RA-2) remain unaddressed by design and are correctly characterized.

---

## 1. RC-1 (my pass-2 condition) — CLOSED, verified by re-running my own probe

`1776938` adds an assertion on the published ack frame in `tests/collab-surface-post.test.ts` (inside the T-1/CO-1 test, which posts with a known key): `metadata.idempotencyKey` must equal the key passed in, plus the other three fields `selectLatestPostAck` reads (`channelId`, `eventId`, `cursor`).

**I re-ran my exact deletion probe** — removed `idempotencyKey` from the ack metadata in `collabSurface.ts`:

```
FAIL … T-1/CO-1: NULL principal refuses COLLAB_IDENTITY_REQUIRED and posts NOTHING
AssertionError: G2A RC-1 REGRESSION: the post ack no longer carries idempotencyKey. …
  expected undefined to be '2e38ac21-6c91-4821-a342-c40f366bed9a'
Tests  1 failed | 38 passed (39)
```

RED, with a message naming the regression. Restored; GREEN. The load-bearing field of the D-1 fix is now pinned.

## 2. NB-RA-3 — header now truthful; all three pointers resolve (checked because it was wrong twice)

- "C-1 fallback probe — commit `c404a24`'s message. VERIFIED PRESENT." → **resolves**: the message contains `expected 'operator' to be 'agent'` (RED observed, restored, GREEN).
- "D-1 ack-correlation probe — commit `cc95499`'s message. VERIFIED PRESENT." → **resolves**: the message records that reverting to channelId-only correlation reproduces the silent drop (message B absent), restored GREEN.
- "G2A's independent re-runs — the two verdict files." → **resolve**: both exist and contain the RED excerpts.
- The fourth item is the honest admission: the four builder-side T-9 probes' RED output lived only in the builder's task output, **was never committed, and is lost** — so by §8's own standard those four are not discharged by the builder, and what stands behind the matrix is my independent re-runs. That is the correct conclusion and the header now says it instead of implying otherwise.

## 3. V-1 — the blocker G1R found and I did not: fix verified, three questions answered

**First, mea culpa with the mechanism named.** G1R is right that I missed this: my pass-2 probes drove the hint path with foreign keys and the D-1 path with at most two sends where only one was acked — I never rendered an ack for the operator's *own* send, which is the one input that satisfies both `selectLatestPostAck` and `selectLatestHintEventId` in the same commit. My "coalescing holds" verdict was correct for the paths I drove and false for the most common path in the product. Recorded plainly: model diversity did not save me from a coverage-shaped blind spot; the fix is a better test suite, not a better claim of thoroughness.

**(a) Does routing the ack re-read through the guard drop a legitimately owed re-read?** No — it is deferred, not dropped. The ack effect (`ChannelsPanel.tsx:863-866`) now marks `refetchDirtyRef` and returns when a read is in flight; the resolved-frame effect (`:597-601`) fires exactly one follow-up when the in-flight read lands. The confirm path is unaffected: the entry was already stamped `awaitingConfirm` before the guard check, and any re-read returning the eventId clears it. One residual edge, pre-existing and slightly more reachable now: if the in-flight read *times out* (5s), the timeout arm clears in-flight but leaves `dirty` set (NB-RA-2b), and the pending entry sits in `awaitingConfirm` — a phase with no timeout of its own — showing "sending…" until the next unrelated frame flushes the flag. Bounded, honest-ish (never renders as sent, never silently clears), but "sending…" can persist past the moment the entry deserves a "no response — retry". Recorded as NB-P3-1 below; non-blocking.

**(b) Is the burst-test bound of 6 genuinely the measured post-fix count?** Yes — I derived both sides analytically and then measured the defective side myself:
- *With the guard:* round 1 fires 2 reads (hint read + dirty-flushed follow-up, because the follow-up's response lands within the round); rounds 2–4 fire 1 each (each round's ack arrives while the previous follow-up is still in flight, so the hint collapses into dirty); plus 1 initial select-read → **6**. The assertion is `toBeLessThanOrEqual(6)`, so it also passes in the fewer-reads direction — it is a ceiling on regrowth, not a tuned equality.
- *Without the guard* (my probe P2 — deleted the `refetchInFlightRef` check in the ack effect): each ack render fires hint-read + unconditional ack-read = 2 per round, no follow-ups (dirty never set), plus the initial → **9**. Observed: `expected 9 to be less than or equal to 6` and `expected 2 to be 1` — both RED, both matching the commit message's recorded outputs verbatim:
  ```
  FAIL … G1R V-1: a SELF-SEND ack fires exactly ONE re-read, not two …
  FAIL … G1R V-1: N self-sends produce N re-reads, not 2N …
  Tests  2 failed | 43 passed (45)
  ```
  Restored; GREEN. The commit's claim "my first attempt used an arbitrary bound of 5 and failed; I measured both sides" is consistent with the arithmetic — 6 is the derivable post-fix count, not a threshold moved until green.

**(c) The secondary timer-stomp claim.** Structurally true, verified by reading `requestTimeline` (`:549-571`): it clears and re-arms the single shared `timelineTimer.current` unconditionally, so two concurrent reads mean the second read's timer overwrites the first's; when the second resolves, the resolved effect clears the timer, and a hung first read's timeout is silently disarmed. The fix (one read in flight at a time) eliminates the stomp by construction. Claim holds.

## Standing non-blocking items

- **NB-RA-1** (same-batch double-ack → one entry shows a false "no response — retry" while visibly sent): G1R reproduced it; its verdict and mine now agree the "self-heals" wording overstates — recovery needs a user retry click. Still non-blocking (idempotent retry, no duplicate, no loss).
- **NB-RA-2** (reselect race + timeout-with-dirty): G1R probed to saturation and confirmed both are genuinely bounded — the dirty flag is a boolean, debt cannot accrue. Unaddressed by design.
- **NB-P3-1 (new, minor):** the `awaitingConfirm`-after-timeout limbo described in 3(a) — an entry can show "sending…" indefinitely if its confirm re-read was coalesced into a read that timed out and no further frames arrive. Pre-existing gap in the pending-state machine (no timeout for `awaitingConfirm`), made marginally more reachable by V-1's deferral. Fails honest-but-stuck, never dishonest.

## Gate results — my own runs, this pass

| gate | result |
|---|---|
| `npx vitest run tests/channels-panel.test.tsx tests/collab-surface-post.test.ts` | PASS — **84/84** (the 2 new V-1 tests included) |
| `npx vitest run tests/authz.test.ts tests/collab-identity.test.ts tests/connection-auth.test.ts tests/collab-connect-dataflow.test.ts` | PASS — 60/60 |
| `npx tsc --noEmit -p packages/gateway/tsconfig.json` | PASS (exit 0) |
| `npx tsc --noEmit -p apps/console/tsconfig.json` | PASS (exit 0) |
| `pnpm reachability` | PASS |
| `git diff --stat cc95499..dc798b2` | 4 files: `ChannelsPanel.tsx` (+26), `channels-panel.test.tsx` (+86), `collab-surface-post.test.ts` (+69/-16), the S4 verdict doc. Scope clean — no unrelated files. |

The full-suite 2128/2129 with the named `tests/failover/controller-timeout.test.ts` flake is the documented one; not chased, per the brief. The intermittent adjacent-gate failure I recorded in pass 2 did not recur this pass.

## Tree state afterward

Clean. Both probe mutations restored byte-identical (`git diff HEAD --stat` empty); no scratch files left; this verdict is the only file created.

---

**Bottom line.** Three passes on this slice, and the arc is the program working as designed: pass 1 caught D-1 (silent drop), pass 2 verified its fix and pinned what was unpinned, G1R's S4 pass caught V-1 (the self-send double-read) that I missed, and this pass verifies all three closures by execution. With RC-1 pinned and V-1 fixed-and-falsifiable, S3+S4 carry my approval. Remaining debt is honestly labeled: NB-RA-1, NB-RA-2, NB-P3-1, and CO-S3-1 (ERROR frames invisible to the console — pre-existing, gateway-wide, still owed).
