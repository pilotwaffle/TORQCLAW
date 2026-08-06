# G1R Receipt - TORQCLAW Collaboration Substrate - Cycle 2

- Date: 2026-08-06
- Reviewer model: `gpt-5.6-terra`
- Reviewer role: independent G1R
- Context isolation: reviewer received only PRD v0.2 and the rubric
- Verdict: `REJECT`
- Builder handoff: `BLOCKED`

## Verbatim reviewer output

King Flowers,

## VERDICT: REJECT

The PRD is strong on scope control and identifies the right invariants, but it is not implementation-ready. Critical recovery-state contradictions and missing normative protocol/persistence contracts permit materially different, unsafe implementations.

## Critical findings

1. **Recovery cannot produce a valid authorized operator**
   - **Section:** `6.3 Backup and key loss`, `7.1 Principal`, `4.1 Authority model`
   - **Why:** Recovery says an authenticated “existing TORQCLAW bootstrap authority” may mint a replacement operator credential after the operator is revoked. That authority is undefined. A revoked principal cannot be restored, and a new operator would not own the existing agents or channels. The PRD defines no ownership-transfer state transition. Recovery is therefore either impossible or becomes an undefined local privilege-escalation path.
   - **Correction:** Define one recovery authority and its credentials, transport, audit record, prerequisites, and command. Add an explicit atomic recovery transition: either restore the original operator under a defined exceptional state, or create a replacement operator and atomically transfer all agent/channel ownership while incrementing all affected authorization epochs and closing sessions. Define recovery failure and rollback behavior.

2. **Wire protocol is not implementable as a deterministic interoperability contract**
   - **Section:** `11 Protocol and errors`, `11.1 ConnectFrame v2`, `11.2 Commands`
   - **Why:** The PRD names frames and commands but does not define their request/response/event schemas, required and server-derived fields, correlation/idempotency fields, success payloads, event-delivery envelope, subscription state frames, cursor encoding, error mapping, or v1/v2 negotiation/rejection behavior. “Strict schema” is a requirement, not the schema itself. Different gateway, client, and test implementations will diverge.
   - **Correction:** Add normative Zod-equivalent definitions or an appendix for every command and event: request, response, delivery frame, error payload, field limits, nullability, server-assigned values, protocol-version negotiation, and exact session/credential binding. Include byte-level fixtures for success, denial, replay, subscribe, unsubscribe, slow-consumer closure, and resume failure.

3. **Tombstone projection is undefined and can leak removed content**
   - **Section:** `7.4 Message and tombstone`, `10.1 Event payload schemas`, `12 Functional requirements`, `16 Messages and replay`
   - **Why:** The PRD says tombstones hide text from “normal rendering” while preserving source records, but never defines what `GET_CHANNEL_TIMELINE`, backlog replay, live delivery, caches, or exported client state return for tombstoned messages. A gateway could send original text and rely on one UI renderer to hide it, leaking it through replay, logs, or future clients.
   - **Correction:** Define a single authorized event projection contract. Specify whether a tombstoned source is omitted, replaced by a fixed redacted message frame, or returned with text removed; apply it identically to timeline, backlog, live events, and client cache. Add acceptance tests proving no authorized collaboration API response after tombstoning contains the original text.

## High findings

1. **Credential revocation is not bound to live sessions/subscriptions**
   - **Section:** `6.2 Lifecycle`, `8.1 Epochs`, `8.2 Coordinator and linearization`, `11.1 ConnectFrame v2`
   - **Why:** Rotation revokes an old credential, but subscriptions retain only principal/member/channel epochs. The session contract persists principal and role, not credential ID. “Credential state where applicable” leaves live-session revocation behavior undefined, so an implementation may allow a socket authenticated by a revoked credential to continue receiving or posting.
   - **Correction:** Persist `credentialId` on the session and subscription authorization context. Define whether revoking a credential increments a credential/session epoch or explicitly closes every bound session under the coordinator. Require pre-command and pre-write credential validation, and add concurrent rotation/revocation acceptance tests.

2. **The migration and SQLite enforcement contract is incomplete**
   - **Section:** `10 Data and integrity contract`, `15 Slice 0`, `16 Compatibility and operations`
   - **Why:** The target tables are specified, but the exact migration is deferred as a Slice 0 artifact. There is no schema-version transition, transaction boundary, `PRAGMA foreign_keys` requirement, index plan beyond one index, WAL prerequisite, migration failure behavior, or compatibility mapping to the accepted Phase 1 database. “Equivalent names are allowed” weakens a contract that must be mechanically enforced.
   - **Correction:** Include the normative migration identifier, ordered statements, required SQLite pragmas, indexes, transaction/rollback behavior, startup migration policy, doctor invariants, and Phase 1 compatibility conditions. Require a migration fixture from the named accepted baseline schema.

3. **Channel rename has no persisted event or replay contract**
   - **Section:** `11.2 Commands`, `10 collab_events.kind`, `10.1 Event payload schemas`, `7.3 Channel`
   - **Why:** `RENAME_CHANNEL` is authorized and listed as a command, but there is no `channel_renamed` event kind, payload, idempotency policy, state transition, replay behavior, or acceptance criterion. Clients can disagree on a channel name during reconnect/replay.
   - **Correction:** Either defer rename from v1 or define its immutable lifecycle event, payload, actor, transaction, idempotency requirement, event projection, replay ordering, and tests.

4. **Subscribe/high-water correctness lacks a required commit-to-buffer ordering contract**
   - **Section:** `8.2 Coordinator and linearization`, `9 Replay and cursor contract`
   - **Why:** The PRD requires no gaps or duplicates across backlog and buffered live events, but does not normatively serialize event commit/fan-out with subscription registration and high-water capture. The coordinator only governs authorization revocation and socket writes. Implementations can lose an event committed at the registration/high-water boundary.
   - **Correction:** Specify one concurrency algorithm: subscription registration and snapshot capture must occur in a defined order relative to event commit and buffer insertion, with transaction visibility rules and a single event-fan-out source. Add deterministic interleaving tests for events committed before registration, during high-water capture, during backlog, and at live-mode transition.

5. **Owner replacement and channel/agent ownership invariants are not enforceable after recovery**
   - **Section:** `4.1`, `7.1`, `10 Additional transaction checks`
   - **Why:** The PRD requires every agent to be owned by the operator and each channel owner to be the active operator. It does not define what happens to those foreign-key relationships after the sole operator is revoked and replaced. Existing records make the stated invariant fail.
   - **Correction:** Add recovery ownership-transfer rules and SQL/application invariants for `principals.owner_principal_id`, `collab_channels.owner_principal_id`, owner memberships, and all affected epochs. Include a restore-from-backup acceptance test proving the recovered operator can safely administer preexisting channels and agents.

6. **Authorization and denial behavior remain incomplete for command/resource combinations**
   - **Section:** `4.2 Normative authorization matrix`, `11.3 Externally observable denial contract`
   - **Why:** The matrix covers action classes, but does not define outcome precedence for multiple invalid conditions, such as revoked credential plus hidden channel, malformed UUID plus unauthorized channel, archived channel plus removed membership, or stale session plus valid principal. These choices affect enumeration resistance, telemetry, and tests.
   - **Correction:** Define validation and denial precedence for every collaboration command. State which failures use indistinguishable `COLLAB_NOT_FOUND`, which return `COLLAB_NOT_PERMITTED`, and which are schema/session errors before resource lookup. Add fixtures for compound-invalid requests.

## Medium findings

1. **Tombstone uniqueness depends on unstated transactional behavior**
   - **Section:** `10 collab_events`, `10 Additional transaction checks`, `7.4`
   - **Why:** The schema permits multiple `message_tombstoned` rows targeting one source event when different idempotency keys are used. The prose says a target must not already be tombstoned, but does not require a serialization strategy or a database-level uniqueness mechanism.
   - **Correction:** Add a partial unique index or a dedicated tombstone projection table keyed by target event ID, plus the required write transaction mode and concurrent-tombstone test.

2. **Performance gates lack a fixed reference environment at the point the requirements are approved**
   - **Section:** `3`, `14`, `20`
   - **Why:** The latency targets are measurable, but the reference hardware is deferred until before Slice 2. This allows the target environment to be selected after implementation, weakening the release gate.
   - **Correction:** Define the minimum Windows reference machine, SQLite configuration, database placement, concurrency harness, and percentile calculation now. Permit stronger hardware as supplemental evidence only.

3. **State-changing command contracts omit idempotency requirements outside message/tombstone operations**
   - **Section:** `6.2`, `7`, `11.2`, `10 Additional transaction checks`
   - **Why:** Idempotency is mandatory only for message and tombstone writes. Retry behavior for creation, rotation, membership changes, archive/unarchive, and rename is unspecified. Network retries can create conflicting principals/credentials or ambiguous command results.
   - **Correction:** Require command IDs/idempotency keys for every externally retriable mutation, or explicitly define each mutation as naturally idempotent with its stable lookup key and canonical response.

4. **“Exactly one active operator” has no explicit healthy-state invariant following bootstrap and recovery**
   - **Section:** `4.1`, `10 principals`, `6.3`
   - **Why:** The partial unique index prevents multiple non-revoked operators but does not guarantee one active operator. Locked recovery may be intended, but the healthy/locked mode transition and its administrative observability are not defined.
   - **Correction:** Define gateway modes: uninitialized, healthy, locked recovery, and migration. State the allowed operator cardinality and permitted commands in each mode, with doctor checks and acceptance tests.

## Low findings

1. **Channel-name requirements are underspecified**
   - **Section:** `10 collab_channels`, `11.2`
   - **Why:** Name normalization, maximum length, duplicate-name policy, and rename audit behavior are absent.
   - **Correction:** Define canonical normalization, limits, duplicate policy, and display behavior.

2. **Rate-limit persistence and reset semantics are unspecified**
   - **Section:** `6.2 Credential lifecycle`
   - **Why:** It is unclear whether lockouts survive restart, how remote addresses are normalized, and how rate-limit state is audited without leaking credential identifiers.
   - **Correction:** Define storage scope, reset behavior, address normalization, bounded telemetry labels, and operator-visible recovery steps.

## Rubric score

| Criterion | Result | Assessment |
|---|---|---|
| Problem, target user, measurable outcome | Pass | Explicit and measurable. |
| Scope and non-goals | Pass | Strong boundary against execution and collaboration creep. |
| Testable flows, edge cases, acceptance | Partial | Extensive tests, but recovery, wire protocol, tombstone projection, and compound denial behavior are incomplete. |
| Functional/NFR, dependencies, data, security, accessibility | Partial | Strong intent; persistence, recovery, protocol, and concurrency requirements remain materially incomplete. |
| Assumptions, risks, owners, deadlines | Partial | Risks and roles are visible, but the recovery authority and ownership-replacement decision are unresolved. |
| Analytics, rollout, rollback, support | Partial | Proportionate coverage, but rollback/recovery cannot be executed safely under the current state model. |
| Feasible, independently verifiable slices | Partial | Sensible sequencing, but Slice 1 cannot safely begin without resolving the critical contracts. |

**Score: 4.5 / 7.0.** Per the rubric, critical and high failures block approval.

## Scope reduction / sequencing

1. Make Slice 0 a true contract-remediation gate before implementation:
   - Recovery authority and ownership-transfer design.
   - Full protocol schema and fixtures.
   - Migration specification.
   - Credential-to-session revocation binding.
   - Subscribe/commit ordering proof.

2. Defer `TOMBSTONE_CHANNEL_MESSAGE` unless the projection/redaction contract is completed. Immutable messages, membership, replay, and revocation form a smaller independently valuable core.

3. Defer `RENAME_CHANNEL` unless it receives a lifecycle-event and replay contract.

## BUILDER_HANDOFF: BLOCKED

Builder handoff becomes **READY** only when all conditions are met:

1. Recovery has a defined, authenticated authority and an atomic valid transition from revoked/locked state to a healthy single-operator state, including agent/channel ownership handling.
2. Every command, event, response, error, subscription frame, and protocol-version behavior has a normative schema and fixture.
3. Credential revocation and rotation are explicitly bound to sessions/subscriptions and covered by pre-command, pre-write, and concurrency tests.
4. Tombstone behavior defines the API projection for timeline, backlog, live delivery, and client cache, with no post-tombstone text disclosure.
5. The SQLite migration, startup behavior, required pragmas, indexes, transaction boundaries, and accepted Phase 1 migration fixture are normative.
6. The subscribe/high-water/event-commit concurrency algorithm is defined and deterministically testable.
7. `RENAME_CHANNEL` is either fully contracted or removed from v1 scope.
