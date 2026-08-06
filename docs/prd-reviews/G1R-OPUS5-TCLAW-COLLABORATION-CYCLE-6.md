# G1R Receipt - TORQCLAW Collaboration Substrate - Cycle 6

> Review context: a gpt-5.6-terra Cycle 6 run was launched first and terminated on
> output limits mid-receipt; its partial output (0 Critical / 3 High reported before
> truncation) independently identified the JSON-escape frame-feasibility defect
> recorded below as Critical 1. Per operator instruction the cycle was re-run in full
> with claude-opus-5 as the independent reviewer. This receipt is the authoritative
> Cycle 6 result.

- Date: 2026-08-06
- Reviewer model: `claude-opus-5`
- Reviewer role: independent G1R
- Reviewed commit: `cedae1f`
- Reviewed artifact: `docs/prd-reviews/PRD-TCLAW-COLLABORATION-SUBSTRATE-001-v0.6.md`
- Consistency evidence: `PASS 49/49` (internal consistency only)
- Verdict: `REJECT`
- Critical: 2
- High: 5
- Medium: 4
- Low: 2
- Builder handoff: `BLOCKED`

## Findings

### Critical

**1. JSON escape expansion admits a message that commits but can never be delivered, in any frame.**

Sections: 7.1, 7.3, 5.4, 8.3, 10, 15.

Impact: Section 7.1 sets message text at 1-16,384 UTF-8 bytes and declares this "the only message-size rule." No character-class restriction exists anywhere in the PRD, and NFC normalization does not remove control characters (verified: U+0001 is NFC-stable). U+0001 occupies 1 UTF-8 byte but JSON-escapes to the six-byte sequence backslash-u-0-0-0-1. Measured against the Section 7.3 envelopes (`channel_event` overhead 418 bytes; inbound `command` overhead ~190 bytes), there is a live window: text of 10,854 to 10,881 control-character bytes (28 distinct valid sizes, all under 16,384). At n=10,854 the inbound `POST_CHANNEL_MESSAGE` frame is 65,372 bytes - under the 64 KiB limit, so it passes Section 7.6 step 1, passes Section 7.1 validation, and commits to `collab_events`. The outbound `channel_event` for that same row is 65,542 bytes, and a single-event `GET_CHANNEL_TIMELINE` page is 65,539 bytes - both exceed 64 KiB and cannot be encoded. The event is durably committed and permanently undeliverable. This breaks four stated guarantees simultaneously: Section 7.1 "a page always contains at least one event when any authorized event exists after the cursor" (the page cannot be built, so every reader stalls forever at that cursor and pagination can never advance past it); Section 5.4 "archive loses no committed event"; Section 8.3 "observable output equals authorized database sequence with no gaps or duplicates"; and Section 15 "zero lost or duplicate event sequences." The Section 7.6 error registry is declared exhaustive and contains no code meaning "event too large to deliver," so the server has no legal way to report the condition. Any authorized member can permanently wedge a channel's timeline with one message. Note the pre-gate "cross-constraint: encoded bounds fit frame" check passed because it compared declared bounds (16,384 < 65,536) without modeling escape expansion - this is exactly the class of defect the pre-gate cannot see.

Concrete correction: bound the message by its encoded size, not its raw size. Replace the Section 7.1 rule with: "Message text is NFC-normalized, 1-16,384 UTF-8 bytes, and MUST additionally satisfy encoded-JSON-string length <= 16,384 bytes; violations return `INVALID_REQUEST`." Independently, forbid unescaped C0/C1 control characters other than TAB/LF/CR in message text and in channel and display names, and state that rule in Section 7.1. Add a Section 10 fixture at each of n=10,853 (must accept) and n=10,854 (must reject) using all-U+0001 text, and a fixture proving the worst-case accepted message encodes within 64 KiB in both the `channel_event` and single-event timeline-page shapes.

**2. `collab_events.seq` is a global sequence exposed to every client as `cursor`, creating a hidden-channel volume and timing oracle.**

Sections: 9, 7.3, 7.4, 2, 7.6, 12.

Impact: The Section 9 DDL declares `seq INTEGER PRIMARY KEY AUTOINCREMENT` on a single `collab_events` table shared by all channels. Verified against SQLite 3.50.4: interleaved inserts across channels c1, c3, c1 receive global seqs 1, 2, 3 - the sequence is global, not per-channel. Section 7.3 defines the client-visible `cursor` as exactly that `seq`, and Section 7.4 returns it from `POST_CHANNEL_MESSAGE`. Concrete scenario: agent A is a member only of channel X. The operator also owns private channel Y, which A is not a member of and which Sections 2 and 7.6 require to be indistinguishable from a channel that does not exist. A posts and receives cursor 100. The operator posts 36 messages in Y. A posts again and receives cursor 137. A now knows that 36 events it cannot see occurred, and when they occurred. If Y were genuinely absent, the gap would be 1. The Section 2 release requirement "hidden channels are indistinguishable from absent channels through the defined API response" is therefore false as designed - the leak is in the response body of a command A is fully authorized to issue, so no amount of denial-precedence work in Section 7.6 closes it. Section 12's "no principal, channel, token, address, or message text labels" addresses metrics but not this protocol-level channel.

Concrete correction: decouple the wire cursor from the global rowid. Either (a) add `channel_seq INTEGER NOT NULL` to `collab_events`, assigned per channel as MAX(channel_seq)+1 for that channel inside the existing sequencer transaction, add `UNIQUE(channel_id, channel_seq)`, and redefine the Section 7.3 `cursor` as `channel_seq`; or (b) keep the global `seq` internal and expose an opaque per-channel-monotonic cursor token. Option (a) is preferred because the existing `collab_events_channel_seq` index and all cursor comparisons carry over unchanged. Update Sections 7.3, 7.4, 9, and add a Section 10 test asserting that a member of one channel observes strictly consecutive cursors regardless of concurrent activity in channels it cannot see.

### High

**3. Archive and fan-out lock discipline is underdetermined; two incompatible readings produce materially different systems.**

Sections: 5.4, 8.2, 8.3.

Impact: Section 8.3 fixes the order "authorization coordinator read lock, then sequencer mutex, then SQLite transaction," and Section 8.2 requires that "each socket write validates `BASE` plus the subscription's current membership/channel visibility and epoch snapshots under the read lock." Section 8.3 step 7 says "commit before fan-out," and fan-out performs socket writes. The PRD never says whether the read lock is held across fan-out or re-acquired per socket write. Under reading (a) - held - a `POST_CHANNEL_MESSAGE` retains the read lock and the sequencer mutex for the entire fan-out to every subscriber; a concurrent `ARCHIVE_CHANNEL` waiting on the authorization write lock is blocked until the slowest consumer's write initiates. Since Section 7.7 permits a 1 MiB queue and a 10-second frame age, revocation latency becomes coupled to consumer speed, and the Section 15 targets "commit-to-last-authorized-client socket-write initiation p95 <= 150 ms" and "revocation-to-last-write-boundary latency" are being measured against an unbounded dependency. Under reading (b) - re-acquired - the guarantee in Section 5.4 that "no socket write for those subscriptions begins after the archive commit" holds only through the Section 8.2 epoch recheck, and Section 5.4's requirement that queue purge complete "before the lock releases" must interleave with fan-out attempts blocked on the read lock. A builder cannot choose between these from the text, and the two differ in observable revocation latency and in which barrier tests Section 10 needs.

Concrete correction: state explicitly in Section 8.2 that the authorization read lock is acquired and released per socket write, that fan-out does not hold the sequencer mutex, and that the sequencer mutex is released at commit (step 7) before any frame is enqueued. Add to Section 8.3: "Fan-out enqueues frames under no lock; each dequeue-and-write re-acquires the read lock, re-validates `BASE` and the subscription's epoch snapshots, and drops the frame if validation fails." Add a Section 15 pass condition bounding revocation-to-last-write-boundary independently of consumer queue depth.

**4. The Section 8.3 atomic protocol's contention branch is unreachable, and the deterministic barrier tests Sections 8.3 and 10 mandate cannot be constructed.**

Sections: 8.3, 10, 9.

Impact: Section 8.3 declares "one in-process sequencer mutex," acquires it at step 1 before `BEGIN IMMEDIATE`, and holds it through commit at step 7. Section 9 declares `CollaborationStore` "the only production writer" and states "raw external SQLite writes are unsupported." Under those two constraints all idempotency-keyed writes are strictly serialized in-process, so a unique-key collision on the `collab_mutation_results` primary key cannot occur - step 8 ("on unique-key contention, roll back, begin a fresh read transaction, re-read the canonical row, and apply steps 4-5") is dead code that no test can exercise. Worse, Section 8.3 then requires "deterministic barriers test concurrent same-key requests before lookup, mutation, result insert, and commit for every mutation class," and Section 10 requires proof that "same-key concurrent races for every mutation class produce one mutation and one canonical result." With the mutex held from step 1 through step 7, no second same-key request can reach any of those four barrier points while the first is in flight; the interleavings the tests are supposed to cover do not exist. A test author is asked to write tests for states the design forbids, and will either weaken the mutex to make them pass or stub them.

Concrete correction: pick one model and make the tests match. Either (i) keep the global mutex, delete step 8, and rewrite the Section 8.3 and Section 10 test mandates to assert serialization directly - "concurrent same-key requests are serialized by the sequencer mutex; the second observes the committed canonical row at step 3 and returns it without mutation" - with barriers placed only at mutex entry and after commit; or (ii) narrow the mutex to per-channel or drop it in favor of relying on `BEGIN IMMEDIATE` plus the PK constraint, in which case step 8 becomes reachable and the four barrier points are real. Option (i) is the smaller change and preserves the single-fan-out-source guarantee.

**5. The `expired` credential state gates authorization but no mechanism can ever set it, and time-based expiry silently defeats the `LAST_OPERATOR_CREDENTIAL` guard.**

Sections: 6.1, 4.2, 5.1, 9, 7.4.

Impact: Section 4.2 `BASE` requires "credential active and unexpired"; Section 6.1 defines states active/expired/revoked with expired terminal; Section 9 declares `expires_at TEXT` and the state CHECK including 'expired'. But no command in the exhaustive Section 7.4 list accepts an expiry parameter, and no rule anywhere states who sets `expires_at`, what transitions active to expired, or whether expiry is evaluated from the column at auth time or written back as a state change. A fixture author told in Section 7.2 to produce an "expired credential" fixture has no defined way to create one. Separately, if expiry is real, it breaks a stated safety property: Section 6.1 says `REVOKE_PRINCIPAL_CREDENTIAL` "returns `LAST_OPERATOR_CREDENTIAL` without mutation if the target is the operator's final active credential" and that "deliberately removing all operator access requires Section 5.1.1." With two active operator credentials where credB carries `expires_at` one second in the future, revoking credA passes the guard (credB is active at evaluation time), credB then expires, and the gateway reaches Section 5.1's "zero usable active operator credentials" - entering `locked_recovery` without ever invoking Section 5.1.1. The guard is not atomic with respect to time.

Concrete correction: choose one. Either (i) remove expiry from v1 - drop `expires_at` from the DDL, drop 'expired' from the state CHECK, drop "unexpired" from `BASE`, and replace the Section 7.2 expired-credential fixture with a revoked one; or (ii) specify it fully - add an optional `expiresAt` to `CREATE_PRINCIPAL_CREDENTIAL` and `ROTATE_PRINCIPAL_CREDENTIAL`, state that expiry is evaluated from `expires_at` at authentication time with lazy write-back of state 'expired', and redefine the guard as "returns `LAST_OPERATOR_CREDENTIAL` unless at least one other operator credential is active and has `expires_at IS NULL`." Option (i) is preferred for v1 given Section 3.2's minimalism.

**6. Credential commands have no defined error codes for unknown, foreign, suspended, or revoked targets, and the Section 7.6 registry is declared exhaustive.**

Sections: 7.4, 7.6, 6.1.

Impact: Section 7.6 states "the exhaustive domain error codes are" and lists twelve, with `COLLAB_NOT_FOUND` scoped in the same section specifically to channels ("absent, hidden, archived-hidden, and non-member channel IDs"). Section 6.1 says `ROTATE_PRINCIPAL_CREDENTIAL` "verifies the replaced credential is active and belongs to the principal" but never names the code returned when that check fails. `REVOKE_PRINCIPAL_CREDENTIAL {credentialId}` takes no `principalId` and has no stated behavior for an unknown ID, an already-revoked ID, or an ID belonging to a different principal. `CREATE_PRINCIPAL_CREDENTIAL {principalId}` is described in Section 6.1 as issuing "for an active principal" but has no stated behavior when `principalId` names a suspended or revoked (terminal) agent - and unlike `SUSPEND_AGENT`/`RESTORE_AGENT`/`REVOKE_AGENT`, which Section 7.4 explicitly guards with `INVALID_REQUEST` when `principalId` names the operator, `CREATE_PRINCIPAL_CREDENTIAL` and `ROTATE_PRINCIPAL_CREDENTIAL` carry no operator-target guard at all. `INVALID_PRINCIPAL_TRANSITION` is defined in Section 5.2 for illegal state transitions and does not fit. Concrete scenario: a fixture author writing the Section 10 case "a lost first response can be recovered with `CREATE_PRINCIPAL_CREDENTIAL`" must also cover the adjacent negative - creating a credential for a revoked agent - and there is no legal code to assert. Two implementers will pick differently, and Section 14's linter will flag whichever code they invent as "an error code outside the exhaustive Section 7.6 registry," failing the pre-gate.

Concrete correction: add `PRINCIPAL_NOT_FOUND`, `CREDENTIAL_NOT_FOUND`, and `INVALID_PRINCIPAL_STATE` to the Section 7.6 registry (or explicitly extend `COLLAB_NOT_FOUND` to principal and credential IDs and say so in Section 7.6). Then state in Section 7.4, per command: `CREATE_PRINCIPAL_CREDENTIAL` returns `INVALID_PRINCIPAL_STATE` for a suspended or revoked principal; `ROTATE_PRINCIPAL_CREDENTIAL` returns `CREDENTIAL_NOT_FOUND` when `replaceCredentialId` is unknown, already non-active, or not owned by `principalId`; `REVOKE_PRINCIPAL_CREDENTIAL` returns `CREDENTIAL_NOT_FOUND` for an unknown ID and is idempotent for an already-revoked ID. Add the operator-target rule for both credential commands.

**7. `revoke-operator` requires a credential the operator may not have, and Section 5.1 contradicts Section 5.1.1's "sole mechanism" claim.**

Sections: 5.1.1, 5.1, 6.1.

Impact: Section 5.1.1 requires the CLI to present "a valid active operator credential" and calls itself "the sole operator-principal revocation mechanism." But Section 6.1 establishes that the whole reason `CREATE_PRINCIPAL_CREDENTIAL` exists is that a one-time credential response can be lost, and Section 5.1 independently lists "zero usable active operator credentials" as a condition that places the gateway in `locked_recovery` on its own. These conflict two ways. First, if the operator has lost every credential, Section 5.1 says the gateway is already in `locked_recovery` - reached without Section 5.1.1 - so Section 5.1.1 is not the sole path into the revoked posture. Second, Section 5.1.1 is unusable in precisely that scenario: the operator who most needs to revoke a compromised-or-lost credential set cannot satisfy the CLI's precondition. Concrete scenario: the operator's only credential is disclosed to an attacker. The operator wants to revoke the operator principal offline. If they still hold the plaintext they can, but if they discarded it after the one-time display (which Section 6.1 encourages by making `CREATE_PRINCIPAL_CREDENTIAL` the recovery path) they cannot revoke, and the attacker retains access until the operator instead runs `recover-operator` - which Section 6.4 permits only in `locked_recovery`, a state they cannot reach. The operator is deadlocked between two commands each of which requires what the other produces.

Concrete correction: replace the credential requirement in Section 5.1.1 with the recovery-kit passphrase, which Section 6.3 already guarantees exists and is verified before healthy mode: change the precondition list to "the Windows account owning the database, an exclusive lock, a valid recovery kit with matching checksum and installation ID, a correct passphrase, and a successful pre-mutation backup," and change the flag from `--credential-stdin` to `--passphrase-stdin`. Separately, reword Section 5.1.1's claim to "this is the sole command that transitions an active operator to revoked" and amend Section 5.1 to note that zero usable operator credentials produces `locked_recovery` without changing operator status, so `recover-operator` is reachable in that state.

### Medium

**8. `LIST_CHANNELS` has no frame-bound rule and its worst case leaves under 4 KiB of margin.**

Sections: 7.4, 7.1, 4.2.

Impact: Section 7.1's byte-cut rule is written only for timeline pages. `LIST_CHANNELS` accepts limit 1..100 and returns rows carrying `name` (up to 80 Unicode scalar values) plus four other fields, with no equivalent clause. Measured worst cases: 100 rows with 80-scalar emoji names encode to 45,290 bytes; with 80 control-character names (permitted - see finding 11) 61,290 bytes. Both fit, but the margin is under 4 KiB and depends on assumptions the PRD never fixes, such as the width of `lastAcknowledgedCursor`. If any field widens, the response exceeds the frame with no defined truncation behavior and no applicable error code.

Concrete correction: extend the Section 7.1 sentence to cover all paginated results: "A paginated result page ends at its limit, or earlier when adding the next item would push the complete encoded `result` frame past the 64 KiB frame limit; `hasMore` and the next-page token continue pagination." Add a Section 10 fixture for `LIST_CHANNELS` at limit 100 with maximum-length names asserting the frame bound holds and `hasMore` is set.

**9. `highWaterCursor` scope is undefined.**

Sections: 7.4, 8.3, 7.3.

Impact: `SUBSCRIBE_CHANNEL` returns `highWaterCursor` but the PRD never says whether it is the global sequencer high water or the channel's greatest visible seq. Section 8.3's "subscription registration and high-water capture occur under the mutex" suggests the global sequencer value, which would hand every subscriber the total event count across all channels - a stronger version of finding 2. A fixture author cannot write the expected value.

Concrete correction: define it in Section 7.4 as "the greatest committed sequence visible to the caller in that channel at registration time," consistent with the per-channel cursor from finding 2, and add the assertion to the Section 10 backlog/live fixture.

**10. Cursor rows have no membership foreign key, no upper bound, and no defined lifecycle across membership removal or archive.**

Sections: 9, 7.4, 5.3, 5.4.

Impact: `collab_cursors` has a non-negative CHECK and foreign keys to channels and principals, but none to `collab_members`. Verified against SQLite: a cursor row for a principal with no membership inserts successfully; only the Section 9 item-5 application check prevents it, and that check runs only on write. The PRD never says what happens to an existing cursor when membership is removed (Section 5.3) or when a channel is archived (Section 5.4) - retained, deleted, or frozen. This matters because Section 7.4 has `LIST_CHANNELS` return `lastAcknowledgedCursor` and Section 5.4 promises resubscribed members replay from their acknowledged cursor. A removed-then-re-added member's replay start point is undefined.

Concrete correction: state in Sections 5.3 and 5.4 that cursor rows are retained unchanged across membership removal, re-add, archive, and unarchive, and that re-added members resume from their retained cursor. Add a Section 10 test covering remove, re-add, resubscribe asserting the replay start point.

**11. Channel names and agent display names have no character-class restriction.**

Sections: 7.1, 12.

Impact: Section 7.1 constrains names only to "NFC-normalized, trimmed, 1-80 Unicode scalar values." Control characters, bidirectional overrides (U+202E), and zero-width joiners are all permitted and all NFC-stable. Section 12 commits to an accessible operator UI, and a channel named with an embedded RTL override renders deceptively in any list view; control characters additionally drive the byte blowup in finding 8. Case-folding to `name_key` does not remove them, so two visually identical names can also coexist as distinct active channels.

Concrete correction: add to Section 7.1: "Names MUST NOT contain C0 or C1 control characters, U+2028, U+2029, or Unicode bidirectional control characters (U+202A-U+202E, U+2066-U+2069); violations return `INVALID_REQUEST`." Add a Section 10 fixture rejecting a bidi-override name.

### Low

**12. Risk owners are role placeholders with no named accountability at Gate 1.**

Sections: 16.

Impact: The Section 16 table assigns eight risks to role placeholders, then states "named humans must be assigned before Slice 2." Rubric criterion 5 asks for visible owners and decision deadlines; at Gate 1 there is no accountable individual for any Critical-adjacent risk, and no dated deadline for assignment.

Concrete correction: name individuals in the Section 16 table before builder handoff, and give the assignment a date rather than a slice reference.

**13. `collab_audit` lacks an index supporting its own operational queries.**

Sections: 9, 13.

Impact: Section 9 gives `collab_audit` only an AUTOINCREMENT primary key. Section 13 requires metrics on migration/recovery/doctor outcomes and verified recovery-kit age, and Section 9 sets doctor warning thresholds, all of which imply filtering by `kind` and `created_at`. Section 14's linter is specified to fail when "a command references an unindexed mandatory access path," so this may surface as a pre-gate failure during implementation.

Concrete correction: add `CREATE INDEX collab_audit_kind_created ON collab_audit(kind, created_at);` to the Section 9 DDL.

## Rubric score

| Criterion | Result | Basis |
|---|---|---|
| 1. Problem, target user, measurable outcome | Pass | Sections 1-2 name the single operator, the missing shared-room abstraction, and ten falsifiable release conditions. |
| 2. Scope and non-goals | Pass | Sections 3.1/3.2 are exhaustive and each exclusion is bound to a separate PRD; Section 18 maps superseded clauses. |
| 3. Flows, edge cases, acceptance criteria testable | Fail | Finding 1 makes a Section 7.1 acceptance criterion unachievable; finding 4 mandates unconstructible barrier tests; finding 6 leaves error paths with no assertable code. |
| 4. Functional and non-functional requirements | Fail | Findings 1 and 2 are arithmetic and information-flow defects in the core protocol; findings 3 and 5 leave locking and credential expiry unimplementable as written. |
| 5. Assumptions, risks, owners, deadlines | Partial | Section 16 risk table is well-targeted and Section 6.4 states the unrecoverable case honestly, but owners are role placeholders (finding 12) and the Section 5.1/5.1.1 contradiction (finding 7) appears in no risk row. |
| 6. Analytics, rollout, rollback, support | Pass | Section 11's destructive-restore contract and Section 13's bounded-label metrics are proportionate to the stated risk. |
| 7. Slices feasible and independently verifiable | Partial | Section 11's five slices are well-cut and independently gated, but Slice 4 cannot satisfy Section 8.3's barrier mandate (finding 4) and Slice 3 inherits finding 1. |

Total: 3 Pass, 2 Partial, 2 Fail. Two Critical and five High findings block approval.

## Builder handoff conditions

1. Bound message text by encoded JSON size (encoded string <= 16,384 bytes) in addition to the raw limit, forbid unescaped C0/C1 control characters in message text, and add Section 10 fixtures at the n=10,853 accept / n=10,854 reject boundary using all-U+0001 text. (Finding 1)
2. Replace the client-visible global cursor with a per-channel sequence: add `channel_seq` and `UNIQUE(channel_id, channel_seq)` to `collab_events`, assign it inside the sequencer transaction, redefine the Section 7.3 cursor accordingly, and add a Section 10 test proving cursors are consecutive within a channel regardless of hidden-channel activity. (Finding 2)
3. Fix the lock discipline explicitly in Sections 8.2/8.3: read lock acquired and released per socket write, sequencer mutex released at commit before any frame is enqueued, fan-out holding neither; add a Section 15 pass condition bounding revocation-to-last-write-boundary independently of consumer queue depth. (Finding 3)
4. Resolve the sequencer-mutex/step-8 contradiction - either delete step 8 and rewrite the Section 8.3 and Section 10 concurrency mandates to assert serialization, or narrow the mutex so the contention branch and the four barrier points are genuinely reachable. (Finding 4)
5. Either remove credential expiry from v1 entirely (drop `expires_at`, the expired state, and "unexpired" from BASE), or specify who sets it, how active-to-expired occurs, and redefine the `LAST_OPERATOR_CREDENTIAL` guard so time-based expiry cannot silently reach `locked_recovery`. (Finding 5)
6. Add `PRINCIPAL_NOT_FOUND`, `CREDENTIAL_NOT_FOUND`, and `INVALID_PRINCIPAL_STATE` to the Section 7.6 exhaustive registry, and state per-command failure codes for `CREATE_PRINCIPAL_CREDENTIAL`, `ROTATE_PRINCIPAL_CREDENTIAL`, and `REVOKE_PRINCIPAL_CREDENTIAL`, including an operator-target guard for the first two. (Finding 6)
7. Change `revoke-operator` to authenticate with the recovery-kit passphrase rather than an active operator credential, and reconcile Section 5.1's "zero usable active operator credentials" path with Section 5.1.1's "sole mechanism" claim so `recover-operator` is reachable after total credential loss. (Finding 7)
8. Generalize the Section 7.1 frame-bound cut rule from timeline pages to all paginated results, and add a `LIST_CHANNELS` worst-case fixture. (Finding 8)
9. Define `highWaterCursor` as the caller's greatest visible sequence in that channel. (Finding 9)
10. State cursor-row lifecycle across membership removal, re-add, archive, and unarchive, with a covering test. (Finding 10)
11. Restrict channel and display names to exclude C0/C1 control characters, U+2028/U+2029, and bidi controls. (Finding 11)
12. Name individual humans in the Section 16 risk table with a dated assignment. (Finding 12)
13. Add `CREATE INDEX collab_audit_kind_created ON collab_audit(kind, created_at);`. (Finding 13)

Conditions 1-7 must be closed for READY; 8-13 should be closed in the same revision to avoid a further cycle.
