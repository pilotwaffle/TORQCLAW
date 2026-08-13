# PRD-TCLAW-GATEWAY-AUTHORIZATION-005

## Server-owned gateway authority and browser-safe operator sessions

**Status:** **PHASE 1 IMPLEMENTED + VERIFIED + SOL G2A APPROVED LOCALLY / UNMERGED + UNPUSHED + INACTIVE / PHASE 2+ NOT AUTHORIZED**
**Revision:** 1.1 — normative Gate 1 packet plus verified Phase 1 receipt
**Pinned baseline:** `c2850f5ac755444d42b930034de536938f31ae22` (2026-08-12)
**Owner:** TORQCLAW operator
**Implementation authority:** the operator authorized Phase 1 only. Phase 2+, V2 activation, cutover, merge, push, deployment, credentials, and certificate operations remain unauthorized.
**Supersession:** replaces earlier gateway-authorization drafts as the normative design.

**Gate 1 clarification (approved by fresh Sol G1R):** Section 9.2.1 and the Phase 1 item below resolve the V1-marker/final-schema compatibility issue and the collision-safe qualified-catalog fence. Phase 1 subsequently passed fresh GPT-5.5 verification and fresh Sol G2A; it remains local and does not activate V2.

**Phase 2A clarification:** **PROPOSED / SOL G1R PENDING / NO IMPLEMENTATION AUTHORITY.** It is limited to offline/inert schema migration and non-authoritative reconciliation diagnostics; it issues no caller and creates no V2 session binding.

## 1. Decision, invariant, and scope

TORQCLAW should implement this architecture, subject to the operator gates in Section 18. The present gateway accepts a shared root token and persists a client-selected role for a fresh session; the console bundle reads that root token. This is not an acceptable authority boundary.

> **AUTHORITY INVARIANT:** every accepted V2 connection has exactly one immutable, server-produced `AuthenticatedCaller`. Its principal, surface, `(surface_kind, surface_role, connection_class)`, derived gateway role, `surface_auth_epoch`, `connection_class_revision`, `capability_revision`, launcher generation, and session intent come from a verified server-side carrier. A wire field may only assert equality; it can never create, select, widen, or transfer authority.

### 1.1 In scope

- V2 connection parsing, caller derivation, session creation and resume.
- Browser WebAuthn enrollment, recovery, session issuance, CSRF, TLS edge, and same-origin BFF WebSocket proxy.
- Migration/reconciliation of `collab.db` and `state.db`, a lifetime authorization coordinator, secret/config cutover, and first-party callers.
- Exact transport limits, concurrency, recovery, accessibility, observability, and artifact scanning.
- The bounded monotonic C2 hardening prerequisite in Section 11.

### 1.2 Explicit non-goals

- Public/Internet gateway exposure, multi-user RBAC, HA/multi-worker gateway, or identity-provider integration.
- Automation authority. It is denied pending a separately reviewed server-owned mapping.
- Signed remote-skill trust, artifact verification, governed-skill activation, or Hermes changes.
- A generic Next.js WebSocket upgrade implementation.
- A rollback that restores the deprecated shared root token after final retirement.

## 2. Current state at c2850f5

All present-tense claims in this section are source findings at the pinned baseline, not proposed behavior.

| Boundary | Current finding | Evidence |
|---|---|---|
| Connect frame | Client requires `role` and `token`; a surface credential is optional. | `packages/contracts/src/commands.ts:139-148` |
| Command sizing | `attachmentIds` and its elements, `queueId`, `approvalId`, and Connect `token`/`clientInfo` strings are unbounded; 100,000 UTF-16 edited Markdown can exceed 600 KB once JSON escaped. | `packages/contracts/src/commands.ts`; current command schemas reviewed at pinned HEAD |
| Root verifier | `TORQCLAW_GATEWAY_TOKEN` is compared; if unset, loopback callers are accepted. | `packages/gateway/src/server.ts:151-164` |
| Fresh session | `sessions.resolve()` inserts the wire role. | `packages/gateway/src/sessions.ts:37-70` |
| Resume | Stored role is compared with the wire role only after session resolution. | `packages/gateway/src/server.ts:240-260`; `authz.ts:60-79` |
| C1 SI-3 | Valid same-principal cross-surface resume is intentionally preserved. | `packages/gateway/src/surfaceGate.ts:16-21`; `sessions.ts:50-60` |
| Console | Browser code reads `NEXT_PUBLIC_GATEWAY_TOKEN`, sends it and `role:'operator'`. | `apps/console/src/components/TorqTerminal.tsx:34-35`; `useGatewayStream.ts:15-38` |
| Console server | The console runs stock `next dev`/`next start`; no upgrade proxy exists. | `apps/console/package.json:5-10`; `ops/dev-up.mjs:137-143` |
| Launcher | Production requires matching server/browser root tokens; children inherit parent environment. | `ops/launcher-config.mjs:37-47`; `ops/dev-up.mjs:48-54,84-92` |
| Secret store | Windows Credential Manager adapter is a throwing stub. | `packages/collab/src/secrets.ts:67-87` |
| C2 registration | Missing evidence/errors return `null`, allowing legacy registration. | `packages/gateway/src/c2Broker.ts:126-173` |
| C2 flag path | Flag-off or unbound approval returns `legacy`. | `packages/gateway/src/c2Broker.ts:190-203` |
| C2 admission | Delegation and deciding epoch are checked, but stored exact approve grant, live deciding role, origin epoch, and origin capability revision are not all rechecked. | `grantAdmission.ts:153-232`; grant fields at `approvalWriter.ts:512-533` |
| Authority revoke | Direct `revokeAuthority()` does not increment surface auth epoch. | `surfaceSecurity.ts:430-440` |

### 2.1 Phase 4 is shipped and protected

`c2850f5` is the Phase-4 remote-skill-source merge. It already makes `APPROVE_SKILL` share the same live `approve` predicate as `APPROVE_TOOL` in `packages/gateway/src/authz.ts:220-243`; its tests cover that seam in `tests/collab-h1-operator-subordination.test.ts:268-339`. Phase-4 error guidance also exists in `packages/gateway/src/skillDecision.ts:22-92`.

The older `docs/SCOPE-PHASE4-REMOTE-SOURCES.md` text saying “NOT merged” is stale intermediate documentation and is not authority over pinned Git HEAD. The authorization lane preserves these seams; it does not own or rewrite them.

Product Graphify is not relied upon: `graphify-product/graph.json` is absent at this baseline, so its strict fitness gate cannot establish architecture truth. Source above is authoritative.

## 3. Threat model

Defended threats include a browser-visible root-token disclosure, role substitution, cross-site loopback requests, replay/racing of a ticket/capability, a stale/revoked surface, a failed two-database migration, stale release artifact downgrade, C2 legacy fallback, and a stale authorization decision reaching a tool.

The design does not claim to protect against a local administrator replacing binaries or arbitrary same-origin JavaScript after a browser session is established. Those are accepted residual risks in Section 17.

## 4. Frozen operator rulings

The following selections require operator ratification; they are not open implementation alternatives in this PRD.

1. **OPERATOR APPROVAL REQUIRED — WebAuthn recovery-kit-only enrollment recovery.**
2. **OPERATOR APPROVAL REQUIRED — Windows Certificate Store local CA**, supporting current managed **Windows Edge and Chrome**. Firefox is unsupported until separately proven.
3. **OPERATOR APPROVAL REQUIRED — Windows Credential Manager** supplies persistent secrets.
4. **OPERATOR APPROVAL REQUIRED — no production synthetic approval carrier.**
5. **OPERATOR APPROVAL REQUIRED — SI-3 remains:** same-principal, same-derived-role cross-surface resume is allowed.
6. **OPERATOR APPROVAL REQUIRED — retention:** transient auth rows 24 hours; browser-session revocations 30 days; audit/cutover/migration ledgers indefinitely.
7. **OPERATOR APPROVAL REQUIRED — downgrade-fence release required** before final cutover.

## 5. Caller, credential, and role matrix

V2 adds no new gateway roles: derived role is one of existing `operator`, `channel`, or `node`. `expectedRole` is required equality-only metadata.

| `connection_class` | Required surface tuple | Derived role | Command allowance |
|---|---|---|---|
| `browser_bff` | `desktop|mobile`, `operator` | operator | Existing operator policy; live `approve` still gates tool and Phase-4 skill approval |
| `channel_dedicated` | `http`, `agent` | channel | Existing channel allowlist |
| `agent_node` | `desktop|mobile|http`, `agent` | node | none |
| `diagnostic` | non-operator surface | node | none; doctor and launcher probes may only connect/close |
| `benchmark_submit` | `http`, `agent` | channel | `SUBMIT_PROMPT` only |
| `acceptance_submit` | `http`, `agent` | channel | `SUBMIT_PROMPT` and own-session observation only |
| `fixture_operator` | test fixture | operator | V2_TEST only; V2_FINAL startup/runtime reject |
| automation, unknown, root, V1 | any | denied in V2 | none |

Dedicated credentials are independent 32-byte CSPRNG values held in Windows Credential Manager; raw values are never stored in either SQLite database. Their server verifier maps a credential to exactly one class/surface/principal/role. Doctor and launcher probes use `diagnostic`; benchmark uses `benchmark_submit`; acceptance uses `acceptance_submit`; automated approval E2E uses `fixture_operator` only in isolated V2_TEST. Production approval acceptance uses the normal browser operator, never an automation credential. `AuthenticatedCaller` carries the exact tuple plus four non-interchangeable values: `surface_auth_epoch` revokes authority, monotonic `connection_class_revision` changes a surface's class mapping, `capability_revision` invalidates issued capability material, and `launcher_generation` identifies an installation lifecycle. None substitutes for another or for CSPRNG entropy, a secret, nonce, or bearer.

## 6. Browser authentication and non-raceable enrollment

### 6.1 Enrollment/recovery transfer

The permanent authorization coordinator owns recovery and enrollment. A native recovery utility reads the recovery secret from stdin, authenticates to the coordinator over its named pipe, and requests registration for one exact configured browser surface.

The coordinator generates an independent 256-bit enrollment authorization and a WebAuthn challenge. It returns only a human-transfer pairing code: a full 128-bit random Base32 value grouped for manual entry. The utility displays it; it is never passed by URL, argv, clipboard, browser bundle, log, or persisted plaintext.

Only domain-separated HMACs are persisted, bound to exact principal/surface, RP ID, origin, launcher generation, 120-second expiry, and pending state. Browser posts the code to `/api/auth/enroll/redeem`; an immediate state transaction atomically changes `pending -> redeeming` before challenge disclosure. A second redemption receives a generic refusal.

Browser submits the WebAuthn registration response with authorization and challenge IDs. Verification requires exact RP ID/origin, user verification, valid public key material, challenge binding, and authenticator-counter policy. Recovery authorizes credential enrollment only; it never creates a browser session.

### 6.2 Login and browser session

Login uses a separate 256-bit WebAuthn authentication challenge. On a valid assertion, state DB creates a browser session with opaque 256-bit bearer and CSRF secret persisted only as HMACs:

`__Secure-torqclaw-auth=<opaque>; HttpOnly; Secure; SameSite=Strict; Path=/api/auth/; Max-Age=28800`

No `Domain` attribute is set. `__Host-` is deliberately not used because it requires `Path=/`, which conflicts with the required `/api/auth/` cookie path.

### 6.3 Enrollment journal across databases

Cross-database atomicity is unavailable. Under the coordinator mutex:

1. State immediate transaction validates authorization/challenge, consumes them, and writes `COLLAB_PENDING` enrollment intent.
2. A separate collab transaction inserts the exact credential once.
3. A state transaction verifies the committed credential fingerprint and marks the intent `COMPLETE`.

A crash before collab commit creates no usable credential. A crash after collab commit may complete bookkeeping only if the exact journal credential fingerprint exists. Until completion login denies; recovery never auto-mints a session.

## 7. Console TLS edge and browser-compatible BFF

`console-edge` is a dedicated launcher-owned TLS/WSS process. It proxies normal HTTP to Next but owns `/api/auth/**` and WebSocket upgrade. Stock Next App Router is not a WebSocket BFF seam.

- The edge private key is non-exportable in Windows Certificate Store.
- The local CA/leaf certificate has exact configured SANs, including `localhost` and `127.0.0.1` where supported.
- Production has no HTTP/WS fallback; failed certificate/trust readiness refuses startup.
- Certificate renewal increments launcher generation and invalidates browser session/CSRF/ticket/capability material while preserving durable gateway sessions.

Browser obtains an in-memory CSRF value from an authenticated no-store endpoint, then posts `POST /api/auth/ws-ticket` with cookie, `X-Torqclaw-CSRF`, exact Origin/Host, and `Sec-Fetch-Site:same-origin`. The body is either `{}` for fresh create or `{sessionId,lastSeenSeq}` for resume.

The edge returns one 128-bit single-use upgrade nonce, valid 15 seconds. Browser supplies it using WebSocket subprotocols:

```text
torqclaw.v2, ticket.<base64url nonce>
```

It is never a URL parameter. The edge validates cookie, origin, host, fetch-site, selected protocol, ticket, expiry, and single consumption; then it asks gateway’s loopback internal issuer to mint a one-use 30-second capability. Raw capability stays edge-to-gateway in a private internal header. The browser sees no reusable operator, surface, issuer, gateway, or capability secret.

The first browser-visible frame is exactly:

```json
{"protocolVersion":2,"expectedRole":"operator","clientInfo":{"name":"torq-console","version":"..."}}
```

It contains no wire role, token, credential, session ID, capability, or resume selector.

## 8. Sessions and SI-3

A later Phase 3/4 V2 session binding records principal and immutable derived role. It does not use a session-stored mutable surface authority. On every socket attach, caller verification and binding checks require:

1. valid current `AuthenticatedCaller` tuple, `connection_class_revision`, `surface_auth_epoch`, and capability revision;
2. caller principal equal to session principal; and
3. caller derived role equal to session derived role.

This preserves SI-3: two valid operator surfaces for one principal can concurrently resume the same operator session. Their live command authority remains separately checked per socket. A channel or node cannot resume it because role equality fails. `sessions.role` remains legacy/audit data, never V2 authority.

For browser fresh creation, a later Phase 4 gateway consumes the capability in one state `BEGIN IMMEDIATE` transaction, creates `sessions`, creates the V2 binding with the caller's `connection_class_revision`, and creates the browser-to-gateway session binding before commit. Crash before commit leaves no partial session; crash after commit leaves a complete resumable binding. This is not Phase 2A behavior.

## 9. Exact migrations and durable schema

### 9.1 Collab database

```sql
-- Shipped collab_schema_migrations is untouched. Authorization owns this ledger.
CREATE TABLE collab_auth_schema_migrations (
  id TEXT PRIMARY KEY,
  checksum_sha256 TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

ALTER TABLE surfaces ADD COLUMN connection_class TEXT NOT NULL DEFAULT 'none'
  CHECK(connection_class IN ('none','browser_bff','channel_dedicated','agent_node',
    'diagnostic','benchmark_submit','acceptance_submit','fixture_operator'));
ALTER TABLE surfaces ADD COLUMN connection_class_revision INTEGER NOT NULL DEFAULT 1
  CHECK(connection_class_revision > 0);

CREATE TABLE webauthn_credentials (
  credential_id TEXT PRIMARY KEY,
  surface_id TEXT NOT NULL REFERENCES surfaces(surface_id) ON DELETE RESTRICT,
  public_key_cose BLOB NOT NULL,
  public_key_sha256 TEXT NOT NULL UNIQUE,
  sign_count INTEGER NOT NULL CHECK(sign_count >= 0),
  transports_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_webauthn_credentials_surface_live
  ON webauthn_credentials(surface_id, state);
```

### 9.2 State database

```sql
CREATE TABLE IF NOT EXISTS gateway_schema_migrations (
  id TEXT PRIMARY KEY,
  checksum_sha256 TEXT NOT NULL CHECK(length(checksum_sha256)=64 AND checksum_sha256 GLOB '[0-9a-f]*'),
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_runtime_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  state_schema INTEGER NOT NULL CHECK(state_schema IN (1,2)),
  mode TEXT NOT NULL CHECK(mode IN ('V1_COMPAT','V2_TEST','V2_FINAL')),
  launcher_generation INTEGER CHECK(launcher_generation > 0),
  serving_state TEXT CHECK(serving_state IN ('STOPPED','VERIFYING','SERVING','FAILED')),
  config_digest_sha256 TEXT,
  secret_set_id TEXT,
  cutover_id TEXT,
  updated_at TEXT NOT NULL,
  CHECK(
    (state_schema=1 AND mode='V1_COMPAT' AND launcher_generation IS NULL
      AND serving_state IS NULL AND config_digest_sha256 IS NULL
      AND secret_set_id IS NULL AND cutover_id IS NULL)
    OR
    (state_schema=2 AND launcher_generation > 0 AND serving_state IS NOT NULL
      AND config_digest_sha256 IS NOT NULL AND secret_set_id IS NOT NULL)
  )
);
```

### 9.2.1 Approved Phase 1 marker/fence clarification

Phase 1 creates **only** `gateway_schema_migrations` and `auth_runtime_state` from the preceding SQL. It never opens or writes `collab.db`; `collab_auth_schema_migrations` begins in Phase 2. It writes exactly one marker row: `(singleton=1, state_schema=1, mode='V1_COMPAT', launcher_generation=NULL, serving_state=NULL, config_digest_sha256=NULL, secret_set_id=NULL, cutover_id=NULL, updated_at=UTC ISO-8601)`. Phase 1 `cutover_id` is inert `TEXT`, deliberately without a foreign key to a later cutover table; Phase 2 adds application validation and cutover transition semantics. The schema is deliberately forward-compatible: schema 2 may use all three listed modes but must satisfy the second check branch. The schema-2 requirements above preserve the final semantics; the later transition validates the V1 row in `BEGIN IMMEDIATE`, populates the required schema-2 fields, updates `state_schema`/mode in that same transaction, and commits. Phase 1 never performs that transition.

Immediately after `new Database(state.db)`, and **before** `journal_mode`, `foreign_keys`, `schema.sql`, any C1/C2 migration, bridge discovery, listener preparation, or `BEGIN`, the gateway runs this read-only full validator. Every marker/ledger read is qualified to `main`: `main.sqlite_schema`; `PRAGMA main.table_info`, `PRAGMA main.index_list`, `PRAGMA main.index_info`, and `PRAGMA main.foreign_key_list`; and `SELECT` from `main.gateway_schema_migrations` / `main.auth_runtime_state`. Unqualified catalog, pragma, or marker queries are forbidden.

1. Read `PRAGMA database_list`. Its accepted result is `main` plus optional SQLite `temp`; any other attached schema refuses `AUTH_RUNTIME_MARKER_ATTACHED_DB` before `BEGIN`. The fence never calls `ATTACH`. The required TEMP catalog spelling is exactly `sqlite_temp_schema` (not `temp.sqlite_schema`): independently inventory it even when `temp` is absent from `database_list` until first use.
2. In both `main.sqlite_schema` and `sqlite_temp_schema`, inventory every object type using `lower(name)` **or** `lower(tbl_name)` against the ASCII reserved identifiers `gateway_schema_migrations` and `auth_runtime_state`; do not filter to tables. The exact read is `SELECT type,name,tbl_name,sql FROM main.sqlite_schema WHERE lower(name) IN ('gateway_schema_migrations','auth_runtime_state') OR lower(tbl_name) IN ('gateway_schema_migrations','auth_runtime_state') ORDER BY type COLLATE BINARY,name COLLATE BINARY,tbl_name COLLATE BINARY`, repeated with `FROM sqlite_temp_schema`. Case-fold is deliberate because SQLite identifiers are ASCII case-insensitive. Legacy means exactly zero reserved inventory rows in both schemas.
3. Any TEMP inventory row is `AUTH_RUNTIME_MARKER_TEMP_SHADOW`. In `main`, a wrong-case table, a view, trigger, named index, an index/trigger whose `tbl_name` is reserved, a duplicate/case-variant catalog row, or any other collision refuses `AUTH_RUNTIME_MARKER_INCOMPATIBLE` read-only before `BEGIN`. SQLite normally prohibits same-schema case variants; exact-cardinality validation remains mandatory against corruption and test doubles.
4. The only accepted nonlegacy main inventory is exactly three rows: canonical lowercase `table` rows named/tabled `gateway_schema_migrations` and `auth_runtime_state`, plus `sqlite_autoindex_gateway_schema_migrations_1` (`type='index'`, `tbl_name='gateway_schema_migrations'`, `sql IS NULL`). Each canonical table `sql` byte-equals a checked-in **expected stored catalog SQL byte string**, derived by executing the two canonical Phase 1 `CREATE TABLE IF NOT EXISTS` statements on the supported SQLite version and recording SQLite's actual catalog transformation (including removal of ` IF NOT EXISTS` and the terminal semicolon as observed). The validator compares only stored bytes; it cannot and must not reject unrecoverable source-history spelling that SQLite normalized. Consequently, keyword-case-only input is accepted iff SQLite stores bytes identical to the expected canonical catalog bytes. No whitespace normalization or alternative **stored** SQL bytes are accepted.
5. Shape validation is exact: `PRAGMA main.index_list('gateway_schema_migrations')` returns only `(seq=0,name='sqlite_autoindex_gateway_schema_migrations_1',unique=1,origin='pk',partial=0)`; `PRAGMA main.index_info('sqlite_autoindex_gateway_schema_migrations_1')` returns only `(seqno=0,cid=0,name='id')`; `PRAGMA main.index_list('auth_runtime_state')` is empty; and `PRAGMA main.foreign_key_list` is empty for both tables. `PRAGMA main.table_info` must exactly match the columns/types/nullability/default/PK grain of the two displayed statements: ledger `(id TEXT,0,NULL,1)`, `(checksum_sha256 TEXT,1,NULL,0)`, `(applied_at TEXT,1,NULL,0)` and marker `(singleton INTEGER,0,NULL,1)`, `(state_schema INTEGER,1,NULL,0)`, `(mode TEXT,1,NULL,0)`, `(launcher_generation INTEGER,0,NULL,0)`, `(serving_state TEXT,0,NULL,0)`, `(config_digest_sha256 TEXT,0,NULL,0)`, `(secret_set_id TEXT,0,NULL,0)`, `(cutover_id TEXT,0,NULL,0)`, `(updated_at TEXT,1,NULL,0)`.
6. For the accepted foundation shape, read only `main.auth_runtime_state` and `main.gateway_schema_migrations`. Require exactly the schema-1 V1 row above and a ledger containing **only** `gateway-auth-foundation-001` with the exact expected checksum. Any extra/unrecognized ledger row, schema-2 row, non-V1 mode, missing/duplicate/bad row, or checksum mismatch refuses before a write or bind.
7. Only after an allowed result may writable pragmas and existing schema work run. If legacy, acquire `BEGIN IMMEDIATE`, rerun this entire validator (including database list, both inventories, SQL/shape/cardinality, and marker/ledger state) before any insert/DDL, then create/insert. After inserts, rerun the entire validator before commit. A post-scan collision or mismatch rolls back with no marker, ledger, or schema mutation.

Migration ID is `gateway-auth-foundation-001`. Its expected lowercase SHA-256 is a checked-in constant over the UTF-8 migration ID bytes, followed by **one LF byte (`0x0A`)**, followed by the LF-normalized canonical SQL bytes of exactly the two displayed Phase 1 `CREATE TABLE IF NOT EXISTS` statements (with no marker insert or later-phase DDL). In one `BEGIN IMMEDIATE` transaction it executes the full validation/revalidation sequence above, inserts the exact V1 row and checksum receipt only when both objects were absent, otherwise no-ops only on exact matching state, and rolls back/refuses every partial or mismatch state. It never repairs, deletes, overwrites, or downgrades a marker.

### 9.2.2 Proposed Phase 2A migration and diagnostic clarification

Phase 2A is offline/inert migration plus diagnostics only. It creates no `AuthenticatedCaller`, `WeakSet` factory, verified carrier, V2 session binding, launcher generation, lifetime mutex, or freshness authority. `gateway_v2_session_bindings` and `auth_reconciliation_receipts` are Phase 3+ objects; their later authority semantics must not be inferred from the Phase 2A diagnostic table.

The Phase 2A state migration ID is `gateway-auth-identity-reconciliation-002`; the collab migration ID is `collab-auth-identity-reconciliation-002`. `collab_auth_schema_migrations` is separate from, and never mutates, shipped `collab_schema_migrations`. The new Phase 2A binary accepts exactly two state-ledger sets while `auth_runtime_state` remains the exact schema-1 V1 row: `{gateway-auth-foundation-001}` and `{gateway-auth-foundation-001,gateway-auth-identity-reconciliation-002}`. Every partial, missing, duplicate, checksum-mismatched, or extra state-ledger mixture refuses. `runAuthFoundationMigration` no-ops on either complete set. The Phase 1 `37667e9` binary rejects the second set by design.

Each Phase 2A checksum is SHA-256 over UTF-8 migration-ID bytes, one `0x0A` byte, then LF-normalized canonical migration-program bytes. The program contains only its guarded collab/state DDL and exact catalog-shape assertions in execution order; it explicitly excludes the ledger-receipt insert and any diagnostic-row insert. Source publishes a golden vector `{id, programUtf8Hex, sha256Hex}` for each migration and unit tests recompute the digest byte-for-byte. Canonical tuple hashing uses UTF-8 length-prefixed fields in order `(principal_id,surface_id,surface_kind,surface_role,connection_class,connection_class_revision)`; no delimiter encoding is allowed.

Only an operator-supplied offline invocation may run Phase 2A. The tool obtains exclusive write locking separately for each database and refuses when it cannot acquire either lock; it neither claims a cross-database snapshot nor attempts to prove all production services are stopped. It performs collab migration first and commits, then state migration and commits; no DB transactions overlap. A crash or state failure after collab commit leaves an idempotent rerun; it creates at most an informational `non_authoritative=1` diagnostic record. Hash divergence is `MISMATCH`/`INVALID` diagnostic evidence only: it never changes V1 startup, authority, surface state, credentials, provisioning, revocation, or repair behavior.

Diagnostic tuple eligibility is explicit: principal `status='active'`, surface `state='active'`, positive class revision, and the Section 5 kind/role/class mapping. `none` is recorded as legacy/ineligible. Because no non-`none` production producer exists in Phase 2A, a real diagnostic may legitimately contain zero eligible tuples. `fixture_operator` is excluded from production diagnostics; it may appear only in a test-only fixture database marked `fixture_mode=1`, and is never a production diagnostic or authority input.

```sql

-- Phase 3+ authority receipt; Phase 2A does not create or consume this table.
CREATE TABLE auth_coordinator_runtime (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  installation_id TEXT NOT NULL UNIQUE,
  coordinator_pid INTEGER NOT NULL CHECK(coordinator_pid > 0),
  launcher_generation INTEGER NOT NULL CHECK(launcher_generation > 0),
  artifact_manifest_sha256 TEXT NOT NULL,
  config_digest_sha256 TEXT NOT NULL,
  secret_set_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('STARTING','VERIFYING','SERVING','FAILED','STOPPED')),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE auth_reconciliation_receipts (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  collab_auth_ledger_sha256 TEXT NOT NULL,
  collab_tuple_sha256 TEXT NOT NULL,
  state_projection_sha256 TEXT NOT NULL,
  reconciled_at TEXT NOT NULL
);

-- Phase 2A-only diagnostic record. It is never authority and is never
-- consumed by gateway runtime, a caller factory, binding logic, or startup.
CREATE TABLE IF NOT EXISTS auth_reconciliation_diagnostics (
  diagnostic_id TEXT PRIMARY KEY,
  non_authoritative INTEGER NOT NULL CHECK(non_authoritative=1),
  status TEXT NOT NULL CHECK(status IN ('MATCH','MISMATCH','INVALID')),
  collab_auth_ledger_sha256 TEXT NOT NULL,
  collab_tuple_sha256 TEXT NOT NULL,
  state_projection_sha256 TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  detail_code TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_reconciliation_diagnostics_observed
  ON auth_reconciliation_diagnostics(observed_at);

CREATE TABLE enrollment_authorizations (
  authorization_id TEXT PRIMARY KEY,
  authorization_hmac BLOB NOT NULL UNIQUE,
  pairing_code_hmac BLOB NOT NULL UNIQUE,
  principal_id TEXT NOT NULL,
  surface_id TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  launcher_generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','redeeming','consumed','expired','revoked')),
  expires_at TEXT NOT NULL,
  redeeming_at TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_enrollment_authorizations_live
  ON enrollment_authorizations(expires_at) WHERE state IN ('pending','redeeming');

CREATE TABLE webauthn_challenges (
  challenge_id TEXT PRIMARY KEY,
  challenge_hmac BLOB NOT NULL UNIQUE,
  enrollment_authorization_id TEXT UNIQUE REFERENCES enrollment_authorizations(authorization_id) ON DELETE RESTRICT,
  surface_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('register','authenticate')),
  rp_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  launcher_generation INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_webauthn_challenges_live
  ON webauthn_challenges(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE enrollment_journal (
  enrollment_id TEXT PRIMARY KEY REFERENCES enrollment_authorizations(authorization_id) ON DELETE RESTRICT,
  surface_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  public_key_sha256 TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('COLLAB_PENDING','COLLAB_COMMITTED','COMPLETE','FAILED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  failure_code TEXT
);

CREATE TABLE auth_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('enrollment_created','enrollment_redeemed',
    'enrollment_completed','browser_session_created','browser_session_revoked',
    'ws_ticket_consumed','capability_consumed','cutover_phase',
    'coordinator_started','coordinator_failed','serving_enabled')),
  subject_type TEXT NOT NULL,
  subject_id_hmac TEXT,
  launcher_generation INTEGER NOT NULL,
  connection_class_revision INTEGER CHECK(connection_class_revision IS NULL OR connection_class_revision > 0),
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_auth_events_created ON auth_events(created_at);
```

```sql
-- State projection carries the exact collab tuple; it is never caller input.
ALTER TABLE gateway_surface_security ADD COLUMN connection_class TEXT NOT NULL DEFAULT 'none'
  CHECK(connection_class IN ('none','browser_bff','channel_dedicated','agent_node',
    'diagnostic','benchmark_submit','acceptance_submit','fixture_operator'));
ALTER TABLE gateway_surface_security ADD COLUMN connection_class_revision INTEGER NOT NULL DEFAULT 1
  CHECK(connection_class_revision > 0);
CREATE UNIQUE INDEX idx_gateway_surface_security_v2_tuple
  ON gateway_surface_security(surface_id, surface_kind, surface_role, connection_class, connection_class_revision);

CREATE TABLE browser_sessions (
  browser_session_id TEXT PRIMARY KEY,
  surface_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  bearer_hmac BLOB NOT NULL UNIQUE,
  csrf_hmac BLOB NOT NULL,
  launcher_generation INTEGER NOT NULL CHECK(launcher_generation > 0),
  state TEXT NOT NULL CHECK(state IN ('active','revoked','expired')),
  expires_at TEXT NOT NULL,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_browser_sessions_live
  ON browser_sessions(bearer_hmac, state, expires_at);

CREATE TABLE ws_upgrade_tickets (
  ticket_id TEXT PRIMARY KEY,
  nonce_hmac BLOB NOT NULL UNIQUE,
  browser_session_id TEXT NOT NULL REFERENCES browser_sessions(browser_session_id) ON DELETE RESTRICT,
  intent TEXT NOT NULL CHECK(intent IN ('CREATE','RESUME')),
  requested_session_id TEXT,
  last_seen_seq INTEGER CHECK(last_seen_seq IS NULL OR last_seen_seq >= 0),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  CHECK((intent='CREATE' AND requested_session_id IS NULL)
     OR (intent='RESUME' AND requested_session_id IS NOT NULL))
);
CREATE INDEX idx_ws_upgrade_tickets_live
  ON ws_upgrade_tickets(nonce_hmac, expires_at) WHERE consumed_at IS NULL;

CREATE TABLE gateway_ws_capabilities (
  capability_id TEXT PRIMARY KEY,
  capability_hmac BLOB NOT NULL UNIQUE,
  ticket_id TEXT NOT NULL UNIQUE REFERENCES ws_upgrade_tickets(ticket_id) ON DELETE RESTRICT,
  surface_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  derived_role TEXT NOT NULL CHECK(derived_role IN ('operator','channel','node')),
  connection_class TEXT NOT NULL CHECK(connection_class='browser_bff'),
  connection_class_revision INTEGER NOT NULL CHECK(connection_class_revision > 0),
  surface_auth_epoch INTEGER NOT NULL CHECK(surface_auth_epoch > 0),
  capability_revision INTEGER NOT NULL CHECK(capability_revision > 0),
  issuer_generation INTEGER NOT NULL CHECK(issuer_generation > 0),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_gateway_ws_capabilities_live
  ON gateway_ws_capabilities(capability_hmac, expires_at) WHERE consumed_at IS NULL;

CREATE TABLE gateway_v2_session_bindings (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE RESTRICT,
  principal_id TEXT NOT NULL,
  derived_role TEXT NOT NULL CHECK(derived_role IN ('operator','channel','node')),
  creator_surface_id TEXT NOT NULL,
  creator_connection_class TEXT NOT NULL,
  connection_class_revision INTEGER NOT NULL CHECK(connection_class_revision > 0),
  bind_generation INTEGER NOT NULL CHECK(bind_generation > 0),
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX idx_gateway_v2_resume
  ON gateway_v2_session_bindings(principal_id, derived_role, closed_at);

CREATE TABLE browser_gateway_sessions (
  browser_session_id TEXT NOT NULL REFERENCES browser_sessions(browser_session_id) ON DELETE RESTRICT,
  gateway_session_id TEXT NOT NULL REFERENCES gateway_v2_session_bindings(session_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(browser_session_id, gateway_session_id)
);

CREATE TABLE auth_cutover_journal (
  cutover_id TEXT PRIMARY KEY,
  from_mode TEXT NOT NULL CHECK(from_mode='V1_COMPAT'),
  phase TEXT NOT NULL CHECK(phase IN ('PREPARED','V2_COMMITTED','CONFIG_ACTIVATED',
    'ROOT_ERASED','VERIFYING','COMPLETE','ABORTED')),
  expected_launcher_generation INTEGER NOT NULL CHECK(expected_launcher_generation > 0),
  release_manifest_sha256 TEXT NOT NULL,
  config_digest_sha256 TEXT NOT NULL,
  secret_set_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  failure_code TEXT
);
CREATE TABLE auth_cutover_transitions (
  from_phase TEXT NOT NULL,
  to_phase TEXT NOT NULL,
  PRIMARY KEY(from_phase, to_phase)
);
INSERT INTO auth_cutover_transitions(from_phase,to_phase) VALUES
  ('PREPARED','V2_COMMITTED'),('PREPARED','ABORTED'),
  ('V2_COMMITTED','CONFIG_ACTIVATED'),('CONFIG_ACTIVATED','ROOT_ERASED'),
  ('ROOT_ERASED','VERIFYING'),('VERIFYING','COMPLETE');
CREATE TRIGGER auth_cutover_phase_transition
BEFORE UPDATE OF phase ON auth_cutover_journal
WHEN NOT EXISTS (SELECT 1 FROM auth_cutover_transitions t
                 WHERE t.from_phase=OLD.phase AND t.to_phase=NEW.phase)
BEGIN SELECT RAISE(ABORT,'invalid_auth_cutover_phase_transition'); END;
```

The browser-session row holds only HMACs; the cookie, CSRF secret, upgrade nonce, and gateway capability are raw only in their intended memory hop. `gateway_v2_session_bindings` is written in the same `BEGIN IMMEDIATE` state transaction that consumes the capability, inserts/reuses `sessions`, and records `browser_gateway_sessions`; a crash therefore yields neither a usable capability nor a partially browser-bound session. `surface_id`, `principal_id`, and journal `credential_id` carried between `state.db` and `collab.db` are application-validated cross-database references, never fictitious SQLite foreign keys. All displayed same-database references are `ON DELETE RESTRICT`; cleanup is terminal-only. Every authorization migration uses `collab_auth_schema_migrations` or `gateway_schema_migrations`, plus `PRAGMA table_info`, index inspection, and `sqlite_master` validation before its ledger row is written. Shipped `collab_schema_migrations` is preserved untouched. Old `none` class rows are valid only in V1_COMPAT and deny in V2.

Phase 2A diagnostics read normalized collab and state tuples separately after their independent migrations, calculate the canonical hashes, and persist only `auth_reconciliation_diagnostics.non_authoritative=1`. They claim neither a cross-DB snapshot nor freshness, are not consumed by startup/runtime/caller/binding code, and treat divergence only as informational `MISMATCH`/`INVALID`. A later Phase 3 authority coordinator may introduce lifetime locking, an authoritative receipt, live epoch/revision checks, and startup refusal only after separate Gate 1 approval.

The coordinator, and only the coordinator, runs retention under the installation mutex. Every 15 minutes it deletes expired `webauthn_challenges`, `enrollment_authorizations`, `enrollment_journal` rows in terminal failed/expired states, consumed `ws_upgrade_tickets`, and consumed/expired `gateway_ws_capabilities` only after `expires_at + 24 hours`; it deletes revoked browser-session rows only after `revoked_at + 30 days`. Foreign keys are enabled in every connection, cleanup is `RESTRICT` (never cascade), and a row with a non-terminal journal or live binding is refused rather than deleted. Credentials, revocation evidence, `auth_events`, cutover rows/transitions, and both migration ledgers are retained indefinitely.

## 10. Lifetime coordinator, mutex, pipe, and fate group

The launcher/auth coordinator acquires an installation-specific Windows named mutex before opening auth databases or binding listeners, and retains it for the entire fate-group lifetime. It exclusively owns cross-database migration/reconcile/provision/revoke/enrollment recovery/cutover/generation operations.

Gateway and edge may perform ordinary single-state-db runtime transactions, but cannot perform cross-db writes or provisioning. Native recovery utilities use a current-user/System-DACL Windows named pipe. Every launch uses an IPC challenge authenticated by recovery-kit-derived proof. Same-user malware is an explicit residual host-compromise risk.

Every cross-store operation holds the installation mutex and has no overlapping database transactions, but there is deliberately no universal database order:

| Operation | Durable transaction protocol under the mutex |
|---|---|
| Enrollment | state `COLLAB_PENDING` intent -> commit; collab credential insert -> commit; state fingerprint verification/`COMPLETE` -> commit |
| Deny-first/grant-last class change or revocation | state deny/revision advance -> commit; collab tuple update -> commit; state projection/reconciliation receipt -> commit |
| Ordinary provisioning where no prior denial is required | collab tuple/credential record -> commit; state projection -> commit |
| Runtime ticket/capability/session work | state-only `BEGIN IMMEDIATE` transaction |

Thus `surface_auth_epoch`, `connection_class_revision`, `capability_revision`, and launcher generation remain independently monotonic, and neither database transaction is held while the other is open. A second launcher/direct writer refuses. If an owner dies, a successor acquires the abandoned mutex, validates owner death, marks old runtime failed, performs deterministic journal recovery, then launches a new fate group. Coordinator death terminates edge/gateway/Next through one Windows job object; named-pipe callers time out and fail closed.

## 11. C2 prerequisite hardening

This is mandatory monotonic debt closure; it does not claim C2 is unshipped.

- With C2 enabled, registration missing evidence or throwing emits a terminal refusal and creates no legacy approval row.
- A C2-bound row remains C2-bound after flag transition; flag-off must refuse it, not decide it as legacy.
- Admission must, in one immediate transaction, validate exact deciding `approve` grant ID, current deciding role/kind/epoch, origin auth epoch, origin capability revision, delegation, action hash, expiry, and one-shot consume.
- `revokeAuthority()` must revoke and increment the owning projection epoch in one transaction.
- Existing LOCAL_EDGE/BRIDGE/FRONTIER fences remain. C2-granted FRONTIER remains refused absent a separately approved exact-argument Hermes pre-tool protocol.

In V1_COMPAT, a flag-off unbound legacy row retains its current legacy behavior; this is the only flag-off compatibility preservation. In every V2 mode, a C2-bound row must refuse when C2 is disabled or evidence is absent. No V2 feature flag may disable server-derived surface/caller checks.

## 12. Protocol and backpressure limits

| Boundary | Exact limit |
|---|---:|
| Inbound WS message | 3,407,872 bytes |
| Gateway outbound event | 3,407,872 bytes |
| Per-socket unsent queue | At most 2 queued frames **or** 6,815,744 pending bytes, whichever is first |
| HTTP headers | 8,192 bytes |
| V2 hello/control envelope | 16,384 bytes |
| Prompt/preview envelope | 212,992 bytes |
| Skill-decision envelope | 655,360 bytes |

Compression is disabled. Frames are UTF-8 text only. Binary, invalid UTF-8, oversized messages, and an outbound event that would exceed either queue bound fail before unbounded buffering. On the first queue-limit failure gateway may enqueue one bounded terminal `backpressure` control frame only if it fits; it then closes with WebSocket 1013 and drops all non-persisted outbound events. Events are not implicitly persisted or replayed: only already-durable session/queue records retain their existing semantics; V2 adds no queue persistence. The 3.25 MiB transport/event cap preserves valid Phase-4 512 KiB skill markdown under worst-case JSON escaping without changing Phase-4 files.

All currently unbounded command identifiers/arrays/client-info/token fields receive explicit byte/count bounds. Parser rejects duplicate semantic JSON keys before `JSON.parse`; V2 schemas are strict.

### 12.1 Phase 1 inert strict-wire foundation

Phase 1 puts V2-only schemas and decoder helpers in gateway-local `packages/gateway/src/v2Contracts.ts` and `packages/gateway/src/strictWire.ts`. They are exported for focused tests only: no production `/ws` path, route, environment flag, generated schema, or Hermes tree imports them in Phase 1. This avoids dual generated-contract emission and preserves `packages/contracts/**`, generated contract JSON, and `engines/hermes_kernel/**`.

`V2ConnectHello` is a strict object containing only `protocolVersion: 2`, `expectedRole: 'operator'|'channel'|'node'`, and strict `clientInfo`; it rejects `role`, `token`, `auth`, `sessionId`, credentials, capability material, and every unknown field. Exact local limits are: `queueId`, `approvalId`, and each `attachmentId` ≤256 UTF-8 bytes; `attachmentIds` ≤64 entries; `clientInfo.name` and `.version` ≤128 UTF-8 bytes each; `previewOf` ≤512 UTF-8 bytes; and `taskId` remains UUID. Existing 32,000-character prompt/preview and 100,000 UTF-16-code-unit `editedMarkdown` semantic limits remain; their serialized envelopes use the Section 12 caps. The strict decoder accepts text only, measures UTF-8 bytes before parse, rejects escape-equivalent duplicate semantic keys before `JSON.parse`, rejects unknown keys, and returns bounded non-secret failures without logging raw input.

## 13. Dedicated first-party caller migration

Migrate console, channel HTTP, doctor, acceptance, benchmark, E2E, and launcher probes before final cutover. Child environment allowlists pass only each child’s necessary endpoint and credential reference; no child receives the root token or unrelated secrets. Doctor uses a zero-command diagnostic connection; health probes remain health-only. Final production has no `NEXT_PUBLIC_GATEWAY_TOKEN` and no root-token fallback.

## 14. Phased implementation and exit gates

1. **Downgrade-fence/foundation:** state-only V1 marker reader/migration ledger, gateway-local inert `v2Contracts`/`strictWire`, and protected Phase-4 semantic manifest. The reader runs before any write-capable DB action; no V2 production parser or behavior is wired. Exit: a current-compatible binary refuses every non-V1/incompatible marker before any write or listener bind.
2. **Identity/reconciliation diagnostics (Phase 2A):** class/revision migration and offline, non-authoritative two-DB diagnostics only. No caller, binding, live parser, startup refusal, repair, or provisioning. Exit: exact per-DB migration/diagnostic evidence while V1 bytes and startup remain unchanged.
3. **Authority coordinator/enrollment:** separately reviewed lifetime coordinator, verified carrier/freshness authority, opaque caller issuance, V2 bindings, mutex/pipe/job object, Credential Manager, CA/TLS, and WebAuthn enrollment/recovery/journal. Exit: crash/race fixtures green.
4. **Console edge/BFF:** CSRF, ticket subprotocol, server-only capability, fresh/resume browser flow. Exit: built artifact scan and browser E2E.
5. **Dedicated callers and C2:** carrier migration and Section 11 hardening. Exit: complete C2 route/mutation matrix.
6. **V2_TEST:** fixture-only deployment, root rejection, restart/revocation soak. Exit: 24h or 10,000 auth attempts, whichever is later.
7. **Final cutover:** operator-signed receipt, state machine below, independent clean-worktree verification.

## 15. Cutover, downgrade, rollback, and recovery

Cutover is a permanent supervisor operation with these monotonic phases:

```text
PREPARED -> V2_COMMITTED -> CONFIG_ACTIVATED -> ROOT_ERASED -> VERIFYING -> COMPLETE
```

Only `PREPARED -> ABORTED` is allowed. There is no post-commit V1 rollback.

1. **PREPARED:** record release manifest hash, migration/reconciliation receipt, config digest, and secret set.
2. **V2_COMMITTED:** one state transaction sets V2_FINAL and advances launcher generation; services remain non-serving.
3. **CONFIG_ACTIVATED:** atomically install final config and per-child allowlists.
4. **ROOT_ERASED:** delete/revoke root secret-store value; remove `TORQCLAW_GATEWAY_TOKEN` and `NEXT_PUBLIC_GATEWAY_TOKEN` from `.env`, child env, launch manifests, and generated configuration.
5. **VERIFYING:** the same coordinator starts the hashed fate group on final ports with edge non-ready. It returns 503 except a coordinator-capability-guarded internal acceptance path.
6. **COMPLETE:** after complete booted gate evidence, one state transaction writes COMPLETE and `SERVING`; the same supervisor flips readiness without a handoff, restart, or second supervisor.

Before V2_COMMITTED, perform a clean console rebuild and scan source, `.next`, source maps, logs, release archives, env manifests, and built bundles for root-token sentinels/public token names. V2_FINAL requires `TORQCLAW_COLLAB_ENABLED=1`.

The downgrade fence quarantines older binaries and requires every retained pre-cutover binary to inspect `auth_runtime_state` before listener bind, refusing schema 2/non-V1 state. An administrator can replace binaries; this is a host-admin residual risk, not a claimed SQLite protection.

V2_FINAL startup validates `TORQCLAW_COLLAB_ENABLED=1`, the V2 marker, coordinator ownership, reconciliation receipt, exact configured surface checks, and root-token absence before it binds a serving listener. Any false/missing condition fails closed; an auth-mode switch cannot turn surface checks off.

Recovery after ROOT_ERASED is V2 reprovisioning only. It may not restore root token, V1 wire acceptance, or a tokenless loopback path.

## 16. Observability, accessibility, and privacy

Metrics/events use bounded reason enums and HMAC correlators only. They never include bearer values, credentials, prompts, URLs, cookies, raw IDs, or WebAuthn material. Doctor verifies an authenticated round trip, not health alone.

The console provides visible and `aria-live` states for enrollment, authentication, reconnect, expired session, revoked authority, and required recovery. All flows are keyboard-completable and do not rely on color. Error responses exposed to untrusted callers are generic and existence-oblivious.

## 17. Acceptance, mutation, and residual-risk matrix

Required tests include:

- Phase 2A per-DB migration cases: fresh/legacy/idempotent/partial/corrupt/checksum-tampered/extra-ledger/missing-column states; collab-first then state failure/crash and idempotent rerun; no overlapping transactions or cross-DB authority claim.
- Phase 2A diagnostic cases: exact length-prefixed hash golden vectors; active-principal/active-surface/class-matrix eligibility; `none` ineligible; `fixture_operator` excluded outside `fixture_mode=1`; zero eligible real tuple result; mismatch/invalid result is a `non_authoritative=1` record only and leaves V1 startup/authority/surface/credential/provisioning/revocation unchanged.
- Phase 2A isolation evidence: migration/diagnostic modules are unreachable from `server.ts`, live C1 helpers, `sessions.resolve()`, and V1 root-token flow; no caller/factory/binding production module or `ForTest` authority API exists.
- Phase 1 verbose-trace unit matrix covers both reserved identifiers in exact/mixed case; every `table`/`view`/`index`/`trigger` collision by `name` and `tbl_name`; missing/extra inherent autoindex; malformed SQL/shape/index-list/index-info/FK list; TEMP shadow through exact `sqlite_temp_schema`; attached database; corrupt duplicate/cardinality result; every extra/unrecognized ledger row; and schema-2/non-V1 marker. Each initial refusal proves no `BEGIN`, DDL, DML, writable PRAGMA, bridge discovery, or bind occurred.
- Catalog-SQL tests derive the expected stored bytes from canonical Phase 1 DDL on the supported SQLite version, then assert rejection for alternative **stored** bytes: whitespace drift, quoted identifier drift, CRLF drift when SQLite preserves it, and constraint-literal drift. Keyword-case-only input is accepted exactly when SQLite stores byte-identical expected catalog SQL. Each source-input mutation helper begins from the exact anchors `CREATE TABLE IF NOT EXISTS gateway_schema_migrations` and `CREATE TABLE IF NOT EXISTS auth_runtime_state`, asserts `mutatedInput !== canonicalInput` before execution, and separately asserts `storedSql !== expectedStoredSql` before it expects a rejection; this prevents a no-op replacement from creating a false test.
- Phase 1 built persistent-main collision matrix leaves state bytes, catalog bytes, and WAL/journal artifacts unchanged for every initial collision, and proves no bridge discovery or port bind. It includes wrong-case canonical-looking tables, canonical views, attached index/trigger owners, and TEMP shadows.
- Phase 1 migration fault injection after **every** migration statement proves transaction rollback leaves neither a partial schema object nor a success ledger receipt or marker row; a rerun can only produce the one exact V1 marker and foundation receipt.
- Phase 1 marker concurrency/TOCTOU: another process changes legacy state to a collision after the read-only scan but before `BEGIN IMMEDIATE`; the full post-BEGIN validator rolls back without creating, overwriting, or downgrading any marker. Simultaneous legacy migrations have one committed exact V1 receipt and one safe no-op/recheck, never split state.
- Gateway-local inert V2 contract tests: exact UTF-8 byte/count limits, multi-byte boundary inputs, valid 32k prompt and 100k edited-Markdown serialized-envelope boundaries, strict unknown fields, and escape-equivalent duplicate JSON keys (for example literal and `\\u` spellings) before `JSON.parse`. Neither decoder failures nor marker refusals write state or log raw input.
- Phase 1 protected-manifest test: c2850f5 semantic target checks for the shared `APPROVE_TOOL`/`APPROVE_SKILL` live `approve` predicate in `packages/gateway/src/authz.ts`, existing Phase-4 subordination cases in `tests/collab-h1-operator-subordination.test.ts`, and Phase-4 guidance in `packages/gateway/src/skillDecision.ts`; implementation receipt also includes a protected-path diff audit against c2850f5. This is semantic evidence, not a brittle full-file hash.
- 128-bit pairing-code entropy/one-winner/expiry/no URL-argv-log-clipboard leak; every enrollment-journal crash point.
- Enrollment negatives: wrong pairing code, pairing-code replay, wrong launcher generation, wrong configured surface, and coordinator restart while redemption is in progress; each fails generically and cannot mint a session or consume another enrollment.
- WebAuthn negatives: revoked credential, revoked surface, unsupported browser/authenticator, wrong RP/origin/UV/counter, and a wrong challenge distinct from a replayed challenge; recovery cannot create a session.
- Same-principal same-role cross-surface resume and concurrent sockets; every mismatched role/class denial is write-free.
- Exact negative matrix: `agent`, `channel`, and root/token callers cannot obtain operator authority; the corresponding legitimate browser operator succeeds only through its BFF carrier.
- `AuthenticatedCaller` clone/spread/JSON/prototype/fixture/mutation tests prove no representation change, stale fixture, or wire copy can widen class, role, epoch, or revision.
- Atomic capability/session `CREATE` crash tests and concurrent-consumption one-winner tests; resume replay past 100 cursors is bounded and does not leak/allocate unbounded history.
- Privileged-sentinel scans cover browser client configuration, source, built artifacts, telemetry, receipts/support exports, and error payloads. The one-use ticket nonce appears only in the selected `ticket.<nonce>` WS subprotocol; the private capability and all other private carrier material are absent from selected protocol, other client-visible protocol values, logs, telemetry, receipts/support exports, and error bodies, and capability is absent from every internal request except the private edge-to-gateway header.
- WebSocket negatives cover wrong cookie, Origin, Host, CSRF, and `Sec-Fetch-Site`; ticket replay and concurrent use; invalid UTF-8, binary frames, compression, duplicate semantic JSON keys, fragmentation, and header-limit exceedance.
- Session and lifecycle negatives cover session revocation, gateway restart, edge restart, and launcher-generation change; all stale browser/session/ticket/capability material fails closed.
- V2_FINAL refuses `TORQCLAW_COLLAB_ENABLED!=1`, presence of either `TORQCLAW_GATEWAY_TOKEN` or `NEXT_PUBLIC_GATEWAY_TOKEN`, tokenless V1 acceptance, incomplete cutover, unapproved artifact, and mode/config/generation mismatch.
- VERIFYING-to-SERVING checks prove the same coordinator-supervised PIDs, artifact hashes, config digest, secret-set ID, and launcher generation; no handoff/restart is permitted.
- Every production carrier allowlist; V2_FINAL rejection of fixture carrier.
- Migration negatives cover fresh, legacy, partial, checksum-tampered, missing, extra, stale, and concurrent multi-process migration states; each prevents listener startup until the exact two-database reconciliation receipt matches.
- Mutex collision, owner-death recovery, pipe DACL/timeout, named-pipe wrong-user access, per-launch IPC-challenge replay, recovery-proof failure, direct-writer refusal, and coordinator death/job-object shutdown.
- Maximum escaped prompt/preview and 512 KiB Phase-4 draft transport/backpressure tests.
- C2 missing-evidence, flag transition, authority-grant/origin epoch/capability, and executor-fence mutants.
- Cutover phase crash matrix, stale secret/config mismatch refusal, downgrade-fence, and built artifact secret scans.
- Keyboard/screen-reader enrollment/reconnect/recovery paths.

Named mutants must make tests red when they treat a Phase 2A diagnostic as authority, issue an `AuthenticatedCaller`/binding, use a cross-DB snapshot or lifetime-mutex claim, accept an incomplete/extra Phase 2 ledger set, include ledger receipt/diagnostic inserts in checksum-program bytes, use delimiter-ambiguous tuple hashing, include inactive or unapproved-class tuples, admit `fixture_operator` outside fixture mode, repair/provision/revoke to force convergence, or reach live V1 server helpers; when they move the Phase 1 marker reader after a writable action; use case-sensitive, table-only, or `name`-only collision discovery; omit exact `sqlite_temp_schema`, database-list, or attachment checks; make an unqualified catalog/pragma/marker read; weaken cardinality, expected-stored-catalog-SQL, autoindex, index-list/index-info, or FK validation; treat a no-op source mutation as an alternative catalog form; skip the post-BEGIN full scan; accept non-V1/malformed/checksum-mismatched state; write on refusal; weaken strict parsing or escape-equivalent duplicate-key rejection; wire an inert V2 parser into production; trust V2 wire authority; allow binary/compression; widen a class/role matrix cell; make ticket/capability consumption non-atomic; expose capability to browser; widen cookie path; skip TLS/WebAuthn origin verification; bypass mutex/fate shutdown; downgrade C2-bound work to legacy; omit exact admission rechecks; remove Phase-4 `APPROVE_SKILL` predicate; or permit V1/root after final cutover.

Accepted residual risks: successful same-origin XSS can act through the active browser session; same-user malware may attack its user’s desktop; a local administrator can replace release binaries; Firefox is unsupported; and V1 remains known-insecure only while explicitly in V1_COMPAT before final cutover.

## 18. Ownership, prohibited files, and operator gates

Authorization implementation may touch contracts, gateway auth/session infrastructure, console edge/auth routes, launcher/coordinator/doctor, dedicated callers, migrations, and focused tests.

It must not modify `engines/hermes_kernel/**`, Phase-4 trust/queue/activation files, physical Phase-4 `APPROVE_SKILL` tests, generated unrelated schemas, memory/state reports, or unrelated runtime code. Any shared `authz.ts` merge must preserve the c2850f5 Phase-4 predicate and have Phase-4 owner review.

Operator must approve: the frozen rulings in Section 4; the exact caller matrix; retention; TLS/CA deployment; Credential Manager readiness; downgrade-fence release; C2 prerequisite scope; V2_TEST promotion evidence; and the final cutover receipt. Commit, push, merge, release, secret provisioning, certificate installation, and production activation remain operator-controlled.

Until all gates pass independently from a clean worktree, status is **designed/migration pending**, never “authorization remediation shipped.”
