# TORQCLAW Collaboration PRD Synthesis Log

## Slice 0 Cycle 1: build, G2A REJECT, and v0.14 (2026-08-06)

The pivot's first full turn validated the executable-gate thesis in both directions. The Haiku 4.5 builder produced `packages/collab` + `tests/collab` with 928/928 unit tests green and a byte-identical Section 9 DDL — and the Opus 4.8 G2A audit still rejected it with 4 Critical / 3 High / 2 Low, every Critical empirically reproduced twice (receipt: `G2A-OPUS-TCLAW-COLLABORATION-SLICE0-CYCLE-1.md`). The headline findings: an escape-parity bug making the duplicate-key pre-scanner reject 61% of valid JSON frames, non-finite detection that accepts `9e308` as `Infinity`, a deterministic UUID generator with 5 collisions per 100k plus cross-seed sequence collisions, and a tautological test suite that could not catch any of it. The audit run was interrupted once by a session usage limit and resumed with evidence intact.

One finding was a defect in the contract itself, unreachable by twelve document reviews: Section 7.1's uniform trim-then-validate rule contradicts Section 10's pinned all-LF accept fixture (8,192 LF trims to empty). v0.14 resolves it — trimming is names-only, message text is never trimmed — and ratifies the builder's `collab_schema_migrations` version table into the Section 9 DDL with explicit no-op re-run semantics. Nothing else changed. Linter 159 → 163; negative control: v0.13 fails exactly the five new/changed checks. v0.14 pre-gate: PASS 163/163.

Code fix pass (Haiku 4.5) launched against the eight G2A conditions; the build remains uncommitted until re-audit passes.

## v0.13 and Slice 0 pivot (operator decision 2026-08-06)

Operator decision: option (a) — draft v0.13 closing all nine Cycle-12 conditions, then pivot to Slice 0 with no thirteenth document review. The G1R document loop is retired; verification authority transfers to executable gates (Section 10 fixtures, deterministic tests, Section 14 linter) built by Haiku 4.5 with Opus 4.8 as G2A auditor, per the standing model-role contract. Builders and auditors are instructed to launch subagents for parallelizable work.

v0.13 closures: `membership_epoch` pinned as a per-membership-row counter with own-row-only subscription revalidation and `authorization_lost` bound to epoch mismatch; `ADD_CHANNEL_MEMBER` and `RESTORE_AGENT` moved to the authorization-mutation lock class with a subscription-survival fixture; `RESTORE_AGENT` semantics defined (epoch increment, defensive `principal_restored` close reason in both registries, fresh-key same-state rule, zero-session fixture); the three timeline fixtures pinned to exact contents (one max-size event; 100 one-byte events; four max-size committed returning exactly three); `LIST_CHANNELS` `hasMore` defined and the disjunctive capacity fixture replaced with pinned 100/101-channel outcomes; the unreachable Section 4.1 stored-status clause replaced with the mechanism-based statement; Section 9 validation 5 restated inline with both bound branches and a re-added-at-head fixture; the unmapped-scalar fold rule and no-post-fold-normalization rule added; revocation-phase observations apportioned 450/450/100 per mutation kind; Section 16 delegation decision deadlines added at slice-gate reviews.

Linter grew from 132 to 159 checks; every new check verified to FAIL against v0.12 (negative control) and PASS against v0.13. v0.13 pre-gate: PASS 159/159, report `PRD-TCLAW-COLLABORATION-V0.13-CONSISTENCY-REPORT.md`.

## Cycle 12: pinned v0.12 at `201c972`

Reviewer: `claude-opus-5`. Verdict: Reject — 0 Critical, 2 High, 4 Medium, 3 Low. Receipt: `G1R-OPUS5-TCLAW-COLLABORATION-CYCLE-12.md`. Both Highs are latent holes in machinery introduced in v0.5-v0.7 and only now reached by review depth: `membership_epoch` scope was never stated (per-row vs per-channel decides whether adding a member disconnects existing subscribers), and `RESTORE_AGENT`'s epoch/session/lock-class semantics were never pinned.

Program trajectory across the Opus era: 2C/5H, 2C/4H, 0C/4H, 0C/2H, 0C/1H, 1C/4H, 0C/2H. The verdict has oscillated in the 1-4 High band for four consecutive cycles. Every remaining finding class — lock-class assignment, epoch scoping, byte-fixture pinning, benchmark apportionment — is a question that Slice 0 executable artifacts answer mechanically on first implementation. Recorded for the operator's decision: draft v0.13 closing the 9 Cycle-12 conditions and continue cycling, or close them and pivot to Slice 0 with the G1R loop retired in favor of executable gates plus G2A audit.

## Cycle 12 draft: v0.11 -> v0.12 (and Cycle 11 verdict)

Cycle 11 (opus-5, pinned `fe20293`): Reject — 1 Critical, 4 High, 4 Medium, 2 Low. The count regressed from Cycle 10's 0C/1H because most findings live in text added by v0.10/v0.11 itself: the v0.10 "only predicate-passers observe CHANNEL_ARCHIVED" precedence sentence turned the long-standing state-bearing `CHANNEL_WRITABLE` predicate into a hard contradiction (Critical); the v0.9-v0.11 `rejoined_seq`/cursor machinery carried an undocumented own-history truncation, an unsatisfiable first-ack predicate, and a dead floor formula. Receipt: `G1R-OPUS5-TCLAW-COLLABORATION-CYCLE-11.md`, including an extensive verified-sound list (all byte fixtures exact, no deadlocks across lock classes, no content or hidden-channel leaks).

All 10 conditions closed in v0.12: state-free `CHANNEL_WRITABLE`/`CURSOR_OWNER` predicates with the archived check at step 8 and a predicate state-purity rule; re-add truncation documented as a deliberate v1 simplification with pinned sequence-number fixtures; ack upsert-from-zero; `LAST_OPERATOR_CREDENTIAL` extended to sole-credential rotation with the create-verify-revoke sequence; vendored Unicode 15.0 `CaseFolding.txt` as the normative fold source with conflict fixtures and a startup version assertion; rotation result shapes pinned for both responses; `revokedAt` added to the determinism-harness enumeration; `@node-rs/argon2` named with a scrypt fallback and slice-2/risk-table entries; all Section 7.1 bounds assigned to precedence step 3 with the oversize-versus-hidden fixture; tautological validation-6 conjunct dropped (restated as a doctor invariant) and pepper rotation explicitly excluded from v1.

Linter grew from 119 to 132 checks. v0.12 pre-gate: PASS 132/132.

## Cycle 11 draft: v0.10 -> v0.11 (and Cycle 10 verdict)

Cycle 10 (opus-5, pinned `9fdc95b`): Reject — 0 Critical, 1 High, 4 Medium, 4 Low. The sole High is purely additive: byte-for-byte fixtures need a determinism harness for server-generated UUIDs and timestamps. The receipt also explicitly tested and refuted six hostile readings (lock ordering, rejoined_seq consistency, all byte-fixture arithmetic, flag matrix, SQLite index coverage) rather than padding severity. Receipt: `G1R-OPUS5-TCLAW-COLLABORATION-CYCLE-10.md`.

All 9 findings closed in v0.11: Section 10 determinism harness (injected clock pinned at 2026-01-01T00:00:00.000Z advancing 1 ms per timestamp; per-fixture seeded UUID generator; covers all server-generated fields including credential secret bytes); revocation-boundary measurement defined (commit return to write-lock release, pre-commit writes excluded); sequential benchmark phases with a 1,000-observation revocation floor supplied by suspend/restore and archive/unarchive pairs over a 100-agent pool; `nextChannelId` defined for normal and empty pages with an advancement fixture; `secrets verify` given a full invocation with decrypt-with-passphrase semantics, `recovery_kit_verified_at`, and a new `recovery_kit_verified` audit kind; duplicate-key parser trap flagged with an `INVALID_FRAME` fixture; frame bound stated as raw UTF-8 bytes; agent-ownership shape documented as deliberately application-enforced; Node.js pinned at 22.11.0 for gate measurements.

Linter grew from 107 to 119 checks. v0.11 pre-gate: PASS 119/119. Convergence: 2C/5H -> 2C/4H -> 0C/4H -> 0C/2H -> 0C/1H across the Opus era. Builder handoff remains blocked pending independent v0.11 G1R; Slice 0 pivot on a clean verdict.

## Cycle 10 draft: v0.9 -> v0.10 (and Cycle 9 verdict)

Cycle 9 (opus-5, pinned `8348ae2`): Reject — 0 Critical, 2 High, 4 Medium, 3 Low; rubric 5 Pass / 2 Partial / 0 Fail; every pinned byte fixture verified exactly. Receipt: `G1R-OPUS5-TCLAW-COLLABORATION-CYCLE-9.md`.

Dispositions in v0.10 — one is a deliberate scope decision:

- High (count oracle): dense absolute per-channel cursors inherently disclose event counts to current members across their own membership gaps, on three success paths. Rather than redesign to a relative cursor space, v0.10 takes the receipt's sanctioned alternative: the unsatisfiable non-disclosure claim and its acceptance bullet are removed, and Section 7.4 documents count-metadata visibility to current members as accepted v1 behavior. Content confidentiality and hidden-channel indistinguishability are unchanged.
- High (close-frame delivery): Section 8.2 gains an explicit post-lock delivery step — close reasons are recorded and queues purged under the write lock; the close frame is delivered after release with no revalidation and is the final frame on the subscription.
- Mediums: `CHANNEL_ENUMERABLE` predicate for `LIST_CHANNELS`; two-phase Section 15 load specification (10-client baseline, 25-reader writer-preference phase); loopback exemption from the address-level lockout; both credential-response shapes pinned with a presence rule.
- Lows: epoch phrasing split; archived-error precedence sentence; startup remediation for orphan session bindings.

Linter grew from 97 to 107 checks. v0.10 pre-gate: PASS 107/107. Builder handoff remains blocked pending independent v0.10 G1R; Slice 0 pivot on a clean verdict.

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
