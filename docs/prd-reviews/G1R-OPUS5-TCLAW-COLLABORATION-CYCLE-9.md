# G1R Receipt - TORQCLAW Collaboration Substrate - Cycle 9

- Date: 2026-08-06
- Reviewer model: `claude-opus-5`
- Reviewer role: independent G1R
- Reviewed commit: `8348ae2`
- Reviewed artifact: `docs/prd-reviews/PRD-TCLAW-COLLABORATION-SUBSTRATE-001-v0.9.md`
- Consistency evidence: `PASS 97/97` (internal consistency only)
- Verdict: `REJECT`
- Critical: 0
- High: 2
- Medium: 4
- Low: 3
- Builder handoff: `BLOCKED`

Reviewer verification note: all four pinned message byte fixtures compute exactly as stated (16,384/16,385 ASCII; 8,192 LF encoding to 16,384; 8,192 x U+0065 U+0301 post-NFC 16,384; 8,192 x U+0344 post-NFC 32,768 — U+0344 confirmed decomposing to U+0308 U+0301). Frame arithmetic, the flag matrix (6 valid / 10 invalid), and lock-class ordering all hold.

## Findings

### Critical

None.

### High

**Removal-window count oracle survives on three authorized success paths, contradicting the PRD's own stated guarantee**

Sections: 7.4 (ack bound, `highWaterCursor`), 7.3 (`nextCursor` on empty page), 5.3, 9 validation 5, 10.

Impact: Section 7.4 asserts "the response never discloses committed counts inside intervals the caller cannot see." The defined mechanism does not achieve this. The caller-visible ack bound returns an absolute per-channel sequence number in both branches, and `channel_seq` is dense and consecutive per channel — density converts a sequence number into a count. Scenario: agent A last saw seq 5, is removed (`member_removed` at 6), 14 private messages commit (7-20), A is re-added (`rejoined_seq` 20, `member_added` at 21). Three success paths disclose the hidden interval size: (1) `ACK_CHANNEL_CURSOR` binary search against `CURSOR_OUT_OF_RANGE` finds the bound 21 in about 15 requests, giving 21 - 5 - 1 = 15 hidden events; (2) `SUBSCRIBE_CHANNEL` returns `highWaterCursor` 21 directly; (3) `GET_CHANNEL_TIMELINE {afterCursor:0}` on an empty post-re-add page returns `nextCursor` "20", disclosing `rejoined_seq` verbatim per the Section 7.3 empty-page rule. The timeline clamp correctly protects hidden event content, so this is a metadata/count leak (High, not Critical) — but it violates a stated invariant on authorized success paths, and the Section 10 bullet claiming no ack-response count leak is unsatisfiable against the specified mechanism.

Concrete correction: make caller-visible cursors relative to the caller's authorized interval, or — more cheaply — delete the non-disclosure claim in Section 7.4 and the corresponding Section 10 acceptance bullet, stating explicitly whether absolute `channel_seq` values may reach a principal across a membership gap. Whichever path is chosen, Sections 7.3, 7.4, and 10 must agree and Section 10 must pin a satisfiable fixture.

**Subscription close-frame delivery under the authorization write lock is unspecified, leaving a self-deadlock or an invariant violation as an implementer coin-flip**

Sections: 8.2, 8.3, 5.4, 8.1.

Impact: Authorization mutations hold the write lock "through commit, subscription closure, and queue purge"; every socket write must acquire the read lock; close reasons are client-observable per Sections 8.1/5.4. The PRD never says whether communicating a close reason is a socket write. If it is, the archive path's close-frame write requests the read lock while the same thread holds the write lock — a writer-preferring, non-upgradeable lock deadlocks, hanging the gateway. If instead the transport closes without a frame, clients cannot distinguish `channel_archived` from `socket_closed`, defeating the close-reason registry and the two archive/unarchive close-reason fixtures that require observability. Two competent teams build incompatible systems; one ships a deadlock.

Concrete correction: exempt subscription close notification from the per-write read-lock rule: under the write lock, mark the subscription closed with its reason and purge its queue; enqueue the close frame to a post-lock delivery step that runs after release with no revalidation. State the close frame is the final frame on the subscription. Alternatively declare the close transport-level and amend Sections 8.1, 5.4, and the Section 10 fixtures.

### Medium

**`LIST_CHANNELS` predicate is `BASE`, but its membership filter lives only in Section 7.4 prose**

Sections: 4.2, 7.4.

Impact: Section 8.2 says commands validate only the mapped predicate; the mapped predicate for `LIST_CHANNELS` is bare `BASE`, and the active-membership filter appears only as Section 7.4 prose. A literal implementer enumerates every channel to any authenticated agent, defeating hidden-channel indistinguishability.

Concrete correction: add a `CHANNEL_ENUMERABLE` predicate ("`BASE`; results restricted to channels where the calling principal holds an active membership") to the Section 4.2 table and map `LIST_CHANNELS` to it.

**Section 15 reference harness client count contradicts its own writer-preference sub-condition**

Sections: 15.

Impact: The configuration pins 10 concurrent clients while the writer-preference condition requires 25 concurrent readers; both cannot be satisfied from one stated configuration, so benchmark sign-off is ambiguous.

Concrete correction: state two load phases: 10 clients for baseline measurements; 25 readers plus one held slow consumer for the writer-preference measurement, with per-phase observation and warm-up rules.

**Rate-limit lockout on a shared normalized address can lock out the operator, with no stated exemption**

Sections: 6.2, 5.1, 6.4.

Impact: On a single-machine install, an agent retry loop with a stale credential trips the 20-per-address threshold and locks the operator's own loopback connects out for 15 minutes, indistinguishably reported as `AUTH_FAILED`, with no in-band remedy.

Concrete correction: exempt loopback from the address-level counter (retaining the per-credential counter), or partition counters per connection role; add a doctor check reporting active lockouts.

**`credentialAvailable:false` is specified as a result field but omitted from the first-response shape contract**

Sections: 7.4.

Impact: The union signature never states which shape appears when, whether the first response carries `credentialAvailable:true`, or whether `credential` and `credentialAvailable` are mutually exclusive; with unknown-field rejection, a schema-validating client may reject a legitimate first response.

Concrete correction: pin both shapes with the rule that `credential` is present if and only if `credentialAvailable` is true, and add a byte fixture for each.

### Low

**Section 5.2 epoch rule is phrased as an exception that reads as self-contradictory**

Sections: 5.2. Correction: split into initialization value plus increment rule.

**`CHANNEL_ARCHIVED` versus `COLLAB_NOT_FOUND` precedence for owner-invoked membership mutation is stated in two places with different emphasis**

Sections: 4.2, 7.6. Correction: state that authorization resolves first with `COLLAB_NOT_FOUND`, and only predicate-passing callers can observe `CHANNEL_ARCHIVED`.

**Doctor's orphan-binding check has no stated remediation**

Sections: 9, 13. Correction: startup closes stale bindings with `socket_closed` and doctor reports the count.

## Rubric score

| Criterion | Result | Basis |
|---|---|---|
| 1. Problem, target user, measurable outcome | Pass | Ten falsifiable release conditions; revocation guarantee correctly bounded to write initiation. |
| 2. Scope and non-goals | Pass | Exclusions each require a separate PRD; supersession tracked explicitly. |
| 3. Flows, edge cases, acceptance criteria testable | Partial | Byte pins verify exactly, but the removal-window count bullet is unsatisfiable and the close-reason fixtures depend on undefined close-frame delivery. |
| 4. Functional and non-functional requirements | Partial | Concrete throughout, but `LIST_CHANNELS` authorization is split between table and prose and the credential response shape is underspecified. |
| 5. Assumptions, risks, owners, deadlines | Pass | Named accountable individual with date and delegation rules. |
| 6. Analytics, rollout, rollback, support | Pass | Verified 6-valid/10-invalid flag matrix; non-destructive default rollback; typed-confirmation destructive path. |
| 7. Feasible independently verifiable slices | Pass | Five cumulative, sequentially gated slices. |

Total: 5 Pass, 2 Partial, 0 Fail. Blocked by 2 High findings under the stated verdict rule.

## Builder handoff conditions

1. Eliminate the removal-window count oracle on all three disclosure paths, or delete the non-disclosure claim and its acceptance bullet, with Sections 7.3, 7.4, and 10 in agreement and a satisfiable pinned fixture.
2. Specify subscription close-frame delivery relative to the write lock: post-lock delivery step, or transport-level close with amended fixtures.
3. Move the `LIST_CHANNELS` membership filter into a named Section 4.2 predicate.
4. Reconcile the Section 15 client count with the 25-reader writer-preference sub-condition via explicit load phases.
5. Exempt loopback (or partition by role) from the address-level lockout; add a doctor lockout report.
6. Pin both credential-response shapes with an explicit presence rule and byte fixtures.

Items 1 and 2 are the High findings and are individually blocking. Items 3-6 are Medium and should be resolved in the same revision. The three Low findings may be dispositioned during implementation.
