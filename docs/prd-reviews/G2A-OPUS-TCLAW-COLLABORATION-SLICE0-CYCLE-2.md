# G2A Receipt - TORQCLAW Collaboration Substrate - Slice 0, Cycle 2

- Date: 2026-08-07
- Auditor model: Opus 4.8 (G2A / final verifier per operator routing policy)
- Audited artifact: Slice 0 fix pass (builder: Haiku 4.5 under the 2026-08-06 contract) plus orchestrator test-strengthening edits, against PRD v0.14
- Verdict: `APPROVE` (initial Cycle 2 pass: REJECT on the test-strengthening condition alone; follow-up confirmed closure)
- Production defects remaining: 0 Critical, 0 High
- Suite at approval: collab subset 110/110; full suite 1101/1101 warm (one known load-dependent timing flake in `tests/failover/phase1-performance.test.ts`, passes 6/6 in isolation; cold-start failover timeouts are a documented pre-existing flake)

## Cycle 2 initial pass (fix-pass verification)

All eight Cycle 1 production-code conditions verified CLOSED by independent probes:

1. Escape parity: fresh 5,000-frame seeded fuzz, 0 false positives; 20/20 hostile cases (trailing escaped backslash, escaped-quote duplicate keys, same key at different depths, 60-deep nesting, `a`-vs-literal duplicate detection).
2. Non-finite detection: `9e308`, `2e308`, `-9e308`, 1+400 zeros, `1e309` all reject; `1e308`, `-1e308`, `1e-320`, `5e-324`, `0`, `-0` accept; walk reaches nested structures; duplicate-key detection precedes it.
3. UUID generator: auditor-seeded 1,000,000 UUIDs, 0 duplicates, 0 malformed; version/variant nibbles correct; all 30 free hex positions full 0-f coverage, worst chi-square 23.3 (df=15) — no detectable bias; PCG output permutation verified to launder LCG low-bit periodicity; cross-process same-seed reproducibility.
4. Seed derivation: FNV-1a 64; the Cycle 1 collision pair diverges at UUID 0; 0 first-UUID collisions across 20,000 random seeds.
5. Text: message text never trimmed (v0.14); all-LF fixture accepted at encoded 16,384; test source literal verified to contain real decomposed U+0065 U+0301; 8,192 x U+0344 rejects at post-NFC 32,768; names still trim; control bans and NFC intact (regression hunt clean).
6. Migration: re-run is a true no-op (byte-identical `sqlite_master`, single version row); rollback intact; DDL byte-identical to v0.14 Section 9 including `collab_schema_migrations`.
7. Test strengthening: initially NOT CLOSED — frame bound had no boundary pin (mutants 65,536→70,000 and >→>= survived); fold version tests were shams asserting the opposite of their titles (version-check-deleted mutant survived).
8. Fold version assertion: implementation correct; coverage arrived with the follow-up.

## Follow-up (test-strengthening closure) — APPROVE

Orchestrator edits confined to `packages/collab/src/fold.ts` (exported pure `checkFoldHeaderVersion`, anchored regex), `tests/collab/fold.test.ts` (real version assertions), `tests/collab/frame.test.ts` (byte-counted 65,536/65,537 killer pair; escape-heavy fuzz alphabet in string leaves and object keys). Auditor re-ran its own mutants independently:

- bound 65,536 → 70,000: **killed**;
- `> 65536` → `>= 65536`: **killed**;
- version check deleted: **killed**;
- regex unanchored: **killed** (auditor's first mutant run was a shell-escaping no-op, corrected and disclosed).

Fuzz corpus re-characterized: 2,000/2,000 frames now contain escaped backslashes, 1,998/2,000 escaped quotes, 2,000/2,000 non-ASCII (previously zero of each). Cycle 2 Low finding 4 (unanchored regex) closed; Low finding 3 (cosmetic escape-error message) withdrawn as a blocker and accepted for Slice 0 on the record.

## Accepted residual risks (on the record)

- Cosmetic: malformed escape sequences report a duplicate-key-scanner message (correct code and type).
- `migration.ts` `applied_at` uses wall clock, outside the determinism harness — revisit only if migration rows ever enter byte fixtures.
- UUID PRNG `rot === 0` correctness relies on JS shift-count masking; an explicit branch would be port-robust.

## Provenance note

The original pinned commits for the document-review era (for example `201c972`, `b49d882`, `3bcf768`) were preserved on `backup/pre-sync-2026-08-07` when master was rebased on 2026-08-07; the same commits exist on master under new hashes (v0.13 = `2cb1099`, v0.14 = `0e9c83e`). All receipt SHA references remain resolvable via the backup branch.
