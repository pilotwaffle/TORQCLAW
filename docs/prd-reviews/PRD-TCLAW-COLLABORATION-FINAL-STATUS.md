# TORQCLAW Collaboration Substrate - Review Status

**Date:** 2026-08-06
**Canonical candidate:** `PRD-TCLAW-COLLABORATION-SUBSTRATE-001-v0.14.md` (v0.13 plus two G2A-surfaced contract corrections: names-only trimming; ratified `collab_schema_migrations`)
**Last completed independent review:** Cycle 12, v0.12 at `201c972`, by `claude-opus-5`
**Last G1R verdict:** `REJECT` (Critical 0, High 2, Medium 4, Low 3) — all nine handoff conditions closed in v0.13
**Builder handoff:** `AUTHORIZED — operator decision 2026-08-06: Slice 0 pivot; document G1R loop retired in favor of executable gates (builder Haiku 4.5, G2A Opus 4.8)`
**Consistency pre-gate (current):** `PASS 163/163` (2026-08-06, report: `PRD-TCLAW-COLLABORATION-V0.14-CONSISTENCY-REPORT.md`)
**Slice 0 status:** `APPROVED by G2A (Opus 4.8) on 2026-08-07` — receipt `G2A-OPUS-TCLAW-COLLABORATION-SLICE0-CYCLE-2.md`. History: Cycle 1 build (Haiku 4.5) rejected 4C/3H/2L (`G2A-OPUS-TCLAW-COLLABORATION-SLICE0-CYCLE-1.md`); fix pass closed all eight production conditions; Cycle 2 initially rejected on test-strengthening alone; follow-up closed it with mutation-verified boundary and version tests. Suite at approval: 110/110 collab, 1101/1101 full (warm). Deliverables: `packages/collab` (migration, frame, text, fold, harness) + `tests/collab`.
**Provenance:** master was rebased 2026-08-07 (originals preserved on `backup/pre-sync-2026-08-07`); document-era pinned SHAs remain resolvable there; v0.13 = `2cb1099`, v0.14 = `0e9c83e` on current master.

Note: Cycle 6 was started by `gpt-5.6-terra`, which terminated on output limits mid-receipt; per operator instruction the cycle was re-run in full by `claude-opus-5`. The receipt is `G1R-OPUS5-TCLAW-COLLABORATION-CYCLE-6.md`. Terra's truncated partial output independently identified the same JSON-escape feasibility defect recorded as Critical 1.

## Outcome

Five review cycles progressively eliminated contradiction, completeness, and feasibility defects. Cycle 5 confirmed every Cycle 4 correction as properly specified and found two feasibility blockers: a timeline page bound that could not fit the protocol frame limit, and channel-name uniqueness that SQLite's ASCII-only `lower()` cannot enforce.

v0.6 closes all Cycle 5 findings:

1. One frame limit governs everything: a timeline page ends at 100 events or when the encoded result frame would exceed 64 KiB; the separate page byte bound is removed.
2. Channel-name uniqueness uses a persisted canonical `name_key` (NFC then Unicode Default Case Folding, pinned to Unicode 15.0, computed by `CollaborationStore`) with a unique active-key index as the concurrency backstop.
3. Archive delivery is deterministic: archive closes that channel's live subscriptions with subscription close reason `channel_archived`, purges unsent queues at the linearization point, and members resubscribe read-only with durable-backlog replay losing no committed event.
4. This status document is regenerated with historical evidence labeled.

The consistency linter gained cross-constraint feasibility checks (no encoded bound may exceed the frame bound) and the `name_key`/archive-contract requirements, growing from 40 to 49 checks.

## Review history

| Cycle | Input | Verdict | Critical | High | Notes |
|---|---|---:|---:|---:|---|
| 1 | v0.1 | Reject | 3 | 4 | authority, revocation, scope |
| 2 | v0.2 | Reject | 3 | 6 | recovery, protocol, migration |
| 3 | v0.3 | Reject | 0 | 5 | internal contradictions |
| 4 | v0.4 (`2f40e3a`) | Reject | 0 | 3 | authorization precedence, credential handling, atomicity |
| 5 | v0.5 (`f851aae`) | Reject | 0 | 2 | frame/page feasibility, Unicode name uniqueness |
| 6 | v0.6 (`cedae1f`) | Reject | 2 | 5 | encoded-size feasibility, global-cursor oracle, lock discipline, expiry, credential errors |
| 7 | v0.7 (`1d981da`) | Reject | 2 | 4 | caller-unscoped CHANNEL_OWNER (present since v0.4), removal-window replay, lock classes, NFC ordering |
| 8 | v0.8 (`3e53e75`) | Reject | 0 | 4 | first zero-Critical Opus cycle; bounds arithmetic, rejoined_seq capture point, ack oracle, lock details |
| 9 | v0.9 (`8348ae2`) | Reject | 0 | 2 | count oracle on success paths, close-frame lock delivery; rubric 5 Pass / 2 Partial / 0 Fail |
| 10 | v0.10 (`9fdc95b`) | Reject | 0 | 1 | sole High: fixture determinism harness (additive); reviewer refuted six hostile readings |
| 11 | v0.11 (`fe20293`) | Reject | 1 | 4 | regressions in new text: state-bearing WRITABLE predicate vs v0.10 precedence rule, re-add truncation, first-ack, rotation guard, fold-table sourcing |
| 12 | v0.12 (`201c972`) | Reject | 0 | 2 | latent epoch/lock-class holes: membership_epoch scope, RESTORE_AGENT semantics |
| 13 | v0.13 | No document G1R — Slice 0 pivot | — | — | operator decision 2026-08-06: all nine Cycle-12 conditions closed, pre-gate 159/159; verification moves to executable gates (fixtures, tests, linter) with G2A audit |

## Historical evidence

The following artifacts are historical only and must not be cited as current pre-gate evidence:

- `PRD-TCLAW-COLLABORATION-V0.4-CONSISTENCY-REPORT.md` (34/34, superseded)
- `PRD-TCLAW-COLLABORATION-V0.5-CONSISTENCY-REPORT.md` (40/40, superseded)
- `PRD-TCLAW-COLLABORATION-V0.6-CONSISTENCY-REPORT.md` (49/49, superseded)
- `PRD-TCLAW-COLLABORATION-V0.7-CONSISTENCY-REPORT.md` (67/67, superseded)
- `PRD-TCLAW-COLLABORATION-V0.8-CONSISTENCY-REPORT.md` (84/84, superseded)
- `PRD-TCLAW-COLLABORATION-V0.9-CONSISTENCY-REPORT.md` (97/97, superseded)
- `PRD-TCLAW-COLLABORATION-V0.10-CONSISTENCY-REPORT.md` (107/107, superseded)
- `PRD-TCLAW-COLLABORATION-V0.11-CONSISTENCY-REPORT.md` (119/119, superseded)
- `PRD-TCLAW-COLLABORATION-V0.12-CONSISTENCY-REPORT.md` (132/132, superseded)

The current authoritative pre-gate evidence is `PRD-TCLAW-COLLABORATION-V0.13-CONSISTENCY-REPORT.md` (159/159). A consistency PASS proves internal consistency only, never protocol feasibility or semantic correctness; the independent G1R remains the approval gate.

## Decision

Implement from v0.13 only. On 2026-08-06 the operator (King Flowers) closed the document-review loop: twelve G1R cycles eliminated the contradiction, completeness, feasibility, and leak defect classes, and the verdict then oscillated in the High band for four consecutive cycles on implementation-adjacent classes (lock-class assignment, epoch scoping, fixture pinning, benchmark apportionment) that executable artifacts settle mechanically. v0.13 closes all nine Cycle-12 conditions with lockstep linter enforcement (159 checks). Verification authority now transfers to Slice 0 executable gates — the conformance fixtures, deterministic tests, and consistency linter of Sections 10 and 14 — built by Haiku 4.5 and audited by Opus 4.8 as G2A. The Section 19 definition of done is unchanged except that its independent-review requirement is discharged by the G2A audit of built artifacts rather than a thirteenth document review.

Historical context (superseded): do not implement from v0.1-v0.6. v0.7 closed all 13 Cycle 6 handoff conditions: encoded-size message bounds with control-character bans, per-channel `channel_seq` wire cursors (global `seq` never exposed), exact per-write lock discipline, serialization-based idempotency without the unreachable contention branch, credential expiry removed from v1, three new credential error codes with per-command mappings, passphrase-authenticated operator revocation, generalized pagination frame rule, defined `highWaterCursor` scope and cursor lifecycle, name character-class restrictions, a named accountable risk owner, and the audit index. It is not builder-ready until an independent G1R of the pinned v0.7 commit reports no Critical or High finding.
