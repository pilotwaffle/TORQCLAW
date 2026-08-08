# G2A Receipt - TORQCLAW Collaboration Substrate - Slice 5 (headless: rollback + benchmark), Cycle 1

- Date: 2026-08-07
- Verifier: independent Opus instance (G2A per operator routing policy)
- Scope: HEADLESS Slice 5 (operator decision (a)) — metrics + Section 15 benchmark + rollback logic/rehearsal; UI + real-socket deferred
- Audited: Slice 5 build (builder: Sonnet 5) + a 3-item test-quality fix pass, on Slice 0/1/2/3 substrate (@95277ba), PRD v0.14
- Verdict: `APPROVE` (0 Critical, 0 High) — 4 builder mutants + 2 auditor mutants all killed
- Baseline at approval (post-fix): typecheck clean; collab 480/480 (26 files); runtime deps clean (better-sqlite3 + @node-rs/argon2 only; typescript moved to devDependencies)

## Destructive-restore path verified against live DBs (both Criticals)

- **C1 two-phase receipt:** crash injected after intent-write, before destroy -> intent receipt EXISTS, NO completion, DB byte-unchanged. Receipts secret-free (dumped; only "pepper" hit is the doctor boolean field name). Intent write precedes the single destructive applyRestore.
- **C2 exact-byte confirmation + checksum backup validation:** Buffer.equals, no normalization; all 7 near-misses (trailing/leading space, lowercase, trailing newline, prefix, combining-mark, NFC variant) rejected with DB byte-unchanged and applyRestore uncalled; backup validated by checksum vs manifest (existing-but-wrong-checksum rejected).
- Ordered-precondition atomicity: each of the 5 gates (gateway-down, confirmation, backup-checksum, fresh-backup-first, boundary) driven to failure with DB byte-unchanged + no completion receipt. TOCTOU: liveness re-asserted immediately before the destructive write (H1).

## Mutation results: 6/6 killed

Builder: m-string (relax to trim/upper), m-order (backup after destroy), m-intent (skip intent write), m-live (remove TOCTOU). Auditor: backup existence-only (drop checksum), destroy-before-intent. No survivors. All mutated files restored byte-identical (rollback.ts SHA256 verified).

## Other revisions closed

H2 measureRevocationWindow independently times commit-return -> write-lock-release-after-purge (own delta, not re-exported; forbids adjacent endpoints). H3 gate/report split (structural floors 10k/10k/10k + revocation >=1,000 with exact 450/450/100; nearest-rank percentile bit-identical to observability; zero lost/dup; zero post-linearization; report mode emits real p95s + Node version, numeric thresholds non-gating). H4 Node 22.11.0 recorded not enforced. H6 real TS-compiler AST no-await scan (self-test proves it detects awaits when present) + Mutex-FIFO grant-order==call-order; store.ts diff vs 95277ba is exactly one line (Mutex export), zero logic drift. M1 addressBuckets cap mirrors credentialBuckets (60k flood <= cap, early lockout survives). M2 normal rollback closes all subs with socket_closed as terminal frame + durable session bindings. M3 additive tables retained + Phase-1 fixture byte-identical. L1 headless doctor recorded in completion receipt. L2 observability counters. L3 floors before percentile.

## Test-quality fix pass (orchestrator-directed, closed before commit)

Three G2A non-blocking findings closed: (1) a tautological self-mutation test (tested a locally-defined comparison, not shipped code) DELETED — the real near-miss suite kills m-string, re-confirmed after deletion; (2) benchmark nowMs-call-count guard extracted to assertExactlyTwoNowMsCalls with direct 0/1/2/3-count tests (negative branch now enforced); (3) typescript moved from runtime dependency to devDependencies, noawaitguard removed from the production export surface (it is a dev/test tool). Collab 477 -> 480 (-1 tautology, +4 guard tests). rollback.ts destructive-restore logic byte-identical throughout (SHA256).

## Two full-suite load-flakes (NOT Slice 5 regressions)

harness.test.ts 1M-UUID determinism and failover/controller-timeout.test.ts time out under the now-larger suite's parallelism (70 files / ~1482 tests) but PASS in isolation (19/19, 7/7). Suite-scaling observation recorded: the two heaviest time-bounded tests are starved by suite concurrency; run isolated or with reduced concurrency to confirm green.

## Residual risks / OWED to the gateway/UI effort

The destructive restore verifies ORDERING/PRECONDITION LOGIC against injected stubs (applyRestore/backupTaker/receiptSink/gatewayLiveness) — the REAL backup engine, real durable receipt sink, and real data-destroying implementation are OWED. Also OWED: accessibility (WCAG 2.2 AA); the six-flag configuration gate + nested-flag startup validator (no flag handling exists in packages/collab); real WindowsCredentialManagerStore adapter; connect-path wall-clock timing fixture; real-socket backpressure; full-slice G1R with UI.

## Section 19 DoD

Satisfied (headless): consistency pre-gate; migration + Phase-1 fixture retention; rollback gate (normal + destructive-restore logic); benchmark gate (structural + report-mode harness). OWED: accessibility; six-flag gate + nested-flag startup validator; real CredMan adapter; real-socket wiring/backpressure; full-slice G1R with UI. FINAL-STATUS claims only the headless subset.
