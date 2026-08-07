# G2A Receipt - TORQCLAW Collaboration Substrate - Slice 1, Cycle 3 (FINAL)

- Date: 2026-08-07
- Verifier: independent Opus instance (G2A per operator routing policy)
- Audited: Slice 1 identity, after two fix passes (builder: Sonnet 5), on Slice 0 @ 1c48ca5, PRD v0.14
- Verdict: `APPROVE`
- Baseline confirmed: typecheck clean; collab 262/262 (11 files); full suite 1253/1253 (54 files); Slice 0 byte-identical to 1c48ca5

## Gate trajectory

- Cycle 1: REJECT 2H/3M — F1 secret-buffer leak on throw; F2 H1 normalization unimplemented; F3 kit header ignored+unauthenticated; F4 unbounded rate map; two mutants surviving.
- Cycle 2: REJECT 1H — all five gating fixes CLOSED and both mutants killed, but the F4 fix introduced NEW-1 (O(n)-per-attempt eviction sweep, 137x amplification, 70 s event-loop block under a 60k flood).
- Cycle 3: APPROVE — NEW-1 and F5 closed with margin; all prior invariants intact; throttle edge cases safe.

## Cycle 3 evidence

- (a) NEW-1: 200 attempts at capacity 5 ms / 0.025 ms-per (was 822 ms / 4.11); 60k flood 97 ms (was 69,865 — 720x); cost-regression fixture 50,199 visits <= 51,000 budget.
- (b) F5: n=2k/4k/8k/16k -> 3/3/5/10 ms (was 72/249/1060/5297), ~2.0x per doubling = linear; gate 0 visits <= 64,000.
- (c) 8/8 invariants: cap held under 60k flood; early lockout survives and is never evicted; expired reclaimed (50,000 -> 1 after window); credential/address thresholds and 15-min lockout exact; rolling window correct; loopback address-exempt (per-credential still applies); malformed -> address-only (M2); AUTH_FAILED indistinguishability.
- (d) Throttle edge case SAFE: map at cap, all entries locked, new legit ID -> admitted, no throw, cap overshoots by exactly 1 per admission (documented intentional branch, never evicts a live lockout). Adversarial sweep-forcing self-limits to 1 sweep / 5 min.
- (e) Scope: only ratelimit.ts changed since Cycle 2; all other Slice 1 sources byte-identical; Slice 0 byte-identical to 1c48ca5.
- Mutants: 8 (remove throttle) KILLED by the new fixture; 2 and 7 (Cycle 2) still killed on untouched files.

## Slice 1 accepted residual risks (carried forward)

1. All-locked-out (50,000 IDs) new-ID admission costs a full Phase-2 scan (~1.05 ms/attempt); reaching that state costs ~250,000 failed attempts, itself address-throttled; self-heals on lockout expiry. Revisit if the cap rises.
2. Cap overshoot by 1 per admission in the all-locked state — intentional, never evicts a live lockout.
3. Address bucket map still uncapped (lower risk: IPv6 -> /64, IPv4 -> host) — cap at the connect slice.
4. Wall-clock connect-path timing fixture OWED at the connect slice; HMAC-count equality is the agreed headless proxy.
5. Credential-response shapes pinned as key-set assertions, not byte-for-byte (Section 10 line 14) — tighten when connect frames exist.
6. WindowsCredentialManagerStore is a stub (throws on get and set); real adapter owed at the CLI slice; bootstrap refuses healthy over a non-persistent store.
7. Single-mutex simplification vs Section 8.3 three-class partition — acceptable with no read path; full partition owed at the Live slice.
8. No agent_created audit kind (schema CHECK) — would require a migration.
9. Corrupted ciphertext reports WRONG_PASSPHRASE (GCM cannot distinguish) — documented.

## Verified-sound highlights (do not re-litigate)

Decoy HMAC path (2 ops across hit/miss/revoked/malformed, 28-input fuzz zero throws); Section 8.3 atomic protocol (replay byte-identical, conflict full rollback, commit before handoff, 10x concurrency one plaintext); validation 9 (35/35 invoker cases, forged kind ignored); secret hygiene (11-table dump, four encodings, zero leaks); Argon2id 2.0.2 shipped and running (64 MiB/3/1); kit header GCM-AAD authenticated with params pinned by formatVersion (13/13 tampers rejected); canonicalJson code-point sort as sole hash input.
