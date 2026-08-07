# G1R Receipt - TORQCLAW Collaboration Substrate - Slice 1 Scope Review

- Date: 2026-08-07
- Reviewer: independent Opus instance (G1R role per operator routing policy of 2026-08-07)
- Review object: G1D implementation scope for Slice 1 (identity), against PRD v0.14 Sections 4.2, 5.1-5.2, 6.1-6.4, 7.4, 8.1, 8.3, 9, 10, on Slice 0 substrate `1c48ca5`
- Verdict: `REVISE-SCOPE` (2 Critical, 3 High, 3 Medium, 2 Low) — re-review waived if all ten revisions land as scope text before build

## Findings (summary)

- **C1** `crypto.timingSafeEqual` throws on length mismatch (probed, Node 22.19.0): malformed tokens would escape as exceptions instead of `AUTH_FAILED`, re-opening the credential-existence oracle the Section 6.1 decoy exists to kill. Revision: assert 32-byte operands, route parse failures through the decoy path, no throw escapes verify().
- **C2** KDF undeployable as scoped (probed): `@node-rs/argon2` not installed; scrypt N=131072,r=8 needs 128 MiB versus Node's 32 MiB default `maxmem`. Highest consequence: lands on the recovery kit, whose loss is unrecoverable by design. Revision: resolve KDF now, pin explicit `maxmem`, self-describing kit format version, round-trip fixture built FIRST.
- **H1** Hashing the raw body (not the post-normalization, post-trim persisted bytes) yields spurious `IDEMPOTENCY_CONFLICT` on the exact lost-first-response retry path the PRD protects. Revision: hash what is persisted; pin a whitespace-variant equivalence fixture.
- **H2** No canonical JSON serializer exists in Slice 0 and "key-sorted" is under-specified (code-unit vs code-point order diverges above the BMP). Revision: exported `canonicalJson()` with code-point sort and pinned escape form, byte-fixtured, sole hash input.
- **H3** Same-state fresh-key rule scoped only for RESTORE; `REVOKE_AGENT` repeat is guaranteed-reachable and must pin `revokedCredentialCount: 0` and zero audit rows. Revision: extend to all three transitions.
- **M1** Injected-RNG fixture collisions on the UNIQUE `secret_hmac` column must be an asserted invariant, not an uncaught constraint error. **M2** Unparseable tokens bucket to the address counter only, bounded map. **M3** Startup order pinned: pepper checks -> mode -> orphan closure only when healthy.
- **L1** JS strings cannot be zeroed: carry secrets as Buffers end-to-end, zero on success and rollback paths. **L2** `LAST_OPERATOR_CREDENTIAL` count runs inside the transaction after `BEGIN IMMEDIATE`.

## Explicit answers

- (a) SecretStore injection is sufficient for this gate; the CredMan adapter may ship as a stub that throws on get AND set — conditional on bootstrap refusing "healthy" over the in-memory store, with a fixture asserting the refusal.
- (b) SHA-256-over-canonical-JSON is sound once H1+H2 land; the frame layer neither normalizes nor canonicalizes, so the store layer owns both and must hash what it persists.
- (c) HMAC-operation-count equality (counter inside the HMAC wrapper) is the correct assertable property for this headless slice; the Section 10 wall-clock connect-path timing fixture remains OWED at the slice that ships connect.
- (d) Commit-before-handoff ordering is correct as scoped; residual: plaintext lives in memory across the transaction, so the rollback path must also zero it, and the sequencer mutex must not be held across the handoff.
- (e) Four silent narrowings found: H3; missing `credential_created`/`credential_revoked` audit rows for all four credential commands; Section 9 validation 9 omitted (storage-level operator-authority backstop — a defense-in-depth hole in a headless slice); rotation-induced session closure under-pinned (`credential_revoked` reason, other-credential sessions survive).

All ten revisions were accepted by G1D and folded into the builder scope verbatim on 2026-08-07.
