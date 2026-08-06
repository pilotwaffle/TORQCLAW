# TORQCLAW Collaboration Substrate - Review Status

**Date:** 2026-08-06
**Canonical candidate:** `PRD-TCLAW-COLLABORATION-SUBSTRATE-001-v0.4.md`
**Last completed independent review:** v0.3 by `gpt-5.6-terra`
**Last G1R verdict:** `REJECT`
**Builder handoff:** `BLOCKED pending v0.4 G1R`
**Consistency pre-gate:** `PASS` (34/34 checks, 2026-08-06, report: `PRD-TCLAW-COLLABORATION-V0.4-CONSISTENCY-REPORT.md`)

## Outcome

The v0.3 gate found no Critical and five High issues. A subsequent source audit confirmed all five and found three additional blockers: missing principal lifecycle commands, event-kind/DDL incompatibility, and unrecoverable dual-pepper machine loss. It also identified five limit/code/idempotency conflicts.

v0.4 consolidates the PRD into one normative source and addresses the expanded remediation set. It is a candidate, not an approved builder handoff.

## Canonical remediation set

1. Operation-scoped authorization predicates.
2. Operator and agent role-bound connect frames.
3. Channel discovery and durable cursor acknowledgement.
4. Deterministic selected-credential rotation.
5. Executable additive DDL with session binding and mutation-result idempotency.
6. One authoritative benchmark in the PRD.
7. One consolidated source with displaced clauses explicitly superseded.
8. Agent suspend, restore, and terminal revoke commands.
9. Exact event-kind parity between protocol and DDL; no tombstone remnants.
10. Verified offline export for both peppers and recovery secret.

The consolidation also freezes one value for message size, page size, slow-consumer limits/code, authentication rate limits, and idempotency scope.

## Final hardening disposition

The post-consolidation audit found and closed:

- undefined operator-principal revocation;
- final-operator-credential self-lockout;
- rotation invalidating unrelated credential sessions through `auth_epoch`;
- undefined authentication, channel-name, and cursor-range errors;
- ambiguous cursor-acknowledgement idempotency;
- missing machine restore of both Credential Manager peppers;
- missing membership/credential access-path indexes;
- the stale `D.2` cross-reference.

Operator revocation is now offline and atomic. Final operator credential revocation is refused. Credential rotation closes only sessions using the replaced credential. Name reuse leaves the unarchive target unchanged and returns `CHANNEL_NAME_CONFLICT`.

## Review history

| Cycle | Input | Verdict | Critical | High |
|---|---|---:|---:|---:|
| 1 | v0.1 | Reject | 3 | 4 |
| 2 | v0.2 | Reject | 3 | 6 |
| 3 | v0.3 | Reject | 0 | 5 |
| next | v0.4 | Not run | unknown | unknown |

## Decision

Do not implement from v0.1-v0.3. v0.4 contains the complete known remediation set, but it is not builder-ready until its consistency pre-gate passes and an independent G1R reports no Critical or High issue.

## Consistency pre-gate implementation

The final specification pass adds startup pepper checks, an exhaustive close-reason registry, explicit idempotency classes, agent display-name validation, failed-mutation behavior, rate-lockout privacy, and mutation-results size reporting. The deterministic gate is implemented at `scripts/lint_collaboration_prd.py`; its generated report is the authoritative pre-gate evidence.

The pre-gate was executed on 2026-08-06 after a document-repair pass (see synthesis log, "Corruption incident and repair") and reports PASS with 34/34 checks. The generated report is `PRD-TCLAW-COLLABORATION-V0.4-CONSISTENCY-REPORT.md`. The sole remaining gate is an independent G1R with no Critical or High findings.
