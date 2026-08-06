# G1R Receipt - TORQCLAW Collaboration Substrate - Cycle 7

- Date: 2026-08-06
- Reviewer model: `claude-opus-5`
- Reviewer role: independent G1R
- Reviewed commit: `1d981da`
- Reviewed artifact: `docs/prd-reviews/PRD-TCLAW-COLLABORATION-SUBSTRATE-001-v0.7.md`
- Consistency evidence: `PASS 67/67` (internal consistency only)
- Verdict: `REJECT`
- Critical: 2
- High: 4
- Medium: 4
- Low: 3
- Builder handoff: `BLOCKED`

## Findings

### Critical

**`CHANNEL_OWNER` predicate constrains the channel, not the caller, granting agents channel administration**

Sections: 4.1, 4.2, 7.6, 9

Impact: Section 4.2 defines `CHANNEL_OWNER` as "`BASE` plus operator owns target channel; channel may be active or archived". Every clause after `BASE` is a property of the target channel, not of the caller. Section 4.1 states "every channel's `owner_principal_id` is that operator ID" - so "operator owns target channel" is true of every channel that exists, by construction. The predicate therefore reduces to `BASE` for all callers. `BASE` (session open, credential active, principal active, owner active for an agent, IDs match, auth epoch matches) is satisfied by any healthy agent. Concretely: agent A2 connects with role `channel`, is a member of no channel, and sends `ARCHIVE_CHANNEL` with the UUID of an operator-private channel. `CHANNEL_OWNER` evaluates true. Section 7.6 rescues only `OPERATOR_GLOBAL` commands ("Operator-only global commands from agents return `COLLAB_NOT_PERMITTED`"), and `ARCHIVE_CHANNEL`, `UNARCHIVE_CHANNEL`, `ADD_CHANNEL_MEMBER`, `REMOVE_CHANNEL_MEMBER` are mapped to `CHANNEL_OWNER`, not `OPERATOR_GLOBAL`. Section 9's storage validations do not backstop this: validations 3, 4, and 7 constrain what rows may be written, not who invoked the command. An agent archiving a channel is a legal transition with a legal `channel_archived` event, so validation 7 passes and validation 6 ("Event insertion validates actor authorization") is undefined for non-message events. The result: any agent can archive every channel in the installation (denial of service against the operator), unarchive channels the operator archived, add arbitrary owned agents to channels they were never granted, and remove the operator's other agents from channels - while `COLLAB_NOT_FOUND` hiding never triggers because the predicate succeeded. This also defeats the Section 2 release proof "hidden channels are indistinguishable from absent channels", since a non-member agent gets an ok result with `{channelId,state,channelEpoch}` for a channel it cannot otherwise see, confirming both existence and current state.

Concrete correction: Redefine the predicate as caller-scoped and require the operator role explicitly: `CHANNEL_OWNER` = "`BASE` plus the current principal is the operator principal, the connection role is `operator`, and the target channel's `owner_principal_id` equals the current principal ID; channel may be active or archived." Add to Section 7.6 that a non-operator principal invoking a `CHANNEL_OWNER` command receives `COLLAB_NOT_FOUND` (not `COLLAB_NOT_PERMITTED`) so the hidden-channel indistinguishability property in Section 2 is preserved. Add to Section 9 a validation 9: "Channel archive, unarchive, and membership mutation verify the invoking principal ID equals the channel's `owner_principal_id` and is kind `operator`; otherwise roll back." Add to Section 10 a required deterministic test: "an agent invoking `ARCHIVE_CHANNEL`, `UNARCHIVE_CHANNEL`, `ADD_CHANNEL_MEMBER`, and `REMOVE_CHANNEL_MEMBER` against both a member channel and a non-member channel receives `COLLAB_NOT_FOUND` and zero rows change."

**Retained-cursor resume replays messages posted during the removal window to a re-added member**

Sections: 5.3, 7.4, 8.3, 10

Impact: Section 5.3 mandates "Cursor rows are retained unchanged across membership removal and re-add; a re-added member resumes replay and unread computation from its retained acknowledged cursor." Section 8.3 says "Backlog sends authorized events through high water ascending" but the PRD never defines per-event authorization - Section 4.2 grants `CHANNEL_VISIBLE` on the basis of current active membership only, with no membership-interval scoping anywhere in the document. Concrete failure: agent A2 is a member of channel C and acknowledges cursor 10. The operator sends `REMOVE_CHANNEL_MEMBER` (writes `member_removed` at `channel_seq` 11). The operator and other agents then post 500 confidential messages, `channel_seq` 12 through 511. The operator re-adds A2 (`member_added` at 512). A2 now satisfies `CHANNEL_VISIBLE`. Per Section 5.3 its retained acknowledged cursor is still 10, so `SUBSCRIBE_CHANNEL {channelId:C, afterCursor:10}` streams `channel_seq` 11 through 512 - delivering all 500 messages posted while A2 was not a member. `GET_CHANNEL_TIMELINE {channelId:C, afterCursor:0, limit:100}` is independently sufficient: it is mapped to `CHANNEL_VISIBLE` with a fully client-chosen `afterCursor` and no lower bound, so A2 can page the entire channel history from `channel_seq` 1 regardless of the cursor row. Removal is therefore not a revocation of access to content authored during the removal window - it is a pause. This directly contradicts the Section 2 release requirement that "membership removal ... stop[s] prohibited commands", and contradicts Section 12's "authorization before content access", because authorization is evaluated as a channel-level boolean while the content spans intervals in which the principal was unauthorized. The Section 10 test "cursor rows are retained across membership removal, re-add ... and a re-added member resumes replay from its retained cursor" affirmatively certifies the leak as correct behavior.

Concrete correction: Decide and state the membership-interval semantics normatively. Recommended: add to Section 5.3 "Membership is interval-scoped. `collab_members` gains `rejoined_seq INTEGER` recording the channel's greatest committed `channel_seq` at the instant of each effective add transition. A principal is authorized for event E in channel C only if E.`channel_seq` is greater than the principal's current `rejoined_seq`." Add to Section 9 DDL: `rejoined_seq INTEGER NOT NULL DEFAULT 0 CHECK(rejoined_seq >= 0)` on `collab_members`, set inside the same `BEGIN IMMEDIATE` transaction as the `member_added` event. Amend Section 7.4 so `GET_CHANNEL_TIMELINE` and `SUBSCRIBE_CHANNEL` clamp the effective `afterCursor` to `max(afterCursor, rejoined_seq)`, and so `SUBSCRIBE_CHANNEL`'s `highWaterCursor` is unchanged but backlog begins at the clamped value. Amend Section 5.3 to "Cursor rows are retained unchanged across membership removal and re-add; on re-add the effective replay floor is `max(acknowledged_seq, rejoined_seq)`, so a re-added member never receives events committed while it was removed." Replace the Section 10 test with: "a member removed at `channel_seq` N and re-added at `channel_seq` M receives no event with `channel_seq` in (N, M] through timeline, subscription backlog, or live fan-out, and its retained cursor does not resurrect them." If instead the intended product semantics are that re-added members do see the gap, Section 12 and Section 2 must say so explicitly and the operator UI must warn at re-add time.

### High

**Lock order is self-contradictory for the seven commands that are both idempotency-keyed and authorization-state-changing**

Sections: 7.4, 8.2, 8.3

Impact: Section 8.3 states two rules in one sentence: "Lock order is authorization coordinator read lock, then sequencer mutex, then SQLite transaction; state-changing authorization operations acquire the authorization write lock before the sequencer mutex. No code may invert this order." Section 8.3 also states "All idempotency-keyed commands, including non-event mutations, use this same sequencer/write path," and step 1 of the atomic protocol is "Acquire the sequencer mutex." Seven commands fall in both sets: `SUSPEND_AGENT`, `REVOKE_AGENT`, `ROTATE_PRINCIPAL_CREDENTIAL`, `REVOKE_PRINCIPAL_CREDENTIAL`, `REMOVE_CHANNEL_MEMBER`, `ARCHIVE_CHANNEL`, `UNARCHIVE_CHANNEL` - each is listed in the Section 7.4 idempotency-keyed class and each is named in Section 8.2 as an operation that acquires the authorization write lock. The PRD does not say which lock these hold on entry. Three readings each produce a defect: (a) read lock then upgrade to write lock self-deadlocks on any standard non-upgradeable RW lock; (b) write lock first violates the stated general order for keyed commands, and the document never says the write lock subsumes the read lock; (c) releasing the read lock before taking the write lock creates an unguarded window in which the Section 7.4 pre-idempotency authorization result becomes stale. A builder cannot pick one without inventing policy, and picking (a) produces a hang on the first `ARCHIVE_CHANNEL`. The Section 15 benchmark "revocation-commit-to-last-write-boundary: p95 <= 150 ms" is unmeasurable until this is resolved.

Concrete correction: Replace the Section 8.3 lock-order sentence with an explicit, non-overlapping classification: read-path commands and non-authorization mutations acquire the authorization read lock, then the sequencer mutex, then the SQLite transaction; authorization mutations acquire the authorization write lock instead of the read lock - never both, never an upgrade - then the sequencer mutex, then the SQLite transaction, holding the write lock through commit, subscription closure, and queue purge. State that the write lock subsumes the read lock and no upgrade path exists. Add to Section 10: "a static or runtime assertion proves no execution path holds the authorization read lock while requesting the write lock."

**Message and name byte bounds are unordered relative to NFC normalization, so conforming implementations disagree on accept/reject**

Sections: 7.1, 10, 14

Impact: Section 7.1 never says whether NFC normalization happens before or after the bounds are checked, and NFC is not length-preserving in either direction. Verified in Node.js v22.19.0: U+0344 is 2 UTF-8 bytes and normalizes under NFC to 4 UTF-8 bytes. A text of 8,192 repetitions of U+0344 is exactly 16,384 bytes as received (accepted if measured pre-normalization) and becomes 32,768 bytes after NFC - more than double the declared cap, stored and fanned out at that size. The converse also holds: 8,192 repetitions of e + U+0301 is 24,576 bytes as received (rejected pre-normalization) but exactly 16,384 bytes after NFC (accepted post-normalization). The same ambiguity applies to channel and display names (80 repetitions of U+0344 is 80 scalars as received, 160 after NFC). The Section 10 boundary fixtures cannot be authored: the largest legal message is a different string under each reading. The Section 14 linter cannot catch this because both bounds are declared as the same number; the pre-gate PASS is consistent with the defect.

Concrete correction: Fix the order explicitly in Section 7.1: the server applies NFC normalization first, then trimming, then all length and character-class validation; all bounds are evaluated against the post-normalization, post-trim text, and that same normalized text is persisted and returned in all frames. Apply the identical ordering to channel names and display names. Add normalization-order fixtures to Section 10 (8,192 x U+0344 rejected; 8,192 x U+0065 U+0301 accepted; persisted bytes equal the normalized form).

**`LIST_CHANNELS` requires a per-principal cursor lookup that the schema cannot index, violating the Section 14 gate the pre-gate reported as passing**

Sections: 7.4, 9, 14

Impact: `LIST_CHANNELS` returns `lastAcknowledgedCursor` for the caller across up to 100 channels per page. Section 9 declares `collab_cursors` with `PRIMARY KEY(channel_id, principal_id)` and no other index, so there is no index whose leading column is `principal_id`. The query is either 100 point lookups (indexable, acceptable) or one full-table scan per call - the PRD does not say which, and Section 14 mandates the linter fail on "a command references an unindexed mandatory access path". The consistency report records 67 passes with no cursor-index check, so the pre-gate PASS is not evidence this gate was evaluated. At Section 15 scale the scan is unlikely to breach a latency bound, so this is a correctness-of-the-gate and handoff-completeness defect rather than a performance one.

Concrete correction: Add `CREATE INDEX collab_cursors_principal_channel ON collab_cursors(principal_id, channel_id);` to Section 9. State the `LIST_CHANNELS` cursor access pattern in Section 7.4 with missing rows reported as "0". Add a cursor-index check to the Section 14 linter.

**`GET_CHANNEL_TIMELINE` result-event object shape is never defined, so the mandated byte fixtures cannot be authored**

Sections: 7.3, 7.4, 10

Impact: Section 7.3 defines the wire shape of exactly one event-bearing structure - the `channel_event` delivery frame. `GET_CHANNEL_TIMELINE -> {events,nextCursor,hasMore}` never defines what an element of `events` contains. Three load-bearing questions are unanswered: whether each element carries its own cursor (a timeline page has up to 100 events, so the frame-level cursor cannot serve them); whether each element carries `channelId`; and whether `nextCursor` is the last returned `channel_seq` or one past it. Section 10 requires byte fixtures for every command success and the frame-cut rule requires measuring the complete encoded result frame incrementally - impossible without a byte-exact element shape. Two teams produce incompatible timeline responses that both satisfy every Section 14 rule, and a client resuming with `afterCursor: nextCursor` either replays the last event or skips one depending on the convention chosen.

Concrete correction: Define the timeline event object in Section 7.3 as identical to the `channel_event` frame's event member with `cursor` added, in ascending cursor order; `nextCursor` is the cursor of the last element returned, or the request's `afterCursor` when events is empty; `hasMore` is true when any authorized event exists after `nextCursor`. Add single-event, 100-event, and frame-cut byte fixtures to Section 10.

### Medium

**Unarchive closes subscriptions with no defined close reason**

Sections: 5.4, 5.5, 8.1, 9

Impact: Section 5.4 says unarchive behaves identically to archive and Section 5.5 confirms unarchive closes subscriptions, but the exhaustive subscription close-reason registry in Section 8.1 has no `channel_unarchived`. A builder must either emit `channel_archived` on unarchive (semantically false, encoded into byte fixtures) or invent a seventh reason, violating exhaustiveness and the Section 14 registry rule. The DDL constrains session reasons only, so the pre-gate registry checks pass while the registry is incomplete relative to Section 5.4's behavior.

Concrete correction: Add `channel_unarchived` to the Section 8.1 subscription close-reason registry and the Section 14 linter, and name it in Sections 5.4 and 10.

**Credential lookup is not constant-time with respect to credential existence**

Sections: 6.1, 6.2, 7.6

Impact: The credential format is `tq1_<credentialId>_<secret>`, so the server must look up the credential row before it has anything to compare in constant time. The miss path (no row, return immediately) and hit path (row found, then constant-time HMAC comparison) differ measurably. Credential IDs are returned in plaintext by four commands and persisted unredacted in `collab_mutation_results`, so an observer can distinguish "this credential ID exists" from "does not exist" without knowing the secret. Rate limits and the single-operator TLS deployment bound the oracle, which is why this is Medium - but Section 16 lists a timing-regression mitigation and no timing test is specified for the authentication path.

Concrete correction: Make credential verification existence-oblivious in Section 6.1: when the parsed credential ID matches no row, compare against a fixed decoy HMAC so hit and miss paths execute the same number of HMAC operations, then return `AUTH_FAILED`; the revoked path performs the same comparison. Add a connect-path timing-regression fixture to Section 10.

**Section 9 storage validation 6 invokes an undefined notion of "actor authorization"**

Sections: 9, 4.2, 8.3

Impact: Validation 6 requires "Event insertion validates actor authorization" but actor authorization is not defined as a storage-layer concept; Section 4.2 defines authorization as protocol-layer predicates over session state unavailable to `CollaborationStore`. The other validations are precise and row-checkable; validation 6 is the one a fixture author cannot implement, yet the negative-fixture mandates depend on it - and it is the only place the storage layer could have backstopped the `CHANNEL_OWNER` defect, so its vagueness is load-bearing.

Concrete correction: Replace validation 6 with row-checkable conditions: `actor_principal_id` names an active principal; for `message_posted` the actor has an active membership row with `rejoined_seq` less than the new `channel_seq` and the channel is active; for the five administrative kinds the actor equals the channel's `owner_principal_id` and is kind operator; `kind` is one of the six Section 7.5 values; `content_json` contains exactly the fields listed for that kind.

**Feature-flag matrix is undefined for partial enablement**

Sections: 11, 19

Impact: Four independent boolean flags give sixteen configurations; the PRD never states the dependency relation. `TORQCLAW_COLLAB_CHANNELS=true` with `TORQCLAW_COLLAB_IDENTITY=false` is undefined: refuse to start, ignore, or open listeners with no principal to own channels. Section 11 also calls the slices "independently gated" while they are strictly cumulative. Section 19 requires gates pass "with features off and on" (two of sixteen configurations).

Concrete correction: State the flags are strictly nested and validated at startup (`CHANNELS` requires `IDENTITY`; `LIVE` requires `CHANNELS`; `UI` requires `CHANNELS`); violated dependencies are startup configuration errors reported by doctor; commands of a disabled tier are unmapped and denied. Amend Section 19 to require the five valid cumulative configurations.

### Low

**`CHANNEL_OWNER` and `OPERATOR_GLOBAL` overlap without stated precedence for `COLLAB_NOT_FOUND` versus `COLLAB_NOT_PERMITTED`**

Sections: 4.2, 7.6

Impact: Once the `CHANNEL_OWNER` fix lands, the four channel-administration commands become operator-only and channel-scoped, and the two Section 7.6 rules prescribe different codes for the same request. Returning `COLLAB_NOT_PERMITTED` to an agent for `ARCHIVE_CHANNEL` on a channel it cannot see would confirm the channel exists.

Concrete correction: State that `COLLAB_NOT_PERMITTED` is returned only for commands with no channel-scoped target (`OPERATOR_GLOBAL` commands); every command carrying a `channelId` returns `COLLAB_NOT_FOUND` for all denial causes.

**`LIST_CHANNELS` does not state whose `lastAcknowledgedCursor` is returned, nor the value when no cursor row exists**

Sections: 7.4, 9

Impact: An implementation could plausibly return the channel owner's cursor rather than the caller's, disclosing the operator's read position to every agent member. A channel never acknowledged has no cursor row, and the PRD does not say whether the field is "0", null, or omitted - Section 7.1 bans unknown fields, so this is a fixture-blocking schema question.

Concrete correction: State that `lastAcknowledgedCursor` is the calling principal's own cursor, rendered as an unsigned base-10 string, "0" when no row exists, and never another principal's.

**Section 11 calls cumulative slices "independently gated"**

Sections: 11

Impact: The five slices are ordered by strict dependency, yet Section 11 says "independently gated", which reads as "in any order". Wording, not design.

Concrete correction: Replace with "Slices are cumulative and sequentially gated: each slice has its own gate, and slice N+1 does not begin until slice N's gate passes."

## Rubric score

| Criterion | Result | One-line basis |
|---|---|---|
| 1. Problem, target user, measurable outcome explicit | Pass | Section 2 names one technical operator on one Windows install and lists ten falsifiable release proofs tied to Section 15 benchmarks. |
| 2. Scope and non-goals prevent ambiguous expansion | Pass | Section 3.2 enumerates exclusions and Sections 17-18 map every superseded clause, each requiring a separate PRD. |
| 3. User flows, edge cases, acceptance criteria testable | Fail | The timeline event shape is undefined, the NFC/bounds order makes boundary fixtures unauthorable, and one required test certifies the removal-window replay leak as correct. |
| 4. Functional and non-functional requirements | Fail | `CHANNEL_OWNER` grants agents channel administration, membership removal does not revoke removal-window content, and `collab_cursors` lacks the index the Section 14 gate claims to require. |
| 5. Assumptions, open questions, risks, owners, deadlines visible | Pass | Section 16 names King Flowers as accountable owner for all eight risks, dated 2026-08-06, with a stated delegation rule. |
| 6. Analytics, rollout, rollback, support proportionate to risk | Partial | Strong on metrics and destructive-restore safety, but the four-flag matrix has no defined dependency or partial-enablement behavior. |
| 7. Implementation slices feasible and independently verifiable | Fail | The lock order self-contradicts for the seven commands that are both idempotency-keyed and authorization-state-changing; one reading self-deadlocks on the first `ARCHIVE_CHANNEL`. |

Total: 3 Pass, 1 Partial, 3 Fail. Two Critical and four High findings; approval threshold not met.

## Builder handoff conditions

1. Redefine `CHANNEL_OWNER` as caller-scoped (current principal is the operator, role `operator`, and the channel's owner), add the Section 9 invoker validation, and add the Section 10 agent-denial test with zero row changes.
2. Introduce membership-interval scoping (`rejoined_seq` on `collab_members`, replay floor `max(afterCursor, rejoined_seq)`), and replace the retained-cursor test with one proving a re-added member receives no removal-window event through any path.
3. Partition commands into read-path, non-authorization-mutation, and authorization-mutation lock classes with exactly one discipline each; write lock subsumes read lock; no upgrade path; add the no-upgrade assertion to Section 10.
4. Fix validation ordering in Section 7.1: NFC, then trim, then all bounds against normalized text, persisting the normalized form; add the U+0344 and U+0065 U+0301 boundary fixtures.
5. Add `collab_cursors_principal_channel` index, state the `LIST_CHANNELS` cursor access pattern, and add the cursor-index check to the linter.
6. Define the timeline event object byte-exactly, including per-element cursor and the `nextCursor` convention; add single-event, 100-event, and frame-cut byte fixtures.
7. Add `channel_unarchived` to the subscription close-reason registry, the linter, and Sections 5.4 and 10.
8. Make credential verification existence-oblivious via a decoy-HMAC miss path; add a connect-path timing-regression fixture.
9. Replace Section 9 validation 6 with row-checkable conditions.
10. Specify feature-flag dependency nesting and startup validation; expand Section 19 to the five valid cumulative configurations.
11. Reserve `COLLAB_NOT_PERMITTED` for `OPERATOR_GLOBAL` commands; every channel-scoped denial returns `COLLAB_NOT_FOUND`.
12. State `lastAcknowledgedCursor` is the caller's own cursor, "0" when absent.
13. Reword Section 11 slices as cumulative and sequentially gated.

Conditions 1-6 are Critical/High closures required for READY; 7-13 should be closed in the same revision.
