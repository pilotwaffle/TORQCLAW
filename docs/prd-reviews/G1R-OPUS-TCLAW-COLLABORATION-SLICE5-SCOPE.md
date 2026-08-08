# G1R Receipt - TORQCLAW Collaboration Substrate - Slice 5 (headless subset) Scope Review

- Date: 2026-08-07
- Reviewer: independent Opus instance (G1R, security/design), pre-build
- Scope: HEADLESS Slice 5 (operator decision (a)) — metrics + Section 15 benchmark + rollback logic/rehearsal; operator UI and real-socket wiring DEFERRED
- Review object: G1D scope against PRD v0.14 Sections 11, 13, 15, 19, on the built Slice 0/1/2/3 substrate (@95277ba)
- Verdict: `REVISE-SCOPE` (2 Critical, 6 High, 4 Medium, 3 Low)
- Operator ruling 2026-08-07: C1 accepted as-scoped ("sounds right"); C2 to be FIXED. Both plus the full 8-item revision list are binding on the build.

## Critical (both in the destructive pre-migration restore path)

- **C1 (operator: ACCEPT)** Receipt-write ordering under-specified; "on completion" steers a builder to write the receipt AFTER the destructive overwrite, leaving a crash window with zero durable record. Fix: TWO-PHASE receipt — durable external INTENT receipt (backup IDs, boundary, typed confirmation, pre-restore checksum, timestamp, operator ack) written BEFORE the first destructive byte; COMPLETION receipt (new checksum, doctor results) after restore+doctor. A crash between leaves a discoverable intent record.
- **C2 (operator: FIX)** Confirmation-string / backup-ID matching not scoped as exact-equality-only, and no scoped abort-atomicity invariant. Fix: raw-byte `===` equality against the exact literal "RESTORE PRE-MIGRATION BACKUP AND DISCARD LATER DATA" (NO trim/case-fold/NFC — the repo normalizes free text elsewhere, so this must be explicit); selected backup ID validated by CHECKSUM against a recorded pre-migration manifest, not mere existence; ANY failed precondition aborts with the live DB byte-unchanged; destruction happens strictly after all gates pass; shutdown re-asserted immediately before the destructive write (no TOCTOU); the fresh full-state backup is an ordered checksummed step whose success is a precondition, never taken after/concurrent with the destroy.

## High

- **H1** "gateway shutdown asserted" must consult a NAMED injected liveness probe with refuse-when-live and proceed-only-when-down tests (else a stub asserts nothing and the headless gate is meaningless). Rollback may only ASSERT injected state, never cause shutdown.
- **H2** Benchmark must independently time the Section 15-exact revocation endpoints (SQLite-commit-return -> write-lock-release-after-purge), NOT re-export the coordinator's own recorded delta (tautology); forbid the three adjacent-endpoint traps (commit->close-frame-delivered; acquireWrite->releaseWrite; trusting the coordinator number). Assert zero post-linearization socket-write initiations and zero lost/duplicate sequences (structural).
- **H3** Reconcile "authoritative benchmark produces real p95s" vs "tests deterministic": GATE-PASSING assertions are structural/observation-count (floors: timeline/commit/fanout >=10,000; revocation >=1,000 with 450 SUSPEND/RESTORE / 450 ARCHIVE/UNARCHIVE / exactly 100 REVOKE_AGENT; nearest-rank percentile; zero-lost/dup; zero-post-linearization). HARNESS is separately runnable, emits real p95s to an artifact, numeric <=100/75/150/150 ms checked in REPORT mode (not gating). Keeping only structural = silent Section 15 narrowing.
- **H4** Node 22.11.0 pin is a documented reference-run requirement recorded into the harness artifact, not enforceable on an arbitrary dev machine (running env is 22.19.x).
- **H5** Enumerate OWED to the gateway effort: WindowsCredentialManagerStore real adapter, connect-path wall-clock timing fixture, real-socket backpressure. Slow-consumer hold is purely queue-byte-based (matches slowconsumer.ts 1_048_576); receipt path takes NO secret material so it composes without the CredMan adapter.
- **H6** Specify the no-await guard MECHANISM (AST/lint rule or runtime-yield instrumentation over runAuthorizationMutation post-commit loop + fanoutOne critical section), not a prose check; Mutex-FIFO property test targets store.ts Mutex (grant order == call order).

## Medium

- **M1** Address-bucket cap: addressBuckets is uncapped/unevicted (ratelimit.ts) — mirror the credential-bucket design (MAX cap, throttled sweep + LRU, never evict a live lockout, bucketVisitCount cost-regression assertion).
- **M2** Normal rollback needs a NEW bulk drain primitive: iterate registry.allActive() closing each with socket_closed + deliverCloseFrame, and close session bindings durably (matches performStartup orphan-closure) — do not assume the per-mutation coordinator close path covers it.
- **M3** Pin the normal-rollback proof: after rollback every collab_* table still exists (additive retention) AND a pre-seeded Phase-1 fixture row set is byte-identical before/after.
- **M4** Section 19 DoD honesty: headless satisfies consistency pre-gate, migration+Phase-1 fixture, rollback gate, benchmark gate. OWED to UI/gateway: accessibility (WCAG 2.2 AA), the six-flag-configuration gate + nested-flag startup validator (no flag handling exists in packages/collab today), full-slice G1R with UI. FINAL-STATUS may claim only the headless subset.

## Low

- L1 define a minimal headless doctor (migration-applied, verifyPepperCheck, installation-row) or record injected-doctor output; L2 note observability gaps vs Section 13 (migration/recovery/doctor outcomes, recovery-kit age) added-or-OWED; L3 run observation-floor assertions BEFORE percentile extraction so a floor miss fails loudly.

Fidelity note: the hardest part (Slice-3 M1 revocation-latency window) is already correctly implemented in the built coordinator; the benchmark must measure it honestly, not reinvent it. The destructive-restore risk is entirely in preconditions + receipt ordering.
