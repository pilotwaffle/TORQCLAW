# G1R Receipt - TORQCLAW Collaboration Substrate - Cycle 12

- Date: 2026-08-06
- Reviewer model: `claude-opus-5`
- Reviewer role: independent G1R
- Reviewed commit: `201c972`
- Reviewed artifact: `docs/prd-reviews/PRD-TCLAW-COLLABORATION-SUBSTRATE-001-v0.12.md`
- Consistency evidence: `PASS 132/132` (internal consistency only)
- Verdict: `REJECT`
- Critical: 0
- High: 2
- Medium: 4
- Low: 3
- Builder handoff: `BLOCKED`

## Findings (summary)

### Critical

None.

### High

1. **`ADD_CHANNEL_MEMBER` increments `membership_epoch` under the read lock, racing the per-write epoch-snapshot check and potentially killing healthy subscriptions** — Sections 4.2, 5.3, 8.1, 8.2, 8.3. The document never states whether `membership_epoch` is per-membership-row or per-channel, never binds `authorization_lost` to epoch comparison, and classes the add (which mutates an epoch that Section 8.2 revalidates) as a non-authorization mutation. Under a per-channel reading, adding member B disconnects member A's healthy subscription; the outcome is nondeterministic and untestable. Correction: scope the epoch to the membership row; subscriptions revalidate only their own row; move `ADD_CHANNEL_MEMBER` to the authorization-mutation lock class; add a subscription-survival fixture.
2. **`RESTORE_AGENT` epoch semantics are undefined where `BASE` depends on them** — Sections 5.2, 4.2, 8.1, 8.2, 8.3. Restore is an effective transition (epoch increments) run under the read lock, unserialised against `BASE` revalidation; no close reason covers a restore-driven session closure; whether a fresh-key same-state repeat increments is undefined; and half the Section 15 revocation-phase observations exercise this unspecified command. Correction: restore increments and closes sessions with new close reason `principal_restored`; move to the authorization-mutation class; define fresh-key same-state behavior; pin fixtures.

### Medium

1. Timeline fixture interaction unpinned: at most 3 maximum-size events fit one 64 KiB frame (computed: 4 events = 66,712 bytes), so the 100-event fixture needs pinned text content (e.g. 1-byte messages) and the frame-cut fixture must return exactly 3 events with `hasMore` true.
2. `LIST_CHANNELS` `hasMore` undefined for the frame-cut case; the Section 10 disjunctive fixture ("stays within the bound or paginates") passes either way and tests nothing. Correction: define `hasMore` like the timeline's and pin exact counts.
3. Section 4.1's "owned agents become ineffective even if their stored status is active" is unreachable given Section 5.1.1 closes all sessions and `locked_recovery` closes listeners. Correction: delete or pin its one reachable case.
4. Section 9 validation 5 cites the caller-visible cursor bound by reference and omits the `rejoined_seq` fallback branch; a member re-added at the channel head could ack its own `member_added` cursor when Section 7.4 forbids it. Correction: restate the two-branch bound inline; add the re-added-at-head fixture.

### Low

1. Vendored fold table: state that unmapped scalars map to themselves, applied per scalar left-to-right with no second NFC pass.
2. Section 15 revocation phase: apportion minimum observations per mutation kind (e.g. 300/300/100) so the floor cannot be met with one kind only.
3. Section 16: add decision deadlines, or gate Slice 2 on delegating or explicitly retaining the security-lead risk rows.

## Rubric score

| Criterion | Result | Basis |
|---|---|---|
| 1. Problem, target user, measurable outcome | Pass | Ten falsifiable release conditions. |
| 2. Scope and non-goals | Pass | Exclusions bound to separate PRDs. |
| 3. Testable flows, edge cases, acceptance criteria | Partial | Byte pins verify exactly, but three fixtures are not deterministically testable. |
| 4. Functional and non-functional requirements | Partial | Epoch scope and restore semantics undefined where Section 8.2 depends on them. |
| 5. Assumptions, risks, owners, deadlines | Partial | Owners named and dated, but no decision deadlines; accountability concentrated. |
| 6. Analytics, rollout, rollback, support | Pass | Nested flags, gated slices, safe rollback contracts. |
| 7. Feasible independently verifiable slices | Pass | Cumulative, sequentially gated; six pinned flag configurations. |

Total: 4 Pass, 3 Partial, 0 Fail.

## Builder handoff conditions

1. Scope `membership_epoch` to the membership row, bind subscription revalidation to the caller's own row with `authorization_lost` on mismatch, move `ADD_CHANNEL_MEMBER` to the authorization-mutation class, and add the subscription-survival fixture.
2. Define `RESTORE_AGENT` epoch/session semantics with new close reason `principal_restored`, move it to the authorization-mutation class, define fresh-key same-state behavior, and pin fixtures.
3. Pin exact text content and byte counts for the three timeline fixtures.
4. Define `LIST_CHANNELS` `hasMore` and replace the disjunctive fixture.
5. Resolve the unreachable Section 4.1 ineffective-agents clause.
6. Restate the two-branch cursor bound inline in Section 9 validation 5 with the re-added-at-head fixture.
7. State the unmapped-scalar fold rule.
8. Apportion revocation-phase observations per mutation kind.
9. Add Section 16 decision deadlines or a Slice 2 delegation gate.

Conditions 1-2 are the High findings and are blocking; 3-9 should close in the same revision.
