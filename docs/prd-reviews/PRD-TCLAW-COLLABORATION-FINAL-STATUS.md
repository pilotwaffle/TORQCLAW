# TORQCLAW Collaboration Substrate - Review Status

**Date:** 2026-08-06
**Canonical candidate:** `PRD-TCLAW-COLLABORATION-SUBSTRATE-001-v0.10.md`
**Last completed independent review:** Cycle 9, v0.9 at `8348ae2`, by `claude-opus-5`
**Last G1R verdict:** `REJECT` (Critical 0, High 2, Medium 4, Low 3)
**Builder handoff:** `BLOCKED pending v0.10 G1R`
**Consistency pre-gate (current):** `PASS 107/107` (2026-08-06, report: `PRD-TCLAW-COLLABORATION-V0.10-CONSISTENCY-REPORT.md`)

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
| next | v0.10 | Pre-gate PASS 107/107; G1R pending | unknown | unknown | closes all 9 Cycle 9 findings; Slice 0 pivot on clean verdict |

## Historical evidence

The following artifacts are historical only and must not be cited as current pre-gate evidence:

- `PRD-TCLAW-COLLABORATION-V0.4-CONSISTENCY-REPORT.md` (34/34, superseded)
- `PRD-TCLAW-COLLABORATION-V0.5-CONSISTENCY-REPORT.md` (40/40, superseded)
- `PRD-TCLAW-COLLABORATION-V0.6-CONSISTENCY-REPORT.md` (49/49, superseded)
- `PRD-TCLAW-COLLABORATION-V0.7-CONSISTENCY-REPORT.md` (67/67, superseded)
- `PRD-TCLAW-COLLABORATION-V0.8-CONSISTENCY-REPORT.md` (84/84, superseded)
- `PRD-TCLAW-COLLABORATION-V0.9-CONSISTENCY-REPORT.md` (97/97, superseded)

The current authoritative pre-gate evidence is `PRD-TCLAW-COLLABORATION-V0.10-CONSISTENCY-REPORT.md` (107/107). A consistency PASS proves internal consistency only, never protocol feasibility or semantic correctness; the independent G1R remains the approval gate.

## Decision

Do not implement from v0.1-v0.6. v0.7 closes all 13 Cycle 6 handoff conditions: encoded-size message bounds with control-character bans, per-channel `channel_seq` wire cursors (global `seq` never exposed), exact per-write lock discipline, serialization-based idempotency without the unreachable contention branch, credential expiry removed from v1, three new credential error codes with per-command mappings, passphrase-authenticated operator revocation, generalized pagination frame rule, defined `highWaterCursor` scope and cursor lifecycle, name character-class restrictions, a named accountable risk owner, and the audit index. It is not builder-ready until an independent G1R of the pinned v0.7 commit reports no Critical or High finding.
