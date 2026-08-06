# G1R Receipt - TORQCLAW Collaboration Substrate - Cycle 8

- Date: 2026-08-06
- Reviewer model: `claude-opus-5`
- Reviewer role: independent G1R
- Reviewed commit: `3e53e75`
- Reviewed artifact: `docs/prd-reviews/PRD-TCLAW-COLLABORATION-SUBSTRATE-001-v0.8.md`
- Consistency evidence: `PASS 84/84` (internal consistency only)
- Verdict: `REJECT`
- Critical: 0
- High: 4
- Medium: 3
- Low: 2
- Builder handoff: `BLOCKED`

## Findings

### Critical

None.

### High

**1. Section 10's mandated normalization fixture is arithmetically impossible to satisfy; the acceptance criterion contradicts the Section 7.1 bound it is meant to prove.**

Sections: 7.1, 10

Impact: Section 10 requires "normalization-order fixtures reject 8,192 repetitions of U+0344 and accept 8,192 repetitions of U+0065 U+0301". Executed: 8,192 repetitions of U+0065 U+0301 normalize under NFC to 8,192 U+00E9 scalars = 16,384 UTF-8 bytes, which passes the raw bound. But Section 7.1 also requires the encoded JSON string form (including surrounding quotes) be at most 16,384 bytes. U+00E9 needs no escaping, so the encoded form is 16,384 + 2 quote bytes = 16,386 bytes, exceeding the encoded bound by exactly the two quotes. Section 7.1 therefore mandates `INVALID_REQUEST` for the exact input Section 10 mandates be accepted. The consistency linter passed this because it compares literals and never models the encoding interaction.

Concrete correction: Change the Section 10 fixture to "accept 8,191 repetitions of U+0065 U+0301 (16,382 raw bytes, 16,384 encoded) and reject 8,192 repetitions (16,384 raw, 16,386 encoded)". Keep the U+0344 rejection case, which is correct (it expands to 32,768 bytes).

**2. The encoded-form bound makes the stated "1-16,384 UTF-8 bytes" message upper limit unreachable, so the "largest legal message" fixture and the "all message validators enforce 16,384 bytes" criterion are undefined.**

Sections: 7.1, 10

Impact: Because the encoded bound of 16,384 bytes includes the two surrounding quotes, no message whose encoded form has zero escapes can exceed 16,382 raw bytes. ASCII at n=16,383 encodes to 16,385 and is rejected; n=16,382 encodes to exactly 16,384 and is accepted. The advertised raw ceiling of 16,384 is unreachable by any input. Section 10 requires a fixture accepting "the largest legal message" and separately asserts "all message validators enforce 16,384 bytes". Two implementers will pin different byte-exact fixtures, both citing the PRD. The encoded bound strictly dominates the raw bound for every legal input, making the raw bound decorative.

Concrete correction: State the two bounds so both are reachable. Either raise the encoded bound to 16,386 (raw 16,384 plus quotes) so the raw bound binds, or restate the raw bound as 16,382 and note the encoded bound is the binding constraint. Pin the "largest legal message" fixture to the resulting exact value and replace the ambiguous "all message validators enforce 16,384 bytes" line with both numbers.

**3. `rejoined_seq` capture point is undefined, and Section 5.3 and Section 10 select opposite readings — a newly added member either does or does not see its own `member_added` event.**

Sections: 5.3, 8.3, 9, 10

Impact: Section 5.3 defines `rejoined_seq` as "the channel's greatest committed `channel_seq` at the instant of each effective add transition, set inside the same transaction as the `member_added` event". Section 8.3 step 6 assigns the event's `channel_seq` as one greater than the channel's greatest committed `channel_seq`. Both evaluate "greatest committed" inside the same uncommitted transaction. Traced: operator creates a channel (`channel_created` at seq 1), adds agent A; `member_added` gets seq 2. If `rejoined_seq` is captured before the event insert it is 1 and A sees its own join event (2 > 1); if after, it is 2 and A never sees it, with the clamp silently starting A's timeline at 3. Section 10's re-add test uses the half-open interval (N, M], excluding M from delivery — asserting the second reading — while Section 5.3's "committed" asserts the first. Two conforming implementations produce different timelines and the byte-pinned fixtures will not match.

Concrete correction: State the capture point normatively in Section 5.3 with a worked example, and make Section 10 agree. Recommended: capture `rejoined_seq` as the greatest committed `channel_seq` before inserting `member_added`, so a member always sees the event announcing its own membership; correct Section 10's interval to (N, M) and add a fixture asserting a first-time member's timeline from afterCursor 0 begins with its own `member_added` event.

**4. `ACK_CHANNEL_CURSOR`'s range check is scoped to the whole channel rather than to the caller, creating an event-count oracle over intervals the caller is explicitly not authorized to see.**

Sections: 5.3, 7.4, 9

Impact: Section 7.4 rejects a cursor "beyond the greatest committed `channel_seq` in that channel" — not caller-scoped, unlike the adjacent `highWaterCursor` definition. Concrete attack: agent A, removed at seq 50 and re-added at 400, binary-searches `ACK_CHANNEL_CURSOR` values against `CURSOR_OUT_OF_RANGE` and learns the channel's exact committed event count in roughly ten requests — including activity inside its removal window, which Section 5.3 guarantees it never receives. The same oracle tells a newly added member how many events predate its join. This is a success-path leak to an authorized caller that weakens the interval-scoping invariant. Section 9 validation 5's "submitted sequence visibility" is undefined and could mean either bound.

Concrete correction: Scope the ack bound to the caller: reject when the submitted cursor exceeds the greatest committed `channel_seq` visible to the calling principal (at or above its `rejoined_seq`). Define "submitted sequence visibility" in Section 9 validation 5 to the same predicate, and add a Section 10 fixture proving no committed-count oracle exists across a removal window.

### Medium

**5. Archiving an already-archived channel (and unarchiving an already-active one) is undefined behavior with no mapped response.**

Sections: 4.2, 5.4, 7.4, 7.6

Impact: Section 5.4 states no idempotence rule and no illegal-transition rule, unlike Sections 5.2 and 5.3. A fresh-key `ARCHIVE_CHANNEL` against an archived channel passes `CHANNEL_OWNER` ("channel may be active or archived") and reaches step 8 with no defined outcome: success-unchanged, `CHANNEL_ARCHIVED`, or a duplicate event. There is no channel-transition error in the exhaustive registry. "Every effective transition increments `channel_epoch`" implies ineffective transitions exist without defining them.

Concrete correction: Add to Section 5.4: "Archiving an archived channel and unarchiving an active channel are no-ops that return the current `{channelId, state, channelEpoch}` with success, increment no epoch, and emit no event." Add the Section 4.2 row and a Section 10 fixture.

**6. "Sequencer mutex where required" is undefined for four of the five read-path commands, leaving `ACK_CHANNEL_CURSOR`'s durable read-modify-write unprotected.**

Sections: 8.3, 7.4, 9

Impact: The predicate "required" is never defined. `ACK_CHANNEL_CURSOR` performs a durable write implementing `max(existing, submitted)` yet sits outside the keyed atomic protocol. Concrete failure: one principal acks cursors 90 and 40 concurrently from two sessions; if `max` is computed in application code across separate read and write steps, interleaving leaves the stored cursor at 40, violating the required cursor-monotonicity fixture. `UNSUBSCRIBE_CHANNEL`, which mutates the mutex-protected subscription registry, is likewise unlisted.

Concrete correction: Replace "where required" with an explicit per-command table: mutex for `SUBSCRIBE_CHANNEL`, `ACK_CHANNEL_CURSOR`, and `UNSUBSCRIBE_CHANNEL`; none for `LIST_CHANNELS` and `GET_CHANNEL_TIMELINE`. Specify the `max` is computed in SQL within the transaction.

**7. Authorization read/write lock fairness is unspecified, so the Section 15 revocation latency bound rests on an unstated implementation assumption and its benchmark does not exercise the failure mode.**

Sections: 8.2, 8.3, 15

Impact: Per-write read-lock holds are bounded, but nothing bounds arrival rate. Node.js has no built-in RW lock and library implementations differ on writer preference. With a reader-preferring lock and many subscriptions, a pending `REVOKE_AGENT` write-lock acquisition can be starved indefinitely by arriving readers, breaking the 150 ms revocation bound. The Section 15 harness measures queue depth (one slow consumer), not reader arrival rate — the actual starvation mechanism. Fairness words appear nowhere in the document.

Concrete correction: Specify the authorization lock as writer-preferring (pending writer blocks new readers). Add a Section 15 measurement under sustained high reader-arrival rate and a Section 10 bounded write-lock wait test under continuous fan-out.

### Low

**8. Section 19 undercounts the valid feature-flag configurations, so the definition of done omits a permitted deployment shape.**

Sections: 11, 19

Impact: UI requires CHANNELS, not LIVE, so six configurations are valid: all-off; IDENTITY; IDENTITY+CHANNELS; IDENTITY+CHANNELS+LIVE; IDENTITY+CHANNELS+UI; all-on. Section 19's "five valid cumulative flag configurations" silently drops IDENTITY+CHANNELS+UI, which startup validation accepts — that configuration ships ungated.

Concrete correction: Change Section 19 to six enumerated configurations, or add UI-requires-LIVE to Section 11 if a linear chain was intended. State the invalid count (ten of sixteen) for the startup-rejection criterion.

**9. Section 9's "only production writer" claim is literally false for the offline CLI paths.**

Sections: 9, 5.1.1, 6.4

Impact: `revoke-operator` and `recover-operator` write these tables. Both run with the gateway stopped under an exclusive lock, so there is no concurrency defect — but the unqualified sentence is the stated premise for the no-contention argument in Section 8.3, and an auditor finds a counterexample in the same document.

Concrete correction: Qualify: "the only writer while listeners are open; the Section 5.1.1 and 6.4 offline CLI paths write only with the gateway stopped under an exclusive lock."

## Rubric score

| Criterion | Result | Basis |
|---|---|---|
| 1. Problem, target user, measurable outcome explicit | Pass | Section 2 names one operator, one install, ten falsifiable release proofs. |
| 2. Scope and non-goals prevent ambiguous expansion | Pass | Section 3.2 exclusions each require a separate PRD; Section 14 lints for excluded features. |
| 3. User flows, edge cases, acceptance criteria testable | Fail | Finding 1 mandates an unsatisfiable fixture; findings 2, 3, and 5 leave byte-exact fixtures undeterminable. |
| 4. Functional and non-functional requirements | Partial | Sections 9, 12, 13, 15 unusually complete; finding 4 is a success-path authorization leak and finding 7 leaves the revocation bound resting on unstated lock discipline. |
| 5. Assumptions, risks, owners, deadlines visible | Pass | Section 16 names an accountable individual with a date for all eight risks. |
| 6. Analytics, rollout, rollback, support proportionate | Partial | Strong contracts; finding 8 leaves one permitted flag configuration outside the definition of done. |
| 7. Implementation slices feasible and independently verifiable | Partial | Slices are cumulative and sequentially gated, but slice 4's lock contract is underdetermined by findings 6 and 7. |

Total: 3 Pass, 3 Partial, 1 Fail.

## Builder handoff conditions

1. Reconcile the Section 7.1 raw-byte and encoded-JSON message bounds so both are reachable, and restate the Section 10 normalization fixture with values satisfying both; pin largest-legal and smallest-illegal messages to exact byte counts. (Findings 1-2)
2. Define the `rejoined_seq` capture point normatively with a worked example and align Section 10's re-add interval test. (Finding 3)
3. Scope the `ACK_CHANNEL_CURSOR` range check to the caller's visible range, define "submitted sequence visibility" to the same predicate, and add the no-oracle fixture. (Finding 4)
4. Define no-op archive/unarchive behavior with the Section 4.2 row and fixture. (Finding 5)
5. Replace "sequencer mutex where required" with an explicit per-command table and specify SQL-computed max. (Finding 6)
6. Specify the authorization lock as writer-preferring with a reader-arrival-rate measurement and bounded-wait test. (Finding 7)
7. Correct the flag-configuration count to six (or add UI-requires-LIVE). (Finding 8)
8. Qualify the "only production writer" sentence for the offline CLI paths. (Finding 9)
9. Extend the linter with a cross-constraint check evaluating the arithmetic interaction of the raw and encoded message bounds against every byte-count literal in Section 10.

Conditions 1-3 close the High findings and are required for READY; 4-9 should be closed in the same revision.
