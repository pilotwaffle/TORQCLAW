# G2A Receipt - TORQCLAW Collaboration Substrate - Slice 0, Cycle 1

- Date: 2026-08-06
- Auditor model: Opus 4.8 (per operator model contract; G1R document loop retired at v0.13)
- Audited artifact: first Slice 0 build (builder: Haiku 4.5) — `packages/collab/src/*`, `tests/collab/*`, uncommitted working tree after PRD v0.13 (`b49d882`)
- Unit-test state at audit: 928/928 passing (40 files) — independently confirmed by the orchestrator before audit
- Verdict: `REJECT`
- Critical: 4
- High: 3
- Low: 2

Note: the audit run was interrupted once by a session usage limit and resumed with context intact; all Critical/High findings were empirically reproduced twice by independently written probes before reporting.

## Findings (summary)

### Critical

1. **`frame.ts` duplicate-key pre-scanner rejects the majority of valid JSON.** String termination looks back one character instead of tracking escape parity, so any string ending in an escaped backslash desynchronizes the scanner. Fuzz probes: 1,226/2,000 and 706/2,000 valid `JSON.stringify` frames rejected. Minimal repro: `{"type":"a","s":"ends\\"}` → `INVALID_FRAME`.
2. **`frame.ts` non-finite detection accepts genuine Infinity.** The `exponent > 308` heuristic ignores mantissa and digit count: `9e308`, `2e308`, and `1` followed by 400 zeros all parse to `Infinity` and are ACCEPTED; only the test-pinned `1e999` happens to reject.
3. **`text.ts` trims message text, making the PRD's pinned all-LF fixture unreachable.** `normalizeMessageText('\n'.repeat(8192))` → `INVALID_REQUEST` (empty after trim) where Section 10 requires ACCEPT. Root cause is a genuine v0.13 contract contradiction between Section 7.1 (trim-then-validate) and Section 10 (all-LF accept); escalated and resolved in PRD v0.14 (names-only trimming). The code must follow v0.14.
4. **`harness.ts` deterministic UUID generator collides.** State is re-derived per call from `seed ^ (counter * 73856093)` with a signed shift discarding entropy: 5 duplicates in 100,000 UUIDs (first at index 41,763), and `Math.abs(x) >>> 0` caps part1's first hex digit at 0-7, halving the reachable space. Colliding IDs violate `collab_events.id UNIQUE` in fixture runs.

### High

5. **`harness.ts` distinct fixture seeds collapse to identical sequences.** 32-bit `hash*31` plus `Math.abs` folding: seeds `fixture-87883` and `immaauae` produce byte-identical UUID streams, breaking Section 10 per-fixture seeding.
6. **`frame.ts` rejects valid small-magnitude numbers.** The exponent check ignores sign: `1e-320` (a finite denormal) → `INVALID_FRAME`.
7. **Test-suite meta-finding: the suite cannot detect findings 1-6.** Instances: the migration re-run test is tautological (try/catch accepts both outcomes; the second run actually throws `table principals already exists`, contradicting the test's title); the "U+0065 U+0301" fixture actually uses precomposed U+00E9; the all-LF fixture was replaced with `'a\n'.repeat(4096)`, sidestepping finding 3; the Turkish-I and no-second-NFC fold tests assert `toBeTruthy()`/mark-free inputs. Two mutations inferred (not machine-verified) to survive: raw-bound `>` → `>=` at 16,384, and frame bound 65,536 → 65,537-69,999.

### Low

8. **`migration.ts` adds `collab_schema_migrations`, absent from the Section 9 DDL.** Otherwise the DDL diff is byte-identical. Ratified into the contract in PRD v0.14 with exact shape and no-op re-run semantics.
9. **`fold.ts` version assertion is a substring test** (`includes('15.0')`); must be an exact-version match.

## Verified sound (empirical, do not re-litigate)

- Section 9 DDL byte-identical to the PRD apart from finding 8; all CHECKs, both partial unique indexes, FK enforcement, and all 7 named indexes verified against live SQLite, including 8/8 close reasons (`principal_restored` present) and 6/6 event kinds.
- Pragmas exact (foreign_keys=1, WAL, synchronous=FULL, busy_timeout=5000); failed migration rolls back cleanly.
- Fold table fully sound: exhaustive re-parse of all 1,530 C+F entries with 0 mismatches; T/S lines correctly excluded (Turkish I safe); F multi-scalar (U+00DF → ss); astral mappings; unmapped self-map; no second NFC pass; vendored file authentic Unicode 15.0.
- Clock exact (2026-01-01T00:00:00.000Z, +1 ms steps); no `Math.random`/`Date.now` in harness.
- Name scalar counting correct for astral characters (80 accept / 81 reject).
- Raw ASCII message bound 16,384/16,385 correct; encoded-form measurement correctly excludes surrounding quotes on post-NFC text.
- Scope discipline clean: no collab content in shared files; exactly 14 intended files; build artifacts gitignored; `tsc --noEmit` clean.

## Conditions (fix pass)

1. Frame scanner: escape-parity string termination + ≥2,000-frame `JSON.stringify` round-trip fuzz at 0% false positives.
2. Non-finite detection: post-parse recursive `Number.isFinite` walk (also fixes finding 6); pin `9e308`, `2e308`, 1+400 zeros as rejects and `1e308`, `1e-320` as accepts.
3. UUID generator: carry PRNG state, unsigned shifts, all 128 bits from advancing state; 0 duplicates in 1,000,000; full 0-f coverage per hex position.
4. Seed derivation: wide hash (FNV-1a 64 / SHA-256); regression test for the `fixture-87883`/`immaauae` collision.
5. Implement v0.14 names-only trimming; restore the true all-LF and decomposed-sequence fixtures.
6. Real migration re-run no-op (per v0.14 `collab_schema_migrations` semantics) with a non-tautological test.
7. Strengthen weak tests: exact frame-bound pins 65,536/65,537; exact-codepoint fold assertions.
8. Exact fold-table version assertion.
