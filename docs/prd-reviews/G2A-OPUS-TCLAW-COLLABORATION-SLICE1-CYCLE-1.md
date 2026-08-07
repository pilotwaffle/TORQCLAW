# G2A Receipt - TORQCLAW Collaboration Substrate - Slice 1, Cycle 1

- Date: 2026-08-07
- Verifier: independent Opus instance (G2A per operator routing policy)
- Audited: Slice 1 identity build (builder: Sonnet 5; builder wedged pre-report, artifacts verified directly), uncommitted, on Slice 0 @ 1c48ca5, PRD v0.14
- Baseline at audit: typecheck clean; collab 240/240 (11 files); warm full suite 1231/1231 (54 files); Slice 0 byte-unchanged; lockfile delta = @node-rs/argon2 2.0.2 + platform binaries only
- Verdict: `REJECT` (0 Critical, 2 High, 3 Medium, 4 Low)

## G1R ten revisions: 7 CLOSED, 3 not

CLOSED with probe evidence: C1 (HMAC counts 2/2/2/2 across hit/miss/revoked/malformed; 28-input fuzz, zero throws), H2 (canonicalJson code-point sort proven on astral keys; sole createHash call site), H3 (all three same-state fresh-key repeats; revokedCredentialCount 0), audit rows for all credential commands, validation 9 (35/35 invoker cases, zero row changes, forged kind ignored), bootstrap refusal + stub throws both ways, HMAC counter inside the wrapper, M1 typed collision error, M3 startup order, L2 in-transaction guard count.

NOT CLOSED:
- **F1 HIGH (L1)** store.ts: secret Buffer zeroed only when the transaction closure RETURNS; any throw after allocation (probed: dropped table, throwing clock) leaves live secret bytes on the heap. DB rollback correct; memory hygiene broken; docstring claims otherwise.
- **F2 HIGH (H1)** store.ts performs no normalization: "  Ana  " persists raw, "Ana" retry gets IDEMPOTENCY_CONFLICT (hashes differ, probed); NFC also skipped. Guarding test was a tautology (passed 'Ana' twice). Violates G1R H1 and PRD Section 10 normalization-order fixtures.
- **F3 MEDIUM (C2 partial)** Argon2id 2.0.2 genuinely ships and runs (64MiB/3/1); scrypt fallback correct with explicit maxmem; but the kit's kdfParams field is parsed then ignored and the header is outside the GCM tag (no AAD) — tampered params still verify. The two defects currently cancel; making params load-bearing without AAD would create a KDF-downgrade attack. Fix together or pin-by-version with authenticated header.

## Other findings

- F4 MEDIUM ratelimit credential-bucket map unbounded (probed 100k entries 1:1; no eviction — note any future cap must never evict locked-out entries). F5 MEDIUM O(n^2) failure pruning (probed 16k -> 1315 ms).
- F6 LOW canonicalJson sparse arrays emit invalid JSON; F7 LOW kit checksum is HMAC-empty-key, docstring says sha256; F8 LOW mutex-across-handoff docstring inaccurate (commit-before-handoff itself holds); F9 LOW "closes zero sessions" fixture asserts nothing.

## Mutation results (7 injected)

Killed: decoy-only-on-miss, validation-9 skip, fresh-key audit row, LAST_OPERATOR_CREDENTIAL neuter, code-unit sort. SURVIVED: request_hash switched to JSON.stringify (nothing binds the hash to canonicalJson at store level); success-path fill(0) removed (zeroing entirely unasserted — why F1 shipped).

## Clean areas

Secret hygiene: 11-table dump in four encodings, zero secret/pepper hits; error paths clean; no command body carries a secret. Section 8.3: replay byte-identical, conflict full rollback, commit precedes handoff, 10x concurrency yields exactly one plaintext. Section 10 identity fixtures substantive except: credential shapes pinned as key-sets not byte fixtures; normalization-order fixtures absent (= F2). Scope/regression clean; three files temporarily mutated for testing were restored SHA-256-identical and disclosed.

## Residual risks accepted this slice

Wall-clock connect timing fixture owed at connect slice; CredMan adapter owed at CLI slice; single mutex acceptable until a read path exists; no agent_created audit kind (would need a migration); GCM cannot distinguish corrupted ciphertext from wrong passphrase (documented).

## Gating fix list (REJECT -> APPROVE)

1. F1: capture secret Buffer at allocation; zero on success AND every throw path; fixture forcing a mid-transaction throw asserts all-zero (kills mutant 7).
2. F2: store normalizes (NFC + trim) before hashing and persisting; real whitespace-variant replay fixture; persisted-bytes-equal-normalized-form fixture per Section 10.
3. F3: authenticate the kit header (GCM AAD) with params pinned by formatVersion and header documented as authenticated-but-advisory.
4. F4: bounded credential-bucket map with eviction that cannot drop locked-out entries.
5. Store-level fixture binding request_hash to canonicalJson via permuted-key replay (kills mutant 2).

F5-F9 recommended, non-gating.
