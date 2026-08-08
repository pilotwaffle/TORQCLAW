# G2A Receipt - TORQCLAW Collaboration Substrate - Slice 3 (live / concurrency), Cycle 1

- Date: 2026-08-07
- Verifier: independent Opus instance (G2A per operator routing policy)
- Audited: Slice 3 live layer (builder: Sonnet 5), uncommitted, on Slice 0/1/2 substrate (@9d6e2e7), PRD v0.14
- Verdict: `APPROVE` (0 Critical, 0 High) — first-cycle pass, 6/6 mutants killed
- Baseline: typecheck clean; collab 400/400 (21 files); full 1392/1392 (64 files); 11 untouched Slice 0/1/2 sources byte-identical; all 6 audited sources sha256-identical after every mutation cycle; git surface exactly 15 files

## Four critical concurrency axes — verified by independent probes + mutation kill

- **C1** fanoutOne: `await acquireRead()` then a fully synchronous block, no await/Promise/microtask between readRevalidationSnapshot and the sink handoff. m-await KILLED by the no-await direct probe.
- **C2** authlock canGrantRead = `!writerActive && pendingWriters === 0` — genuine grant-queue writer-preference, not FIFO; pendingWriters increments at acquireWrite entry before grant. m-fifo KILLED by the 200-reader-flood test. (This is the load-bearing property: FIFO would break the revocation race, latency bound, and close ordering together.)
- **C3** by-construction argument SOUND, structural-only test ADEQUATE — see below.
- **C4** subscription.closed checked first; one FIFO queue for events+close; close() purges synchronously then delivers the close frame last. m-closeorder KILLED by 3 tests incl. "close frame provably last with pending buffered frames".

## C3 determination (the flagged risk)

With m-highwater active (register moved outside the sequencer mutex), the suite loses EXACTLY ONE test — the textual structural assertion; all behavioral tests still pass. The auditor independently determined this does NOT mask a real gap: three adversarial live-DB probes (concurrent subscribe + 8 posts x 25 seeds; a post at every microtask offset 0-12 around subscribe; a post queued directly behind subscribe on the mutex), run WITH m-highwater active, produced zero gaps and zero dups across 40+ interleavings. Mechanism: the sequencer Mutex is strict FIFO (tail-promise chaining), so any post committing at seq > captured highWater runs its mutex callback strictly after subscribe's, and subscribe's register runs in its synchronous continuation ahead of the later post's completion — the "commit lands in the register gap" window is structurally unreachable through the public async API. A behavioral test cannot exist for an unreachable gap; pinning the construction textually is correct and sufficient.

RESIDUAL (owed to Slice 5 hardening, not a finding): the structural test's adequacy is contingent on the Mutex staying strict-FIFO and no await entering any event-commit path before register. Add a Mutex-FIFO property test + a commit-path no-await lint guard.

## Other revisions closed

H1 per-write membership scoped to caller's own row (all three epoch snapshots); subscription-survival proven. H2 ADD_CHANNEL_MEMBER + RESTORE_AGENT on the write-lock path (not demoted). H3 slow-consumer 1 MiB + 10 s on the injected clock, age bound trips on a tick with no new traffic, single reason, ack never auto-advances. H4 seq filter is candidate-selection only; per-write revalidation independently authorizes (m-h4 killed). M1 revocation-latency window = commit-return -> write-lock-release-after-purge, pre-commit excluded. M2 one ordered FIFO sink. M3 injectable sink with byte-length + enqueue-time; real backpressure owed to Slice 5. L1 driver re-slotting correct (LIST/TIMELINE no sequencer mutex). L2 connect timing fixture N/A to this slice.

## Mutation results

6/6 killed: m-await, m-fifo, m-highwater (structural, behaviorally unreachable = adequate), m-closeorder, m-h1 (own-row), m-h4 (seq-filter-as-sole-auth). All sources restored byte-identical.

## Low findings (non-blocking, test-quality debt for Slice 5)

1. coordinator M1 latency test under-asserts (checks defined/>=0, not pre-commit exclusion — code is correct, probe-proven).
2. store-level writer-preference test is a light smoke (fires once, not sustained arrival — the real property is proven at the unit level via m-fifo).
3. commitReturnMs > 0 guard drops a sample if an injected clock returns 0 (test-instrumentation edge only).

## Residual risks / owed to Slice 5

Real-socket backpressure + Section 15 wall-clock benchmark; C3 Mutex-FIFO property test + no-await lint guard; strengthen the M1 and store-level writer-preference assertions.

## Scope

git surface = exactly index.ts + store.ts (modified) + 6 new src (authlock/subscriptions/fanout/coordinator/slowconsumer/observability) + 7 new tests. No other Slice 0/1/2 source touched; no DDL change. Slice 0/1/2 tests still within the 400.
