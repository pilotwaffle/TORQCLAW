# Normative Contract Addendum - PRD-TCLAW-COLLABORATION-SUBSTRATE-001 v0.3

**Date:** 2026-08-06
**Status:** Candidate after G1R Cycle 2 remediation
**Precedence:** This addendum is part of v0.3 and supersedes conflicting text in v0.2.

## A. Frozen v1 scope

The v1 command and event allowlists below are exhaustive. Features not named are unavailable.

Included: one human operator principal; managed agent principals; session-bound revocable credentials; private channels and membership; immutable text messages; backlog, live subscription, reconnect, and cursor resume; archive/unarchive; minimal operator UI and recovery CLI.

Removed from v1: message tombstones/deletion, channel rename, edits, reactions, threads, search, Git, task bridge, hash chains, federation, media, and multiple human operators.

## B. Gateway modes and recovery

| Mode | Durable condition | Allowed operations |
|---|---|---|
| `uninitialized` | zero operators and no completed bootstrap | local bootstrap only |
| `healthy` | exactly one active operator and valid schema | normal v2 protocol |
| `locked_recovery` | operator revoked, no usable operator credential, or invariant failure | health, doctor, backup, offline recovery |
| `migration` | exclusive migration active or failed | health only |

Startup derives mode before opening collaboration listeners. Other states are startup errors.

The sole recovery authority is the local Windows account owning the TORQCLAW data directory plus the installation recovery secret. Bootstrap generates 32 CSPRNG bytes, displays `tqr1_<base64url>` once, stores only `HMAC-SHA-256(recoveryPepper, secret)` in SQLite, and stores the pepper in Windows Credential Manager under `TORQCLAW/recovery-pepper`.

Recovery is offline only:

`torqclaw collab recover-operator --database <absolute-path> --recovery-key-stdin`

Prerequisites: gateway stopped; caller owns database and parent directory by Windows ACL; exclusive database lock; constant-time key validation; successful backup before mutation.

One `BEGIN IMMEDIATE` transaction MUST reactivate the existing sole operator (the only legal `revoked -> active` transition), increment its `auth_epoch`, revoke all operator and managed-agent credentials, increment all managed-agent auth epochs, increment every channel and membership epoch, insert a secret-free `recovery_completed` audit record, create one replacement operator credential hash, then commit. Print plaintext once only after commit. Failure rolls back and leaves `locked_recovery`. Ownership IDs do not change. Lost recovery secret requires restoring a verified healthy backup. Startup closes all pre-recovery sessions. Tests prove old credentials/sockets fail and the recovered operator controls all existing agents/channels.

## C. Credential/session binding

Sessions persist `session_id, protocol_version, connection_role, principal_id, credential_id, auth_epoch_snapshot, created_at, closed_at, close_reason`. Subscriptions retain session, principal, credential, and auth/member/channel epoch snapshots.

Credential revocation/rotation linearizes at SQLite commit under the authorization write lock. The same critical section revokes the credential, increments principal auth epoch, closes every bound session with `credential_revoked`, removes subscriptions, and schedules socket close.

Every command and socket write holds the authorization read lock and validates: session open; credential active/unexpired; principal active; matching auth epoch; active membership; matching member epoch; active channel; matching channel epoch. No write begins after the revocation commit.

## D. Normative protocol v2

Frames are UTF-8 JSON objects. Reject unknown fields, duplicate keys, non-finite numbers, and frames over 64 KiB. IDs are canonical lowercase UUIDs. Server timestamps are RFC 3339 UTC milliseconds. Channel names are NFC-normalized, trimmed, 1-80 scalars, unique case-insensitively among active channels. Message text is NFC-normalized and 1-16,384 UTF-8 bytes.

Client connect:
`{"type":"connect","protocolVersion":2,"role":"channel","credential":"<secret>","requestId":"<uuid>"}`

The server derives principal and credential ID from the credential; clients never submit principal ID. Non-v2 returns `UNSUPPORTED_PROTOCOL` and closes. Protocol v1 stays unchanged and cannot issue v2 commands.

Connected:
`{"type":"connected","protocolVersion":2,"requestId":"<uuid>","sessionId":"<uuid>","principal":{"id":"<uuid>","kind":"operator|agent"},"serverTime":"<timestamp>"}`

Request:
`{"type":"command","protocolVersion":2,"requestId":"<uuid>","command":"<name>","idempotencyKey":"<uuid|null>","body":{}}`

Success:
`{"type":"result","protocolVersion":2,"requestId":"<uuid>","ok":true,"body":{}}`

Failure:
`{"type":"result","protocolVersion":2,"requestId":"<uuid>","ok":false,"error":{"code":"<code>","message":"Request could not be completed","retryable":false}}`

Delivery:
`{"type":"channel_event","protocolVersion":2,"subscriptionId":"<uuid>","channelId":"<uuid>","cursor":"<decimal-seq>","event":{"id":"<uuid>","kind":"<kind>","actorPrincipalId":"<uuid>","occurredAt":"<timestamp>","payload":{}}}`

Subscription state:
`{"type":"subscription_state","protocolVersion":2,"requestId":"<uuid|null>","subscriptionId":"<uuid>","channelId":"<uuid>","state":"backlog|live|closed","highWaterCursor":"<decimal-seq>","reason":"<code|null>"}`

Cursor is unsigned base-10 `collab_events.seq` without leading zeroes; `0` means before first event.

### D.1 Exhaustive commands

All mutations require an idempotency UUID. Repeating principal+command+key returns the original result; changed canonical body returns `IDEMPOTENCY_CONFLICT`.

- `CREATE_AGENT {displayName} -> {principalId,credential}`, operator only.
- `ROTATE_PRINCIPAL_CREDENTIAL {principalId} -> {credentialId,credential}`, operator only.
- `REVOKE_PRINCIPAL_CREDENTIAL {credentialId} -> {credentialId,revokedAt}`, operator only.
- `CREATE_CHANNEL {name} -> {channelId,name}`, operator only.
- `ADD_CHANNEL_MEMBER {channelId,principalId} -> {channelId,principalId,memberEpoch}`, operator only.
- `REMOVE_CHANNEL_MEMBER` with same body/result, operator only; owner cannot be removed.
- `ARCHIVE_CHANNEL {channelId} -> {channelId,archivedAt,channelEpoch}`, operator only.
- `UNARCHIVE_CHANNEL {channelId} -> {channelId,channelEpoch}`, operator only.
- `POST_CHANNEL_MESSAGE {channelId,text} -> {eventId,cursor,occurredAt}`, active member.
- `GET_CHANNEL_TIMELINE {channelId,afterCursor,limit:1..500} -> {events,nextCursor,hasMore}`, active member.
- `SUBSCRIBE_CHANNEL {channelId,afterCursor} -> {subscriptionId,highWaterCursor}`, active member.
- `UNSUBSCRIBE_CHANNEL {subscriptionId} -> {subscriptionId,state:"closed"}`, owning session.

Secrets are one-display values and never stored replayably. A retried create/rotate confirms success with `credentialAvailable:false`; losing the secret requires explicit rotation.

### D.2 Exhaustive collaboration events

- `channel_created: {channelId,name}`
- `member_added: {channelId,principalId,memberEpoch}`
- `member_removed: {channelId,principalId,memberEpoch}`
- `message_posted: {channelId,text}`
- `channel_archived: {channelId,archivedAt,channelEpoch}`
- `channel_unarchived: {channelId,channelEpoch}`

Payloads contain exactly listed keys. Actor is in the envelope. Recovery/credential audit events are never delivered through channel timelines.

### D.3 Denial precedence

Order: framing limits -> protocol -> envelope/schema/UUID -> session/credential/principal -> idempotency -> resource authorization -> resource state/command validation.

A syntactically valid absent, hidden, archived-hidden, or non-member channel returns identical `COLLAB_NOT_FOUND` status, fixed message, and body. An authorized member sees `CHANNEL_ARCHIVED`. Active agents attempting operator-only non-resource commands receive `COLLAB_NOT_PERMITTED`. Malformed IDs return `INVALID_REQUEST` before lookup.

Conformance fixtures cover revoked credential+hidden channel, malformed ID+unauthorized resource, removed membership+archived channel, stale session+valid principal, and idempotency conflict+hidden channel.

### D.4 Required fixtures

Slice 0 freezes compact byte fixtures for connect, unsupported version, every command success, denial classes, replay, backlog-to-live, unsubscribe, credential-revoked close, slow consumer, resume success/gap, and idempotency conflict. Key order is canonical in fixtures but decoders ignore order.

## E. SQLite migration

Migration ID: `20260806_001_collaboration_v1`. Require SQLite 3.35+, `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=FULL`, and `busy_timeout=5000`. Verify each before listeners open.

Under `BEGIN EXCLUSIVE`, create the exact v0.2 tables (no equivalent-name substitution), add session credential binding and required indexes, set schema version last, then commit. Error rolls back entirely and leaves listeners closed in migration failure mode.

Required indexes: unique active operator; unique `lower(channel.name)` for active channels; unique mutation result on `(principal_id,command,idempotency_key)`; events `(channel_id,seq)` and `(channel_id,occurred_at)`; memberships `(principal_id,channel_id)`; credentials `(principal_id,revoked_at,expires_at)`; sessions `(credential_id,closed_at)`.

Slice 0 records the accepted Phase 1 commit and uses its created database as migration fixture. Migration preserves all Phase 1 task, receipt, approval, event, and session rows. `torqclaw doctor` verifies schema/pragmas/foreign keys, one active operator in healthy mode, agent/channel ownership, owner memberships, and no orphan events. No downgrade after writes; rollback disables v2 and restores the mandatory backup.

## F. Commit/fan-out/replay ordering

One collaboration sequencer mutex and one fan-out source are mandatory.

Subscribe: under mutex register `backlog` and capture max committed channel seq; release; send authorized events `afterCursor < seq <= highWater` ascending. New commits above high water buffer for the subscription. Under mutex drain ascending with seq deduplication, then mark `live`.

Writer: under the same mutex run `BEGIN IMMEDIATE`, insert, commit, append the committed event to each eligible subscription buffer, then release. Rolled-back events never fan out. Authorization loss closes subscription and discards buffer under authorization write lock.

Barrier tests cover before registration, registration/high-water, backlog, commit/buffer boundary, and live transition. Output equals ascending authorized DB sequence with no gap/duplicate.

Slow consumer means queued encoded frames over 1 MiB or oldest frame over 10 seconds. Send closed state with `SLOW_CONSUMER` when writable, then close. Resume uses last fully received cursor.

## G. Operational contracts

Reference environment: Windows 11, 4 logical CPUs, 8 GiB RAM, SSD local NTFS DB, Node.js LTS, Section E SQLite settings, 10,000 events, 10 clients, 30-minute harness. Nearest-rank percentiles use at least 10,000 observations after 60-second warm-up.

Credential-failure limits are deliberately in-memory/restart-reset: 5 per normalized credential ID and 20 per normalized address per rolling 5 minutes, then 15-minute lockout. IPv4 uses host; IPv6 uses /64. Telemetry stores bounded labels and keyed hashes only.

## H. Revised Slice 0 exit gate

No production slice starts until review accepts: exact migration and Phase 1 fixture; schemas and byte fixtures; denial table; recovery transition and failures; session revocation interleavings; commit/high-water model test; doctor/migration failure contract; benchmark manifest.

Builder handoff is READY only after G1R reports no Critical or High findings against v0.3.

