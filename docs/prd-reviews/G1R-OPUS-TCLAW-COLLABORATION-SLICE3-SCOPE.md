# G1R Receipt - TORQCLAW Collaboration Substrate - Slice 3 (live) Scope Review

- Date: 2026-08-07
- Reviewer: independent Opus instance (G1R, security/concurrency/design), pre-build
- Review object: G1D scope for Slice 3 (live: RW authorization lock, subscriptions, fan-out, revocation coordinator, slow consumers) against PRD v0.14 Sections 5.5, 7.3, 7.7, 8.1, 8.2, 8.3, 9, 10, 13, 15, on the built Slice 0/1/2 substrate (@9d6e2e7)
- Verdict: `REVISE-SCOPE` — direction faithful on all three catastrophe axes; ship after folding 12 revisions (C1-C4 load-bearing)

## The one fact that flips multiple safe answers to unsafe

If the authorization lock's writer-preference is implemented as FIFO rather than a grant-queue property (pending-writer count gates new read grants), then the revocation race (a), the latency bound (c), and close-frame ordering (d) ALL fail together — a reader flood between a buffered event's commit and its delivery gets granted ahead of a pending revocation.

## Critical revisions

- **C1** Per-write revalidation + write-initiation is ONE synchronous critical section under one read-lock hold; NO await between the BASE/epoch read and the sink handoff; read lock released only after the write is initiated. (Prevents a REMOVE committing+purging in an await window and delivering to a removed principal.)
- **C2** The authorization lock is a genuine writer-preferring RW-lock — a DIFFERENT primitive than the existing synchronous single-waiter Mutex. Writer-preference must be a grant-queue rule, not caller ordering. Layer: acquireWrite (await) -> sequencerMutex.withLock(SYNC tx) -> post-commit sync close+purge -> releaseWrite. The sequencer mutex STAYS synchronous (no yield BEGIN IMMEDIATE..commit). Add the deterministic bounded-wait-under-sustained-readers test.
- **C3** Subscription registry insertion + `buffering` flag + high-water capture are ONE atomic step under the sequencer mutex (so every post-registration commit enqueues to the buffer — closes the dropped-highWater+1 gap). backlog: max(afterCursor,rejoined_seq) < seq <= highWater; live: seq > highWater; buffer dedup on > highWater; transition-to-live under the mutex.
- **C4** Per-write path checks subscription.closed FIRST and drops if closed; ONE ordered FIFO sink for both channel_event and the close frame; queue purge under the write lock; a mutation's registry close reason wins over a concurrent revalidation-derived reason. (Makes "close frame is the last frame" true by construction.)

## High/Medium/Low

- H1 per-write membership comparison scoped to the caller's OWN row only (all three epoch snapshots: auth, own membership, channel).
- H2 ADD_CHANNEL_MEMBER and RESTORE_AGENT stay write-lock class (they mutate an epoch revalidation reads) — forbid read-lock demotion on "closes nothing" grounds.
- H3 both slow-consumer thresholds (1 MiB, 10 s) on the injected clock; age bound evaluated on tick/delivery-attempt not only enqueue; identical single close path; ack cursor never auto-advances.
- H4 the channel_seq > rejoined_seq seq filter and the per-write BASE/epoch revalidation are BOTH required and independent — the filter selects candidates, revalidation authorizes each write.
- M1 revocation-latency counter endpoints pinned to Section 15: SQLite-commit-return -> write-lock-release-after-purge; exclude pre-commit writes.
- M2 one ordered per-subscription sink (channel_event + close frame FIFO).
- M3 in-process injectable sink is faithful enough for Slice 3; sink models "write initiated" as the lock-release boundary and exposes byte-length + enqueue-time; real-socket backpressure coupling and the Section 15 wall-clock benchmark are OWED to Slice 5.
- L1 read-path drivers acquire the read lock first per Section 8.3 (SUBSCRIBE/ACK/UNSUBSCRIBE read lock then sequencer mutex; LIST/TIMELINE read lock, not sequencer mutex).
- L2 the OWED wall-clock connect-path timing fixture belongs to the gateway-wiring/Slice 5 layer, not Slice 3.

## Answers

(a) no post-revocation channel_event — YES given C1+C2+H1+H4. (b) backlog->live gap/dup-free — YES given C3. (c) slow consumer cannot delay revocation latency — YES given C2 writer-preference as a grant property. (d) close step cannot emit channel_event after close — YES given C4 (relies on C1+C2). (e) in-process injectable sink faithful enough — YES (M3); Node single-threadedness makes the interleavings the real ones. (f) four silent narrowings: H4, H3, C4, C2.
