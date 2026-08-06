# TORQCLAW Collaboration PRD Synthesis Log

## Cycle 9 draft: v0.8 -> v0.9

All 9 Cycle 8 conditions were accepted and closed directly in the consolidated v0.9 source. One disposition chooses a cleaner equivalent of the receipt's literal correction, with rationale: the encoded message bound now excludes the surrounding quotes, making the raw and encoded bounds equal (16,384) and the advertised raw ceiling reachable — this satisfies findings 1-2 with one number everywhere instead of the receipt's 16,386/16,382 split. Boundary fixtures pin exact values for ASCII, all-LF, and both NFC cases.

Other closures as recommended: `rejoined_seq` captured immediately before the `member_added` insert (members see their own join event), with a worked example and the (N, M) open-interval test; caller-visible `ACK_CHANNEL_CURSOR` bound closing the committed-count oracle; same-state archive/unarchive defined as success no-ops; explicit per-command sequencer-mutex table with SQL-computed ack max; writer-preferring authorization lock with a reader-arrival-rate benchmark; six enumerated flag configurations; only-writer claim qualified for offline CLIs; linter bound-equality arithmetic check.

Linter grew from 84 to 97 checks. v0.9 pre-gate: PASS 97/97 on first run. Builder handoff remains blocked pending independent v0.9 G1R; on a clean verdict, Slice 0 begins (builder: Haiku 4.5; G2A: Opus).

## Cycle 8: pinned v0.8 at `3e53e75`

Reviewer: `claude-opus-5`, isolated, empirical. Verdict: Reject. Critical 0, High 4, Medium 3, Low 2. Receipt: `G1R-OPUS5-TCLAW-COLLABORATION-CYCLE-8.md`. First zero-Critical verdict of the Opus review era; finding scope narrowed from architectural to arithmetic/wording:

- High: the two v0.8 message bounds interact so the mandated boundary fixture is off by exactly the two JSON quote bytes, and the raw 16,384 ceiling is unreachable (encoded bound dominates).
- High: `rejoined_seq` capture point (before vs after the `member_added` insert) is ambiguous; the two readings disagree on whether a member sees its own join event.
- High: `ACK_CHANNEL_CURSOR` range check is channel-scoped, not caller-scoped, giving a committed-count oracle across removal windows via `CURSOR_OUT_OF_RANGE` binary search.
- High: lock details — "mutex where required" undefined for read-path commands; RW-lock fairness (writer preference) unstated, so the 150 ms revocation bound rests on an unstated assumption.
- Medium/Low: no-op archive/unarchive response, flag-configuration count (six, not five), "only production writer" overclaim vs offline CLIs, linter arithmetic extension.

All 9 conditions accepted for v0.9 disposition. Agreed: on a clean v0.9 verdict, pivot to Slice 0 (builder: Haiku 4.5; G2A: Opus) so remaining classes are settled by executable artifacts.

## Cycle 8 draft: v0.7 -> v0.8

All 13 Cycle 7 conditions were accepted and closed directly in the consolidated v0.8 source:

- `CHANNEL_OWNER` is caller-scoped (operator principal, role `operator`, owns the target channel), with a storage-layer invoker validation and an agent-denial test with zero row changes.
- Membership is interval-scoped: `collab_members.rejoined_seq` and a `max(afterCursor, rejoined_seq)` replay floor mean removed members never see removal-window content and new members never see pre-join content.
- Commands are partitioned into three explicit lock classes; the write lock subsumes the read lock; no upgrade path; assertion test added.
- Validation order fixed: NFC, then trim, then all bounds against normalized text, persisting the normalized form; U+0344 / e+U+0301 boundary fixtures added.
- `collab_cursors_principal_channel` index added with the `LIST_CHANNELS` access pattern stated.
- Timeline event object defined byte-exactly with the `nextCursor` convention.
- `channel_unarchived` subscription close reason registered.
- Credential verification made existence-oblivious via a decoy HMAC, with a timing-regression fixture.
- Storage validation 6 replaced with row-checkable conditions.
- Feature flags declared strictly nested with startup validation; Definition of Done expanded to the five valid configurations.
- `COLLAB_NOT_PERMITTED` reserved for `OPERATOR_GLOBAL`; channel-scoped denials always `COLLAB_NOT_FOUND`.
- `lastAcknowledgedCursor` defined as the caller's own, `"0"` when absent.
- Slices reworded as cumulative and sequentially gated.

Linter grew from 67 to 84 checks. v0.8 pre-gate: PASS 84/84. Builder handoff remains blocked pending independent v0.8 G1R. Agreed next step on a clean verdict: pivot to Slice 0 (builder: Haiku 4.5; G2A: Opus) so remaining defect classes are settled by executable artifacts.

## Cycle 7: pinned v0.7 at `1d981da`

Reviewer: `claude-opus-5`, isolated, empirical (Node.js NFC experiments, SQLite index verification). Verdict: Reject. Critical 2, High 4, Medium 4, Low 3. Receipt: `G1R-OPUS5-TCLAW-COLLABORATION-CYCLE-7.md`.

The two Criticals are notable for having survived earlier cycles:

- `CHANNEL_OWNER` predicate constrains the channel ("operator owns target channel" — true of every channel by construction) rather than the caller, granting any healthy agent archive/unarchive/membership administration over every channel. Present verbatim since v0.4; missed by Cycles 4-6.
- Retained-cursor re-add semantics (added in v0.7 per Cycle 6's cursor-lifecycle finding) certify replay of messages posted during a member's removal window; membership is a boolean, not an interval, so removal pauses rather than revokes content access.

Highs: lock-order self-contradiction for the seven commands that are both idempotency-keyed and authorization-state-changing; NFC normalization unordered relative to byte bounds (NFC is not length-preserving in either direction); `collab_cursors` unindexable for the `LIST_CHANNELS` access path despite the Section 14 gate claiming to check it; timeline event object shape never defined. All 13 conditions accepted for v0.8 disposition.

## Cycle 7 draft: v0.6 -> v0.7

All 13 Cycle 6 handoff conditions were accepted and closed directly in the consolidated v0.7 source. One disposition deviates deliberately from the receipt's literal wording, with rationale:

- The "operator-target guard" for credential commands is a clarification, not a prohibition: `CREATE_PRINCIPAL_CREDENTIAL` and `ROTATE_PRINCIPAL_CREDENTIAL` are explicitly valid for the operator principal, because they are the only way operator credentials are added and replaced (prohibiting them would contradict the `LAST_OPERATOR_CREDENTIAL` recovery design).
- The lock-discipline fix keeps in-memory buffer insertion under the sequencer mutex (bounded pointer work, ordering-critical) while moving frame encoding and all socket writes outside both locks with per-write read-lock acquisition — this satisfies the finding's substance (revocation latency independent of consumer queue depth) while preserving the single-fan-out-source ordering guarantee.

Other closures as recommended: encoded JSON message bound plus C0/C1 ban; per-channel `channel_seq` with `UNIQUE(channel_id,channel_seq)` and the global `seq` never exposed; contention branch deleted with serialization-assertion tests; credential expiry removed from v1 entirely; `PRINCIPAL_NOT_FOUND`/`CREDENTIAL_NOT_FOUND`/`INVALID_PRINCIPAL_STATE` registered with per-command mappings; `revoke-operator` authenticates with the recovery-kit passphrase; pagination frame rule generalized; `highWaterCursor` defined per-channel; cursor rows retained across membership and archive transitions; bidi/control character name bans; King Flowers named accountable owner for all risks (dated); `collab_audit_kind_created` index added.

Linter grew from 49 to 67 checks, adding the encoded-message-fits-frame arithmetic check and required/forbidden literals for every closure. v0.7 pre-gate: PASS 67/67. Builder handoff remains blocked pending independent v0.7 G1R.

## Cycle 6: pinned v0.6 at `cedae1f`

Reviewer: `claude-opus-5` (gpt-5.6-terra started the cycle, hit output limits mid-receipt, and was replaced per operator instruction; its partial output independently converged on the JSON-escape defect). Verdict: Reject. Critical 2, High 5, Medium 4, Low 2. This review verified claims empirically against SQLite 3.50.4 and measured actual frame encodings.

Accepted findings for disposition in v0.7:

- Critical: JSON escape expansion admits messages that commit but can never be delivered in any frame (bound message text by encoded size; forbid raw control characters).
- Critical: global `collab_events.seq` exposed as the wire cursor is a hidden-channel volume oracle (introduce per-channel `channel_seq`).
- High: fan-out lock discipline underdetermined (per-write read-lock acquisition; mutex released at commit).
- High: sequencer mutex makes the step-8 contention branch and mandated barrier tests unconstructible (delete step 8; assert serialization).
- High: `expired` credential state has no setter and defeats the `LAST_OPERATOR_CREDENTIAL` guard (remove expiry from v1).
- High: credential commands lack error codes for unknown/foreign/wrong-state targets (add `PRINCIPAL_NOT_FOUND`, `CREDENTIAL_NOT_FOUND`, `INVALID_PRINCIPAL_STATE`).
- High: `revoke-operator` requires a credential the operator may have lost (authenticate with the recovery-kit passphrase instead).
- Medium: generalize the frame-bound cut rule to all paginated results; define `highWaterCursor` scope; define cursor-row lifecycle; restrict name character classes.
- Low: named risk owners with a date; `collab_audit` index.

Receipt: `G1R-OPUS5-TCLAW-COLLABORATION-CYCLE-6.md`. Builder handoff remains blocked.

## Cycle 6 draft: v0.5 -> v0.6

All Cycle 5 findings were accepted and closed directly in the consolidated v0.6 source:

- Removed the 512 KiB page byte bound; a timeline page now ends at 100 events or the 64 KiB result-frame limit, whichever comes first.
- Replaced the `lower(name)` index with a persisted canonical `name_key` (NFC + Unicode Default Case Folding, Unicode 15.0, computed by `CollaborationStore`) and a unique active-key index; `CHANNEL_NAME_CONFLICT` is defined against the key.
- Defined archive delivery: archive closes live subscriptions with new subscription close reason `channel_archived`, purges unsent queues at the linearization point, and resubscribed members replay from durable backlog with no committed-event loss. Unarchive behaves identically.
- Regenerated the final status document with historical evidence labeled.

Linter updated in lockstep: `channel_archived` registry entry, `name_key` and archive-contract requirements, forbidden legacy literals, and a new cross-constraint feasibility check that no encoded byte bound exceeds the frame bound. v0.6 pre-gate: PASS 49/49. Builder handoff remains blocked pending independent v0.6 G1R.

## Cycle 5: pinned v0.5 at `f851aae`

All Cycle 4 findings were closed and the consistency pre-gate passed 40/40. Independent G1R returned `REJECT`: 0 Critical, 2 High, 1 Medium, and 1 Low. Accepted dispositions:

- Align timeline response size with the protocol frame limit.
- Replace SQLite `lower(name)` with enforceable canonicalization or restrict names to ASCII.
- Define archive subscription, buffering, and socket-write behavior.
- Make v0.5 consistency evidence canonical and label v0.4 evidence historical.

Builder handoff remains blocked. Receipt: `G1R-TERRA-TCLAW-COLLABORATION-CYCLE-5.md`.



## Cycle 5 draft: v0.4 -> v0.5

All Cycle 4 findings were accepted. v0.5 reorders authorization before idempotency, adds secret-redacted credential delivery and `CREATE_PRINCIPAL_CREDENTIAL`, defines one atomic keyed-write protocol, makes storage authority validation executable, separates session/subscription closure, defines safe rollback, and makes `node` fail strict frame validation. The consistency linter is updated in lockstep. Builder handoff remains blocked pending the v0.5 pre-gate and independent G1R.

## Cycle 4: pinned v0.4 at 2f40e3a

Verdict: Reject. Critical: 0. High: 3. Builder handoff remains blocked.

Accepted findings for disposition:

- Channel-scoped authorization must precede idempotency lookup so removed members and hidden resources cannot replay stored success or conflict responses.
- Credential mutation results must persist only secret-redacted data, always expose credential IDs, and define a recoverable issuance path after one-time delivery loss.
- Every keyed command needs one atomic `BEGIN IMMEDIATE` lookup/mutate/result protocol with deterministic duplicate-race behavior.
- Authority invariants need executable transaction validation or triggers and negative persistence fixtures.
- Session and subscription close reasons/lifecycles must be separated.
- Destructive rollback needs explicit backup, acknowledgement, downtime, data-loss boundary, and receipt requirements.
- The collaboration protocol must define deterministic handling for connection role `node`.

Receipt: `G1R-TERRA-TCLAW-COLLABORATION-CYCLE-4.md`.


**Canonical directory:** `E:\TorqClaw\docs\prd-reviews`
**Date:** 2026-08-06

## Cycle 1: v0.1 -> v0.2

Verdict: Reject. All Critical/High findings accepted.

- Added explicit authority concepts and matrix.
- Added epoch/linearization revocation model.
- Removed task bridge, search, Git, threads, reactions, edits, and hash chain.
- Added state, schema, credential, and hidden-channel contracts.

## Cycle 2: v0.2 -> v0.3

Verdict: Reject. All Critical/High findings accepted.

- Added offline recovery transition and gateway modes.
- Added strict v2 envelopes and command/event allowlists.
- Bound credentials to sessions/subscriptions.
- Added migration, denial precedence, and commit/high-water ordering.
- Removed tombstones and channel rename from v1.

## Cycle 3: v0.3 -> v0.4

Verdict on v0.3: Reject; zero Critical, five High. All five accepted.

- Replaced universal authorization validation with operation-scoped predicates.
- Added operator connect.
- Added `LIST_CHANNELS` and `ACK_CHANNEL_CURSOR`.
- Made rotation replace one named credential.
- Replaced layered migration prose with executable DDL.
- Froze benchmark values in the PRD.
- Consolidated the source.

## Post-cycle source audit

Three additional blockers were accepted:

- Added `SUSPEND_AGENT`, `RESTORE_AGENT`, and `REVOKE_AGENT`.
- Regenerated `collab_events.kind` directly from the protocol event allowlist and removed tombstone columns.
- Added mandatory encrypted offline export of both peppers and recovery secret.

Five consistency conflicts were accepted and normalized:

- message: 1-16,384 UTF-8 bytes;
- timeline: 100 events and 512 KiB;
- slow consumer: 1 MiB or 10 seconds, `SLOW_CONSUMER`;
- authentication rate limit: 5/credential and 20/address per 5 minutes, 15-minute lockout;
- idempotency: UUID keyed by principal+command in `collab_mutation_results`.

## Rejected reviewer suggestions

None. Scope-reducing recommendations were preferred where they preserved the product outcome.

## Current state

v0.4 is a consolidated candidate. Builder handoff remains blocked until the deterministic consistency pre-gate and a new independent G1R pass with no Critical/High findings.

## Final v0.4 hardening pass

The post-consolidation audit was accepted in full:

- Added an offline, authenticated, exclusive-lock operator-revocation procedure.
- Restored zero usable operator credentials as a `locked_recovery` condition and prohibited revoking the final active operator credential.
- Removed `auth_epoch` increments from credential rotation/revocation so unrelated credential sessions remain valid.
- Registered `AUTH_FAILED`, `CHANNEL_NAME_CONFLICT`, `CURSOR_OUT_OF_RANGE`, and `LAST_OPERATOR_CREDENTIAL`.
- Classified `ACK_CHANNEL_CURSOR` as naturally idempotent without mutation-result growth.
- Added `secrets restore` and the explicit recovery-pepper Credential Manager location.
- Added indexes for channel discovery and principal credential lookup.
- Replaced the stale `D.2` reference with Section 7.5.
- Defined create/unarchive name-collision behavior.

No finding was rejected. No new precedence layer was created; all changes were made directly in the consolidated v0.4 source.

## Consistency pre-gate implementation

The final Medium/Low audit was accepted:

- Added domain-separated principal/recovery pepper checks verified at startup.
- Enumerated and constrained all session close reasons.
- Classified every command as idempotency-keyed, naturally idempotent, or no-key.
- Stated that failures are never persisted as mutation results.
- Added display-name validation and minor command/error behavior.
- Added doctor reporting for mutation-result growth.

`scripts/lint_collaboration_prd.py` is the deterministic Section 14 gate. Its generated report records the executable result.

## Corruption incident and repair

Applying the final hardening edits via PowerShell regex replacement expanded `$1` captures as empty shell variables and silently deleted matched lines from v0.4. The linter correctly failed (`missing section: ### 8.1 Session binding`). Repair on 2026-08-06 restored seven lost items from a verified pre-corruption copy: the 6.2, 7.1, and 8.1 headings; the Section 6.3 bootstrap paragraph; the Section 7.4 channel-collision paragraph; the Section 9 transaction-checks sentence and Section 14 extended-rules paragraph; and the `recovery_secret_hmac` column in `collab_installation`. All intended hardening additions were preserved.

One linter defect was also fixed: the forbidden-literal check substring-matched, so the legacy `4 MiB` ban fired on the Argon2id `64 MiB` parameter. The check is now boundary-aware. After repair and linter fix: PASS, 34/34 checks, exit 0, report `PRD-TCLAW-COLLABORATION-V0.4-CONSISTENCY-REPORT.md`.

Process rule adopted: structured patching only for document edits; PowerShell regex replacement with `$` captures is prohibited in workspace guidance (`TORQCLAW_CLAUDE.md`, "Shell Editing Safety").
