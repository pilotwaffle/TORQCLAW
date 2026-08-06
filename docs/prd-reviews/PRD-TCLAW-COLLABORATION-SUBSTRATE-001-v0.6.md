# PRD-TCLAW-COLLABORATION-SUBSTRATE-001

**Status:** Gate 1 candidate; builder handoff requires independent approval
**Version:** 0.6
**Date:** 2026-08-06
**Owner:** TORQCLAW product and engineering
**Target:** Windows-first, single-process, self-hosted TORQCLAW
**Repository:** `E:\TorqClaw`

## 1. Decision

Build a minimal governed collaboration substrate inside the TORQCLAW gateway. One human operator and operator-managed agents can share private channels, post immutable text messages, discover authorized channels, and consume ordered replay. TORQCLAW remains the sole authority for identity, execution, approvals, receipts, routing, budgets, privacy, and MCP access.

This document is the sole normative v0.6 source. It replaces v0.1-v0.5 and their addenda. Earlier documents, commits `2f40e3a` and `f851aae`, and review receipts remain evidence only.

## 2. Problem, user, and outcome

TORQCLAW has durable execution sessions and governed task evidence but no shared-room abstraction with durable actor identity, membership, replay, and immediate revocation.

The v1 user is one technical operator managing local or cloud-backed agent identities on one Windows TORQCLAW installation.

Release requires proof that:

- one operator and two agents are distinct durable principals;
- hidden channels are indistinguishable from absent channels through the defined API response;
- authorized agents can discover channels and replay immutable messages in sequence;
- mutation retries commit once;
- suspension, principal revocation, credential revocation, membership removal, and channel archive stop prohibited commands and prevent new socket writes after their linearization point;
- operator revocation locks collaboration and suspends effective agent authority;
- recovery restores the same operator principal without losing ownership;
- deliberate offline operator revocation invalidates every collaboration credential;
- feature-off behavior preserves accepted Phase 1 behavior;
- all Section 15 benchmarks pass.

A socket write initiated before revocation may complete afterward. The guarantee is that no new socket write begins after the revocation commit.

## 3. Scope

### 3.1 Included

- one operator principal;
- operator-owned agent principals;
- suspend, restore, and terminal revoke lifecycle for agents;
- high-entropy credentials bound to sessions;
- private channels, owner membership, and agent membership;
- channel discovery and archive/unarchive;
- immutable text messages;
- timeline pagination, durable acknowledged cursors, live subscription, and resume;
- SQLite migration, doctor checks, backup/recovery, feature flags, minimal accessible UI, and conformance tests.

### 3.2 Excluded

No v1 command, schema, or implied authority exists for:

- tombstones, deletion, edits, reactions, threads, DMs, media, or voice;
- search/FTS, Git integration, task bridge, workflow triggers, or agent execution;
- multiple human operators, delegated administrators, federation, Nostr, or hash chains;
- collaboration export, retention automation, or legal hold;
- new tools, MCP permissions, provider behavior, routing, approval, receipt, budget, privacy, or memory policy.

Each excluded capability requires a separate PRD.

## 4. Authority model

### 4.1 Identity concepts

- Connection role: `operator`, `channel`, or `node`.
- Principal kind: `operator` or `agent`.
- Membership role: `owner` or `agent`.
- Session: authenticated transport state, never an actor identity.

Exactly one operator principal exists after bootstrap. It may be `active` or `revoked`. Every agent's `owner_principal_id` and every channel's `owner_principal_id` is that operator ID. Operator revocation places the gateway in `locked_recovery`; owned agents become ineffective even if their stored status is active.

Role binding is exact:

- active operator principal connects with role `operator`;
- active agent principal connects with role `channel`;
- `node` has no collaboration authority;
- any principal/role mismatch returns `ROLE_PRINCIPAL_MISMATCH` and closes.

### 4.2 Authorization predicates

Every command first requires `BASE`:

- session open;
- credential active and unexpired;
- principal active;
- owner active for an agent;
- session credential/principal IDs match;
- auth epoch matches.

Additional predicates:

| Predicate | Requirements |
|---|---|
| `OPERATOR_GLOBAL` | `BASE` plus operator principal and role `operator` |
| `CHANNEL_VISIBLE` | `BASE` plus active or archived channel and active membership |
| `CHANNEL_WRITABLE` | `CHANNEL_VISIBLE` plus active channel |
| `CHANNEL_OWNER` | `BASE` plus operator owns target channel; channel may be active or archived |
| `SUBSCRIPTION_OWNER` | `BASE` plus subscription belongs to current session |
| `CURSOR_OWNER` | `CHANNEL_VISIBLE` and cursor principal is current principal |

Command mapping is exhaustive:

| Command | Predicate | Archived behavior |
|---|---|---|
| `CREATE_AGENT` | `OPERATOR_GLOBAL` | N/A |
| `SUSPEND_AGENT` | `OPERATOR_GLOBAL` | N/A |
| `RESTORE_AGENT` | `OPERATOR_GLOBAL` | N/A |
| `REVOKE_AGENT` | `OPERATOR_GLOBAL` | N/A |
| credential create/rotate/revoke | `OPERATOR_GLOBAL` | N/A |
| `CREATE_CHANNEL` | `OPERATOR_GLOBAL` | N/A |
| `ADD_CHANNEL_MEMBER` / `REMOVE_CHANNEL_MEMBER` | `CHANNEL_OWNER` | denied with `CHANNEL_ARCHIVED` |
| `ARCHIVE_CHANNEL` / `UNARCHIVE_CHANNEL` | `CHANNEL_OWNER` | unarchive allowed |
| `LIST_CHANNELS` | `BASE` | includes authorized archived channels marked read-only |
| `GET_CHANNEL_TIMELINE` | `CHANNEL_VISIBLE` | allowed read-only |
| `SUBSCRIBE_CHANNEL` | `CHANNEL_VISIBLE` | allowed read-only |
| `POST_CHANNEL_MESSAGE` | `CHANNEL_WRITABLE` | denied with `CHANNEL_ARCHIVED` |
| `ACK_CHANNEL_CURSOR` | `CURSOR_OWNER` | allowed |
| `UNSUBSCRIBE_CHANNEL` | `SUBSCRIPTION_OWNER` | allowed |

Every unmapped operation is denied. Existing TORQCLAW v1 commands retain their existing policy and cannot be invoked through these collaboration commands.

Operator-principal revocation is not a network command. It is the offline procedure in Section 5.1.1.

## 5. State machines

### 5.1 Gateway

- `uninitialized`: no operator/bootstrap record; local bootstrap only.
- `healthy`: one active operator and valid schema; v2 enabled.
- `locked_recovery`: operator revoked, zero usable active operator credentials, missing/wrong principal or recovery pepper, or operator invariant failure; health, doctor, secret restore, backup, and offline recovery only.
- `migration`: migration active or failed; health only.

Listeners open only in `healthy`.

### 5.1.1 Operator revocation

The operator can revoke itself only while the gateway is stopped:

`torqclaw collab revoke-operator --database <absolute-path> --credential-stdin --recovery-kit-id <uuid> --confirm REVOKE`

The CLI requires the Windows account owning the database, an exclusive lock, a valid active operator credential, a matching verified recovery-kit record, and a successful pre-mutation backup. One `BEGIN IMMEDIATE` transaction changes the operator to revoked, increments every principal auth epoch, revokes every operator and agent credential, closes every collaboration session, records `operator_revoked` without secrets, and commits. The gateway subsequently starts in `locked_recovery`. Failure rolls back completely. This is the sole operator-principal revocation mechanism.

### 5.2 Agent principal

- absent -> active by `CREATE_AGENT`;
- active -> suspended by `SUSPEND_AGENT`;
- suspended -> active by `RESTORE_AGENT`;
- active/suspended -> revoked by `REVOKE_AGENT`;
- revoked is terminal.

Each transition increments `auth_epoch` except initial creation starts at 1. Suspend/revoke closes all sessions and subscriptions. Revoke also revokes every agent credential. Repeating a transition to the same state is idempotent; illegal transitions return `INVALID_PRINCIPAL_TRANSITION`.

### 5.3 Membership

- absent/removed -> active by add;
- active -> removed by remove;
- same-state repetition is idempotent.

Every effective transition increments `membership_epoch`. Owner membership is created with the channel and cannot be removed.

### 5.4 Channel

- absent -> active by create;
- active -> archived by archive;
- archived -> active by unarchive.

Every effective transition increments `channel_epoch` after creation. Archived channels remain discoverable, readable, subscribable, and cursor-acknowledgeable by active members, but reject posts and membership mutations.

Archive closes every live subscription on that channel. Under the authorization write lock, the archive transaction commits the state change, epoch increment, and `channel_archived` event; before the lock releases, affected subscriptions close with subscription close reason `channel_archived` and their unsent queues are purged. No socket write for those subscriptions begins after the archive commit. Members may resubscribe read-only and receive the `channel_archived` event and any earlier undelivered committed events through durable backlog from their acknowledged cursor; archive loses no committed event. Unarchive behaves identically with the `channel_unarchived` event.

### 5.5 Messages and subscriptions

Messages are immutable. There is no edit, tombstone, or delete state.

Subscriptions move absent -> backlog -> live -> closed. Authorization loss, channel archive or unarchive, slow consumer, unsubscribe, or socket close produces closed. Closed subscriptions never deliver.

## 6. Credentials, bootstrap, and disaster recovery

### 6.1 Credentials

Credential format is `tq1_<credentialId>_<32-byte-base64url-secret>`. Store only `HMAC-SHA-256(principalPepper, complete-token-bytes)`. Compare in constant time. Plaintext is displayed once and never logged or persisted.

`principalPepper` is 32 random bytes stored outside SQLite in Windows Credential Manager at `TORQCLAW/principal-pepper`.

Credential states are active, expired, revoked. Expired/revoked are terminal.

`CREATE_PRINCIPAL_CREDENTIAL` issues an additional credential for an active principal without requiring knowledge of an existing credential. It is the recovery path when a one-time credential response is lost.

`ROTATE_PRINCIPAL_CREDENTIAL` body includes `principalId` and `replaceCredentialId`. In one transaction it verifies the replaced credential is active and belongs to the principal, creates the replacement, revokes exactly `replaceCredentialId`, closes sessions bound to the replaced credential, and stores a secret-redacted mutation result. Rotation does **not** increment `auth_epoch`; sessions authenticated by other active credentials remain valid. It never revokes unspecified credentials.

`REVOKE_PRINCIPAL_CREDENTIAL` also leaves `auth_epoch` unchanged and closes only sessions bound to that credential. It returns `LAST_OPERATOR_CREDENTIAL` without mutation if the target is the operator's final active credential. Deliberately removing all operator access requires Section 5.1.1, which enters `locked_recovery`.

### 6.2 Rate limits

Authentication failures use in-memory rolling windows:

- 5 failures per normalized credential ID per 5 minutes;
- 20 failures per normalized remote address per 5 minutes;
- 15-minute lockout after either threshold.

IPv4 uses host address; IPv6 uses /64. Restart resets counters by design. Telemetry stores bounded outcome labels and keyed hashes, never raw tokens or addresses. Rate-limit lockout is reported as `AUTH_FAILED` and is indistinguishable from another authentication failure.

### 6.3 Bootstrap and recovery kit

Local bootstrap requires loopback binding, `TORQCLAW_COLLAB_BOOTSTRAP=1`, zero operator rows, and the owning Windows account. It creates the operator, operator credential, principal pepper, 32-byte recovery secret, and independent 32-byte recovery pepper. Recovery material is shown once.

At bootstrap, `collab_installation.principal_pepper_check` is `HMAC-SHA-256(principalPepper, UTF8("torqclaw-principal-pepper-check:" + installation_id))` and `recovery_pepper_check` uses the equivalent domain-separated recovery string. Startup recomputes both checks in constant time before opening listeners. Missing or mismatched checks place the gateway in `locked_recovery`, making wrong-machine pepper restoration detectable before authentication.

The independent recovery pepper is stored outside SQLite in Windows Credential Manager at `TORQCLAW/recovery-pepper`. Before mode becomes healthy, bootstrap MUST create an encrypted offline recovery kit with:

- principal pepper;
- recovery pepper;
- recovery secret;
- database installation ID;
- schema version;
- kit creation timestamp.

Command:

`torqclaw collab secrets export --output <removable-or-off-machine-path> --passphrase-stdin`

Encryption is AES-256-GCM with a random 16-byte salt and 12-byte nonce. Key derivation is Argon2id with 64 MiB memory, 3 iterations, parallelism 1, producing 32 bytes. The database stores only kit ID, SHA-256 ciphertext checksum, and export timestamp. Bootstrap requires explicit verification by `torqclaw collab secrets verify` before healthy mode. Doctor warns when no verified kit record exists or the kit predates a pepper rotation. It cannot claim the offline file still exists.

Machine restore command:

`torqclaw collab secrets restore --database <absolute-path> --kit <path> --passphrase-stdin`

With the gateway stopped, this command verifies the kit checksum and installation ID against the database, requires the owning Windows account, and restores the principal and recovery peppers into their named Windows Credential Manager entries. It never prints either pepper or writes them to SQLite. It is permitted in `locked_recovery` and MUST run before operator recovery on a replacement machine.

The database stores only `HMAC-SHA-256(recoveryPepper,recoverySecret)`. A state database backup excludes both peppers and plaintext credentials; the recovery kit is a separately protected backup.

### 6.4 Offline recovery

`torqclaw collab recover-operator --database <absolute-path> --kit <path> --passphrase-stdin`

Requirements: gateway stopped, Windows caller owns database/data directory, exclusive lock, valid kit checksum/installation ID, successful pre-mutation backup, and constant-time recovery-secret validation.

Operator recovery is permitted only in `locked_recovery`. On a replacement machine, `secrets restore` MUST complete first.

One `BEGIN IMMEDIATE` transaction reactivates the same operator, increments every principal auth epoch, revokes all credentials, increments every channel/member epoch, closes all collaboration sessions, records a secret-free recovery audit row, and creates one replacement operator credential hash. Commit precedes one-time plaintext display. Failure rolls back and remains locked. Loss of both machine secrets and offline kit is unrecoverable by design; restore alone is insufficient, and documentation MUST state this.

## 7. Protocol v2

### 7.1 Common constraints

Frames are strict UTF-8 JSON objects, maximum 64 KiB. Reject duplicate keys, unknown fields, and non-finite numbers. IDs and mutation idempotency keys are canonical lowercase UUIDs. Timestamps are server-generated RFC 3339 UTC milliseconds.

Channel names are NFC-normalized, trimmed, 1-80 Unicode scalar values, and case-insensitively unique among active channels. Uniqueness is defined by the persisted canonical `name_key`: the NFC-normalized name transformed by Unicode Default Case Folding (full folding, pinned to Unicode 15.0), computed by `CollaborationStore` before SQL. SQLite's built-in `lower()` is never used for uniqueness. Agent display names are NFC-normalized, trimmed, and 1-80 Unicode scalar values.

Message text is NFC-normalized and **1-16,384 UTF-8 bytes**. This is the only message-size rule.

A timeline page ends at **100 events**, or earlier when adding the next event would push the complete encoded `result` frame past the **64 KiB** frame limit. There is no separate page byte bound: every server frame, including timeline results, obeys the single 64 KiB frame limit, and `hasMore`/`nextCursor` continue pagination. A page always contains at least one event when any authorized event exists after the cursor.

### 7.2 Connect

Client:

`{"type":"connect","protocolVersion":2,"role":"operator|channel","credential":"<secret>","requestId":"<uuid>"}`

Role must match principal kind under Section 4.1. Server derives principal/credential IDs. Non-v2 returns `UNSUPPORTED_PROTOCOL` and closes.

A connect frame with `role:"node"` fails strict frame validation at error-precedence step 3 with `INVALID_REQUEST` and closes. It never reaches principal-role matching.

Success:

`{"type":"connected","protocolVersion":2,"requestId":"<uuid>","sessionId":"<uuid>","principal":{"id":"<uuid>","kind":"operator|agent"},"serverTime":"<timestamp>"}`

Fixtures MUST include operator success, agent success, operator-as-channel mismatch, agent-as-operator mismatch, node denial, expired credential, and revoked credential.

### 7.3 Envelopes

Request:

`{"type":"command","protocolVersion":2,"requestId":"<uuid>","command":"<name>","idempotencyKey":"<uuid|null>","body":{}}`

Result and error:

`{"type":"result","protocolVersion":2,"requestId":"<uuid>","ok":true,"body":{}}`

`{"type":"result","protocolVersion":2,"requestId":"<uuid>","ok":false,"error":{"code":"<code>","message":"Request could not be completed","retryable":false}}`

Delivery:

`{"type":"channel_event","protocolVersion":2,"subscriptionId":"<uuid>","channelId":"<uuid>","cursor":"<seq>","event":{"id":"<uuid>","kind":"<kind>","actorPrincipalId":"<uuid>","occurredAt":"<timestamp>","payload":{}}}`

Cursor is unsigned base-10 `collab_events.seq` without leading zeroes; `0` means before first.

### 7.4 Exhaustive commands

Idempotency classification is exhaustive:

| Class | Commands |
|---|---|
| Idempotency-keyed | `CREATE_AGENT`, `CREATE_PRINCIPAL_CREDENTIAL`, `SUSPEND_AGENT`, `RESTORE_AGENT`, `REVOKE_AGENT`, `ROTATE_PRINCIPAL_CREDENTIAL`, `REVOKE_PRINCIPAL_CREDENTIAL`, `CREATE_CHANNEL`, `ADD_CHANNEL_MEMBER`, `REMOVE_CHANNEL_MEMBER`, `ARCHIVE_CHANNEL`, `UNARCHIVE_CHANNEL`, `POST_CHANNEL_MESSAGE` |
| Naturally idempotent | `ACK_CHANNEL_CURSOR`, `UNSUBSCRIBE_CHANNEL` |
| No idempotency key | `LIST_CHANNELS`, `GET_CHANNEL_TIMELINE`, `SUBSCRIBE_CHANNEL` |

Idempotency-keyed commands require a UUID. Every other command requires null. Cursor acknowledgement uses `max(existing,submitted)` and unsubscribe returns the same closed result when repeated by its owning session. Naturally idempotent commands do not write `collab_mutation_results`. Failed mutations never write `collab_mutation_results`; after the cause is corrected, retry may execute normally.

For channel-scoped commands, the current Section 4.2 predicate and visible channel state are evaluated **before** any idempotency lookup. Removed members receive `COLLAB_NOT_FOUND`; authorized members retrying a post against an archived channel receive `CHANNEL_ARCHIVED`. Neither same-body nor changed-body retry reveals a stored result until current authorization succeeds. After authorization succeeds, same principal+command+key+canonical body returns the stored redacted result and a changed body returns `IDEMPOTENCY_CONFLICT`.

An authorization change can prevent a client from confirming whether its original channel mutation committed. After authorization is restored, `GET_CHANNEL_TIMELINE` is the sole source of truth for committed channel events; no hidden-resource confirmation side channel exists.

- `CREATE_AGENT {displayName} -> {principalId,credentialId,credential|credentialAvailable:false}`
- `CREATE_PRINCIPAL_CREDENTIAL {principalId} -> {principalId,credentialId,credential|credentialAvailable:false}`
- `SUSPEND_AGENT {principalId} -> {principalId,status,authEpoch}`
- `RESTORE_AGENT {principalId} -> {principalId,status,authEpoch}`
- `REVOKE_AGENT {principalId} -> {principalId,status,authEpoch,revokedCredentialCount}`
- `ROTATE_PRINCIPAL_CREDENTIAL {principalId,replaceCredentialId} -> {credentialId,credential|credentialAvailable:false,replacedCredentialId}`
- `REVOKE_PRINCIPAL_CREDENTIAL {credentialId} -> {credentialId,revokedAt}`
- `CREATE_CHANNEL {name} -> {channelId,name}`
- `ADD_CHANNEL_MEMBER {channelId,principalId} -> {channelId,principalId,membershipEpoch}`
- `REMOVE_CHANNEL_MEMBER {channelId,principalId} -> {channelId,principalId,membershipEpoch}`
- `ARCHIVE_CHANNEL {channelId} -> {channelId,state,channelEpoch}`
- `UNARCHIVE_CHANNEL {channelId} -> {channelId,state,channelEpoch}`
- `LIST_CHANNELS {afterChannelId:null|uuid,limit:1..100,includeArchived:boolean} -> {channels:[{channelId,name,state,role,lastAcknowledgedCursor}],nextChannelId:null|uuid,hasMore:boolean}`
- `POST_CHANNEL_MESSAGE {channelId,text} -> {eventId,cursor,occurredAt}`
- `GET_CHANNEL_TIMELINE {channelId,afterCursor,limit:1..100} -> {events,nextCursor,hasMore}`
- `ACK_CHANNEL_CURSOR {channelId,cursor} -> {channelId,acknowledgedCursor}`
- `SUBSCRIBE_CHANNEL {channelId,afterCursor} -> {subscriptionId,highWaterCursor}`
- `UNSUBSCRIBE_CHANNEL {subscriptionId} -> {subscriptionId,state:"closed"}`

Credential-producing commands persist only `principalId`, `credentialId`, and `credentialAvailable:false` in `collab_mutation_results.result_json`. The plaintext secret exists only in the in-memory first-response envelope after commit and is then zeroed. A replay always returns the credential ID with `credentialAvailable:false`. If delivery fails after commit, the operator uses `CREATE_PRINCIPAL_CREDENTIAL` to issue another credential and may revoke the unavailable credential by its returned ID. Plaintext is never reconstructable or persisted.

`LIST_CHANNELS` orders by channel ID ascending, filters to active memberships, and includes archived rows only when requested. `ACK_CHANNEL_CURSOR` stores `max(existing,submitted)` but rejects a cursor beyond the greatest committed sequence visible in that channel.

`CREATE_CHANNEL` returns `CHANNEL_NAME_CONFLICT` when an active channel already has the same canonical `name_key`. `UNARCHIVE_CHANNEL` returns the same code and leaves the target archived if another active channel has claimed its `name_key`; the operator must archive the conflicting channel first. `ACK_CHANNEL_CURSOR` returns `CURSOR_OUT_OF_RANGE` when the submitted cursor exceeds the greatest committed sequence visible in that channel.

`SUSPEND_AGENT`, `RESTORE_AGENT`, and `REVOKE_AGENT` return `INVALID_REQUEST` when `principalId` names the operator. Authentication lockout at connect returns `AUTH_FAILED`. Failed mutations are not cached, including `CHANNEL_NAME_CONFLICT` and `CURSOR_OUT_OF_RANGE`.

### 7.5 Exhaustive collaboration events

Only these event kinds can enter `collab_events`:

- `channel_created {channelId,name}`
- `member_added {channelId,principalId,membershipEpoch}`
- `member_removed {channelId,principalId,membershipEpoch}`
- `message_posted {channelId,text}`
- `channel_archived {channelId,channelEpoch}`
- `channel_unarchived {channelId,channelEpoch}`

Payloads have exactly the listed fields. Principal/credential/recovery audit records use `collab_audit` and never appear in channel replay.

### 7.6 Error precedence

Order:

1. frame/JSON limits -> `INVALID_FRAME`;
2. protocol -> `UNSUPPORTED_PROTOCOL`;
3. envelope/schema/UUID -> `INVALID_REQUEST`;
4. connect credential missing, malformed, unknown, expired, or revoked -> `AUTH_FAILED`, then close;
5. established session/credential/principal/role -> `SESSION_INVALID` or `ROLE_PRINCIPAL_MISMATCH`, then close;
6. current command predicate and hidden-resource authorization;
7. idempotency lookup/conflict;
8. visible resource state and command validation.

Absent, hidden, archived-hidden, and non-member channel IDs return identical `COLLAB_NOT_FOUND` status/body/message. Authorized archived-channel invalid writes return `CHANNEL_ARCHIVED`. Operator-only global commands from agents return `COLLAB_NOT_PERMITTED`.

The exhaustive domain error codes are `AUTH_FAILED`, `ROLE_PRINCIPAL_MISMATCH`, `SESSION_INVALID`, `COLLAB_NOT_FOUND`, `COLLAB_NOT_PERMITTED`, `CHANNEL_ARCHIVED`, `CHANNEL_NAME_CONFLICT`, `CURSOR_OUT_OF_RANGE`, `LAST_OPERATOR_CREDENTIAL`, `INVALID_PRINCIPAL_TRANSITION`, `IDEMPOTENCY_CONFLICT`, and `SLOW_CONSUMER`. Framing codes are `INVALID_FRAME`, `INVALID_REQUEST`, and `UNSUPPORTED_PROTOCOL`.

### 7.7 Slow consumers

A consumer is slow when queued encoded frames exceed **1 MiB** or the oldest queued frame is older than **10 seconds**. The sole close reason/error code is `SLOW_CONSUMER`. The acknowledged cursor does not advance automatically.

## 8. Revocation and event ordering

### 8.1 Session binding

The exhaustive session close reasons are `credential_revoked`, `principal_suspended`, `principal_revoked`, `operator_revoked`, `slow_consumer`, `socket_closed`, and `recovery`.

The exhaustive subscription close reasons are `unsubscribed`, `authorization_lost`, `channel_archived`, `slow_consumer`, `session_closed`, and `socket_closed`. Subscriptions are in-memory records containing subscription/session/channel IDs, epoch snapshots, state, close reason, and queue metadata. `UNSUBSCRIBE_CHANNEL` closes only the target subscription with `unsubscribed`; it does not close the session or any other subscription. Session closure closes every owned subscription with `session_closed`.

Each collaboration session stores session ID, protocol version, role, principal ID, credential ID, auth epoch snapshot, created/closed timestamps, and close reason. Each subscription stores session/principal/credential IDs plus auth, membership, and channel epoch snapshots.

### 8.2 Authorization coordinator

Revocation, suspension, membership removal, and archive acquire the authorization write lock, commit state/epoch changes, close affected sessions/subscriptions and purge queues before releasing. SQLite commit is the linearization point.

Each command validates only the predicate mapped in Section 4.2. Each socket write validates `BASE` plus the subscription's current membership/channel visibility and epoch snapshots under the read lock. This does not require active-channel state for read-only archived subscriptions.

### 8.3 Sequencer

One in-process sequencer mutex and one fan-out source exist.

All idempotency-keyed commands, including non-event mutations, use this same sequencer/write path. Lock order is authorization coordinator read lock, then sequencer mutex, then SQLite transaction; state-changing authorization operations acquire the authorization write lock before the sequencer mutex. No code may invert this order.

After current authorization succeeds, every keyed command executes this atomic protocol:

1. Acquire the sequencer mutex and execute `BEGIN IMMEDIATE`.
2. Revalidate the command predicate inside the transaction.
3. Look up `(principal_id,command,idempotency_key)`.
4. If found with the same request hash, commit no mutation and return the canonical secret-redacted result.
5. If found with a different hash, roll back and return `IDEMPOTENCY_CONFLICT`.
6. Otherwise perform all state/event writes and insert the redacted mutation result in the same transaction.
7. Commit before fan-out or one-time secret handoff.
8. On unique-key contention, roll back, begin a fresh read transaction, re-read the canonical row, and apply steps 4-5.

No keyed mutation is visible without its canonical result row, and no canonical success row exists without its mutation. Deterministic barriers test concurrent same-key requests before lookup, mutation, result insert, and commit for every mutation class.

Subscription registration and high-water capture occur under the mutex. Backlog sends authorized events through high water ascending. Writers hold the mutex through `BEGIN IMMEDIATE`, insert, commit, and buffer insertion. Events above high water buffer during backlog. Under the mutex, buffered events drain ascending with sequence deduplication, then subscription becomes live. Rolled-back rows never fan out.

Barrier tests cover every registration/high-water/commit/buffer/live boundary. Observable output equals authorized database sequence with no gaps or duplicates.

## 9. Exact SQLite v1 migration

Migration ID: `20260806_001_collaboration_v1`. Require SQLite 3.35+, `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=FULL`, and `busy_timeout=5000`. Run under `BEGIN EXCLUSIVE` before listeners. Set schema version last. Any error rolls back and keeps listeners closed.

```sql
CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('operator','agent')),
  display_name TEXT NOT NULL,
  owner_principal_id TEXT REFERENCES principals(id),
  status TEXT NOT NULL CHECK(status IN ('active','suspended','revoked')),
  auth_epoch INTEGER NOT NULL DEFAULT 1 CHECK(auth_epoch > 0),
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (kind='operator' AND owner_principal_id IS NULL AND status IN ('active','revoked'))
    OR
    (kind='agent' AND owner_principal_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX principals_single_operator
  ON principals(kind) WHERE kind='operator';

CREATE TABLE principal_credentials (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  secret_hmac BLOB NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('active','expired','revoked')),
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE collab_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','archived')),
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  channel_epoch INTEGER NOT NULL DEFAULT 1 CHECK(channel_epoch > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX collab_channels_active_name_key
  ON collab_channels(name_key) WHERE state='active';

CREATE TABLE collab_members (
  channel_id TEXT NOT NULL REFERENCES collab_channels(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  role TEXT NOT NULL CHECK(role IN ('owner','agent')),
  state TEXT NOT NULL CHECK(state IN ('active','removed')),
  membership_epoch INTEGER NOT NULL DEFAULT 1 CHECK(membership_epoch > 0),
  joined_at TEXT NOT NULL,
  removed_at TEXT,
  PRIMARY KEY(channel_id, principal_id)
);

CREATE TABLE collab_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  channel_id TEXT NOT NULL REFERENCES collab_channels(id),
  actor_principal_id TEXT NOT NULL REFERENCES principals(id),
  kind TEXT NOT NULL CHECK(kind IN (
    'channel_created','member_added','member_removed',
    'message_posted','channel_archived','channel_unarchived'
  )),
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(channel_id,id)
);

CREATE INDEX collab_events_channel_seq
  ON collab_events(channel_id,seq);

CREATE TABLE collab_cursors (
  channel_id TEXT NOT NULL REFERENCES collab_channels(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  acknowledged_seq INTEGER NOT NULL CHECK(acknowledged_seq >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(channel_id,principal_id)
);

CREATE TABLE collab_mutation_results (
  principal_id TEXT NOT NULL REFERENCES principals(id),
  command TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash BLOB NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(principal_id,command,idempotency_key)
);

CREATE TABLE collab_session_bindings (
  session_id TEXT PRIMARY KEY,
  protocol_version INTEGER NOT NULL CHECK(protocol_version=2),
  connection_role TEXT NOT NULL CHECK(connection_role IN ('operator','channel')),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  credential_id TEXT NOT NULL REFERENCES principal_credentials(id),
  auth_epoch_snapshot INTEGER NOT NULL CHECK(auth_epoch_snapshot > 0),
  created_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT CHECK(close_reason IS NULL OR close_reason IN (
    'credential_revoked','principal_suspended','principal_revoked',
    'operator_revoked','slow_consumer',
    'socket_closed','recovery'
  ))
);

CREATE INDEX collab_session_credential_open
  ON collab_session_bindings(credential_id,closed_at);

CREATE INDEX collab_members_principal_state_channel
  ON collab_members(principal_id,state,channel_id);

CREATE INDEX principal_credentials_principal_state
  ON principal_credentials(principal_id,state);

CREATE TABLE collab_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN (
    'bootstrap_completed','credential_created','credential_revoked',
    'agent_suspended','agent_restored','agent_revoked',
    'operator_revoked','recovery_completed','recovery_kit_exported'
  )),
  actor_principal_id TEXT REFERENCES principals(id),
  subject_principal_id TEXT REFERENCES principals(id),
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE collab_installation (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  installation_id TEXT NOT NULL UNIQUE,
  recovery_secret_hmac BLOB NOT NULL,
  principal_pepper_check BLOB NOT NULL,
  recovery_pepper_check BLOB NOT NULL,
  recovery_kit_id TEXT,
  recovery_kit_checksum TEXT,
  recovery_kit_verified_at TEXT,
  schema_version INTEGER NOT NULL CHECK(schema_version=1)
);
```

Phase 1 rows remain untouched because v1 creates additive tables. `collab_session_bindings.session_id` deliberately has no foreign key to the Phase 1 session table; gateway application code MUST create/close it atomically with the corresponding gateway session and doctor reports orphan bindings. This avoids assuming a Phase 1 column name while keeping exact v1 DDL.

The `CollaborationStore` is the only production writer for these tables. Every write transaction MUST execute the following validations after `BEGIN IMMEDIATE` and before mutation:

1. Agent creation verifies the owner row is the sole active `operator`.
2. Channel creation verifies `owner_principal_id` is that operator and creates exactly one active `owner` membership in the same transaction.
3. Agent membership verifies the principal is kind `agent`, owned by the channel operator, and uses role `agent`; owner-role insertion is rejected.
4. Owner membership removal or role mutation is rejected.
5. Cursor insert/update verifies an active membership and submitted sequence visibility.
6. Event insertion validates actor authorization, legal channel state, exact event kind, and strict payload schema before SQL insertion.
7. Principal, membership, and channel updates validate the Section 5 transition and required epoch increment.
8. Channel creation and unarchive compute and persist `name_key` with the Section 7.1 algorithm before insert/update; the unique active-`name_key` index is the concurrency backstop, and a constraint violation maps to `CHANNEL_NAME_CONFLICT`.

Any failed validation rolls back and returns the mapped protocol error. Direct storage-level negative fixtures invoke every `CollaborationStore` write method with agent-owned channels, nested agent ownership, forged owner memberships, unauthorized cursors, illegal transitions, and malformed event payloads and prove zero rows change. Raw external SQLite writes are unsupported and detected by doctor invariant checks.

`torqclaw doctor` reports `collab_mutation_results` row count and encoded result bytes. Retention remains outside v1; warning thresholds are 100,000 rows or 256 MiB, and crossing them does not delete records.

## 10. Conformance and acceptance

Required byte fixtures cover both role connects, mismatches, every command success, every denial class, hidden-resource compound failures, idempotency replay/conflict, agent state transitions, credential replacement, channel discovery pagination, cursor monotonicity, archived reads, backlog/live/resume, `SLOW_CONSUMER`, and recovery.

Required deterministic tests prove:

- suspended/revoked agent cannot authenticate, command, resume, or receive;
- terminal principal revocation differs from one-credential revocation;
- every Section 7.5 event inserts into the Section 9 CHECK and no other event does;
- each idempotency-keyed successful mutation writes one `collab_mutation_results` row and channel-less mutations work;
- every credential-producing persisted result is secret-redacted and a lost first response can be recovered with `CREATE_PRINCIPAL_CREDENTIAL`;
- same-key concurrent races for every mutation class produce one mutation and one canonical result;
- membership removal and archive precede idempotency replay and do not leak stored success or conflict;
- unsubscribing one channel leaves the session and all other subscriptions live;
- direct storage-level authority-invariant violations roll back with zero row changes;
- all message validators enforce 16,384 bytes;
- all timeline paths enforce the 100-event page bound and the 64 KiB result-frame bound;
- Unicode case-fold fixtures prove `name_key` conflicts for non-ASCII case pairs at create and unarchive;
- archiving a channel closes its live subscriptions with `channel_archived`, purges unsent queues, and resubscribed members replay the archive event from durable backlog;
- all slow-consumer paths use one threshold and code;
- hidden-channel response shape and status are identical to absent;
- no socket write starts after revocation linearization;
- no gap/duplicate occurs at subscription boundaries;
- machine-loss recovery succeeds from database backup plus verified offline kit and fails clearly without the kit.
- revoking the final active operator credential returns `LAST_OPERATOR_CREDENTIAL` without mutation;
- operator revocation enters `locked_recovery`, while rotation preserves sessions using non-replaced credentials;
- secret restore repopulates both Credential Manager entries without exposing their values;
- create/unarchive name collisions and beyond-range cursor acknowledgements return their sole defined codes.

## 11. Rollout and rollback

Feature flags: `TORQCLAW_COLLAB_IDENTITY`, `TORQCLAW_COLLAB_CHANNELS`, `TORQCLAW_COLLAB_LIVE`, and `TORQCLAW_COLLAB_UI`, default false.

Slices:

1. Contract gate: generated schemas, exact migration, Phase 1 fixture, protocol fixtures, consistency linter, recovery fixtures.
2. Identity: bootstrap, agents, credentials, lifecycle, sessions, recovery kit.
3. Channels: membership, discovery, archive, immutable messages, cursor.
4. Live: sequencer, backlog/live transition, revocation races, slow consumers.
5. UI/pilot: accessible operator UI, metrics, benchmark, rollback rehearsal.

Each slice is independently gated. Migration takes a mandatory pre-migration backup.

Normal rollback is non-destructive: stop new v2 connections, drain/close subscriptions, disable all collaboration flags, retain additive tables, and restart Phase 1 behavior. Destructive restoration of the pre-migration backup is a last-resort offline operation because it discards **all** post-backup Phase 1 and collaboration data. It requires gateway shutdown, a new current full-state backup, typed confirmation `RESTORE PRE-MIGRATION BACKUP AND DISCARD LATER DATA`, display of the exact time/data-loss boundary, and an operator-selected backup ID. Completion writes a secret-free external restore receipt containing old/new database checksums, backup IDs, timestamps, operator acknowledgement, and doctor results. Rollback rehearsal proves normal feature-off preserves Phase 1 changes and destructive restore loses only the explicitly acknowledged interval. No downgrade migration exists.

## 12. Security and privacy

- TLS is mandatory beyond loopback.
- Secrets never enter logs, events, receipts, exports, URLs, or analytics.
- Channel lookup uses parameterized queries and authorization before content access.
- Caches key by gateway, principal, and channel and purge on identity change/revocation.
- Channel text is private local data and is not sent to models unless a separately governed execution action is approved.
- Metrics use bounded labels only; no principal, channel, token, address, or message text labels.
- Accessibility target: keyboard operation, visible focus, semantic controls, WCAG 2.2 AA contrast, and screen-reader announcements for new messages without focus theft.

## 13. Observability

Metrics:

- connect outcomes by bounded reason;
- authorization denials by command class;
- active/backlog/closed subscriptions;
- revocation-to-last-write-boundary latency;
- timeline, commit, and fan-out latency;
- queue bytes/age and `SLOW_CONSUMER` closes;
- migration/recovery/doctor outcomes;
- verified recovery-kit age.

Alerts: invariant failure, migration failure, any post-linearization write detected, recovery failure, or benchmark regression.

## 14. Consistency pre-gate

Before model review, a deterministic documentation linter MUST extract and compare:

- command names;
- event kinds;
- error/close codes;
- numeric byte, event, time, rate, and benchmark limits;
- state names and transitions;
- DDL CHECK enum values;
- protocol fixture enum values.

It fails if an identifier is referenced but not defined, if a definition has multiple values, if a protocol event is rejected by DDL, or if an excluded feature appears in commands/events/schema/acceptance criteria. Generated schema and fixture drift is also a failure.

It also fails when an error code appears outside the exhaustive Section 7.6 registry, a state-changing command lacks an explicit idempotency classification, or a command references an unindexed mandatory access path.

It also enforces cross-constraint feasibility: any declared encoded response or payload byte bound that exceeds the 64 KiB frame bound is a failure.

The required implementation is `scripts/lint_collaboration_prd.py`. It exits 0 only on PASS, exits nonzero on findings or parse failure, and can write the review artifact with `--report`.

## 15. Authoritative benchmark

Reference: Windows 11; 4 logical CPUs; 8 GiB RAM; SSD local NTFS database; Node.js LTS; Section 9 SQLite pragmas; 100,000 collaboration events; 10 concurrent clients; 30-minute harness; 60-second warm-up; at least 10,000 observations; nearest-rank percentiles.

Pass conditions:

- warm 100-event timeline query: p95 <= 100 ms;
- message commit: p95 <= 75 ms;
- commit-to-last-authorized-client socket-write initiation: p95 <= 150 ms;
- zero lost or duplicate event sequences;
- zero socket-write initiations after revocation linearization.

These values supersede every earlier draft/status-memo benchmark.

## 16. Risks and ownership

| Risk | Owner | Mitigation |
|---|---|---|
| authorization race | gateway lead | coordinator lock, epochs, instrumented boundaries |
| replay gap | gateway lead | one sequencer/fan-out source, barrier tests |
| hidden-channel leak | security lead | denial precedence, response/timing regression |
| machine-loss lockout | security lead | mandatory verified offline recovery kit |
| migration damage | storage lead | additive DDL, fixture, backup, rollback rehearsal |
| contract drift | contracts lead | generated schemas plus consistency linter |
| cache identity leak | frontend lead | scoped keys and purge tests |
| scope creep into execution | product owner | explicit exclusions and follow-on PRDs |

Named humans must be assigned before Slice 2.

## 17. Finding traceability

| Finding | v0.6 closure |
|---|---|
| timeline page exceeds frame limit | Sections 7.1 and 10 |
| unenforceable Unicode name uniqueness | Sections 7.1, 7.4, 9, and 10 |
| ambiguous archive delivery semantics | Sections 5.4, 5.5, 8.1, and 10 |
| stale v0.4 pre-gate evidence | final status document (historical labels) |
| idempotency evaluated before channel authorization | Sections 7.4, 7.6, and 8.3 |
| credential plaintext persistence and stranded issuance | Sections 6.1, 7.4, and 10 |
| missing atomic keyed-mutation protocol | Sections 8.3 and 10 |
| unenforced authority invariants in storage | Sections 9 and 10 |
| session/subscription close-reason conflation | Sections 8.1, 9, and 10 |
| destructive rollback without safety contract | Section 11 |
| nondeterministic `node` connect outcome | Section 7.2 |
| universal validator | Sections 4.2 and 8.2 |
| operator cannot connect | Sections 4.1 and 7.2 |
| missing discovery/cursor commands | Sections 4.2 and 7.4 |
| ambiguous rotation | Sections 6.1 and 7.4 |
| non-executable migration/session binding | Section 9 |
| missing agent suspend/restore/revoke | Sections 5.2 and 7.4 |
| event kind/DDL contradiction | Sections 7.5, 9, and 10 |
| dual-pepper machine-loss lockout | Sections 6.3-6.4 |
| undefined operator revocation | Section 5.1.1 |
| final operator credential lockout | Sections 5.1 and 6.1 |
| rotation/epoch contradiction | Sections 6.1 and 8.2 |
| missing protocol error codes | Sections 7.4 and 7.6 |
| cursor idempotency ambiguity | Sections 7.3-7.4 |
| recovery secret restore gap | Sections 6.3-6.4 |
| channel-name reuse on unarchive | Sections 7.4 and 9 |
| undetectable wrong pepper | Sections 6.1 and 9 |
| undefined close reasons | Sections 8.1 and 9 |
| unsubscribe idempotency ambiguity | Section 7.4 |
| failed mutation replay ambiguity | Section 7.4 |
| unbounded mutation-result observability | Sections 9 and 13 |
| benchmark conflict | Section 15 |
| tombstone/rename remnants | Sections 3.2, 5.5, 7.5, and 9 |
| message/page/slow/rate conflicts | Sections 6.2, 7.1, 7.4, and 7.7 |
| idempotency scope conflict | Sections 7.4 and 9 |

## 18. Superseded-clause map

| Prior source | Disposition in v0.6 |
|---|---|
| v0.5 separate timeline page byte bound | superseded by Section 7.1 |
| v0.5 ASCII-fold channel-name uniqueness index | superseded by Sections 7.1 and 9 |
| v0.5 archive delivery ambiguity | superseded by Sections 5.4 and 8.1 |
| v0.4 Section 7.6 idempotency-before-authorization precedence | superseded by Sections 7.4 and 7.6 |
| v0.4 credential-bearing mutation results | superseded by Sections 6.1 and 7.4 |
| v0.4 Section 11 restore-only destructive rollback | superseded by Section 11 |
| v0.4 `unsubscribed` session close reason | superseded by Section 8.1 |
| v0.2 Sections 3/14/20 benchmark values | superseded by Section 15 |
| v0.2 Sections 5/7.4/10/11/12/16 tombstones | removed; Sections 3.2 and 5.5 |
| v0.2 Section 6 rate limits/recovery | superseded by Section 6 |
| v0.2 Section 9 replay/page/slow-consumer rules | superseded by Sections 7.4, 7.7, and 8.3 |
| v0.2 Section 10 schema/idempotency | superseded by Section 9 |
| v0.3 Addendum universal validator | superseded by Section 4.2 |
| v0.3 Addendum protocol/allowlists | superseded by Section 7 |
| final-status benchmark memo | superseded by Section 15 |

### 18.1 Explicit implementation supersession

No prior rule for operator revocation, credential exhaustion, rotation epoch increments, connect authentication errors, channel-name collisions, cursor-range errors, secret restoration, or cursor idempotency remains normative. Sections 5-9 are exhaustive for those behaviors.

## 19. Definition of done

- consistency pre-gate passes;
- independent G1R reports no Critical or High finding;
- exact migration and Phase 1 fixture pass;
- all authorization cells, state transitions, protocol fixtures, recovery, concurrency, privacy, accessibility, rollback, and benchmark gates pass;
- existing TORQCLAW gates pass with features off and on;
- no execution or governance authority changes.

## 20. Research basis

Checked 2026-08-06:

- `E:\TorqClaw\README.md`
- `E:\TorqClaw\packages\gateway\db\schema.sql`
- gateway sessions, events, authorization, storage, receipts, contracts, and HTTP-channel adapter;
- Block Buzz README, architecture, CLI, and project-vision documents.

Buzz contributes the shared-room and replay concepts. TORQCLAW retains its stricter execution and governance authority. Known Buzz risks around tenant cache scope, stale refresh failures, owner revocation, workflow approvals, host-wide developer paths, and media quotas are not imported.
