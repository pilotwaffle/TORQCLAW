# TORQCLAW Collaboration Substrate - Review Status

**Date:** 2026-08-06
**Canonical candidate:** `PRD-TCLAW-COLLABORATION-SUBSTRATE-001-v0.6.md`
**Last completed independent review:** Cycle 5, v0.5 at `f851aae`, by `gpt-5.6-terra`
**Last G1R verdict:** `REJECT` (Critical 0, High 2, Medium 1, Low 1)
**Builder handoff:** `BLOCKED pending v0.6 G1R`
**Consistency pre-gate (current):** `PASS 49/49` (2026-08-06, report: `PRD-TCLAW-COLLABORATION-V0.6-CONSISTENCY-REPORT.md`)

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
| next | v0.6 | Pre-gate PASS 49/49; G1R not run | unknown | unknown | |

## Historical evidence

The following artifacts are historical only and must not be cited as current pre-gate evidence:

- `PRD-TCLAW-COLLABORATION-V0.4-CONSISTENCY-REPORT.md` (34/34, superseded)
- `PRD-TCLAW-COLLABORATION-V0.5-CONSISTENCY-REPORT.md` (40/40, superseded)

The current authoritative pre-gate evidence is `PRD-TCLAW-COLLABORATION-V0.6-CONSISTENCY-REPORT.md` (49/49). A consistency PASS proves internal consistency only, never protocol feasibility or semantic correctness; the independent G1R remains the approval gate.

## Decision

Do not implement from v0.1-v0.5. v0.6 contains the complete known remediation set across all five cycles plus both source audits. It is not builder-ready until an independent G1R of the pinned v0.6 commit reports no Critical or High finding.
