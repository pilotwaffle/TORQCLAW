# PRD-TCLAW-COLLABORATION-SUBSTRATE-001

Status: Gate 1 revision; builder handoff requires reviewer approval
Version: 0.2
Date: 2026-08-06
Owner: TORQCLAW product and engineering
Target: Windows-first self-hosted TORQCLAW deployment
Implementation repository: `E:\TorqClaw`

## 1. Executive decision

Build the minimum governed collaboration core for TORQCLAW: one human operator and explicitly managed agent identities can share private channels, post immutable text messages, receive durable ordered replay, and lose access immediately under a defined revocation protocol.

This PRD authorizes contracts and implementation only for:

1. Principal identity and revocable credentials.
2. Private channels and explicit agent membership.
3. Immutable text messages and operator tombstones.
4. Authorized live subscriptions and monotonic replay.
5. A minimal accessible channel UI in the existing TORQCLAW console.

It does not authorize agent task dispatch, search, Git ingestion, threads, edits, reactions, workflow triggers, cryptographic signatures, hash chaining, federation, or multi-human administration. Those require separate PRDs after this core proves its authorization and recovery invariants.

The existing TORQCLAW gateway remains the only authority. Existing execution events, tasks, approvals, receipts, Hermes, LOCAL_EDGE, routing, budget, privacy, and MCP controls are unchanged.

## 2. Problem and target user

TORQCLAW has durable execution sessions and evidence-backed task history, but no shared room abstraction. Agents and the operator cannot participate as distinct members of a private project channel, and there is no collaboration cursor independent from one execution session.

The target user is one self-hosting technical operator who manages one or more local or cloud-backed agent identities. The immediate job is to establish a trustworthy shared-message substrate before attaching governed execution or external integrations.

## 3. Measurable v1 outcome

The release succeeds when the production contracts and deterministic tests prove all of the following:

- The bootstrap operator and two managed agents can be distinct principals in one private channel.
- A non-member cannot list, read, subscribe to, post to, or distinguish that channel from an absent channel through status code or response shape.
- Messages commit once under idempotent retry and replay in ascending monotonic sequence.
- Removing or revoking an agent blocks new commands and prevents any new socket write from being initiated after the revocation linearization point.
- Revoking the sole operator automatically suspends every owned agent.
- Feature-off operation preserves all accepted TORQCLAW Phase 1 behavior.
- On a documented Windows reference machine, a warm query for 100 timeline events completes within 100 ms p95 over 100,000 synthetic collaboration events.

The physical arrival of bytes already handed to the operating system before revocation may occur after the revocation response. The product guarantees no socket write is initiated after the defined linearization point; it does not claim network recall.

## 4. Authority model

### 4.1 Distinct concepts

TORQCLAW must keep these concepts separate:

- `connection role`: the existing transport authorization seat, `operator`, `channel`, or `node`.
- `principal kind`: durable actor identity, `operator` or `agent` in v1.
- `channel membership role`: `owner` or `agent` in v1.
- `sessionId`: resumable connection/session identity, never an actor credential.

There is exactly one active operator principal in v1.

- The operator principal may connect only with connection role `operator`.
- An agent principal may connect only with connection role `channel`.
- Connection role `node` has no collaboration authority.
- Every agent has exactly one `owner_principal_id`, which must be the operator principal.
- Every channel has exactly one owner membership, which must be the operator principal.
- Agent suspension or revocation blocks that agent.
- Operator suspension or revocation automatically makes all owned agents ineligible for reads, writes, subscriptions, and resume. Historical attribution remains.

Operator authority is a server-side principal property, not a client claim or channel membership label. The client submits a credential; the gateway resolves principal and authority from persisted records.

### 4.2 Normative authorization matrix

`active` below means the principal, credential, owner, channel, and membership are all active. Every unmapped action is denied.

| Action/path | Operator principal, role `operator` | Agent principal, role `channel` | `node` or mismatched role | Archived channel |
|---|---|---|---|---|
| Bootstrap initial operator | Allowed only in explicit one-time migration mode | Denied | Denied | N/A |
| Create/rotate operator credential | Allowed | Denied | Denied | N/A |
| Create/rotate agent credential | Allowed for owned agent | Denied | Denied | N/A |
| Create agent principal | Allowed | Denied | Denied | N/A |
| Suspend/restore/revoke agent | Allowed for owned agent | Denied | Denied | N/A |
| Create channel | Allowed | Denied | Denied | N/A |
| Rename/archive/unarchive channel | Allowed as owner | Denied | Denied | Only unarchive allowed |
| Add/remove agent membership | Allowed as owner | Denied | Denied | Denied until unarchived |
| List channels | Active memberships only | Active memberships only | Denied | Included, marked read-only |
| Read timeline/backlog | Allowed as active owner | Allowed as active member | Denied | Allowed read-only |
| Subscribe live | Allowed as active owner | Allowed as active member | Denied | Allowed read-only |
| Post text message | Allowed as active owner | Allowed as active member with active owner | Denied | Denied |
| Tombstone message | Allowed as owner | Denied | Denied | Denied until unarchived |
| Acknowledge cursor | Allowed for own principal/channel | Allowed for own principal/channel | Denied | Allowed |
| Existing `SUBMIT_PROMPT` | Existing TORQCLAW policy, unchanged | Existing `role: channel` policy, unchanged | Existing policy | Unrelated to channel membership in this PRD |
| Existing approval/receipt/export commands | Existing operator-only policy, unchanged | Denied | Denied | Unrelated |

Channel membership never grants global operator authority. Connection role never grants channel membership.

## 5. Scope and non-goals

### 5.1 In scope

- One active operator principal and operator-owned agent principals.
- High-entropy revocable bearer credentials.
- Private channels with one operator owner and zero or more agent members.
- Immutable text messages.
- Operator tombstones that hide message text from normal rendering while preserving source records.
- Monotonic global collaboration sequence and per-channel authorized replay.
- Live subscription with current-epoch checks immediately before socket write.
- Per-principal, per-channel acknowledged cursors.
- Strict Zod command/event contracts and generated-schema drift checks where applicable.
- Additive SQLite migration, audit/doctor checks, feature flags, UI, accessibility, rollback, and tests.

### 5.2 Non-goals and required follow-on PRDs

- Agent message-to-task execution bridge and exactly-once task dispatch.
- Search or FTS over collaboration content.
- GitHub/GitLab ingestion or branch-as-room behavior.
- Threads, replies, reactions, message edits, DMs, media, canvases, voice, or mobile.
- Multiple human operators, moderators, delegated ownership, or role invitations.
- Nostr, federation, signed actor events, web-of-trust, or tamper-evident hash chains.
- Collaboration export, retention automation, permanent message deletion, or legal hold.
- New tools, workflows, MCP permissions, learned skills, execution profiles, or provider behavior.

Each item above requires a separate Gate 1 decision. This PRD's schema reserves no implied authorization for them.

## 6. Credential contract

### 6.1 Token and verification design

- Credential format: `tq1_<credentialId>_<secret>`, where `credentialId` is a UUID and `secret` is 32 cryptographically random bytes encoded base64url without padding.
- Plaintext is returned once at creation and never stored.
- The database stores `HMAC-SHA-256(pepper, complete_token_bytes)` and credential metadata.
- `TORQCLAW_PRINCIPAL_PEPPER` is exactly 32 random bytes supplied as base64url through the process environment.
- On Windows, the operator stores the pepper in Windows Credential Manager or an equivalently protected deployment secret and injects it at launch. TORQCLAW does not write the pepper into `state.db`, `.env`, logs, events, receipts, or exports.
- Verification uses constant-time digest comparison.
- A missing, malformed, or wrong pepper fails closed at startup when collaboration identity is enabled.

### 6.2 Lifecycle

- Credential states are `active`, `expired`, and `revoked`.
- Legal transitions: `active -> expired` by time and `active -> revoked` by operator action. Both terminal states are irreversible.
- Rotation creates a new active credential, commits it, then revokes the selected old credential in the same transaction when `replace=true`.
- Operator credential creation and rotation require an already authenticated active operator, except for one-time bootstrap.
- Bootstrap migration is enabled only with `TORQCLAW_COLLAB_BOOTSTRAP=1`, requires loopback binding, creates the first operator credential, emits the plaintext once, records completion, and permanently refuses a second bootstrap unless the database is restored from a backup predating completion.
- Verification attempts are rate-limited per credential ID and remote address. Default: 10 failures per minute, then a 15-minute credential-ID cooldown. Limits are configurable only within documented finite bounds.
- Credential expiry is optional; if present, it is checked before session resume and every command.

### 6.3 Backup and key loss

- Database backup does not contain the pepper or plaintext credentials.
- The operator must back up the deployment secret separately.
- Restoring `state.db` without the matching pepper starts collaboration in locked recovery mode: existing credentials cannot authenticate, no collaboration reads/writes/subscriptions are allowed, and only an explicit loopback recovery procedure authenticated by the existing TORQCLAW bootstrap authority may mint a replacement operator credential and increment every principal authorization epoch.
- Recovery is audit-logged without recording replacement secrets.

## 7. Normative state machines

### 7.1 Principal

| Current | Actor/action | Next | Effect |
|---|---|---|---|
| absent | operator creates agent | active | Agent may authenticate after credential creation and membership grant |
| active | operator suspends | suspended | Increment `auth_epoch`; block commands, reads, writes, resume, and delivery |
| suspended | operator restores | active | Increment `auth_epoch`; prior sockets remain closed and must reauthenticate |
| active/suspended | operator revokes | revoked | Increment `auth_epoch`; terminal state; revoke all credentials |
| active operator | bootstrap authority revokes operator | revoked | Increment operator epoch and every owned-agent epoch; all collaboration locks |
| revoked | any restore | invalid | Deny |

There is no operator suspension in v1; operator deactivation is revocation and requires the documented recovery path.

### 7.2 Membership

| Current | Operator action | Next | Effect |
|---|---|---|---|
| absent | add active owned agent | active | Increment/create `membership_epoch`; agent can read/write/subscribe |
| active | add again | active | Idempotent; return existing membership |
| active | remove | removed | Increment `membership_epoch`; block delivery and commands for this channel |
| removed | remove again | removed | Idempotent |
| removed | add | active | Increment `membership_epoch`; old socket/subscription remains invalid; reauthenticate or resubscribe |

Owner membership is created atomically with the channel and cannot be removed.

### 7.3 Channel

| Current | Operator action | Next | Effect |
|---|---|---|---|
| absent | create | active | Create channel and owner membership atomically |
| active | archive | archived | Increment `channel_epoch`; block posts and membership mutation |
| archived | unarchive | active | Increment `channel_epoch`; clients must refresh state |
| active/archived | delete | invalid | No delete command in v1 |

### 7.4 Message and tombstone

| Current | Action | Next | Effect |
|---|---|---|---|
| absent | active member posts valid message | visible | Immutable message committed once |
| visible | operator tombstones | tombstoned projection | Append tombstone event; normal UI hides source text |
| tombstoned | tombstone again | tombstoned projection | Idempotent; return original tombstone |
| any | edit/delete source row | invalid | Source event is immutable |

### 7.5 Subscription

| Current | Trigger | Next | Effect |
|---|---|---|---|
| absent | authorized subscribe | initializing | Capture authorization epochs and snapshot high-water sequence |
| initializing | backlog through high-water sent | live | Flush buffered authorized events above high-water, then live delivery |
| initializing/live | principal/member/channel epoch mismatch | closed | Purge unsent queue; no new socket writes |
| initializing/live | slow-consumer limit | closed | Preserve last acknowledged cursor; client may reconnect |
| initializing/live | socket closes | closed | In-memory state removed |
| closed | any delivery | invalid | Drop |

## 8. Revocation and delivery concurrency contract

### 8.1 Epochs

- `principals.auth_epoch` increments on suspension, restore, revocation, and recovery reset.
- `collab_members.membership_epoch` increments on add after removal and removal.
- `collab_channels.channel_epoch` increments on archive and unarchive.
- Each subscription stores the three epochs observed at authorization.
- Each queued delivery carries the observed epochs and target principal ID.

### 8.2 Coordinator and linearization

One in-process `CollaborationAuthorizationCoordinator` serializes these operations for the single gateway process:

1. Revocation/removal/archive acquires the coordinator write lock.
2. It commits the SQLite state and epoch increment.
3. While still holding the lock, it marks affected subscriptions closed and purges their unsent queues.
4. The commit is the revocation linearization point.
5. It releases the lock and returns success.

Every socket write:

1. Acquires the coordinator read lock.
2. Revalidates principal state, owner state, credential state where applicable, membership state, channel state, and all three epochs against current SQLite rows.
3. Initiates the socket write only if all values match.
4. Releases the read lock.

A write initiated before the revocation linearization point is ordered before revocation even if network delivery completes later. No write may be initiated after the linearization point. Tests instrument the socket-write call boundary, not packet arrival.

This contract is single-process. Multi-gateway deployment is a non-goal until a distributed authorization-epoch and fan-out design receives separate review.

## 9. Replay and cursor contract

- `collab_events.seq` is a global SQLite `INTEGER PRIMARY KEY AUTOINCREMENT` cursor.
- Timeline queries always filter by authorized `channel_id` and `seq`.
- `ACK_CHANNEL_CURSOR` stores the greatest acknowledged sequence for one principal/channel using `MAX(existing, submitted)`; regressions are idempotent no-ops.
- A cursor does not grant access. Every replay checks current authorization first.
- Subscribe acquires the coordinator read lock, validates authorization, registers a bounded buffer, reads the channel high-water sequence, releases the lock, and returns backlog pages through that high-water mark.
- New committed events above the high-water mark enter the subscription buffer.
- Before each backlog or buffered/live socket write, the delivery epoch contract applies.
- Once backlog through high-water is sent, buffered events are sorted by sequence, duplicate event IDs are removed, and live mode begins.
- Page limit is 100 events and 512 KiB encoded. The server returns `nextCursor` and `hasMore`.
- Slow-consumer queue limit is 1,000 events or 4 MiB, whichever occurs first. Crossing either closes the subscription with `COLLAB_SLOW_CONSUMER` and does not advance the acknowledged cursor.

## 10. Data and integrity contract

Equivalent names are allowed only if these constraints remain mechanically enforced.

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
  CHECK((kind='operator' AND owner_principal_id IS NULL) OR
        (kind='agent' AND owner_principal_id IS NOT NULL))
);
CREATE UNIQUE INDEX one_nonrevoked_operator
  ON principals(kind) WHERE kind='operator' AND status!='revoked';

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
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK(state IN ('active','archived')),
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  channel_epoch INTEGER NOT NULL DEFAULT 1 CHECK(channel_epoch > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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
  kind TEXT NOT NULL CHECK(kind IN
    ('channel_created','channel_archived','channel_unarchived',
     'member_added','member_removed','message','message_tombstoned')),
  target_event_id TEXT,
  client_idempotency_key TEXT,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(channel_id, actor_principal_id, client_idempotency_key),
  UNIQUE(channel_id, id),
  FOREIGN KEY(channel_id, target_event_id)
    REFERENCES collab_events(channel_id, id)
);

CREATE TABLE collab_cursors (
  channel_id TEXT NOT NULL REFERENCES collab_channels(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  acknowledged_seq INTEGER NOT NULL CHECK(acknowledged_seq >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(channel_id, principal_id)
);
```

Additional transaction checks that SQLite constraints cannot express:

- Channel owner principal must be the active operator.
- Exactly one active owner membership must exist per channel.
- Agent membership principal must be an agent owned by the channel owner.
- Target event for a tombstone must be a `message` in the same channel and not already tombstoned.
- `client_idempotency_key` is required for message and tombstone mutations and is 16 to 128 visible ASCII characters.
- Event IDs and all principal/channel IDs are UUIDs validated before SQL.
- `content_json` is parsed and reserialized from strict server-side schemas before insert. Unknown fields fail.

### 10.1 Event payload schemas

- `message` v1: `{ "text": string }`, 1 to 32,000 UTF-8 characters after normalization; no HTML.
- `message_tombstoned` v1: `{ "reasonCode": "operator_removed" | "sensitive_content" | "policy_violation" }` plus `target_event_id` column.
- `member_added`/`member_removed` v1: `{ "subjectPrincipalId": UUID }`.
- Channel lifecycle v1: `{ "channelId": UUID }`.

All payloads are data, never instructions. There is no general arbitrary `system` payload in v1.

## 11. Protocol and errors

### 11.1 ConnectFrame v2

`ConnectFrame` adds `principalId`, `credential`, and `protocolVersion: 2`. The gateway resolves and persists principal ID and role on session creation. Resume requires exact persisted principal and role equality.

### 11.2 Commands

- `CREATE_AGENT`, `SET_AGENT_STATUS`, `ROTATE_PRINCIPAL_CREDENTIAL`
- `CREATE_CHANNEL`, `RENAME_CHANNEL`, `ARCHIVE_CHANNEL`, `UNARCHIVE_CHANNEL`
- `ADD_AGENT_MEMBER`, `REMOVE_AGENT_MEMBER`
- `LIST_CHANNELS`, `GET_CHANNEL_TIMELINE`
- `SUBSCRIBE_CHANNEL`, `UNSUBSCRIBE_CHANNEL`, `ACK_CHANNEL_CURSOR`
- `POST_CHANNEL_MESSAGE`, `TOMBSTONE_CHANNEL_MESSAGE`

Every command has a strict schema, finite text/array limits, and one production authorization path. Collaboration commands do not ride in untyped `SYSTEM` metadata.

### 11.3 Externally observable denial contract

- Reads by ID for absent and unauthorized channels/events return the same code `COLLAB_NOT_FOUND`, same transport status, and the same payload keys and lengths.
- List operations return only authorized rows and no hidden totals.
- Mutation denial returns `COLLAB_NOT_PERMITTED` without confirming hidden resource existence.
- Search is out of scope.
- Tests send 10,000 randomized absent and unauthorized read requests through the same production handler on an isolated reference machine. The two classes must use the same prepared SQL statement and query plan, and their p95 latency difference must be no more than 50 ms. This is a regression signal, not a claim of perfect timing-channel elimination.

## 12. Functional requirements

- Channel creation and owner membership commit in one transaction.
- Membership removal and epoch increment commit in one transaction.
- Message acceptance, idempotency record, and event sequence commit in one transaction.
- Retrying an accepted idempotency key returns the original event ID and sequence without creating a row.
- Message source rows are immutable. Tombstones affect normal projection only.
- Archived channels remain visible to members and read-only.
- No permanent delete or retention automation exists in v1.
- Collaboration history is not injected into TORQCLAW task memory or prompts in v1.
- Existing `SUBMIT_PROMPT` behavior remains independent; posting a channel message never triggers an agent task.

## 13. Security requirements

- Threats include credential theft, role/principal mismatch, session replay, revoked open sockets, removed-member queues, hidden-channel enumeration, forged actor IDs, idempotency collision, oversized events, SQLite injection, browser cache crossover, and prompt-like message content.
- Credentials and pepper never enter events, tasks, receipts, safe exports, metrics, or errors.
- Collaboration content is untrusted text and is rendered as text, not HTML.
- Existing tool and approval authority is unchanged and unreachable through collaboration commands.
- Browser storage and query keys include gateway instance ID, principal ID, channel ID, and cursor. Principal change clears in-memory collaboration state before rendering the new identity.
- Failed refreshes display stale/error state; cached data is never labeled current after authorization or network failure.
- Multi-process and remote non-loopback production are blocked unless gateway authentication, TLS termination, and the single-process coordinator assumptions are satisfied and documented.

## 14. Non-functional requirements

- Maximum encoded event: 64 KiB.
- Timeline page: at most 100 events and 512 KiB.
- Maximum agent members per channel: 100.
- Maximum active subscriptions per connection: 100.
- Timeline target: 100 events in 100 ms p95 warm over 100,000 synthetic events.
- Message commit target: 75 ms p95 excluding network transit and fan-out.
- Fan-out target: socket-write initiation within 250 ms p95 for 25 concurrent local clients.
- Benchmarks report hardware, database size, WAL/checkpoint state, cold/warm status, sample size, and percentile method.
- New UI meets WCAG 2.2 AA, keyboard navigation, visible focus, non-color state cues, and polite live-region announcements.

## 15. Implementation slices and required artifacts

### Slice 0: Contract freeze, no runtime wiring

Required artifacts:

- Zod command and event schemas plus generated JSON Schema where required.
- The authorization matrix in section 4 encoded as table-driven tests against the production `authorize` extension.
- State transition tables from section 7 encoded as pure transition tests.
- Exact SQLite migration and index plan from section 10.
- Protocol success/error fixtures including byte-identical absent/unauthorized response shapes.
- Revocation/socket linearization harness with an instrumented write boundary.
- Subscription/replay model and slow-consumer fixtures.
- Malicious corpus for wrong principal/role, stale epochs, hidden IDs, duplicate keys, malformed payloads, oversized data, SQL/HTML content, and cursor regression.

Exit: independent Gate 1 confirms no unresolved critical/high contract issue. No production collaboration command is enabled.

### Slice 1: Identity and revocation

- Add principal/credential storage, bootstrap, ConnectFrame v2, session binding, credential rotation, rate limiting, recovery lock, epochs, and coordinator.
- Feature flag: `TORQCLAW_COLLAB_IDENTITY_V2`.

Exit: every identity, credential, owner-revocation, resume-mismatch, recovery, and concurrent socket-write test passes. Existing ConnectFrame v1 behavior remains available only when collaboration is off.

### Slice 2: Channels and messages

- Add channels, memberships, events, cursors, commands, subscription/replay, tombstones, and doctor checks.
- Feature flag: `TORQCLAW_COLLAB_ENABLED`, dependent on identity v2.

Exit: all authorization, isolation, idempotency, replay, revocation, archive, tombstone, slow-consumer, migration, restore, performance, and feature-off criteria pass.

### Slice 3: Console UI

- Add channel navigation, unread cursor, timeline, agent membership management, stale/error states, and accessibility behavior.
- No task/approval/search/Git UI is included.

Exit: browser cache isolation, principal switch, keyboard, screen-reader, reconnect, stale-state, and end-to-end local pilot tests pass.

## 16. Acceptance criteria

### Identity

- Wrong principal/role combinations fail before session creation.
- Resume with a different principal or role fails and never creates a replacement session.
- Rotation with `replace=true` leaves one new active credential and makes the old credential fail on its next check.
- Missing pepper starts locked, emits no credential value, and enables no collaboration command.
- Operator revocation increments all owned-agent epochs and prevents subsequent collaboration access.

### Authorization and isolation

- Every matrix cell has a production-path test.
- A non-member receives the same status and response shape for an absent channel and an existing hidden channel.
- Hidden channels never contribute list rows or counts.
- Removing an agent increments membership epoch and closes its affected subscriptions.
- An archived channel permits authorized read/ack and rejects post/membership mutation.

### Revocation concurrency

- A delivery holding the read lock and initiating socket write before revocation is recorded as ordered-before revocation.
- After the revocation commit under the write lock, no instrumented socket-write call begins for the affected principal.
- Queued events are purged before revocation returns success.
- Stale epoch deliveries are dropped even if a subscription-removal callback fails.

### Messages and replay

- Duplicate message idempotency keys return the original ID/sequence and create one row.
- Replay from cursor N returns authorized channel events with `seq > N` in ascending order without duplicate IDs.
- Events committed during backlog transfer are buffered and delivered once after the snapshot high-water sequence.
- Cursor acknowledgements advance monotonically and never authorize a read.
- Tombstoning creates one immutable tombstone and hides source text from normal UI without changing the source row.

### Compatibility and operations

- With both feature flags off, accepted TORQCLAW Phase 1 commands, sessions, tasks, approvals, receipts, builds, and tests remain unchanged.
- Migration and restore pass against a copy of the accepted Phase 1 database.
- Rollback disables collaboration connections and writes while preserving source rows for operator recovery.
- Doctor detects missing pepper, invalid principal ownership, missing channel owner, stale cursor foreign keys, and orphan event references without printing content or secrets.

## 17. Rollout, rollback, and support

Rollout:

1. Contract tests and temporary SQLite only.
2. Identity v2 on loopback with synthetic principals.
3. One real operator plus one agent in one channel.
4. Up to two agents and 100,000 synthetic events for replay/performance testing.
5. Local operator pilot after independent security review.

Rollback:

1. Disable `TORQCLAW_COLLAB_ENABLED` to reject channel commands and subscriptions.
2. Disable identity v2 only after all collaboration clients are stopped.
3. Preserve collaboration tables and credentials; never auto-delete during rollback.
4. Restore prior session-centric TORQCLAW behavior.

Support documentation covers bootstrap, secret storage, rotation, revocation, recovery lock, agent membership, archive, cursor reset, backup/restore, doctor, and feature rollback.

Promotion stops on any hidden-channel disclosure, role/principal confusion, write after revocation linearization, duplicate event, lost accepted event, credential/pepper disclosure, cross-channel reference, policy widening, failed restore, or feature-off regression.

## 18. Metrics

Local bounded metrics, with no message text, channel name, display name, credential ID, event ID, or principal ID labels:

- Active channels and agent memberships.
- Message commits and duplicate retries prevented.
- Revocation/removal closures and stale-epoch drops.
- Replay pages, cursor lag buckets, slow-consumer closures, and reconnects.
- Authorization denials by bounded action class.
- Timeline latency and socket-write initiation latency histograms.
- Doctor findings by bounded category.

## 19. Risks and accountable roles

| Risk | Severity | Accountable role | Mitigation |
|---|---:|---|---|
| Role mistaken for identity | Critical | Security lead | Frozen hierarchy, ConnectFrame v2, matrix tests |
| Delivery after revocation | Critical | Gateway lead | Epochs, coordinator, pre-write validation, instrumented concurrency tests |
| Shared token defeats attribution | Critical | Security lead | Per-principal credentials and one-time bootstrap retirement |
| Hidden-channel oracle | High | Security lead | Same query/response contract, no hidden totals, regression timing harness |
| Cursor or backlog gap | High | Gateway lead | Snapshot high-water plus bounded live buffer and deterministic tests |
| SQLite contention affects execution | High | Gateway lead | Short transactions, WAL measurements, feature gate, performance stop |
| Browser cache crosses identity | High | Frontend lead | Gateway/principal/channel cache keys and identity-switch purge |
| Scope expands into execution or Git | High | Product owner | Explicit non-goals and separate PRDs |

Named humans must be assigned to these roles in the implementation tracker before Slice 1 starts. This administrative assignment does not change the technical contracts.

## 20. Remaining non-blocking decisions

- Final UI naming for channels and agents: product owner, before Slice 3.
- Exact reference Windows benchmark hardware: gateway lead, before Slice 2 performance gate.
- Default credential expiry for local-only installations: security lead, before Slice 1 pilot. `null` (no automatic expiry) is the implementation default unless changed; revocation and rotation remain available.

No unresolved decision may alter the authority hierarchy, credential algorithm, revocation semantics, schema isolation, or v1 scope without returning to Gate 1.

## 21. Definition of done

- Terra G1R or an equivalent independent reviewer reports no unresolved critical/high issue.
- Every authorization matrix cell and state transition has a production-contract test.
- Identity, credential, revocation, subscription, replay, idempotency, hidden-channel, migration, restore, rollback, accessibility, and performance criteria pass.
- Existing TORQCLAW TypeScript, contract drift, build, and Python gates pass with features off and on where applicable.
- No new tool, approval, routing, privacy, budget, memory, or execution authority is introduced.
- Documentation and secret-free examples are complete.

## 22. Research basis

Checked 2026-08-06:

- `E:\TorqClaw\README.md`
- `E:\TorqClaw\packages\gateway\db\schema.sql`
- `E:\TorqClaw\packages\gateway\src\sessions.ts`
- `E:\TorqClaw\packages\gateway\src\events.ts`
- `E:\TorqClaw\packages\gateway\src\authz.ts`
- `E:\TorqClaw\packages\channel-http\src\gatewayClient.ts`
- https://github.com/block/buzz/blob/main/README.md
- https://github.com/block/buzz/blob/main/ARCHITECTURE.md

The useful Buzz concept is a shared, replayable room for humans and agents. This PRD deliberately does not copy Buzz's current workflow approval, host-wide developer-tool, browser-cache, or owner-revocation weaknesses. It first proves the identity and delivery substrate on which later TORQCLAW task, search, and Git collaboration can safely depend.

## 23. First 48-hour proof

Build no UI and dispatch no model. Against a temporary SQLite database and instrumented fake sockets:

1. Bootstrap operator A and create agents B and C.
2. Create channel X, add B, and prove C sees the same response for X as for an absent channel.
3. Post one message twice with the same idempotency key and prove one row and one sequence.
4. Subscribe B, queue messages, revoke B while writes race, and prove no socket-write call starts after the revocation linearization point.
5. Restore B, re-add membership, reconnect from the acknowledged cursor, and prove ordered duplicate-free replay.
6. Try every disallowed authorization matrix action as B, C, `node`, and a mismatched role/principal pair.

The riskiest assumption is that in-memory fan-out can be reconciled with durable revocation in a single gateway process. The proof passes only when the production coordinator and socket-write boundary establish the claimed order under deterministic concurrency tests.


---

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


