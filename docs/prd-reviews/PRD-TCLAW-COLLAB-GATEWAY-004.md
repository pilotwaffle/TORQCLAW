# PRD-TCLAW-COLLAB-GATEWAY-004 — Surface Identity (C1) + Approval Broker (C2)

- Status: **DESIGN ONLY — Revision 4 correction, 2026-08-11.** This full §1–§13 document is the canonical C1/C2 design contract. It incorporates the frozen rulings (identity≠capability≠AUTHORITY; CT-2 `approve` provisioning; H-1 operator-short-circuit subordination; `CTXHASH_V1`; Property-10 apply-time re-validation deferred to C3) and corrects the destructive migration proposal that was pushed in `3220157`. No C1/C2 runtime build is authorized by this document. No runtime source, TrustOS, governed-skill, GS, or paused-lane file is changed by this design lane.
- Scope: **C1 (Surface Identity) and C2 (Approval Broker) only.** C3/C4 and everything in §9 are out of scope.
- Frozen schema baseline: **`af52430a0d719c449a9379866b84c154fc3c3b8a`** (merge of PR #44, C0.1 authenticated identity transport, on `feat/collab-gateway-c1-c2`). The C0 principal bridge (`packages/gateway/src/principalBridge.ts`) landed at `da688c0`, which is **historical only** as a baseline ref — its CONTRACTS (§1.3) remain frozen and are not re-specified. The target is **strictly additive over `af52430`**, with no destructive exception (§1.5).
- **Build gate (operator sequencing, updated 2026-08-11): the governed-skill implementation lane is CLOSED.** GS-COORD shipped (`c824bcd`) and GS-ROLLBACK closed GS-ACCEPT finding F-1 at `39a7707` on 2026-08-10. The lane handoff reports a merged-tree re-run of **9 passed / 1 xfailed** (minor F-2, empty-body); the immutable repository receipt still records the earlier 8 passed / 2 xfailed run on `83690f3`. A builder MUST re-run and receipt the active baseline rather than promote either count into current proof. The remaining external gate before any C1/C2 RUNTIME surface is the operator's **soak → governed default-on** decision, followed by separate explicit C1/C2 runtime authorization. See §11 CT-4.
- Feature flag: `TORQCLAW_COLLAB_ENABLED`, read **per-call** (`collabEnabled()`), default **off**. For a fixed legacy transcript, flag-off observable protocol bytes/order/errors, dispatch decisions, and existing logical row values are byte-identical to today—including the SEC-1 hole—per C0's rationale; additive schema bytes are not claimed identical.
- House-style ancestors: `docs/prd-reviews/PRD-TCLAW-COLLABORATION-SUBSTRATE-001-v0.14.md` (section shape, DDL rigor, exhaustive-registry discipline, consistency pre-gate).

---

## 1. Decision and scope boundary

### 1.1 Decision

Adopt a four-layer identity model (**Principal / Surface / Credential / Session**) and an **approval broker that EXTENDS the existing `tool_approvals` state machine** — it does not create a second one. Collab supplies identity and collaboration semantics; the gateway remains the sole execution authority. Both slices ship behind `TORQCLAW_COLLAB_ENABLED` (default off) and land only under the three-proofs acceptance bar in §5.

### 1.2 Authority boundary (normative)

| Concern | Owner | Note |
|---|---|---|
| Routing, tier selection, provider failover | **Gateway** | unchanged |
| Tool execution, tool grants, budget/spend caps | **Gateway** | unchanged |
| Execution status, receipts, events, spend ledger | **Gateway** | unchanged; `events` is append-only source of truth |
| **Approval STATE** (`pending→approved\|rejected\|expired`) | **Gateway** (`tool_approvals`) | C2 EXTENDS, never forks |
| Principal identity, surface identity, credential verification | **Collab** | C1 adds tables; crypto reuses `packages/collab/src/credentials.ts` |
| Which surfaces may receive/decide; who decided | **Collab configured identity → Gateway enforcement projection; Gateway canonical decision** | eligibility uses current `gateway_surface_security` + `surface_authorities`; immutable origin is `gateway_task_origins`; canonical origin/decision evidence is on `tool_approvals`; bindings carry only action/context facts |

### 1.2.1 The load-bearing distinction — identity ≠ capability ≠ AUTHORITY (FROZEN, normative)

Operator ruling 2026-08-08 (frozen; do not re-litigate). Three layers are kept **structurally distinct**, each stored and checked separately. This is the spine of the C1/C2 security model and the reason `approve` can never be reached through the execution path.

| Layer | Question it answers | Contents | Storage / check seam |
|---|---|---|---|
| **Identity** | WHO / WHERE | `principal_id`, `surface_id`, `session_id`, `task_id`, task origin | collab `principals` + `surfaces` (C1); `sessions` (C0); immutable per-request origin in `gateway_task_origins`; canonical approval origin/decider columns on `tool_approvals` (§2.13, §3.1) |
| **Execution CAPABILITY** | WHAT a surface may request/do | Existing `CapabilityClass` values `read` / `write` / `exec` / `send`, optionally narrowed by exact operation id; browser/network access is a scope/profile property, not a fifth capability | collab configuration is validated into `state.db.gateway_surface_security`, then checked at `authz.ts` (§2.7) |
| **Control-plane AUTHORITY** | WHICH control-plane DECISIONS a surface may make | `approve` (**frozen, reserved now**); `cancel`, `delegate` (**reserved for future**) | a **separate** authority store/check, NEVER the execution-capability path (§2.7.1, CT-2 §3.14) |

**Ruling AR-1 (frozen): `approve` is a reserved control-plane AUTHORITY token, not a tool/execution capability.** It is stored and checked separately from execution capabilities so it can **NEVER** be reached through the execution-capability path. A surface that holds `terminal_power` (or any execution profile) does not thereby hold `approve`. `approve` is frozen into the authority vocabulary as of this revision; `cancel` and `delegate` are reserved names for future authority primitives (each requiring its own threat model when introduced). This **clears C-3** and encodes **CT-2**.

**Vocabulary status:** the `approve` authority token is **RESOLVED and frozen** here. The residual **OQ-1 (§12)** is whether a surface grant uses only the shipped `CapabilityClass` set (`read|write|exec|send`) or additionally narrows to exact operation ids. Browser/network remains effective profile/scope state. See §2.7.

**Hard constraints (each a FREEZE blocker if violated):**

1. The gateway `sessions` table is NOT replaced by `collab_session_bindings`. C0 already ruled this out (`principalBridge.ts` header, "WHAT THIS DELIBERATELY DOES NOT DO"). C1 EXTENDS `sessions.resolve()` / `assertResumeAllowed()`; it does not swap, archive, rename, or delete the live C0.1 store.
2. No second execution/event/receipt/approval state machine is created. `events` stays the append-only source of truth; `run_receipts` and the new `approval_deliveries` are **rebuildable, droppable projections** modeled on the `run_receipts` precedent (`schema.sql §9`, `ops/receipts-rebuild.mjs`). Approval lifecycle evidence uses the canonical `tool_approvals` row plus existing `events`; a new approval-event log FAILS review (§6.5).
3. The existing physical `tool_approvals` table and its rows stay canonical for approval state and legacy display/audit `args_json`. Exact-action authority belongs only to the immutable binding and one-shot grant digests (§3.1). C2 adds exactly six nullable, guarded columns plus exactly one index, `idx_tool_approvals_status_expires`; it does not rebuild the table, rewrite history, change rowids, or move approval truth into a sidecar or collab table.
4. Flag-off = documented legacy behavior, byte-for-byte, including the SEC-1 hole for pre-bridge sessions (C0 rationale: enabling a subsystem and changing security behavior are separate, individually-revertable decisions).

### 1.3 What C0 already established (do not re-specify)

- `PrincipalBinding { principalId, surfaceId }`; `SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`.
- `collabEnabled()` reads `TORQCLAW_COLLAB_ENABLED` per-call (never captured at import — the stale-`dist` trap).
- `resolvePrincipalBinding(frame)` → `null` when flag off or no identity; **throws** on a PARTIAL claim (principal without surface, or surface without principal).
- `assertResumeAllowed(owner, caller)`: `owner null` → allow (legacy); `caller null` + `owner set` → refuse; principals differ → refuse (**SEC-1**); principals match → allow **regardless of surface** (cross-surface resume is the whole point).
- `sessions.principal_id`, `sessions.surface_id` exist (nullable), populated on create by `sessions.resolve()`.
- Migration precedent: `storage.ts:107-111` — `PRAGMA table_info(sessions)` guarding `ALTER TABLE ... ADD COLUMN` because `CREATE TABLE IF NOT EXISTS` never re-runs on an existing DB.

### 1.4 Controlling invariant (Revision 4, FROZEN, normative)

A command may cause direct external work only when a server-derived `ConnectionAuthContext`, current gateway-owned auth epoch, current effective execution-capability/profile revision, current scoped authority, and **one unconsumed exact-action grant** validate in the **same canonical `state.db` serialization interval at the actual pre-tool-execution seam immediately before `dispatch_started`**. Registration and the regenerated tool call both use `@torqclaw/collab` `canonicalJson` over `(request_id, tool_name, args)`; unequal action hashes do not consume the grant and return to a new approval. The winning transaction consumes the grant and durably records `dispatch_started` before the executor may invoke the side effect. Revocation/narrowing that commits first prevents execution; consumption that commits first may proceed and is never automatically replayed.

Consequences pinned by this invariant:

- `ConnectionAuthContext` is **server-derived and connection-scoped** from bind-time credential validation (§2.6 step 2), never client-supplied or trusted from a frame. A durable session can have multiple concurrent presenting surfaces; immutable task origin is captured per `request_id` in `gateway_task_origins` (§2.13), not overwritten in a session-keyed row.
- The "one unconsumed exact-action grant" is a first-class record (`gateway_action_grants`, §3.1). Task-level `dispatch()` is too early because model-generated args do not exist yet; every local/bridge/Hermes tool executor must call the one gateway admission seam with the actual `(tool,args)` immediately before execution. Missing, mismatched, consumed, revoked, or expired grant ⇒ no side effect.
- The revocation/dispatch race has exactly one legal outcome per side: whichever commits first wins, and the loser observes it. There is no window in which both a committed revocation and a subsequent automatic dispatch can hold.
- This invariant is the C2 counterpart of the gateway's existing no-replay discipline (`tool_approvals` first-decision-wins): decisions are never auto-replayed, and grants are never auto-reissued.
- `collab.db` and `state.db` are separate SQLite databases with separate WALs. This PRD claims no cross-database atomic transaction. Widening/provisioning commits identity/config in `collab.db` first and activates the gateway projection/authority **last**; interruption leaves the surface inactive. Revocation or narrowing commits the gateway deny/epoch/revision **first** and records the collab-side mutation second; interruption leaves dispatch denied. Recovery may finish revoke-side bookkeeping, but MUST NOT complete a partial grant or reverse a committed deny.
- Current LOCAL_EDGE and FRONTIER paths grant by tool name; FRONTIER's Hermes approval hook does not inspect args. Therefore the exact-action invariant is a future C2 dependency, not a current fact: LOCAL_EDGE must route every actual tool call through the gateway admission seam, and FRONTIER requires a separately authorized structured grant/check/consume protocol at the Hermes pre-tool-call hook. Until that protocol is proved reachable, FRONTIER approval under the flag fails closed. A crash after decision/grant but before tool admission never auto-dispatches; recovery revokes the inert grant and requires reissue.

### 1.5 Revision 4 baseline boundary (strictly additive over `af52430`)

The target state is **strictly additive** over the `af52430` baseline. The physical `state.db` and `collab.db` remain separate. Every baseline table name, column, index, trigger, row, value, and live lookup remains available; in particular:

1. `tool_approvals` is altered in place with exactly six nullable, `PRAGMA table_info`-guarded columns plus the guarded `idx_tool_approvals_status_expires` index. Its original rows, values, `args_json`, `status`, and SQLite `rowid` ordering are preserved.
2. `principals`, `principal_credentials`, and `collab_session_bindings` (which **does not swap** with gateway `sessions`) remain live in `collab.db`, as do `collab_installation` and `collab_schema_migrations`. C0.1 authentication/migration discovery continue unchanged. No table is renamed, archived, copied as replacement, or deleted.
3. `skill_queue`, tasks, events, episodes, receipts, telemetry, and every unrelated object are data-untouched. Card/export redaction is a read-time projection; C1/C2 performs no blanket at-rest rewrite.

Flag-off makes every new table and column inert. Any irreversible historical erasure or C0.1 retirement is a separate, explicitly authorized future migration, not C1/C2.

---

## 2. C1 — Surface Identity

### 2.1 The four-layer model (identity concepts)

| Layer | Definition | Authority | Storage |
|---|---|---|---|
| **Principal** | WHO owns authority. The unit of trust. | Holds the full authority set. | collab `principals` (C0 substrate) |
| **Surface** | WHERE a principal acts (a device/channel/automation endpoint). | Requests a bounded **SUBSET** of the principal role's permitted execution authority; control-plane authority remains separate. | `surfaces` (**C1, new**) |
| **Credential** | HOW a surface authenticates. | Proves a surface, not a principal. | `surface_credentials` (**C1, new**) |
| **Session** | Gateway execution + replay context. | Bound to `(principal_id, surface_id)` at create (C0); a resumed connection may present another valid same-principal surface. | `sessions` (C0 columns); connection auth stays in server-owned connection context; task origin snapshots live in `gateway_task_origins` (§2.13) |

**Invariant SI-1:** a Surface belongs to exactly one Principal. A compromised Surface exposes at most that Surface's effective execution-capability intersection and separately provisioned control-plane authority, **never** all authority implied by the principal role (§2.7).

**Invariant SI-2:** each of `desktop, mobile, http, telegram, slack, automation` is a **surface kind**, not a principal. Adding a new device or channel adds a `surfaces` row, never a `principals` row. The schema accommodates all six kinds without any per-kind table.

### 2.2 Canonical Surface schema (new table in `collab.db`)

```sql
-- C1: a Surface is where one Principal acts. Belongs to exactly one principal.
-- Additive, guarded migration (see §6.2); NEVER re-specifies sessions/principals.
CREATE TABLE IF NOT EXISTS surfaces (
    surface_id        TEXT PRIMARY KEY,               -- SAFE_ID shape (C0 regex reused)
    principal_id      TEXT NOT NULL,                  -- owner; SAFE_ID shape
    surface_kind      TEXT NOT NULL CHECK (surface_kind IN
                        ('desktop','mobile','http','telegram','slack','automation')),
    surface_role      TEXT NOT NULL DEFAULT 'agent'    -- OPERATOR-KIND DISCRIMINATOR (§2.7.1):
                        CHECK (surface_role IN ('operator','agent','automation')),
    display_name      TEXT,                           -- NFC-normalized + trimmed (collab text.ts discipline)
    capability_json   TEXT NOT NULL DEFAULT '[]',     -- bounded execution-capability request (§2.7)
    state             TEXT NOT NULL DEFAULT 'active'
                        CHECK (state IN ('active','revoked')),
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    revoked_at        DATETIME,
    last_seen_at      DATETIME,
    FOREIGN KEY (principal_id) REFERENCES principals(id),
    CHECK (surface_kind NOT IN ('telegram','slack','automation')
           OR surface_role != 'operator')
);
CREATE INDEX IF NOT EXISTS idx_surfaces_principal_state ON surfaces(principal_id, state);
```

Rationale for column choices, each pinned by a test:
- `surface_kind` CHECK enumerates exactly the six kinds (SI-2). A seventh kind is a reviewed schema change, not silent free text.
- `surface_id PRIMARY KEY` is globally unique within `collab.db`; it cannot be reused under a second principal. The principal foreign key and immutable-owner API pin SI-1. A composite ownership key may be added for validation, but can never replace this global key.
- **`surface_role` is the normative "operator-kind surface" discriminator** (FROZEN predicate, §2.7.1). `surface_kind` (device/channel type) is NOT sufficient to decide operator-kind: two `desktop` surfaces can differ in whether they are the operator's control-plane surface. `surface_role ∈ ('operator','agent','automation')` is the authoritative predicate CT-2 checks (`operator-kind surface ⇔ surface_role = 'operator'`), and it defaults to `'agent'` (fail-closed: a mis-provisioned surface is never operator-kind). The CHECK enumerates exactly three roles; a new role is a reviewed schema change.
- The cross-column CHECK makes CT-2 structural: `telegram`, `slack`, and `automation` kinds cannot be written as operator-role surfaces. Provisioning and decision time recheck both kind and role; the DDL constraint is a backstop, not the only guard.
- `state` mirrors the collab credential `('active','revoked')` two-state discipline (`credentials.ts` `state` field). Expiry is a **credential** property (§2.4), not a surface-row property.
- `capability_json` defaults to `'[]'` (deny-all) so a mis-provisioned surface holds no authority (§2.7, fail-closed).

### 2.3 Surface credential issuance + hashing (REUSE, do not redefine crypto)

Credentials for surfaces reuse `packages/collab/src/credentials.ts` verbatim as the crypto pattern. This PRD does not redefine any crypto primitive; it cites the contract:

- Token format `tq1_<credentialId>_<32-byte-base64url-secret>` (`issueCredential`).
- Store **only** `HMAC-SHA-256(principalPepper, complete-token-bytes)` (`secretHmac`). Plaintext token is shown **once**; the secret Buffer is `.fill(0)`'d after handoff (L1 discipline).
- Verification is **existence-oblivious** (`verifyCredential`): unknown ID, malformed token, revoked credential, and active-but-wrong-secret all cost the **same number of HMAC operations** (two: presented + decoy) and return the identical `{ ok:false, reason:'AUTH_FAILED' }`. `timingSafeEqual` is length-guarded to 32 bytes (throws on mismatch — G1R C1).
- No exception ever escapes `verifyCredential`.

```sql
CREATE TABLE IF NOT EXISTS surface_credentials (
    credential_id     TEXT PRIMARY KEY,               -- canonical lowercase UUID (parseToken shape)
    surface_id        TEXT NOT NULL,                  -- the surface this credential authenticates
    secret_hmac       BLOB NOT NULL UNIQUE,           -- one deterministic credential match; NEVER the token
    state             TEXT NOT NULL DEFAULT 'active'
                        CHECK (state IN ('active','revoked')),
    issued_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at        DATETIME,                        -- NULL = non-expiring; §2.4
    revoked_at        DATETIME,
    FOREIGN KEY (surface_id) REFERENCES surfaces(surface_id)
);
CREATE INDEX IF NOT EXISTS idx_surface_credentials_surface_state ON surface_credentials(surface_id, state);
```

`credential_id PRIMARY KEY` and `secret_hmac UNIQUE` are load-bearing: the `tq1_<credentialId>` lookup resolves at most one row before constant-work verification, and a duplicate id or HMAC is rejected by SQLite. Negative DDL probes for both collisions are C1 acceptance evidence (§7, C1-2).

> **Note on `expires_at` (contradiction surfaced — see §11 CT-1):** the collab substrate PRD/lint *forbids* `expires_at` and `'expired'` because they were removed from the **`principal_credentials`** model. This `expires_at` lives on **`surface_credentials`** (a different, C1-new table) and on the approval-expiry seam (§3.9). These are distinct tables with a distinct product requirement (surface credential TTL, one-shot-approval TTL). Reviewer must confirm the surface/approval TTL is intended to reintroduce expiry at the SURFACE/APPROVAL layer while the PRINCIPAL-credential layer keeps its no-expiry ruling. Encoded here as an **explicit divergence**, not an oversight.

### 2.4 Expiration

- Surface **credential** expiry is `surface_credentials.expires_at` (NULL = non-expiring). At verify time, an expired credential returns `AUTH_FAILED` on the **same existence-oblivious path** as revoked/unknown (add the `expires_at <= now` check to the state gate that already turns `state != 'active'` into `AUTH_FAILED`, so cost stays constant).
- A Surface itself does not expire; only its credentials do. A surface with all credentials expired is unreachable but its capability record and audit trail persist (recovery, §2.9).

### 2.5 Surface revocation

- `REVOKE_SURFACE` is a two-database **deny-first** protocol. First, one `state.db BEGIN IMMEDIATE` marks `gateway_surface_security` revoked and increments its auth/delegation revision, revokes live `surface_authorities`, and revokes every unconsumed grant bound to the surface. Only after that commits does a `collab.db BEGIN IMMEDIATE` mark `surfaces.state='revoked'`, set `revoked_at`, and cascade the surface credentials to revoked. There is no cross-WAL atomicity claim.
- Post-revocation, any live session bound to that `(principal, surface)` MUST be refused on its next resume attempt (§2.6) and — design contract only — SHOULD have its socket closed with a `surface_revoked` close reason. (Socket-close wiring is builder work; the contract is: revocation is observable, not silently deferred.)
- Revocation is **not** the same as a different-principal refusal. A revoked surface belonging to principal A still fails as A's surface; SEC-1 (different-principal) remains a separate, stronger refusal.
- Under the §1.4 invariant, a revocation that COMMITS before a dispatch admission check wins: the check reads current scoped authority in the same serialization interval and refuses. A dispatch that committed first stands, durably recorded, never replayed.
- If the collab-side second commit fails, the gateway remains denied and recovery may complete only that revoke/audit write. It never rolls the epoch back or recreates authority/grants.

### 2.6 Session binding (EXTEND sessions.resolve / assertResumeAllowed — do NOT replace)

C1 tightens the C0 resume path **without removing any C0 rule**. Today `sessions.resolve()` calls `resolvePrincipalBinding(frame)` then `assertResumeAllowed(owner, caller)`. C1 inserts a **surface-validity gate** between binding-resolution and the C0 principal check:

Ordered resume gate (all conditions evaluated in this order; first refusal wins):
1. `resolvePrincipalBinding(frame)` (C0) — throws on PARTIAL claim; `null` when flag off / no identity.
2. **C1 surface-validity:** if `caller` is non-null, verify the presented credential and active owned surface, then require the matching live gateway security projection. Failure → `AUTH_FAILED` (existence-oblivious). On success the server derives a connection-scoped `ConnectionAuthContext`; at each task ingress it writes immutable `gateway_task_origins` evidence for that request (§2.13). It never overwrites one session-wide auth row.
3. **C0 `assertResumeAllowed(owner, caller)`** — unchanged: legacy-owner allow, caller-null refuse, SEC-1 principal-mismatch refuse, principal-match allow regardless of surface.

**Invariant SI-3 (C0 preserved):** cross-surface resume by the same principal still succeeds — step 3's "principals match → allow regardless of surface" is untouched. Step 2 only requires that the *presenting* surface is itself valid; it does not require it to be the *owning* surface. Barry on his phone (valid mobile surface) resuming his desktop session (owned by desktop surface) still works.

**Invariant SI-4 (flag-off byte-identity):** when `collabEnabled()` is false, `caller` is `null`, step 2 is skipped entirely, and the path is byte-identical to today (including the SEC-1 hole for legacy `owner==null` sessions).

### 2.7 Configured capability and effective profile assignment

- `collab.db.surfaces.capability_json` is a configured request: a JSON array of capability tokens (each `SAFE_ID`-shaped). The shipped `principals` table has no standalone capability set, so this PRD does not pretend a stored principal-capability superset exists. Gateway activation validates the request against the principal role plus the current effective profile/policy/registry contract, then writes only the allowed intersection to `gateway_surface_security`. It is not read across a second WAL during dispatch.
- **Enforcement point (design contract):** the gateway materializes the authorized capability/auth epoch in `state.db.gateway_surface_security` and each allowed task profile in `state.db.gateway_profile_delegations` (§2.13). `authz.ts` checks both live records and revisions *in addition to* the session `role`, not instead of it. A missing/stale projection, delegation, or capability denies even if the principal role would otherwise permit it. Widening uses grant-last; narrowing/revocation uses deny-first (§1.4), so a cross-database partial failure never opens authority.
- `surfaces.capability_json` holds **execution grants only**: shipped `CapabilityClass` values `read|write|exec|send` and, if OQ-1 selects it, exact operation ids. Browser/network is represented by effective scope/profile identity, not a `browser` capability token. The field **never** holds `approve` or another control-plane authority token (§2.7.1).
- **Open question OQ-1 (§12), narrowed:** choose capability-class-only versus capability-class-plus-exact-operation-id grants. C1 fixes storage, validation, and enforcement; it does not invent a vocabulary absent from `packages/contracts`. `approve` is not part of this question (AR-1).
- Fail-closed default: `capability_json` default `'[]'` = deny everything; an absent or revision-mismatched gateway effective projection also denies. Provisioning is an explicit grant.

### 2.7.1 Control-plane AUTHORITY store + H-1 operator short-circuit subordination (FROZEN, normative)

**Separate authority, separate store.** Control-plane authority (`approve`, and the reserved `cancel`/`delegate`) is held on a **distinct authority store** for the surface — the new **`surface_authorities`** table, NOT in `surfaces.capability_json`. The authorization check for `APPROVE_TOOL` reads the surface's held **authority**, never its execution capability set (§1.2.1, ruling AR-1). This is what makes "reachable only through the authority path" structurally true rather than a naming convention.

**Concrete authority store — `state.db.surface_authorities` (NEW C1 table, gateway-owned).** A dedicated table (chosen over a `surfaces.authority_json` column) gives each high-sensitivity grant a clean, indexable, individually-revocable audit grain. **Owner: gateway.** The authority read, effective surface capability/auth epoch, and exact profile delegation are therefore rechecked in the same `state.db` transaction as the approval decision. Collab owns configured identity; gateway owns effective execution and control-plane authority. Provisioning across the databases follows grant-last, and revocation follows deny-first (§1.4, §6.2).

```sql
-- C1: SEPARATE control-plane AUTHORITY store (§2.7.1, ruling AR-1). Gateway-owned.
-- NEVER the execution-capability path — a row here is the ONLY way a surface holds
-- `approve`. Additive, guarded migration (§6.2). One row = one authority grant.
CREATE TABLE IF NOT EXISTS surface_authorities (
    grant_id          TEXT PRIMARY KEY,
    surface_id        TEXT NOT NULL,                  -- the surface holding the authority (SAFE_ID)
    authority         TEXT NOT NULL                   -- reserved control-plane authority token
                        CHECK (authority IN ('approve','cancel','delegate')),
    granted_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    auth_epoch        INTEGER NOT NULL,               -- must equal gateway_surface_security.auth_epoch
    revoked_at        DATETIME,                       -- NULL = live; non-NULL = revoked (fail-closed)
    FOREIGN KEY (surface_id) REFERENCES gateway_surface_security(surface_id)
);
CREATE INDEX IF NOT EXISTS idx_surface_authorities_surface ON surface_authorities(surface_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_surface_authorities_one_live
    ON surface_authorities(surface_id, authority) WHERE revoked_at IS NULL;
```

- **Serialization format:** authority is an immutable grant ledger, one row per grant — NOT serialized JSON. The partial unique index permits at most one live `(surface_id, authority)` while retaining revoked history and allowing an explicitly authorized later re-grant at the current epoch. The `authority` CHECK pins the vocabulary (`approve` frozen; `cancel`/`delegate` reserved).
- **Read/write API sketch (design contract; builder implements at the gateway seam):**
  - `grantAuthority(surfaceId, authority)` — provisioning-time write; performs **no cross-WAL read**. Projection activation has already validated configured `surfaces.surface_kind/surface_role` and copied them grant-last with the source revision. In the same `state.db` transaction that inserts the ledger row, it requires the current live projected kind/role/auth epoch/source revision and, for `approve`, `surface_role='operator'` plus a non-channel/automation kind. A live duplicate is an explicit refusal, not a silent no-op.
  - `revokeAuthority(surfaceId, authority)` — sets `revoked_at = now` on the one live row and bumps/commits the gateway deny epoch in the same transaction (never deletes; audit trail persists).
  - `holdsAuthority(surfaceId, authority, authEpoch): boolean` — decision-time read used by `authz.ts`; returns true **only** for a row with matching `(surface_id, authority)`, matching current auth epoch, and `revoked_at IS NULL`. This is the single authority read seam for `APPROVE_TOOL`.
- **Fail-closed default:** a surface with NO matching live, current-epoch `surface_authorities` row holds NO authority. Absence, revocation, epoch mismatch, unknown surface, or malformed lookup all resolve to "no authority" → `APPROVE_TOOL` denied. Authority is never implied by execution capability, profile, principal role, or surface kind.
- **Migration:** `CREATE TABLE IF NOT EXISTS surface_authorities (...)` per §6.2; any post-first-ship column is `PRAGMA table_info`-guarded `ALTER` (storage.ts:107-111 precedent).

**Ruling H-1 (frozen): subordinate the operator short-circuit in `authz.ts`.** Today `authz.ts:99-101` short-circuits ALL per-command logic for operators:

```ts
export function authorize(role, cmd, ctx) {
  if (role === 'operator') return ALLOW;          // line 100 — blanket operator authority
  if (role === 'node') return DENY_NOT_PERMITTED;
  ...switch
}
```

This is a blanket, unconditional operator authority class: a **compromised operator surface inherits the principal's full authority** because the check never consults the surface layer. The PRD **normatively requires** this be changed so operator authority is **INTERSECTED with the authority/capability actually held by the presenting surface/session**. An operator principal acting through a limited or compromised surface gets only what THAT surface holds — never the full principal authority.

Corrected layering (no shortcut may skip a lower layer):

```
principal authority
  → surface / session authority (held authority & execution capability of the presenting surface)
    → requested capability / authority token (execution capability, or the `approve` authority)
      → specific operation (the ClientCommand action)
        → specific resource / task (this approvalId, this taskId, this path)
```

**Ownership + flag semantics:**
- This is a **normative change to `authz.ts` owned by a C1 ticket (C1-4, extended)**. The PRD specifies the requirement; the builder implements the intersection at the `authz.ts` seam.
- **Flag-off preserves today's behavior byte-identically.** When `collabEnabled()` is false there is no surface authority to intersect, so operator resolves to the legacy `ALLOW` (line 100) exactly as today. The subordination is active **only** under `TORQCLAW_COLLAB_ENABLED` — consistent with the C0 rule that enabling a subsystem and changing security behavior are separate, individually-revertable decisions (§1.2 constraint 4, §6.1).
- This is the **highest-value security change in C1** (operator ruling). Clearing H-1 is a FREEZE-blocking obligation for the C1 slice.

### 2.8 Principal ownership

- Every `surfaces` row carries `principal_id NOT NULL`. There is no ownerless surface.
- `surface_credentials.surface_id` → `surfaces.surface_id` → `principal_id` is the only ownership chain. A credential never names a principal directly (credentials belong to surfaces; authority belongs to principals — C0 `PrincipalBinding` doc comment).
- Ownership is immutable: a surface cannot be re-parented to a different principal (that would be a new surface). Reviewer ruling requested — recorded as **OQ-2 (§12)** in case the operator wants transfer semantics later.

### 2.9 Audit / provenance and recovery semantics

- Every C1 mutation (`CREATE_SURFACE`, issue/rotate/revoke credential, `REVOKE_SURFACE`) writes a **secret-free** audit row (reuse collab audit discipline: `collab_audit`-style, secret-free, indexed by kind+created). Design contract: audit is append-only and never carries token bytes or `secret_hmac`.
- **Recovery:** because `surfaces`/`surface_credentials` are authoritative (not projections), they are backed up with the DB. The plaintext token is unrecoverable by construction (only the HMAC is stored) — recovery of a lost credential is **re-issue**, never retrieval. This mirrors the collab recovery-kit posture (secrets are re-minted, never read back).
- **Revision 4 correction:** the existing C0.1 auth records and live table names remain unchanged and continue to serve the legacy path. New C1 surface credentials are additive. Recovery never renames or substitutes one store for the other.
- Cross-database recovery follows the security order in §1.4: it may finish a collab-side revoke/audit after a gateway deny has committed, but it MUST NOT finish a partially activated grant, roll an auth epoch backward, recreate an authority row, or replay external work.

### 2.10 Migration / backward-compat

- New tables via **guarded** migration (§6.2), following the exact `storage.ts:107-111` precedent. `CREATE TABLE IF NOT EXISTS surfaces (...)` plus, for any column added to `surfaces`/`surface_credentials` *after their first ship*, a `PRAGMA table_info` guard before `ALTER TABLE ... ADD COLUMN`.
- **IF NOT EXISTS trap (called out):** an existing DB that already has `surfaces` will NOT pick up a new column from a re-run `CREATE`. Every post-first-ship column is nullable + `ALTER`-guarded.
- No `sessions` schema change is needed by C1. Auth remains connection-scoped; immutable task origin/revision evidence is additive in `gateway_task_origins` (§2.13), never in new `sessions` columns.
- The migration does not copy `principals` into `state.db` and does not rebuild, rename, archive, or delete any C0.1 table in `collab.db`. Each database migrates locally and repeatably; the runtime coordinator supplies grant-last/deny-first ordering across their separate WALs.

### 2.11 Flag-off behavior

With `TORQCLAW_COLLAB_ENABLED` off: `resolvePrincipalBinding` returns `null`, step 2's surface gate is skipped, no C1 table is read on the hot path, and resume behavior is byte-identical to today (SI-4). The C1 tables may exist (migration is additive and safe to run with the flag off) but are inert until the flag is on.

### 2.12 Negative authorization cases (each a required test — see also §7)

| Case | Required outcome |
|---|---|
| Surface of principal A presents A's credential to resume principal B's session | Refuse (SEC-1, C0 step 3). |
| Revoked surface reconnects with a still-known token | `AUTH_FAILED`, existence-oblivious (step 2). |
| Expired credential reconnects | `AUTH_FAILED`, same path as revoked. |
| Valid surface, capability set lacks the requested action | Denied at `authz.ts` seam even though principal holds it (SI-1). |
| PARTIAL claim (principal without surface) | `PrincipalBindingError` thrown (C0, unchanged). |
| Flag off, legacy `owner==null` session | Allowed (documented SEC-1 hole preserved; SI-4). |

### 2.13 Revision 4 gateway security projection + immutable task-origin snapshot (NEW, gateway-owned)

The baseline `sessions` table and the live C0.1 store stay unchanged (§10.3). `collab.db` remains identity/config truth; `state.db.gateway_surface_security` is the fail-closed gateway enforcement projection used to avoid a cross-WAL authorization read. Missing or stale projection state denies.

```sql
-- C1: gateway-owned effective authorization projection. It is not a second
-- identity registry; activation is grant-last and denial/epoch change is deny-first.
CREATE TABLE IF NOT EXISTS gateway_surface_security (
    surface_id                    TEXT PRIMARY KEY,
    principal_id                  TEXT NOT NULL,
    surface_kind                  TEXT NOT NULL CHECK (surface_kind IN
                                    ('desktop','mobile','http','telegram','slack','automation')),
    surface_role                  TEXT NOT NULL
                                    CHECK (surface_role IN ('operator','agent','automation')),
    state                         TEXT NOT NULL DEFAULT 'revoked'
                                    CHECK (state IN ('active','revoked')),
    auth_epoch                    INTEGER NOT NULL CHECK (auth_epoch > 0),
    allowed_capability_classes_json TEXT NOT NULL DEFAULT '[]', -- read|write|exec|send
    allowed_operation_ids_json    TEXT NOT NULL DEFAULT '[]',
    capability_revision           INTEGER NOT NULL CHECK (capability_revision > 0),
    source_identity_revision      TEXT NOT NULL,
    activated_at                  DATETIME,
    revoked_at                    DATETIME
);

-- A surface can be delegated multiple task profiles. One immutable live ledger row
-- per (surface, profile), with source EffectiveProfile + registry-enforcement evidence.
CREATE TABLE IF NOT EXISTS gateway_profile_delegations (
    delegation_id                 TEXT PRIMARY KEY,
    surface_id                    TEXT NOT NULL,
    profile_id                    TEXT NOT NULL,
    profile_delegation_revision   INTEGER NOT NULL CHECK (profile_delegation_revision > 0),
    profile_schema_version        TEXT NOT NULL,
    profile_version               INTEGER NOT NULL,
    tool_registry_version         TEXT NOT NULL,
    effective_profile_policy_hash TEXT NOT NULL,
    registry_enforcement_hash     TEXT NOT NULL,
    granted_at                    DATETIME DEFAULT CURRENT_TIMESTAMP,
    revoked_at                    DATETIME,
    FOREIGN KEY (surface_id) REFERENCES gateway_surface_security(surface_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gateway_profile_delegations_one_live
    ON gateway_profile_delegations(surface_id, profile_id) WHERE revoked_at IS NULL;
```

Together these rows are the **state-owned effective capability/profile revision**. Surface security holds the live capability intersection; `gateway_profile_delegations` allows multiple task profiles per surface and stores `effective_profile_policy_hash` byte-identically from the source-owned `EffectiveProfile.policyHash`—there is no duplicate profile hash. That source hash covers the authoritative operation maps/scopes and the static `toolRegistryVersion`, but current source omits registered input schemas and path-enforcement material. The separate `registry_enforcement_hash` closes that gap with the exact formula below. A delegation row is immutable: any effective-profile, capability, registry, or path-enforcement material change revokes it and inserts a new row with a greater `profile_delegation_revision`; it is never updated in place. Widening activates the new row last; narrowing/revocation commits the old delegation's denial first.

`registry_enforcement_hash := SHA256(canonicalJson({schemaVersion:"torqclaw.registry-enforcement/v1", pathPolicyVersion:PATH_POLICY_VERSION, tools}))`, where `tools` is the exact live allowed-operation set sorted by namespaced `name`. Each entry contains only enforcement material, with keys `name`, `sourceServerId`, `rawName`, `inputSchema`, `capability`, `requiresApproval`, `pathScope`, and `pathArgKeys`; `inputSchema` is the registered plain JSON schema and `pathArgKeys` is the resolved sorted explicit-or-fallback key list. Optional `pathScope` has a mandatory injective sentinel: `tool.pathScope === undefined ? null : {read: sortedNormalizedRead, write: sortedNormalizedWrite, deny: sortedNormalizedDeny}`. A null absent scope remains distinct from an explicitly present `{read:[],write:[],deny:[]}` scope because current enforcement treats absence as denial in profile-aware execution while present empty arrays are unconstrained. No `undefined` reaches `canonicalJson`; a mutation that equates null with empty MUST change the digest/gate result. Descriptions are excluded. Other missing/noncanonical material refuses activation. `PATH_POLICY_VERSION` changes whenever path extraction/normalization/check semantics change. `toolRegistryVersion` remains the source contract-format version and MUST NOT be presented as a live registry-content digest.

`ConnectionAuthContext` remains server-derived and **connection-scoped**. It is not stored as one mutable row keyed by durable session: C0 allows same-principal cross-surface resume, and concurrent connections may present different valid surfaces for one session. At task ingress, before dispatch, the gateway copies the proven connection tuple into an immutable request-keyed origin snapshot:

```sql
-- Immutable origin evidence per task. A session may have many tasks from different
-- currently authenticated same-principal surfaces; no last-writer-wins session row.
CREATE TABLE IF NOT EXISTS gateway_task_origins (
    request_id        TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL,
    connection_id     TEXT NOT NULL,
    principal_id      TEXT NOT NULL,
    surface_id        TEXT NOT NULL,
    surface_kind      TEXT NOT NULL,
    credential_id     TEXT NOT NULL,
    credential_expires_at DATETIME,
    auth_epoch        INTEGER NOT NULL,
    capability_revision INTEGER NOT NULL,
    delegation_id     TEXT NOT NULL,
    profile_delegation_revision INTEGER NOT NULL,
    effective_profile_policy_hash TEXT NOT NULL,
    registry_enforcement_hash TEXT NOT NULL,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (request_id) REFERENCES tasks(request_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    FOREIGN KEY (surface_id) REFERENCES gateway_surface_security(surface_id),
    FOREIGN KEY (delegation_id) REFERENCES gateway_profile_delegations(delegation_id)
);
```

- `gateway_task_origins` MUST be written atomically with task creation from the authenticated connection in one local `state.db` transaction; registration reads it by `request_id`. A missing/mismatched origin or delegation snapshot makes flag-on registration inert/refused. It is never overwritten on resume and no client may supply its fields.
- The §1.4 transaction compares the immutable origin/registration snapshot and deciding connection with live `gateway_surface_security`; historical evidence alone cannot keep stale authority alive.
- Flag-off: the new snapshot/projection is never written or read (SI-4 holds); baseline `sessions` and C0.1 remain unchanged.

---

## 3. C2 — Approval Broker

### 3.1 Foundation: EXTEND `tool_approvals`, do not fork or rebuild it

`tool_approvals` (`schema.sql §8`) stays canonical for approval STATE. `approvals.ts::decideApproval` already performs `UPDATE ... WHERE approval_id=? AND status='pending'` — **first-decision-wins and replay-harmless are ALREADY enforced at this seam** (properties 3 and 4 partially hold today). C2 EXTENDS this row and its handler; it does not introduce a parallel approval store.

Revision 4 uses the shipped migration precedent instead of a table copy. The existing table, original columns, rows, values, and `rowid` ordering remain in place. Exactly six nullable columns are added, each only after `PRAGMA table_info(tool_approvals)` proves it absent. No column has a new default or constraint, so legacy rows remain valid and null in all six additions.

```ts
// C2 EXTENDS the physical table in place. These are the only six additions.
const cols = db.prepare(`PRAGMA table_info(tool_approvals)`).all(); // { name }[]
const add = (name, ddl) => { if (!cols.some(c => c.name === name)) db.exec(ddl); };
add('origin_principal_id',  `ALTER TABLE tool_approvals ADD COLUMN origin_principal_id  TEXT`);
add('origin_surface_id',    `ALTER TABLE tool_approvals ADD COLUMN origin_surface_id    TEXT`);
add('decided_principal_id', `ALTER TABLE tool_approvals ADD COLUMN decided_principal_id TEXT`);
add('decided_surface_id',   `ALTER TABLE tool_approvals ADD COLUMN decided_surface_id   TEXT`);
add('expires_at',           `ALTER TABLE tool_approvals ADD COLUMN expires_at           DATETIME`);
add('context_hash',         `ALTER TABLE tool_approvals ADD COLUMN context_hash         TEXT`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_approvals_status_expires
           ON tool_approvals(status, expires_at)`);
```

`status` may now be written as `'expired'`; the shipped table has no status CHECK to replace. No migration changes historical `status` or `args_json`. Source is explicit that `args_json` is display/audit-only and never replayed. A **new flag-on C2 registration** requires a present acyclic plain JSON object; a no-argument tool supplies `{}`. Null, undefined, root arrays/scalars, sparse arrays, non-plain objects, cycles, functions, symbols, bigint, and non-finite numbers are rejected before any pending row. The writer persists the exact UTF-8 string returned by `@torqclaw/collab` `canonicalJson(args)` with no null/falsey coercion; historical rows remain byte-untouched and inert under C2. The gateway hashes those persisted bytes, while the regenerated actual call must independently validate/canonicalize and match at the pre-execution seam. Cards/exports/logs receive only a generated bounded/redacted view. Historical at-rest erasure is outside C1/C2.

**Operator ruling 2026-08-11 (recorded at adoption; delegated decision):** the at-rest retention trade-off flagged at adoption is **ACCEPTED**. Historical model-proposed argument bytes remain at rest exactly as shipped; redaction stays read-time-only through the bounded/redacted card/export path (prop 8). Rationale: erasure is irreversible, while retention preserves the audit and rollback record on a local single-operator store whose every export already passes the redactor. If at-rest erasure is ever wanted, it is a separately scoped operator lane, never a C1/C2 change.

`ACTIONHASH_V1` is SHA-256 over the ASCII version tag followed by three required U32BE-length-prefixed UTF-8 fields in order: exact stored `request_id`, exact namespaced `tool_name`, and the exact bytes returned by the pinned `@torqclaw/collab` `canonicalJson(args)` implementation. All three are present; there is no NULL encoding. Registration stores only the lowercase digest/version in the binding. The regenerated actual call is canonicalized by the same source-bound implementation at the true pre-execute hook; equality authorizes consumption, mismatch creates no side effect and requires a new approval.

**Frozen `ACTIONHASH_V1` vector:** source request `11111111-1111-4111-8111-111111111111`, canonical operation `filesystem__write_file`, and canonical args `{"a":"é","z":1}` produce a 99-byte framed stream and lowercase SHA-256 `c3db5267496d68d9edea579e0bd43c1e397364026e281401e30fa0bc596af6bb`. Substituting the regenerated dispatch id, using raw `write_file`, changing any argument, or using non-canonical argument bytes changes the digest and MUST fail its named mutation test.

The additive C2 state tables below contain binding/grant material but no approval state:

```sql
-- Immutable registration facts only. No status and no decision fields.
CREATE TABLE IF NOT EXISTS gateway_approval_bindings (
    approval_id       TEXT PRIMARY KEY,
    request_id        TEXT NOT NULL,
    action_hash_version TEXT NOT NULL CHECK (action_hash_version = 'ACTIONHASH_V1'),
    action_hash       TEXT NOT NULL,
    canonical_args_hash TEXT NOT NULL,
    registration_context_hash TEXT NOT NULL,
    delegation_id    TEXT NOT NULL,
    profile_delegation_revision INTEGER NOT NULL,
    registered_profile_id TEXT NOT NULL,
    registered_profile_version INTEGER NOT NULL,
    registered_tool_registry_version TEXT NOT NULL,
    registered_effective_profile_policy_hash TEXT NOT NULL,
    registered_capability_revision INTEGER NOT NULL,
    registered_registry_enforcement_hash TEXT NOT NULL,
    registered_privacy_context_hash TEXT NOT NULL,
    registered_routing_context_hash TEXT NOT NULL,
    registered_security_policy_hash TEXT NOT NULL,
    registered_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (approval_id) REFERENCES tool_approvals(approval_id),
    FOREIGN KEY (request_id) REFERENCES tasks(request_id),
    FOREIGN KEY (request_id) REFERENCES gateway_task_origins(request_id),
    FOREIGN KEY (delegation_id) REFERENCES gateway_profile_delegations(delegation_id)
);

-- One exact-action, one-shot grant created only by the winning APPROVE transaction.
CREATE TABLE IF NOT EXISTS gateway_action_grants (
    grant_id          TEXT PRIMARY KEY,
    approval_id       TEXT NOT NULL UNIQUE,
    source_request_id TEXT NOT NULL,
    dispatch_request_id TEXT NOT NULL UNIQUE,
    tool_name         TEXT NOT NULL,
    action_hash       TEXT NOT NULL,
    context_hash      TEXT NOT NULL,
    origin_surface_id TEXT NOT NULL,
    deciding_surface_id TEXT NOT NULL,
    origin_auth_epoch INTEGER NOT NULL,
    deciding_auth_epoch INTEGER NOT NULL,
    origin_capability_revision INTEGER NOT NULL,
    delegation_id    TEXT NOT NULL,
    profile_delegation_revision INTEGER NOT NULL,
    deciding_authority_grant_id TEXT NOT NULL,
    effective_profile_policy_hash TEXT NOT NULL,
    registry_enforcement_hash TEXT NOT NULL,
    expires_at        DATETIME NOT NULL,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    consumed_at       DATETIME,
    revoked_at        DATETIME,
    FOREIGN KEY (approval_id) REFERENCES tool_approvals(approval_id),
    FOREIGN KEY (source_request_id) REFERENCES tasks(request_id),
    FOREIGN KEY (dispatch_request_id) REFERENCES tasks(request_id),
    FOREIGN KEY (delegation_id) REFERENCES gateway_profile_delegations(delegation_id),
    FOREIGN KEY (deciding_authority_grant_id) REFERENCES surface_authorities(grant_id)
);
```

`dispatch_request_id` is not a free-standing nonce. APPROVE allocates it server-side, and the winning `state.db` decision transaction first creates the corresponding re-minted `tasks` row, then writes the canonical approval evidence and grant that references both source and dispatch tasks. The FK plus `tasks.request_id` primary key and the grant's `UNIQUE` constraint make the lookup referential and single-use. If task creation, decision, or grant insertion fails, the whole transaction rolls back. If the transaction commits and the process crashes before admission, the task/grant remain inert and recovery revokes the grant; it never creates a second re-mint or dispatches automatically.

Grant expiry is distinct from pending-approval expiry. The winning APPROVE transaction sets `gateway_action_grants.expires_at = canonical_now + GRANT_TTL_SECONDS`; it never copies the approval row's deadline. `GRANT_TTL_SECONDS` is finite (proposed 60 seconds, ratified with OQ-5). The pre-tool admission transaction first marks any unconsumed grant with `expires_at<=canonical_now` revoked, then refuses it; consumption requires `revoked_at IS NULL AND consumed_at IS NULL AND expires_at>canonical_now`. Sweep and lazy admission share that writer, so an expired grant cannot execute or be revived.

**Canonical row shapes (normative):** a newly registered `pending` row has non-null `origin_*` and `expires_at`; its `decided_*`, `decided_at`, and `context_hash` remain null and it has no grant. The winning `approved` or `rejected` decision atomically writes non-null `decided_*`, `decided_at`, and `context_hash` with the guarded status transition; only `approved` creates exactly one grant. An `expired` row retains origin/expiry, keeps `decided_*`, `decided_at`, and `context_hash` null, and has no grant. Pre-C2 rows remain valid without fabricated values.

**Single-writer requirement (M-1/M-2, normative).** Because there is no DDL status CHECK, `pending|approved|rejected|expired` has exactly **one centralized writer**. Every lazy decide and sweep call enters the same procedure:

1. `BEGIN IMMEDIATE` and capture one database-derived `canonical_now` for the whole transaction.
2. For the target, materialize expiry with `UPDATE tool_approvals SET status='expired' WHERE approval_id=? AND status='pending' AND expires_at IS NOT NULL AND expires_at<=canonical_now`. This writes no `decided_*`, `decided_at`, or `context_hash` and mints no grant.
3. If still pending, decision is eligible only with `expires_at IS NOT NULL AND expires_at>canonical_now`, current context/authority/binding checks, and the guarded status predicate. APPROVE atomically writes canonical evidence plus exactly one grant; REJECT writes evidence and no grant.
4. Commit. Competing decision/expiry/replay observes the serialized winner and changes zero rows. A NULL-expiry or missing-binding legacy row is unchanged and returns reissue-required under flag-on.

No other module updates approval status. The `(status, expires_at)` index and mutation tests pin this writer, nullability, and race behavior.

The absence of a table CHECK is therefore a code-audit and mutation-test obligation. By contrast, new `approval_deliveries` keeps its DDL CHECK on projection-only `delivery_state` because a fresh table can carry that constraint from first ship.

### 3.2 What collab identity decides (and what it does not)

Collab/Surface identity supplies four *inputs* to a gateway-owned decision:
- which surfaces may **RECEIVE** an approval card (delivery targeting, §3.13);
- which surfaces may **DECIDE** it (authorization, property 2);
- which **principal+surface** decided (evidence, property 7);
- where the **originating task** came from (immutable request-keyed `gateway_task_origins` copied from the server-owned connection at task creation, then recorded in canonical `tool_approvals.origin_*`; exact-action/context facts are bound in `gateway_approval_bindings`, while baseline `tasks` stays untouched).

The **state transition itself** remains the gateway's `decideApproval` guarded UPDATE. Collab never writes `tool_approvals.status`.

### 3.3 The twelve properties as testable contracts

| # | Property | Contract | Enforcement seam |
|---|---|---|---|
| 1 | Channel-originated task cannot self-approve | If `origin_surface_id` is a channel/automation surface, a DECIDE from that same surface is refused; independently, every channel/automation deciding surface lacks operator-role `approve` authority. | `authz.ts` + C2 broker check |
| 2 | Origin ⟂ Authority | **Origin independent of Authority:** `origin_*` records who submitted; the currently authenticated deciding connection supplies `decided_*`. A different-origin authorized operator is a required positive path. Authority comes from a live `approve` row plus existing resource/task `authz`, never from origin equality. | canonical origin/decision columns + authority check |
| 3 | Only first valid decision changes state | Reuse existing `UPDATE ... WHERE status='pending'` (`approvals.ts:52-56`). At most one transition fires. | **already holds** — C2 writes evidence in the SAME transaction |
| 4 | Duplicate/replayed decisions harmless | Second decide → `info.changes===0` → `null`, no side effect. | **already holds** (`approvals.ts:58`) |
| 5 | Delivery failure never becomes approval | `approval_deliveries` is a projection; a delivery-row failure cannot write `tool_approvals.status`. Delivery and decision are separate tables with separate writers. | table separation (§3.13) |
| 6 | Delivery survives operator-surface disconnect/reconnect | An undelivered/`pending` approval is re-derivable and re-deliverable on reconnect from `tool_approvals` + `approval_deliveries` (projection is rebuildable). | reconnect re-projects |
| 7 | Decision evidence records principal+surface | `decided_principal_id`/`decided_surface_id`, `decided_at`, and `context_hash` are written on canonical `tool_approvals` **in the same transaction** as the guarded status UPDATE. No sidecar holds a competing decision tuple. | canonical row (§3.1) |
| 8 | Approval cards get bounded/redacted arg summaries only | The card carries a generated bounded/redacted summary—never raw `args_json`. Existing display/audit values remain byte-preserved; authorization uses the separately stored canonical action hash computed at registration, not replay of this column. C1/C2 adds no payload copy or blanket rewrite. | read-time redactor |
| 9 | Approval EXPIRES rather than staying actionable | New rows receive finite `expires_at`. APPROVE requires `status='pending' AND expires_at>canonical_now`; expiry uses `UPDATE ... WHERE status='pending' AND expires_at<=now` in the same centralized writer. A flag-on legacy row with NULL expiry/binding is inert and must be reissued, never silently actionable. | canonical writer + TTL |
| 10 | Approval bound to execution context; changed policy/profile/privacy INVALIDATES a stale approval | **C2 registration→decision:** registration stores a `registration_context_hash` in the immutable binding; decision recomputes it, refuses/expires on mismatch, then stores `tool_approvals.context_hash` as decision evidence. **C2 decision→dispatch:** apply remains synchronous and the §1.4 fence rechecks current epoch/profile/security. **C3:** live re-validation across a future asynchronous decision-delivery→apply seam remains deferred. | C2: registration/decision comparison + decision evidence. **C3: async apply re-check (deferred)** |
| 11 | No "Allow for session" unless a real session-grant primitive exists | Default C2 contract is **one-shot** (`gateway_action_grants.approval_id UNIQUE` — one grant per approval, consumed once). A durable "allow for session" grant is explicitly NOT designed here (OQ-3, §12); UIs must not offer it. | contract + lint literal |
| 12 | Path/profile/security restrictions remain authoritative AFTER approval | Approval grants the exact action; it never bypasses path allowlists, privacy restrictions, policy hash, registry version, or the **current profile delegation**. The synchronous admission fence rechecks the live effective capability/profile revision and downstream restrictions before consuming the grant. | §1.4 transaction + dispatch re-check |

### 3.4 Context binding — `CTXHASH_V1` (C2 registration→decision check; C3 async apply check)

Two operator rulings 2026-08-08 (frozen) govern this section: (a) **OQ-4 is closed** — the context input set and byte serializer are normative; and (b) **Property-10 / C-1** — C2 decision→dispatch stays SYNCHRONOUS, while live re-validation across a future asynchronous decision-delivery→apply seam is DEFERRED to C3. The correction adds the missing C2 registration→decision comparison without inventing an async apply seam.

Legacy parser compatibility note: `server.ts:185-202` is the historical line-span citation retained by the original 67 checks, not a moving source contract. Builders verify the `APPROVE_TOOL` → decision → mint → shared route/constrain → pre-tool admission symbols and reachability at the then-current baseline.

#### 3.4.1 Canonical `context_hash` input set (FROZEN, normative — clears C-2, closes OQ-4)

`tool+args` alone is TOO WEAK: a TORQCLAW task resolves to an **execution profile** that governs capabilities, tier, path, network, and approval-requirement, so an approval must bind to the resolved profile and privacy context, not merely the tool name. The `context_hash` is computed over **exactly** the following inputs, and **only** these, in a **pinned canonical order** (the order below is the canonical order):

1. **Principal identity** — exact `gateway_task_origins.principal_id` copied to `tool_approvals.origin_principal_id`.
2. **Surface identity** — exact `gateway_task_origins.surface_id` copied to `tool_approvals.origin_surface_id`.
3. **Task identity** — original blocked `gateway_task_origins.request_id` / `tool_approvals.request_id`, never the minted dispatch request id.
4. **Task origin** — exact server-derived `gateway_task_origins.surface_kind`; arbitrary `GatewayRequest.sourceChannel` is not identity.
5. **Resolved execution profile** — exact live delegated `EffectiveProfile.profileId` (`read_only|workspace_write|browser_research|terminal_power`).
6. **Requested capability / tool** — exact canonical `tool_approvals.tool_name`, not predicted `requiredTools`.
7. **Canonical tool arguments** — exact UTF-8 bytes persisted for the new row from `@torqclaw/collab` `canonicalJson(args)` after the required plain-object validation; a no-argument call is `{}`, never null/undefined/falsey coercion, `JSON.stringify`, `canonicalizePolicy`, or the failover canonicalizer.
8. **Privacy / security context** — lowercase `privacy_context_hash` defined below.
9. **Routing / tier context** — lowercase `routing_context_hash` defined below from the shared route+profile-constrain result.
10. **Relevant policy revision** — lowercase `security_policy_hash` defined below, including profile, capability, delegation, and the exact registry/path-enforcement identity.

The hash is computed over exactly these ten inputs in this pinned canonical order. **Free-text prompt is deliberately EXCLUDED.** Fields 1–4, 6, and 7 are immutable registration facts; decision re-resolves fields 5, 8, 9, and 10 from current source-owned policy/delegation state and compares the resulting digest with `registration_context_hash`.

The three inner digests are themselves SHA-256 of exact `canonicalJson` objects:

```text
privacy_context_hash := SHA256(canonicalJson({
  schemaVersion: "torqclaw.approval-privacy/v1",
  containsSensitiveData: GatewayRequest.constraints.containsSensitiveData,
  redactionPolicyRevision: APPROVAL_REDACTION_POLICY_VERSION
}))

routing_context_hash := SHA256(canonicalJson({
  schemaVersion: "torqclaw.approval-routing/v1",
  executionMode: GatewayRequest.constraints.executionMode,
  selectedTier: constrained RouterDiagnostics.tier,
  ruleId: RouterDiagnostics.ruleId ?? null,
  routerPolicyRevision: ROUTER_POLICY_VERSION
}))

security_policy_hash := SHA256(canonicalJson({
  schemaVersion: "torqclaw.approval-policy/v1",
  effectiveProfile: {
    schemaVersion: EffectiveProfile.schemaVersion,
    profileId: EffectiveProfile.profileId,
    profileVersion: EffectiveProfile.profileVersion,
    toolRegistryVersion: EffectiveProfile.toolRegistryVersion,
    effectiveProfilePolicyHash: EffectiveProfile.policyHash
  },
  capabilityRevision: gateway_surface_security.capability_revision,
  profileDelegationRevision: gateway_profile_delegations.profile_delegation_revision,
  registryEnforcementHash: gateway_profile_delegations.registry_enforcement_hash
}))
```

`EffectiveProfile.policyHash` and `toolRegistryVersion` are source-owned contracts; `effective_profile_policy_hash` is their byte-identical stored policy copy and is never a second hash definition. `ROUTER_POLICY_VERSION` and `APPROVAL_REDACTION_POLICY_VERSION` are versioned gateway source constants; `registry_enforcement_hash` is the exact §2.13 digest over registered enforcement material and `PATH_POLICY_VERSION`. Missing sources refuse registration rather than falling back to prose or timestamps. A surface can hold multiple live profile delegations, but registration, decision, and pre-execution each recheck the exact immutable `delegation_id`, its revision, effective profile policy, and registry-enforcement hash used by this task.

**Canonical byte serializer (FROZEN, versioned — clears the C2-5 reproducibility gap).** The ten semantic fields being frozen is necessary but NOT sufficient: two implementations must also produce **identical bytes** from the same ten inputs. The `context_hash` is therefore SHA-256 over a pinned, versioned, length-prefix-framed byte stream — NOT over ad-hoc concatenation and NOT over a JSON object (whose key order / whitespace / number formatting would be an unpinned second variable):

```
context_hash_input :=
    "CTXHASH_V1"                       (the serializer version tag, UTF-8, no separator)
 || U32BE(len(f1))  || f1
 || U32BE(len(f2))  || f2
 || ...
 || U32BE(len(f10)) || f10

context_hash := SHA-256(context_hash_input)      -- lowercase hex of the 32-byte digest
```

Pinned normatively:
- **Version tag:** the literal ASCII string `CTXHASH_V1` is the first bytes of the stream. Any future change to field set, order, or encoding REQUIRES a new tag (`CTXHASH_V2`); the tag is part of the hashed bytes so two versions can never collide.
- **Field order:** exactly the §3.4.1 canonical order (1 → 10 above). Not sorted, not re-ordered — the order IS the numbered list.
- **Encoding:** each field `fN` is its exact **UTF-8 bytes**. `len(fN)` means UTF-8 byte length, not JavaScript character/code-unit count. Field 7 is the already-persisted `canonicalJson` byte string and is not re-serialized. `canonicalJson` sorts object keys by Unicode code point, preserves array order, performs no Unicode normalization, and rejects undefined/function/symbol/bigint/non-finite/sparse/cyclic or non-plain values through the C2 validation wrapper.
- **Presence:** all ten fields are required and non-null; missing source evidence rejects registration/decision. An explicitly present empty string may encode with `U32BE(0)`, but absence is never mapped to it. This restores the serializer's injectivity claim.
- **Length framing:** each field is preceded by its UTF-8 byte length as a 4-byte big-endian unsigned integer (`U32BE`). A value longer than `0xffffffff` bytes is rejected. No field can forge a boundary, so `("ab","c")` and `("a","bc")` hash differently.
- **Hash:** SHA-256 over the whole byte stream; the stored `context_hash` (§3.1) is the lowercase-hex digest.

Two independent implementations that agree on the ten field VALUES will produce byte-identical `context_hash_input` and therefore an identical digest. This is what makes C2-5's "independently reproducible" AC mechanically checkable.

**Frozen serializer vector (framing-only):** for synthetic fields `prn_operator_01`, `srf_desktop_01`, `11111111-1111-4111-8111-111111111111`, `desktop`, `workspace_write`, `filesystem__write_file`, `{"a":"é","z":1}`, `privacy-v1:sensitive`, `routing-v1:OLLAMA_LOCAL`, and 64 lowercase `c` characters, the UTF-8 byte lengths are `15,14,36,7,15,22,16,20,23,64`, total framed input length is `282`, and the SHA-256 is `96424e5e9f3bb595e74408a9e1fe07b1b7f981d3f04c427e1af1ac5fa3ff2c2a`. The short f8/f9 strings are deliberately synthetic and do **not** satisfy the semantic inner-digest contract; this vector pins only version-tag/framing/UTF-8 behavior.

**Frozen end-to-end semantic vector:** use the same f1–f7, then derive f8–f10 with the source `canonicalJson` implementation from these exact fixture objects:

```text
privacy = {"schemaVersion":"torqclaw.approval-privacy/v1","containsSensitiveData":true,"redactionPolicyRevision":"torqclaw.redaction/v1"}
routing = {"schemaVersion":"torqclaw.approval-routing/v1","executionMode":"AUTO","selectedTier":"OLLAMA_LOCAL","ruleId":"LOCAL_TOOL_INTENT","routerPolicyRevision":"torqclaw.router/v1"}
security = {"schemaVersion":"torqclaw.approval-policy/v1","effectiveProfile":{"schemaVersion":"torqclaw.effective-profile/v1","profileId":"workspace_write","profileVersion":1,"toolRegistryVersion":"torqclaw.tools/v1","effectiveProfilePolicyHash":"e67951376789e1ae88b2388f22351fc8bc5a5c93dcbce7f1d412926f8bfc0b7e"},"capabilityRevision":7,"profileDelegationRevision":11,"registryEnforcementHash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}
```

The required lowercase hashes are f8 `b503e9e4eb94c4c3ef34481efced486596a270955036a961f8fd02682156ad16`, f9 `944af7d5cf70a7ba35a48d1eba0255e61dda8718e9b2b11017d4c0f70cce3e25`, and f10 `4ddc3aa9ad1d6a905fba67ca74183cf28cbf1141a340eee6aaf56a71c0157310`. The final field lengths are `15,14,36,7,15,22,16,64,64,64`, total framed length is `367`, and `CTXHASH_V1` is `d7bf709cf2ee293b854e77f7aa649cc18c3195e52870b2e8e01066e270556626`. Permuting the input object's argument keys preserves f7 because `canonicalJson` sorts them; changing any semantic value changes its inner and final digest. Both vectors, Unicode/large-length/rejection cases, and an independent implementation are mandatory.

**Why adversarial test A9 passes BECAUSE of this set:** A9 changes the profile and/or privacy posture between request and apply. Because **resolved execution profile (5)** and **privacy/security context (8)** are inputs to the hash, any such change produces a different `context_hash`, so the mismatch is detectable by construction. A9 cannot be defeated by a tool/args-only hash — that is exactly the weakness this frozen set removes. (A9 is a **C3** acceptance test — see §3.4.3.)

#### 3.4.2 C2 behavior — registration may wait; decision→dispatch stays SYNCHRONOUS

**Ruling (frozen): in C2 there is no asynchronous decision-delivery→apply gap.** That does not erase the real request/registration→decision wait: an approval may remain pending while profile, policy, registry, routing, privacy, or surface state changes. C2 closes that existing gap as follows:

1. Registration computes `CTXHASH_V1` over the frozen request context and stores it as `gateway_approval_bindings.registration_context_hash`; canonical `tool_approvals.context_hash` remains null while pending.
2. The centralized decision writer resolves the **current** ten inputs and recomputes the digest. A mismatch refuses approval (or atomically expires the still-pending row with an explicit context-invalidated reason); it writes no decider evidence and creates no grant.
3. Before the transaction, APPROVE allocates a server-only `dispatch_request_id` and builds the re-minted request through the shared route-plus-profile-constrain helper (including `constrainTier`). On a context match, the guarded decision transaction atomically creates that request's `tasks` row, writes canonical `decided_*`, `decided_at`, and `context_hash`, and inserts one FK-backed grant binding the original `source_request_id` to the dispatch task. Under the flag, legacy `grantedTools` names alone never authorize external work.
4. After commit, the server invokes exactly that stored re-mint; it cannot allocate or reuse another dispatch id for the approval. At the actual regenerated tool call, lookup is by `dispatch_request_id`; the §1.4 transaction recomputes `ACTIONHASH_V1` with the stored source request id, rechecks origin/deciding epochs, live authority grant, capability, immutable delegation, `EffectiveProfile.policyHash`, `toolRegistryVersion`, `registry_enforcement_hash`, privacy/routing policy, and expiry, then consumes and records `dispatch_started` before execution.
5. A mismatch creates no side effect and requires a new approval. A crash after approval/grant but before consumption never automatically dispatches; recovery revokes the inert grant and requires reissue. FRONTIER's separately authorized protocol must authenticate the Hermes `(server_id, raw_tool_name)` to the exact gateway namespaced operation id before hashing, reject `args or {}` or any other falsey coercion, carry the actual validated plain-object args, and perform the same profile-policy/registry/delegation fence before the Hermes call; until all of that is reachable, it refuses.

C2 still MUST NOT invent an asynchronous/offline apply seam solely to make C3's A9 pass. The registration→decision comparison and synchronous admission fence are C2; a later decision-delivery→apply comparison is C3.

#### 3.4.3 Property 10 deferred to C3 — the real decide≠apply seam (property-6-vs-10 collision is latent-until-C3)

The property-6-vs-10 collision (durable delivery of a *stale-but-delivered decision*) only becomes real in **C3**, where async/offline delivery introduces a genuine decision-delivery→apply seam. **Property-10 live re-validation across that future seam is DEFERRED to C3.** At that point:
- Recompute the current `context_hash` (over the §3.4.1 frozen inputs) at the moment the decision would take effect.
- Equal to the stored hash → apply normally.
- Materially different → the stale approval is **INVALIDATED**: transition `pending→expired` (or, if already `approved`, refuse to act and surface it) and emit an **EXPLICIT operator-facing failure state** — NOT a silent no-op.
- **Ruling: property 10 WINS over property 6** at the collision point. Durable delivery (6) guarantees the decision is not *lost*; it does not guarantee it is still *valid*. This ruling is recorded now but is a **C3** invariant.

**The property-6-vs-10 delivery collision is therefore LATENT-UNTIL-C3.** C2 nevertheless rejects context drift accumulated while the approval was pending and rechecks the live gateway security revisions before synchronous dispatch.

**Source-of-truth note:** immutable registration context lives in `gateway_approval_bindings.registration_context_hash`; the winning decision digest lives in canonical `tool_approvals.context_hash`. Neither lives in the delivery projection, so `approval_deliveries` can be dropped and rebuilt without changing approval or context truth.

### 3.5–3.12 Property detail (see the table in §3.3; expanded contracts)

- **3.5 (prop 1 detail):** "self-approve" is defined structurally: a DECIDE whose current deciding surface equals `origin_surface_id` and is channel/automation is refused. An operator-role surface with a live current-epoch `approve` grant MAY approve a task it originated; that same-origin operator path is the deliberate ordinary single-operator case, not an authority shortcut, and still requires resource/task authz plus every context/exact-action check. A **different-origin authorized operator** surface may also decide under those same conditions. Channel/automation surfaces fail both the kind/role gate and the authority lookup.
  - **Dependency H-2 (frozen): property 1 origin-trust depends on C1-5.** The presenting credential/surface is proven on the server-owned connection, then copied once into immutable `gateway_task_origins` at task ingress. Registration reads that request-keyed snapshot. A mutable session row or client origin field is insufficient. **Therefore C2-3 depends on C1-5.**
- **3.6 (prop 2 detail):** origin fields are written on canonical `tool_approvals` from immutable request-keyed `gateway_task_origins`; the current deciding connection supplies decision fields inside the winner. The positive predicate never binds current identity to origin identity. **Origin independent of Authority** is tested with a different-origin authorized operator success plus cross-channel/non-operator negatives.
- **3.7 (props 3+4):** the existing atomic pending guard remains the core. C2 widens the same transaction to write canonical decision evidence and, for APPROVE only, one grant. Tests prove two simultaneous decisions or decision-vs-expiry yield exactly one terminal transition and never a second evidence tuple or grant.
- **3.8 (prop 5):** `approval_deliveries` writer is separate from `decideApproval`; a delivery insert/ack failure path has no code route to `tool_approvals.status`.
- **3.9 (prop 9 TTL):** new registrations receive a finite TTL (proposed 15 minutes—OQ-5) from one captured database clock. Decision requires `status='pending' AND expires_at IS NOT NULL AND expires_at>canonical_now`; expiry uses `status='pending' AND expires_at IS NOT NULL AND expires_at<=canonical_now` inside the §3.1 `BEGIN IMMEDIATE` writer. Expired evidence remains null and no grant exists; legacy NULL/binding gaps are inert/reissue-required.
- **3.10 (prop 8 redaction):** the gateway produces card/export summaries at read time, reusing `export.ts` redactor primitives; honest language only ("known secret shapes removed"), never "safe". Historical `args_json` bytes are preserved; new flag-on rows use validated `canonicalJson` but remain display/audit-only. C1/C2 persists only the action hash needed for equality. Payload persistence is reserved for a future operator-approved protection/retention decision and is not a C1/C2 table.
- **3.11 (prop 11):** one-shot is the only grant C2 ships (`gateway_action_grants`, one consumable row per approval). **Prohibition statement (normative):** "Allow for session" is PROHIBITED as a shippable grant option — it MUST NOT appear as a grant type in any UI, config, or grant-type enum — until a real canonical session-grant primitive is separately designed (OQ-3, §12). The §10 pre-gate lints this prohibition in two directions: the implementation/config surface must not contain the string, and THIS PRD must contain this prohibition statement (§10, corrected).
- **3.12 (prop 12):** the re-minted `GatewayRequest` uses the same shared route+`constrainTier` resolver as initial submit. Approval widens exactly one action. At the actual pre-tool seam, §1.4 recomputes the action digest and rechecks origin/deciding epochs, current live authority grant, source-owned `EffectiveProfile.policyHash`, `toolRegistryVersion`, immutable profile delegation, capability revision, exact `registry_enforcement_hash`, privacy/routing context, expiry, and unconsumed grant before execution.

### 3.13 Durable delivery projection `approval_deliveries` (NEW — projection, NOT truth)

Modeled **exactly** on `run_receipts` (`schema.sql §9`): a derived, rebuildable, droppable read-cache. It is never the only copy of anything and can be rebuilt from `tool_approvals` (+ session/surface routing) at any time.

```sql
-- C2: durable delivery PROJECTION. NOT approval truth. Rebuildable from
-- tool_approvals (+ routing). Droppable — modeled on run_receipts (schema §9).
-- A row here NEVER authorizes or represents an approval decision.
CREATE TABLE IF NOT EXISTS approval_deliveries (
    id                TEXT PRIMARY KEY,               -- randomUUID, projection row id
    approval_id       TEXT NOT NULL,                  -- = tool_approvals.approval_id
    target_surface_id TEXT NOT NULL,                  -- surface the card was routed to
    delivery_state    TEXT NOT NULL DEFAULT 'pending' -- pending | delivered | acked | failed
                        CHECK (delivery_state IN ('pending','delivered','acked','failed')),
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (approval_id) REFERENCES tool_approvals(approval_id)
);
CREATE INDEX IF NOT EXISTS idx_approval_deliveries_approval ON approval_deliveries(approval_id);
CREATE INDEX IF NOT EXISTS idx_approval_deliveries_target_state
    ON approval_deliveries(target_surface_id, delivery_state);
```

- A `rebuild` script (analogous to `ops/receipts-rebuild.mjs`) MUST be able to drop and regenerate the **current actionable delivery view** from canonical pending approvals plus current eligible operator surfaces, with no loss of approval truth. Historical transport attempts/acks are observability only and need not reproduce byte-identically; they cannot authorize a decision.
- Reconnect (property 6): on operator-surface reconnect, undelivered/`pending` approvals are re-projected and re-offered; the delivery projection tracks best-effort delivery, the `tool_approvals` row remains the truth.
- Rebuild/reconnect excludes revoked, stale-epoch, and otherwise ineligible target surfaces. If no eligible operator surface exists, the approval remains canonically `pending` until its ordinary expiry and the API reports textual `delivery-failed`/`no-eligible-operator-surface`; no card is offered to the revoked target and no delivery failure changes approval state.

### 3.14 CT-2 — `approve` authority provisioning rule (FROZEN, normative)

Operator ruling 2026-08-08 (frozen; clears H-3, encodes CT-2). This is the provisioning + enforcement counterpart to the authority/capability split (§1.2.1) and the H-1 subordination (§2.7.1).

**Ruling CT-2 (frozen): the `approve` authority is grantable ONLY to operator-kind surfaces.**
- **Operator-kind predicate (FROZEN, mechanically checkable):** configured truth says a surface is operator-kind **iff `surfaces.surface_role = 'operator'`** (§2.2, §2.7.1); it is never inferred from `surface_kind`. Enforcement truth is the grant-last, epoch-current copy in `gateway_surface_security.surface_role`. Provisioning validates the configured predicate before activating that projection; decision never performs a cross-WAL read and accepts only the matching live projected role/auth epoch/source revision. Missing, stale, revoked, or observed-divergent projection state denies. Thus the predicate is singular while its configured source and state-owned enforcement copy are explicit.
- **Grantable to:** operator-kind surfaces only — surfaces with `surface_role = 'operator'` (the operator's own control-plane surfaces; typically provisioned on `desktop`/`http` kinds, but membership is decided by `surface_role`, never by kind alone).
- **NEVER grantable to:** any surface with `surface_role ∈ ('agent','automation')` — this includes every `channel` or `automation` surface (`telegram`, `slack`, `automation`, and any future channel kind), which can never carry `surface_role = 'operator'`. Provisioning `approve` onto a non-operator-role surface is a **provisioning-time FAILURE**, not a silent grant.
- **Cross-channel approval is forbidden.** A decision presented from a channel/automation surface can never carry `approve` authority regardless of which principal owns it.
- **Default is fail-closed:** no surface holds `approve` unless explicitly and validly provisioned; a mis-provisioned or unspecified surface holds **no authority** (mirrors the `capability_json` deny-all default, §2.7).

**Two enforcement points (both required):**
1. **Provisioning time:** projection activation validates configured `surfaces.surface_role = 'operator'` plus the kind/role cross-rule, then writes kind, role, and source revision grant-last into `gateway_surface_security`. `grantAuthority(surfaceId, 'approve')` performs no cross-WAL read; inside the authority-insert `state.db` transaction it requires that live current-epoch projection. A configured `agent`/`automation` or channel-kind surface can never receive an active `approve` row.
2. **Decision time:** `authz.ts` (post-H-1 subordination, §2.7.1) reads only `state.db`: it requires `gateway_surface_security.surface_role='operator'` at the current live auth epoch/source revision and calls `holdsAuthority(surfaceId, 'approve')` for a matching live `surface_authorities` grant before any `APPROVE_TOOL` transition. The configured-role writer is coordinated: narrowing commits this gateway deny/epoch first, so no legitimate partial state can leave a narrower collab role with an active older projection. Missing/stale/revoked/observed-divergent projection evidence refuses.

**If autonomous approval is ever needed** (e.g. a trusted automation approving low-risk tools), it is a **NEW authority primitive with its own threat model** — designed separately, never reached by incidentally widening a surface's execution capability or by relaxing this rule. Rationale (operator): TORQCLAW already treats approval as unusually sensitive — `APPROVE_TOOL`, approval-history, receipts, and cost are operator-only; approval history is operator-only because it leaks gated tool names + decision timing. CT-2 keeps that narrow posture intact while C2 adds identity evidence around it.

> **Relationship to CT-2 in §11:** §11's CT-2 flagged that capability-gated approval is a *widening* the reviewer must ratify. This ruling **resolves that**: approval authority is widened only to the extent that `approve` is now an explicit reserved authority provisioned to operator-kind surfaces — it is NOT opened to channel/automation surfaces or to role-only grants. The widening the reviewer ratifies is bounded by this rule.

---

## 4. Source-of-truth matrix

| Concept | Authoritative owner / table | Projection / cache | Notes |
|---|---|---|---|
| Principal identity | `collab.db.principals` + live C0.1 tables | — | C0 substrate remains live and unchanged |
| **Surface** | **`collab.db.surfaces` (C1)** | — | globally unique immutable owner; identity/config truth |
| **Surface credential (HMAC)** | **`collab.db.surface_credentials` (C1)** | — | `SurfaceCredential`; globally unique id/HMAC; plaintext never stored |
| **Configured surface capability** | **`collab.db.surfaces.capability_json` (C1)** | — | requested configuration, never a dispatch-time cross-WAL read |
| **Effective surface capability** | **`state.db.gateway_surface_security` (C1)** | identity-derived enforcement state | state-owned live capability/auth epoch; missing/stale denies |
| **Effective profile delegation** | **`state.db.gateway_profile_delegations` (C1)** | source-owned `EffectiveProfile.policyHash` + exact registry-enforcement digest | one surface may hold multiple immutable live profile delegations; policy, registry/path enforcement, and delegation revision are rechecked |
| Session (execution/replay) | `state.db.sessions` (C0 columns) | — | NOT replaced by collab bindings |
| **Connection/task origin evidence** | server-owned connection context + **`state.db.gateway_task_origins`** | — | connection-scoped auth; immutable request-keyed origin/revisions; C0.1 remains live |
| **Approval authority (who may decide)** | **`state.db.surface_authorities` (C1)** | — | live current-epoch `approve` ledger row; never execution capability |
| Execution status / events | `state.db.tasks` / **`state.db.events`** | `run_receipts` | existing event source of truth; no new lifecycle log |
| **Approval state / display audit** | **`state.db.tool_approvals` (canonical)** | read-time redacted card/export | original table/rows/rowid/args retained; six nullable additions only; no second approval state machine |
| **Approval origin** | **`tool_approvals.origin_*`** | — | written at registration from the immutable request-keyed task-origin snapshot |
| **Immutable registration binding** | **`state.db.gateway_approval_bindings`** | — | task/delegation/action/context facts only; no status or decision fields |
| **Decision evidence** | **`tool_approvals.decided_*`, `decided_at`, `context_hash`** | — | same canonical transaction as the winning status UPDATE |
| **Action grant (one-shot consumption, §1.4)** | **`state.db.gateway_action_grants`** | — | exact action + revisions; consumed durably at admission |
| **Approval expiry** | **`tool_approvals.status='expired'` + `expires_at`** | — | centralized writer; expired has null decision/context and no grant |
| **Approval payload presentation** | existing display/audit `args_json` remains unchanged; no new payload store | read-time redacted card/export | action authorization uses a digest; future payload persistence requires separate operator-approved protection/retention design |
| **Approval-context binding** | **registration digest in `gateway_approval_bindings`; decision digest in `tool_approvals.context_hash`** | — | C2 compares registration→decision; C3 async apply recheck deferred |
| **Approval delivery** | **`approval_deliveries` (C2) — PROJECTION** | (is the projection) | rebuildable, droppable; never truth |
| Receipts | `run_receipts` (projection) | (is the projection) | precedent for `approval_deliveries` |
| Governed-skill state | existing Hermes/kernel owners | — | `skill_queue` schema/data/runtime untouched by C1/C2 |

Explicit statement: **gateway owns effective execution, events, receipts, approval state, and control-plane authority; collab owns configured identity, surfaces, and credentials. All C1/C2 schema work is additive.** The two physical databases are not unified and no existing authoritative table is repurposed, rebuilt, archived, renamed, or deleted.

---

## 5. Three-proofs acceptance (operator-mandated, load-bearing)

**Baseline test-count note (Revision 4).** Test counts drift with every merged lane and MUST be re-derived at the active baseline (`af52430`, and again after any rebase) at build time — this PRD deliberately cites **no absolute count** (the Rev-3 text's counts were stale within two days of being written, which is the lesson). **Discipline note (unchanged, load-bearing):** a green general gate is **necessary but NOT sufficient** for a security property — do not over-read a green count. Each security-relevant control still needs a **property-specific adversarial proof** (the three-proofs bar below; the §7 adversarial matrix). "The suite is green" never substitutes for "this specific control refused this specific attack on a booted artifact."

Every C1/C2 control, where applicable, requires all three of the following. **A control is NOT landed on green units alone.**

1. **(a) Unit behavior** — the control's logic proven in isolation (e.g. existence-oblivious verify count; first-decision-wins; context-hash mismatch invalidates).
2. **(b) Runtime REACHABILITY** — `pnpm reachability` (`ops/reachability.mjs`) must prove real running code reaches the control. The gate walks the import graph transitively from declared entry points; a module wired to nothing FAILS even with green units. **As each C1/C2 slice gains a real runtime entry point, it is removed from the `DORMANT['packages/collab']` declaration** (`reachability.mjs:60-68`, which already names the C0→C1→C2→C3→C4 order). New gateway modules under `packages/gateway/src` must be transitively reachable from `packages/gateway/src/server.ts`.
3. **(c) BUILT-ARTIFACT enforcement** — boot the built `dist`/binary and prove the control is active there, not merely in TS source. This is the **stale-`dist` auth-hole lesson** cited directly in `principalBridge.ts:69` and `reachability.mjs` — a control present in source but stale in the shipped artifact is not landed. Reuse the built-artifact boot harness pattern (`ops/runtime-build.mjs`, `ops/reachability.mjs`).

Per-control proof obligations (illustrative, not exhaustive — the ticket acceptance criteria in §8 pin the full set):

| Control | (a) unit | (b) reachability | (c) built artifact |
|---|---|---|---|
| Surface credential verify (existence-oblivious) | HMAC-count equality across hit/miss/revoked/expired/malformed | reached from `server.ts` connect path | booted dist refuses revoked surface |
| Connection/task-origin gate (§2.6/§2.13) | concurrent same-session surfaces retain distinct connection contexts; immutable request snapshot written at task ingress | reached from connect/resume and task creation | booted dist rejects stale projection and preserves correct per-task origin |
| First-decision-wins + evidence (props 3,7) | concurrent decide/expiry → one canonical transition, one evidence tuple, at most one grant | reached from `APPROVE_TOOL` handler and centralized expirer | booted dist records canonical evidence |
| Channel self-approve prevention (prop 1) | channel/automation `decided_surface_id`==`origin_surface_id` refused; channel surface holds no `approve` authority | refusal reached from the `APPROVE_TOOL` authority check (post-H-1 seam, §2.7.1) — depends on C1-5 origin-trust | **booted dist refuses channel self-approve** (channel surface cannot decide its own originated task on a live artifact) |
| Post-approval exact-action/path/profile re-check (prop 12) | server-only grant binds source request to the re-minted dispatch request; the actual regenerated canonical arguments, action hash, current authority, capability, profile/delegation, registry, path, privacy, and routing state are rechecked and the grant is consumed immediately before the tool side effect | pre-tool execution seam is transitively reached; under the flag, `grantedTools` alone never authorizes; FRONTIER remains fail-closed until its separately authorized structured-grant hook exists | **booted dist refuses altered args and stale policy/path/delegation state and proves no side effect**; a matching grant is consumed once |
| Context binding (§3.4.1, prop 10 **C2 part**) | registration digest stored; decision recomputes current digest, rejects mismatch, stores canonical evidence only on a winner | reached from register + `APPROVE_TOOL` paths | booted dist rejects registration→decision drift and writes winning `context_hash` |
| Context invalidation (§3.4.3, prop 10 **C3 part — DEFERRED**) | context mismatch → explicit failure | reached from async apply/re-mint path (C3) | booted dist fails loudly on stale apply (C3) |
| Delivery projection rebuild (§3.13) | rebuild yields identical delivery view | rebuild script reachable | rebuild runs against booted DB |
| Revision 4 migration (§1.5, §3.1) | six guarded nullable columns; original `tool_approvals` table/rowid/rows/values/args/status preserved; C0.1 + `skill_queue` untouched | migration runs from the real startup path | booted dist over separate migrated DB copies preserves legacy flag-off artifacts and denies missing/stale gateway projections |

---

## 6. Cross-cutting requirements

### 6.1 Feature-flag rollout strategy
- `TORQCLAW_COLLAB_ENABLED` is read **per-call** via `collabEnabled()` (never captured at import — stale-`dist` trap, `principalBridge.ts:64-73`) and defaults off. No migration, build, test, or release may change that default.
- After the external governed-skill soak decision and separate explicit C1/C2 runtime authorization, rollout is staged: (R0) additive migration on disposable copies; (R1) production schema present but flag off/inert; (R2) shadow evaluation that records secret-free comparison metrics and never grants; (R3) explicitly named operator-surface canary; (R4) bounded soak; (R5) default-on only after a separate operator decision. No stage advances automatically.
- Immediate abort/flag-off conditions include any unauthorized decision/dispatch, duplicate grant, post-deny dispatch, context mismatch incorrectly accepted, migration-manifest drift, secret leakage, or evidence-integrity failure. Quantitative latency/lock/error thresholds must be ratified under OQ-8 before runtime authorization.
- **Flag-off byte-identity (SI-4)** compares the exact observable artifacts for a fixed legacy transcript: protocol response bytes and ordering, error codes, task/event/receipt/approval row values, dispatch decisions, and absence of reads/writes to new tables. An additive schema necessarily changes raw SQLite file bytes, so the PRD does not make the false claim that the entire DB file is byte-identical; existing logical rows and observable legacy behavior are.
- **Operator ruling 2026-08-11 (recorded at adoption; delegated decision):** the rescoped SI-4 formulation above is **ACCEPTED as the frozen meaning**. Observable-artifact identity over a fixed legacy transcript is the claim this program verifies; the earlier raw-DB-file reading was physically unsatisfiable under any additive schema and is not restored.

### 6.2 DB migration strategy (strictly additive, nullable, guarded)
- All new tables via `CREATE TABLE IF NOT EXISTS`.
- Every column added to an *already-shipped* table via `PRAGMA table_info(<table>)` guard before `ALTER TABLE ... ADD COLUMN`, following `storage.ts:107-111` verbatim (the C0 lesson).
- **IF NOT EXISTS trap (explicit):** an existing DB never re-runs `CREATE`, so it will never pick up new columns from an edited `CREATE`; new columns are ALWAYS nullable + `ALTER`-guarded.
- Exactly six nullable columns are added to the existing physical `tool_approvals`; no rebuild, backfill, history rewrite, or rowid change is permitted. Flag-on legacy rows missing expiry/binding data are inert and reissue-required; flag-off retains the unchanged legacy path.
- Capture separate pre/post manifests for `state.db` and `collab.db`: schema objects, columns/FKs/indexes/triggers, row counts, primary-key/value digests, `tool_approvals` rowid/order/value digest, `skill_queue` digest, and `PRAGMA foreign_key_check`. Existing manifests must match; new columns are NULL on old rows and new tables are empty.
- Never rename/archive/delete C0.1 live tables, copy principals into `state.db`, rewrite task/event/episode/receipt/telemetry/approval/skill data, delete either DB, or delete a backup. Repeat migration is a no-op. Cross-database runtime state follows grant-last/deny-first (§1.4); no cross-WAL atomicity is claimed.

### 6.3 Reachability-gate requirements
- No C1/C2 module ships as an orphan. Each slice removes itself from `DORMANT` in `reachability.mjs` as it gains a real entry point (§5(b)).

### 6.4 No secret-bearing browser/channel credentials
- Surface tokens are `tq1_` bearer secrets and MUST NOT be embedded in browser/channel client code or shipped to a channel adapter as a static secret. Only the HMAC is stored server-side; the plaintext is shown once at issuance. Browser/PWA surfaces obtain credentials through issuance flows, never baked-in secrets. (Design contract; adapter implementations are C3, out of scope.)

### 6.5 No second execution/event/receipt authority
- Any design that introduces a parallel event log, a second approval state table, or a collab-owned execution status FAILS review. Existing `events` stays the single append-only execution/lifecycle log; canonical approval evidence stays on `tool_approvals`. Registration bindings and delivery projections carry no status transition authority.

### 6.6 Rollback behavior
- Flag-off is the primary runtime rollback (§6.1). Additive columns/tables remain inert; all live C0.1 names/data and historical `tool_approvals` values remain available. Dropping/rebuilding `approval_deliveries` is safe because it is only a projection, but destructive cleanup is not part of ordinary rollback.
- **Rollback MUST only reduce or preserve authority.** Recovery may finish collab-side recording after a gateway-first revoke, but MUST NOT finish a partial provision or grant, restore an earlier epoch, create/recreate/consume a grant, change canonical approval state, replay dispatch, or delete/rename/rewrite database history or backups. A committed approval whose FK-backed dispatch task/grant was never consumed is revoked and reissued only by a new operator action—never completed or dispatched by recovery. A two-database restore is a separately approved operator procedure with manifests and dispatched-work reconciliation, not an automatic C1/C2 action.

### 6.7 Observability
- Secret-free, bounded-cardinality metrics/audit cover: surface provisioning activation/partial-failure/revocation; credential outcomes bucketed only as `AUTH_FAILED`; gateway epoch/capability/delegation mismatch; decisions by terminal state; expiry backlog and decision-vs-expiry winner; protected-payload persistence refusal; registration-context/evidence mismatch; source/dispatch grant binding plus mint/consume/revoke/duplicate refusal; post-deny refusal; delivery rebuild; governed `UNPROVEN` outcomes; migration manifest results; and flag-off unexpected new-table access. IDs remain in correlated audit records, never metric labels.
- Every failure carries a correlation id that joins existing gateway audit/event/receipt evidence without logging tokens, HMACs, raw args, ciphertext, or secret-bearing metadata. Dashboards must distinguish correctness-integrity alarms from delivery availability.
- Before canary, an operator/support runbook must cover: migration refusal, revoke-side-only cross-database recovery, partial provisioning refusal, stale-delegation reissue, legacy reissue-required, context invalidation, expiry backlog/races, projection rebuild, protected-payload refusal, flag-off verification, governed `UNPROVEN` disk inspection with no automatic retry, and separately approved two-database restore. Each entry names diagnosis evidence and the safe action; none instructs automatic external-work retry.

### 6.8 Operator-facing failure states
- Enumerated and honest: `AUTH_FAILED` (existence-oblivious), SEC-1 refusal, capability-denied, profile-delegation-stale, authority-denied, approval-expired, approval-legacy-reissue-required, protected-payload-persistence-unavailable, grant-consumed, grant-revoked, action-binding-mismatch, **approval-context-invalidated** (C2 registration→decision and later C3 async apply), delivery-failed (projection only), governed `UNPROVEN` (operator inspection required), and migration/reflection-manifest failure. A refusal is explicit, never a silent no-op or apparent success.

### 6.9 Progressive disclosure in eventual UI contracts (contract only; UI out of scope)
- Approval cards expose a bounded/redacted summary first, with the authoritative receipt reachable through existing operator-only `GET_RECEIPT`. The response contract supplies stable `approvalId`; the canonical status enum; `createdAt`, `expiresAt`, and server-authoritative `serverNow`; server-derived `canApprove`/`canReject`; unavailable reason/code; a human-readable redacted action label; authorized origin provenance; delivery sequence/revision; one-shot scope; and deterministic ordering. State/reason is always textual—never color/icon alone—and consequences are explicit for approve/reject/expired/context-invalidated states. Raw args and secrets never cross the boundary.
- UI/PWA implementation and formal WCAG conformance testing are deferred with the UI, but the C1/C2 API cannot omit the accessible name/status/error/timing data required to build a keyboard- and screen-reader-operable approval flow. Accessibility contract tests validate nonempty labels, deterministic ordering, text alternatives, and that redaction does not erase the action's meaningful name.

### 6.10 Performance, contention, and capacity gates
- The §1.4 synchronous fence adds reads/writes and lock time to connect, decision, and dispatch. Before runtime authorization, the owner must record an active-baseline load profile and ratify numeric budgets for p95/p99 added latency, sustained throughput floor, SQLite busy/lock duration, expiry-sweep work, and reconnect projection rebuild. OQ-8 is therefore a runtime-authorization blocker, not permission to ship without a budget.
- Required indexes include approval `(status, expires_at)`, delivery `(target_surface_id, delivery_state)`, and every live epoch/authority lookup used by the fence. Load tests exercise decision/expiry/revoke/dispatch races on separate realistic DB copies. Correctness wins over latency: timeout/busy fails closed and never bypasses the fence or auto-retries external work.

---

## 7. Adversarial scenario matrix

**Slice-tag semantics (normative).** Only rows tagged for the current slice gate that slice. **A9 is C3** because it attacks context drift after a decision is durably delivered but before a future asynchronous apply. The existing C2 registration→decision drift is separately mandatory in the Revision-4 obligations below (§3.4.2); synchronous C2 does not excuse it.

| # | Slice | Scenario | Setup | Attack | Required outcome |
|---|---|---|---|---|---|
| A1 | C1 | Cross-principal resume | Session owned by principal B; A holds a valid surface | A presents A's credential + B's `sessionId` | Refuse (SEC-1, C0 step 3). No resume. |
| A2 | C1 | Revoked surface reconnect | Surface revoked, token still known | Reconnect with old token | `AUTH_FAILED`, existence-oblivious (§2.6 step 2). |
| A3 | C1 | Expired credential reconnect | Credential `expires_at` in past | Reconnect | `AUTH_FAILED`, same path as A2. |
| A4 | C2 | Channel attempts APPROVE_TOOL | Channel-role/surface session | Send `APPROVE_TOOL` | Deny (`authz.ts` default-deny; prop 1). No state change. |
| A5 | C2 | Unauthorized operator surface approves | Operator principal, surface lacks `approve` authority | `APPROVE_TOOL` | Authority-denied (`holdsAuthority` false; SI-1). No transition. |
| A6 | C2 | Authorized decisions race | One `pending` approval from a different origin; two independently authorized operator surfaces | Two concurrent `APPROVE` | Different-origin authorized operator path is reachable; exactly one transition/evidence/grant, loser changes zero rows (props 2,3,4,7,11). |
| A7 | C2 | Approval replayed | Already-decided approval | Re-send same `APPROVE` | No-op, `info.changes===0` (prop 4). No second grant row (`approval_id UNIQUE`). |
| A8 | C2 | Decision races expiry | `pending`, expiry boundary reached | Valid operator decides while expirer runs | Same centralized writer/clock: first commit wins; terminal shape is either decided with evidence (and grant only if approved) or expired with null decision/context and no grant. |
| A9 | C3 | Context changes after decision before asynchronous apply | C3 has delivered a durable decision; profile/privacy/policy changes before later apply | Apply old decision | **C3 only:** recomputed context mismatch → explicit INVALIDATED refusal; property 10 wins over property 6. C2 has no such post-decision async seam. |
| A10 | C2 | Approval delivery lost/restarted | Delivery projection row `failed`/missing; prior target may be revoked | Gateway restarts | Approval remains `pending` (truth intact); re-project to current eligible operator surfaces only. If none exists, report `delivery-failed`/`no-eligible-operator-surface` and let ordinary expiry win; never target the revoked surface (props 5,6). |
| A11 | C1 | Stale built artifact bypasses control | New control in TS source, stale `dist` | Boot stale artifact | Three-proofs (c) FAILS the landing; control proven only when booted dist enforces it (§5). |
| A12 | C1 | Feature flag off | `TORQCLAW_COLLAB_ENABLED` unset | Fixed legacy traffic transcript | Byte-identical protocol/error/order and existing-row artifacts; no new-table reads/writes; documented SEC-1 legacy behavior preserved (SI-4). |

Acceptance-gate rows by slice: **C1 gates = A1, A2, A3, A11, A12**; **C2 gates = A4, A5, A6, A7, A8, A10**; **C3 (forward-looking, not gated now) = A9**.

Revision 4 adds the following mandatory adversarial obligations without renumbering the frozen A1–A12 registry:

- Duplicate `surface_id`, `credential_id`, or `secret_hmac`, orphan ownership, and channel-kind/operator-role combinations fail at DDL/provisioning; lookups remain unambiguous.
- Collab identity commit followed by failed gateway activation leaves the surface unable to act (**grant-last**). Gateway deny/epoch commit followed by failed collab bookkeeping remains denied; recovery finishes revoke-side audit only (**deny-first**).
- Registration context changed before decision is refused/expired in C2; a matching different-origin authorized operator decision succeeds when its live `approve` row and resource/task `authz` pass.
- Same-origin operator approval is a required positive path only when the originating/deciding surface is operator-role with a live current-epoch `approve` grant; changing the configured role follows deny-first, and a missing/stale/revoked/observed-divergent enforcement projection refuses.
- Legacy NULL-expiry/missing-binding approval under flag-on is inert and reissue-required; decision-vs-expiry, decision-vs-revoke, and revoke-vs-dispatch races each have one durable winner.
- Consumed/revoked/mismatched action grants, stale auth/capability/profile revisions, and current-profile-delegation mismatch refuse before `dispatch_started` with no automatic replay.
- Migration interruption/repeat preserves every historical `tool_approvals` value/rowid, all live C0.1 objects/data, `skill_queue`, and unrelated schema/data. Any rebuild, blanket redaction, archive/removal, DB/backup deletion, or cross-database unification mutation fails the gate.
- A stale/fabricated evidence harness—`observed` copied from `expected`, static PASS in `finally`, overwritten failure report, or unlaunched artifact—fails and cannot be labeled built-artifact proof.

---

## 8. Ticket decomposition, acceptance, and FREEZE criteria

Each ticket is independently gated by the three-proofs bar (§5) where a runtime control exists.

### C1 tickets
- **C1-1 Surface schema + guarded `collab.db` migration** — globally unique `surfaces.surface_id`, immutable owner FK, six kinds, role/kind cross-CHECK. AC: legacy repeat/interruption; duplicate id/orphan owner/channel-as-operator fail; live C0.1 schema/data unchanged.
- **C1-2 Surface credential issuance + verify (reuse credentials.ts)** — globally unique `credential_id` and `secret_hmac`, surface FK, existence-oblivious verify including expiry. AC: duplicate id/HMAC fail; HMAC-count equality across hit/miss/revoked/expired/malformed; plaintext once and Buffer zeroed.
- **C1-3 Revocation/expiration + cross-database coordinator** — credential/surface mutation plus gateway projection epoch. AC: A2/A3; grant-last provisioning and deny-first revocation crash boundaries; recovery cannot complete a partial grant or reverse deny.
- **C1-4 Effective capability/profile + H-1 authority subordination** — validate collab configuration into `gateway_surface_security`; actual `CapabilityClass`/operation ids and full effective profile revision; immutable `surface_authorities` ledger. AC: missing/stale/revoked/revision mismatch denies; current profile delegation is rechecked; `approve` requires live current-epoch row and operator kind+role; execution capability/operator role alone cannot authorize.
- **C1-5 Resume surface gate + immutable task origin** — validate credential, derive server-side connection-scoped `ConnectionAuthContext`, require current projection, and capture `gateway_task_origins` per request. AC: multiple concurrent presenting surfaces on one durable session remain distinct; same-principal cross-surface positive; A1/A2/A3/stale-revision negatives; SI-4 parity.
- **C1-6 Audit/provenance/support evidence** — secret-free audit/correlation records and runbook paths for provisioning/revocation partial failures. AC: no token/HMAC/raw args/ciphertext in audit; every failure maps to a safe operator action without automatic work retry.

### C2 tickets
- **C2-1 additive approval migration** — exactly six nullable guarded additions on the existing physical `tool_approvals`; create only the §10.3 additive state objects. AC: pre/post manifests prove table/rowid/original columns/rows/values/`args_json`/`status`, live C0.1, `skill_queue`, and unrelated objects unchanged; repeat/interruption safe; legacy NULL rows inert under flag-on and unchanged under flag-off.
- **C2-2 Canonical decision evidence (props 2,3,4,7)** — origin at registration; current connection supplies decision evidence directly on `tool_approvals`; approved winner alone mints one grant. AC: A6 plus decision/expiry concurrency yields one terminal row/evidence tuple and at most one grant.
- **C2-3 Authority vs origin + channel self-approve guard (props 1,2)** — authority-gated decide (reads `approve` authority per §2.7.1, never execution capability); structural self-approve refusal (§3.5); CT-2 channel/automation exclusion (§3.14). AC: A4, A5. **DEPENDS ON C1-5** (H-2, §3.5): `origin_surface_id` origin-trust is only sound once the C1-5 bind-time surface-validity gate has validated the presenting credential at connect. C2-3 MUST NOT land before C1-5.
- **C2-4 Approval expiry (prop 9)** — one canonical clock/writer; decision predicate includes `expires_at>now`; expiry predicate is `status='pending' AND expires_at<=now`. AC: A8, NULL legacy semantics, terminal nullability, `(status, expires_at)` plan/index, replay harmlessness.
- **C2-5 `CTXHASH_V1` registration→decision binding (prop 10, C2 part)** — store immutable registration digest, recompute current ten-field digest at decision, refuse/expire drift, and write the winning canonical digest as evidence. AC: frozen serializer vectors independently reproduce Unicode, explicit-empty, missing/null rejection, and large-length cases; profile/policy/privacy/registry changes fail; synchronous fence rechecks current revisions. Future decision-delivery→apply revalidation remains C3/A9.
- **C2-6 Redacted approval card contract (prop 8)** — read-time allowlist/scrub/cap with accessible labels and honest wording. AC: raw args never on wire/log; historical `args_json` byte-preserved; no protected payload sidecar exists or receives writes—future payload persistence requires a separate operator-approved encryption/key/AAD/retention/failure-semantics project; accessibility data tests pass.
- **C2-7 `approval_deliveries` projection + rebuild (props 5,6)** — indexed current actionable view. AC: A10; drop/rebuild yields correct current pending targets; loss of historical delivery attempt state loses no approval truth.
- **C2-8 Exact one-shot grant + pre-tool admission (props 11,12)** — "Allow for session" prohibited; bind action digest/epoch/context/profile revisions; compare regenerated actual args and consume inside §1.4 immediately before tool execution. AC: LOCAL_EDGE and every bridge executor traverse one gateway seam; FRONTIER remains refused until a separately authorized Hermes structured-grant hook proves args-aware check/consume reachability; consumed/revoked/mismatched/stale/expired grants refuse; `GRANT_TTL_SECONDS` is finite, independently ratified, set from decision `canonical_now`, and never copied from approval expiry; route uses the same shared route+constraint resolver as initial submit; no automatic replay after crash.

### FREEZE criteria ("done for review")
This PRD is frozen for review only when: §§1–13 are complete; the source-of-truth/property/adversarial registries agree; the executable §10 gate passes both pinned physical SQLite fixtures and every negative-teeth mutation; old 67 checks remain green; destructive patterns are absent; independent security and implementation reviews have no unresolved BLOCKING/FATAL finding; and open questions are explicitly defaulted or marked as runtime-authorization blockers. Runtime code is neither required nor authorized by this design freeze.

---

## 9. Explicitly OUT OF SCOPE

- Any C1/C2 runtime source, runtime test, generated distribution, feature-default change, release, deploy, merge, or push in this design-only lane.
- C3 channel adapters; Telegram; Slack.
- C4 Task Rooms.
- Operator UI/PWA implementation and formal WCAG conformance testing. The accessibility-ready response/data contract in §6.9 remains in scope for C1/C2 design.
- Unified search.
- Governed-skill, Hermes/kernel, TrustOS, `skill_queue`, GS, or console runtime changes.
- Live destructive restore.
- Replacement of gateway `sessions` / `events` / `receipts`.
- Wholesale collab activation (the 7.7k-line switch-on `reachability.mjs:60-68` explicitly forbids).
- Redesign of the collab substrate DDL — the §10.1 baseline embeds are verbatim FIXTURES of what shipped at the baseline ref, quoted for the pre-gate; they are not proposals and nothing in them is being re-specified.
- Fine-grained **execution-capability** vocabulary finalization, surface transfer semantics, and TTL numeric values remain OPEN QUESTIONS (§12), not in-scope decisions. (The `approve` **authority** and the **context-hash input set** are NO LONGER open — both frozen: AR-1 §1.2.1 and §3.4.1 respectively.)
- **C3-scoped and out of C2:** live apply-time `context_hash` re-validation / property-10-wins (§3.4.3) and adversarial test A9 — deferred to C3's async/offline delivery seam.

### 9.1 Required governed-kernel boundary carried by C1/C2 (contract only)

The current repository proves kernel-MCP registration of `rollback_skill` and `list_skill_versions`; it does **not** by itself prove end-to-end gateway/operator reachability. Before any future gateway or console exposure, both tools are **operator-surface only** as a required invariant: there is no channel/automation/cross-channel path, no C2 card path, and no delegated-approval path. Read-only `list_skill_versions` receives the same reachability boundary as mutation-capable `rollback_skill`.

If C2 displays or propagates governed activation failures, it MUST call the shared `governed_skills.map_activation_failure` contract and never copy/re-create the error dictionaries. The bridge/client must preserve a returned `{ok:false,...}` result as failure; it may not emit apparent decision success merely because the MCP transport call returned.

The exact contract codes are:

- `SKILL_ROLLBACK_TARGET_NEVER_ACTIVE`
- `SKILL_ROLLBACK_INVALID_TARGET`
- `SKILL_PROJECTION_UNPROVEN_AFTER_REVERT`
- `SKILL_ACTIVATION_CACHE_UNPROVEN`

The two `UNPROVEN` codes are non-retryable: clients **must not auto-retry**, and the operator must inspect disk. Governed disable/unpublish does not exist; `GS-DISABLE` is unscoped, and no C2 card/UI may promise either. `rollback_skill` re-enables a disabled skill by design. `TORQCLAW_GOVERNED_SKILLS` remains default-off until the soak completes and the operator explicitly decides default-on. The Revision-4 linter binds these names and retry classifications to the current mapper/source rather than accepting PRD string presence alone.

---

## 10. Consistency pre-gate (SPECIFY, do not implement)

**Revision-4 correction:** the historical heading is retained so the original 67-check parser remains backward-compatible; the deterministic Revision-4 extensions in §10.4 are implemented now for design freeze. "Do not implement" continues to mean no C1/C2 runtime implementation in this lane.

`scripts/lint_collab_gateway_prd.py` runs over this canonical PRD. It preserves the original 67 checks and adds executable Revision-4 provenance, SQLite, map, source-boundary, and negative-teeth checks. A zero exit is required before review-ready status; a string-only PASS is insufficient.

**Required literals present** (missing any → FAIL):
- Four-layer model terms: `Principal`, `Surface`, `Credential`, `Session`.
- Six surface kinds: `desktop`, `mobile`, `http`, `telegram`, `slack`, `automation`.
- C0 frozen symbols: `resolvePrincipalBinding`, `assertResumeAllowed`, `collabEnabled`, `SAFE_ID`, `da688c0`.
- Credential reuse: `tq1_`, `HMAC-SHA-256`, `existence-oblivious`, `credentials.ts`.
- Approval state set: `pending`, `approved`, `rejected`, `expired`.
- **Identity/capability/authority split (frozen):** `identity`, execution `capability`, and control-plane `authority` remain separate; `approve` is reserved authority, never execution capability. Execution vocabulary is source-bound to `CapabilityClass` (`read|write|exec|send`) and effective profile identity, including policy/registry revision and network/browser scopes.
- **CT-2 provisioning rule (frozen):** the literal that `approve` is grantable ONLY to operator-kind surfaces and NEVER to channel/automation surfaces; `cross-channel approval` forbidden.
- **H-1 subordination (frozen):** `authz.ts` operator short-circuit is subordinated — operator authority `INTERSECTED` with surface-held authority; the corrected layering `principal authority → surface / session authority → requested capability → specific operation → specific resource / task` present.
- **Property-10 split:** C2 compares frozen registration context to current decision context, stores winning `context_hash`, and synchronously rechecks the §1.4 fence; live revalidation across a future asynchronous decision-delivery→apply seam is `DEFERRED to C3`, where `property 10 WINS over property 6` and the collision is `latent-until-C3`.
- **OQ-4 frozen input set:** the ten canonical `context_hash` inputs enumerated (§3.4.1) with `resolved execution profile` and `privacy` context both present (so A9 passes by construction).
- **Context-hash byte serializer (frozen):** the versioned canonical byte serializer literal `CTXHASH_V1` MUST be present (§3.4.1), so the hash is independently reproducible for C2-5.
- **Separate authority store (frozen):** the authority-store table name `surface_authorities` MUST be present (§2.7.1) and the operator-kind discriminator `surface_role` MUST be present (§2.2/§2.7.1). These pin that authority lives in a store separate from `capability_json` and that "operator-kind surface" is a mechanically checkable predicate.
- Projection precedent: `run_receipts`, `receipts-rebuild.mjs`, `approval_deliveries` declared "NOT approval truth".
- Three-proofs literals: `reachability`, `built-artifact`, `stale-dist` (or `stale \`dist\``).
- Migration lesson: `PRAGMA table_info`, `IF NOT EXISTS`, `ALTER TABLE`.

**"Allow for session" — the rule lints the IMPLEMENTATION/CONFIG surface, NOT the PRD prose (CORRECTED).** The earlier spec forbade the literal string `Allow for session` anywhere in this PRD (presence → FAIL). That was a **spec defect**: §3.3/§3.11/§8/OQ-3 legitimately contain the phrase precisely to DOCUMENT the prohibition, so the literal-presence rule made the linter reject its own PRD. Corrected rule:
- The forbidden literal `Allow for session` is forbidden **in the shipped IMPLEMENTATION/CONFIGURATION surface** — the eventual UI grant-option list, config values, and the grant-type enum. It is a grant option that must never ship. A future implementation-surface linter enforces the string's ABSENCE there.
- **This PRD's job is to DOCUMENT that prohibition, not to avoid the phrase.** The PRD linter therefore does the opposite of forbidding the string: it **REQUIRES a present, explicit prohibition statement** — the PRD must state, in normative prose, that "Allow for session" is prohibited as a shippable grant option until a real session-grant primitive is designed (property 11 / OQ-3). **Presence of the prohibition statement → PASS; its absence → FAIL.** (The prohibition statement is the required literal below.)

**Required prohibition statement (absence → FAIL):** the PRD MUST contain a normative sentence prohibiting "Allow for session" as a shippable grant option. The linter asserts this prohibition statement is present; removing it FAILS the gate. This replaces the self-contradicting "literal presence → FAIL" rule.

**Forbidden literals** (present → FAIL):
- Any claim of a second event log or second approval authority. `collab_session_bindings` **is not replaced**, does not replace gateway `sessions`, and cannot be used as the gateway session store.
- `collab_events` / collab channel commands (would mean C3 scope leaked in). *(Revision 4 scoping note: the §10.1 baseline embeds below necessarily contain these names as verbatim quotations of the shipped baseline DDL — the scan is scoped so fixture embeds inside this section are never counted as scope leaks; they are quotations, not proposals.)*

**Structural parity checks:**
- Source-of-truth matrix (§4) contains a row for each of: Surface, SurfaceCredential, surface capability, approval origin, approval authority, approval delivery, approval expiry, decision evidence, context binding.
- All 12 approval properties present in §3.3 (numbered 1–12).
- All 12 adversarial rows present in §7 (A1–A12).
- Every ticket (§8) has an acceptance criterion line.

The linter exits non-zero with named findings, runs its negative mutations, and writes no runtime-success claim. It may report design/source/SQLite-model evidence only. Future built-artifact proof must launch and hash the real artifact, derive observations from child output/disposable DBs, reject `observed` copied from `expected`, preserve failure reports, and emit PASS only after a zero child result—never from `finally`.

### 10.1 Embedded physical baseline fixtures — `af52430` (verbatim source content)

The following source texts pin `packages/gateway/db/schema.sql` (`state.db`) and the `db.exec` DDL payload in `packages/collab/src/migration.ts` (`collab.db`). The linter compares canonical-LF content and SHA-256 to read-only `git show` at `baseline_ref`, then executes them in **separate** SQLite databases. Their concatenation below is a document container, never a claim that both schemas share one transaction domain. No replacement schema is synthesized.

BASELINE_STATE_DB_AF52430_BEGIN
BASELINE_GATEWAY_SCHEMA_AF52430_BEGIN
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 1. Sessions outlive sockets. A session is resumed by passing its id in the
--    ConnectFrame; a new WebSocket does NOT mean a new session.
--    C0: principal_id/surface_id bind a session to the identity that created
--    it, so a resume can be authorized instead of trusting whoever holds the
--    id (SEC-1). Nullable: sessions predating the bridge have no owner and
--    stay resumable. See packages/gateway/src/principalBridge.ts.
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    client_name TEXT,
    principal_id TEXT,
    surface_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Append-only event log during normal runtime. A versioned startup security
--    migration may rewrite legacy ERROR message text only to remove known
--    secret shapes; seq/id/order remain unchanged. seq is the replay cursor:
--    monotonic AUTOINCREMENT, never wall-clock (CURRENT_TIMESTAMP has 1s
--    resolution; tool loops emit several events per second).
CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    request_id TEXT,
    tier TEXT,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    metadata TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);

-- 3. Task lifecycle (persist BEFORE executing; crash leaves a resumable row).
CREATE TABLE IF NOT EXISTS tasks (
    request_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    tier TEXT NOT NULL,
    router_reason TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'running',     -- running | completed | failed
    request_json TEXT NOT NULL,                 -- full GatewayRequest (audit + replay)
    result TEXT,
    error TEXT,
    telemetry_json TEXT,                        -- final telemetry incl. costUsd
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME
);

-- 4. Episodic memory: LLM-condensed summaries of completed tasks.
CREATE TABLE IF NOT EXISTS task_episodes (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    original_prompt TEXT NOT NULL,
    final_result TEXT NOT NULL,
    summary TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 5. FTS5 external-content index over episodic memory.
CREATE VIRTUAL TABLE IF NOT EXISTS task_search USING fts5(
    original_prompt,
    summary,
    content='task_episodes',
    content_rowid='rowid'
);

-- 6. Full trigger set. External-content FTS5 corrupts silently if deletes
--    and updates aren't mirrored with the special 'delete' insert.
CREATE TRIGGER IF NOT EXISTS task_episodes_ai AFTER INSERT ON task_episodes BEGIN
  INSERT INTO task_search(rowid, original_prompt, summary)
  VALUES (new.rowid, new.original_prompt, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS task_episodes_ad AFTER DELETE ON task_episodes BEGIN
  INSERT INTO task_search(task_search, rowid, original_prompt, summary)
  VALUES ('delete', old.rowid, old.original_prompt, old.summary);
END;

CREATE TRIGGER IF NOT EXISTS task_episodes_au AFTER UPDATE ON task_episodes BEGIN
  INSERT INTO task_search(task_search, rowid, original_prompt, summary)
  VALUES ('delete', old.rowid, old.original_prompt, old.summary);
  INSERT INTO task_search(rowid, original_prompt, summary)
  VALUES (new.rowid, new.original_prompt, new.summary);
END;

-- 7. Pending skill approvals (human-in-the-loop gate over the Hermes loop).
CREATE TABLE IF NOT EXISTS skill_queue (
    queue_id TEXT PRIMARY KEY,
    proposed_name TEXT NOT NULL,
    skill_markdown TEXT NOT NULL,
    source_task_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',    -- pending | approved | rejected
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    decided_at DATETIME
);

-- 8. Pending tool approvals (P2: one-shot tool grant over the LOCAL_EDGE loop).
--    A gated-tool hit registers a row; the gateway emits the terminal
--    PENDING_APPROVAL carrying approval_id. APPROVE re-mints the GatewayRequest
--    from tasks.request_json with grantedTools=[tool_name]; REJECT -> terminal
--    ERROR. args_json is the model-proposed args (display/audit only; NEVER
--    replayed — the re-run regenerates the call under the grant).
CREATE TABLE IF NOT EXISTS tool_approvals (
    approval_id TEXT PRIMARY KEY,
    request_id  TEXT NOT NULL,                 -- the BLOCKED task's request id
    tool_name   TEXT NOT NULL,                 -- real (namespaced) name = grant unit
    args_json   TEXT NOT NULL,                 -- proposed args, display/audit only
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    decided_at  DATETIME
);
CREATE INDEX IF NOT EXISTS idx_tool_approvals_request ON tool_approvals(request_id);

-- 9. Run receipts (TCLAW-4A): a DETERMINISTIC PROJECTION over tasks/events/
--    tool_approvals for one task (request_id), materialized after each
--    terminal dispatch outcome. The event log + tasks table remain the
--    source of truth; this table is a derived, rebuildable read cache — it
--    is NEVER the only copy of anything and can be dropped and rebuilt from
--    events/tasks/tool_approvals at any time (see ops/receipts-rebuild.mjs).
--    Gateway-DB-only: this is NOT an emitted contract (no schema in
--    packages/contracts/generated or engines/hermes_kernel/mcp_wrapper/schemas).
--    TCLAW-4B: read-only via LIST_RECEIPTS/GET_RECEIPT as untyped SYSTEM-event
--    metadata; still not a typed emitted contract of its own.
CREATE TABLE IF NOT EXISTS run_receipts (
  id TEXT PRIMARY KEY,                      -- randomUUID, receipt row id (preserved on re-projection)
  task_id TEXT NOT NULL UNIQUE,             -- = tasks.request_id (upsert key)
  session_id TEXT NOT NULL,
  source_channel TEXT,
  selected_tier TEXT,
  route_diagnostics_json TEXT,
  budget_limit REAL,
  budget_source TEXT,                       -- NULL for 4A (not persisted)
  cost_usd REAL,
  cost_enforceable INTEGER,                 -- NULL for 4A (not persisted)
  elapsed_ms INTEGER,
  iterations INTEGER,
  tools_called_json TEXT,
  cancelled INTEGER,
  blocked_on TEXT,
  memory_used INTEGER,
  context_chars INTEGER,
  result_state TEXT,                        -- 'completed' | 'failed' | 'blocked' (derived)
  safe_export_json TEXT,                    -- deliberately NULL -- export is computed on demand by
                                             -- GET_SAFE_EXPORT (packages/gateway/src/export.ts) so
                                             -- the newest redactor always runs; reserved for a
                                             -- redactor-versioned cache if profiling ever demands one
  full_receipt_json TEXT,
  evidence_start_seq INTEGER,
  evidence_end_seq INTEGER,
  projection_version INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,   -- materialization time (preserved on conflict)
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP    -- bumped each projection
);
CREATE INDEX IF NOT EXISTS idx_run_receipts_session ON run_receipts(session_id);
CREATE INDEX IF NOT EXISTS idx_events_request ON events(request_id);

-- 10. Spend ledger (TCLAW-1A-core, Epic 1 Cost Control Center §9.1): one row
--    per FRONTIER terminal task carrying provider-reported spend, so
--    session/daily caps can be enforced by SUM() BEFORE dispatch. This table
--    is gateway-DB-only -- NOT an emitted contract (no schema in
--    packages/contracts). It is a rebuildable cache of tasks.telemetry_json
--    (see ops/spend-rebuild.mjs if/when added), not a sole source of truth.
--    task_id UNIQUE + ON CONFLICT DO NOTHING makes recordSpend idempotent, so
--    a retried terminal-emission path can never double-count the same task.
CREATE TABLE IF NOT EXISTS spend_ledger (
  id TEXT PRIMARY KEY,                  -- randomUUID per entry
  task_id TEXT NOT NULL UNIQUE,         -- = tasks.request_id (idempotent key)
  session_id TEXT NOT NULL,
  source_channel TEXT,                  -- req.sourceChannel, null for direct
  provider TEXT,                        -- provider/model tag, null if unknown/local
  cost_usd REAL,                        -- provider-reported; NULL when unavailable (never fabricate 0)
  attribution TEXT NOT NULL,            -- 'exact' | 'account_delta' | 'unavailable' (3-way, 1A-attr; TEXT so
                                         -- the split needed no schema change over 1A-core's original 2-way)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_spend_ledger_session ON spend_ledger(session_id);
CREATE INDEX IF NOT EXISTS idx_spend_ledger_created ON spend_ledger(created_at);

-- TORQCLAW_RESILIENCE_SCHEMA_BEGIN
-- Phase-1 gateway projections are rebuildable read models. The Python ledger
-- and its outbox remain the attempt authority; these tables never authorize a
-- provider transition.
CREATE TABLE IF NOT EXISTS resilience_projection_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  applied_outbox_id INTEGER NOT NULL CHECK (applied_outbox_id >= 0),
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO resilience_projection_cursor (id, applied_outbox_id) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS provider_attempt_projection (
  task_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  attempt_id TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL,
  model_id TEXT,
  started_at_ms INTEGER,
  ended_at_ms INTEGER,
  failure_class TEXT,
  failure_code TEXT,
  failure_source TEXT,
  dispatch_attempted INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_attempted IN (0,1)),
  terminal_outcome TEXT,
  reserved_micro_usd INTEGER,
  actual_micro_usd INTEGER,
  cost_known INTEGER CHECK (cost_known IS NULL OR cost_known IN (0,1)),
  cost_source TEXT,
  transition_decision TEXT,
  PRIMARY KEY (task_id, epoch)
);
CREATE INDEX IF NOT EXISTS idx_provider_attempt_projection_task ON provider_attempt_projection(task_id, epoch);

CREATE TABLE IF NOT EXISTS failover_task_projection (
  task_id TEXT PRIMARY KEY,
  plan_hash TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  feature_revision TEXT NOT NULL,
  terminal_outcome TEXT,
  final_provider_id TEXT,
  active_attempt_id TEXT,
  active_epoch INTEGER,
  deadline_ms INTEGER NOT NULL,
  cancellation_requested_at_ms INTEGER,
  immutable_plan_json TEXT NOT NULL DEFAULT '{}',
  provider_metadata_json TEXT NOT NULL DEFAULT '{}'
);

-- TORQCLAW_RESILIENCE_SCHEMA_END
BASELINE_GATEWAY_SCHEMA_AF52430_END
BASELINE_COLLAB_MIGRATION_DDL_AF52430_BEGIN

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
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
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
  rejoined_seq INTEGER NOT NULL DEFAULT 0 CHECK(rejoined_seq >= 0),
  joined_at TEXT NOT NULL,
  removed_at TEXT,
  PRIMARY KEY(channel_id, principal_id)
);

CREATE TABLE collab_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  channel_id TEXT NOT NULL REFERENCES collab_channels(id),
  channel_seq INTEGER NOT NULL CHECK(channel_seq > 0),
  actor_principal_id TEXT NOT NULL REFERENCES principals(id),
  kind TEXT NOT NULL CHECK(kind IN (
    'channel_created','member_added','member_removed',
    'message_posted','channel_archived','channel_unarchived'
  )),
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(channel_id,channel_seq),
  UNIQUE(channel_id,id)
);

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
    'credential_revoked','principal_suspended','principal_restored',
    'principal_revoked','operator_revoked','slow_consumer',
    'socket_closed','recovery'
  ))
);

CREATE INDEX collab_session_credential_open
  ON collab_session_bindings(credential_id,closed_at);

CREATE INDEX collab_members_principal_state_channel
  ON collab_members(principal_id,state,channel_id);

CREATE INDEX collab_cursors_principal_channel
  ON collab_cursors(principal_id,channel_id);

CREATE INDEX principal_credentials_principal_state
  ON principal_credentials(principal_id,state);

CREATE TABLE collab_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN (
    'bootstrap_completed','credential_created','credential_revoked',
    'agent_suspended','agent_restored','agent_revoked',
    'operator_revoked','recovery_completed','recovery_kit_exported',
    'recovery_kit_verified'
  )),
  actor_principal_id TEXT REFERENCES principals(id),
  subject_principal_id TEXT REFERENCES principals(id),
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX collab_audit_kind_created
  ON collab_audit(kind, created_at);

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

CREATE TABLE collab_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

BASELINE_COLLAB_MIGRATION_DDL_AF52430_END
BASELINE_STATE_DB_AF52430_END

### 10.2 BASELINE_OBJECT_EXPECTATIONS_V4 (verbatim)

BASELINE_OBJECT_EXPECTATIONS_V4_BEGIN
{
  "baseline_ref": "af52430a0d719c449a9379866b84c154fc3c3b8a",
  "principals": ["id","kind","display_name","owner_principal_id","status","auth_epoch","revoked_at","created_at","updated_at"],
  "sessions": ["id","role","client_name","principal_id","surface_id","created_at","last_active_at"],
  "events_fk": ["session_id -> sessions(id)"],
  "tasks": ["request_id","session_id","tier","router_reason","state","request_json","result","error","telemetry_json","created_at","finished_at"],
  "tool_approvals": ["approval_id","request_id","tool_name","args_json","status","created_at","decided_at"],
  "required_baseline_objects": ["sessions","events","tasks","task_episodes","task_search","skill_queue","tool_approvals","run_receipts","spend_ledger","resilience_projection_cursor","provider_attempt_projection","failover_task_projection","principals","principal_credentials","collab_channels","collab_members","collab_events","collab_cursors","collab_mutation_results","collab_session_bindings","collab_audit","collab_installation","collab_schema_migrations"],
  "c01_auth_tables": ["principal_credentials","collab_session_bindings","collab_installation","collab_schema_migrations"]
}
BASELINE_OBJECT_EXPECTATIONS_V4_END

### 10.3 STATE_DB_MAP_V4 (verbatim)

STATE_DB_MAP_V4_BEGIN
{
  "baseline_ref": "af52430a0d719c449a9379866b84c154fc3c3b8a",
  "physical_databases": {"state.db":"packages/gateway/db/schema.sql", "collab.db":"packages/collab/src/migration.ts"},
  "state.db": {
    "sessions": {"target":"sessions", "key":"id", "action":"unchanged", "data":"preserve"},
    "events": {"target":"events", "key":"seq", "fk":"session_id -> sessions(id)", "action":"unchanged", "data":"preserve"},
    "tasks": {"target":"tasks", "key":"request_id", "action":"unchanged", "data":"preserve"},
    "skill_queue": {"target":"skill_queue", "action":"unchanged", "schema":"preserve", "data":"preserve", "runtime":"out of scope"},
    "tool_approvals": {"target":"tool_approvals", "action":"extend additive", "preserve":["table","rowid","every original column","every original row","args_json","status"], "guarded_nullable_columns":["origin_principal_id","origin_surface_id","decided_principal_id","decided_surface_id","expires_at","context_hash"], "new_index":"idx_tool_approvals_status_expires", "canonical_approval_state":true},
    "new_additive_objects":["gateway_surface_security","gateway_profile_delegations","gateway_task_origins","surface_authorities","gateway_approval_bindings","gateway_action_grants","approval_deliveries"]
  },
  "collab.db": {
    "principals": {"target":"principals", "action":"unchanged", "columns":"verbatim", "data":"preserve"},
    "c01_auth": {"source":["principal_credentials","collab_session_bindings","collab_installation","collab_schema_migrations"], "action":"unchanged", "live_names":"preserved", "data":"preserve", "flag_off":"legacy path byte-identical"},
    "new_additive_objects":["surfaces","surface_credentials"]
  },
  "cross_database_protocol": {"unification":"forbidden", "grant_order":"collab identity commit then state authority activation", "revoke_order":"state deny or epoch commit then collab identity revocation", "failure_bias":"deny", "automatic_reverse_copy":"forbidden", "automatic_grant_completion":"forbidden", "recovery":"revoke-side-only", "cross_database_fk":"forbidden", "cross_database_atomicity_claim":"forbidden"},
  "unrelated_objects": {"action":"unchanged", "schema":"preserve", "data":"preserve"}
}
STATE_DB_MAP_V4_END

### 10.4 Revision 4 pre-gate extensions (implemented now)

The same CLI implements the original 67 checks plus the following Revision-4 freeze gates:

1. **Baseline provenance:** extract both embedded blocks with their exact boundary whitespace, normalize checkout newlines to canonical LF, compare SHA-256/content with read-only `git show` at `baseline_ref`, and fail on drift. A baseline bump is reviewed, never silently re-quoted.
2. **Separate fixture execution:** execute gateway and collab DDL in separate temporary SQLite databases; derive `sqlite_master`, `table_info`, FK, index, trigger, uniqueness, and collision evidence independently. Never concatenate them into a fictional schema.
3. **Expectation check:** the §10.2 expectations (columns, FKs, `required_baseline_objects`) hold against the fixture.
4. **Map and migration coverage:** the exact two-database map covers required baseline objects, `skill_queue` no-touch, live C0.1 preservation, seven gateway additive objects, two collab additive objects, the six guarded nullable columns plus the one declared approval-expiry index, and grant-last/deny-first failure bias.
5. **Negative teeth:** mutate each load-bearing invariant—global key/HMAC uniqueness, pending/expired nullability, canonical approval state, origin/decision independence including the different-origin authorized-operator positive path, current authority/resource authz, context serializer, migration preservation, cross-database ordering, governed boundary, and evidence integrity. Every named mutant must turn the gate red.
6. **Source-bound governed checks:** inspect current kernel mapper/tool registration to bind the four codes and retryability, while requiring this PRD's stronger operator-only gateway reachability boundary. String presence alone cannot pass.
7. **Scoped scans:** exclude the verbatim fixture blocks from proposal-level C3/session/destructive scans without excluding §10.2–§10.4 or any normative proposal text.

---

## 11. Contradictions found between operator spec and shipped baseline

- **CT-1 (`expired` / `expires_at` reintroduction).** The collab substrate lint (`scripts/lint_collaboration_prd.py:368-369`) FORBIDS `'expired'` and `expires_at` because they were removed from the **`principal_credentials`** model. The operator's C2 spec REQUIRES `'expired'` on `tool_approvals` and TTL/`expires_at` on surface credentials. **No actual conflict** — different tables (`tool_approvals` and `surface_credentials` vs `principal_credentials`) — but it is a real, deliberate divergence a reviewer could mistake for a violation. Surfaced in §2.3 and flagged here. The substrate linter must NOT be run over this PRD (it targets the substrate doc); the C2 linter (§10) is the correct gate.
- **CT-2 (approval authority currently operator-only) — RESOLVED by operator ruling 2026-08-08.** `authz.ts` `case 'APPROVE_TOOL'` is operator-only today, and `LIST_APPROVALS`/`GET_SAFE_EXPORT` are explicitly operator-only with strong stated rationale. The prior draft proposed *capability-gated* approval, which read as an unbounded widening the reviewer had to ratify. **The frozen ruling resolves this and CORRECTS the framing:** approval is gated on a **reserved control-plane AUTHORITY** (`approve`), NOT an execution capability (ruling AR-1, §1.2.1) — and that authority is grantable **ONLY to operator-kind surfaces**, NEVER to channel/automation surfaces, with cross-channel approval forbidden (ruling CT-2, §3.14). The net posture change vs. today is narrow and bounded: `approve` moves from "operator *role*" to "operator-kind *surface* holding the `approve` authority," which is if anything **stricter** (a compromised operator surface without the authority, or any non-operator surface, is refused — see also H-1, §2.7.1). This is no longer an open "should we relax?" ruling for the reviewer; it is a frozen decision to be verified.
- **CT-3 (status has no CHECK constraint) — RESOLVED additively.** `schema.sql §8` declares `tool_approvals.status TEXT NOT NULL DEFAULT 'pending'` with no CHECK. Adding the `expired` writer state therefore requires no table rebuild or constraint edit. The one centralized writer and its compare-and-swap predicates (M-1/M-2) enforce the state machine; the existing table, rowids, columns, rows, values, `args_json`, and status values remain physically unchanged by migration.

- **CT-4 (baseline freshness across concurrently moving lanes) — sequencing resolved, evidence kept precise.** The original CT-4 flagged that the governed-skill lane could supersede quoted behavior. GS-COORD and GS-ROLLBACK are present in the `39a7707` baseline (2026-08-10), closing the earlier blocking rollback gap. The lane handoff reported a later merged-tree GS-ACCEPT result of 9 passed / 1 xfailed; this PRD does not promote that handoff statement into immutable evidence. The repository receipt `.torq/artifacts/03_verifier/gs_accept_r1.md` records the earlier 8 passed / 2 xfailed run on `83690f3`. A builder MUST re-run and receipt the current gate at its actual build baseline.

  What a C1/C2 builder must now take from this:
  1. **Re-read the shipped baseline at build time; do not quote this PRD's citations as current.** In particular, `skill_queue.decide()`'s failure arms were EXTRACTED into one shared mapper (`governed_skills.map_activation_failure`) with golden-pinned byte-identical shapes, and a governed rollback surface (`rollback_skill` / `list_skill_versions` MCP tools) now exists. A governed APPROVE returns fail-fast/retryable shapes (e.g. `{ok:false, code:"SKILL_RUNTIME_BUSY", retryable:true, status:"pending", activeTasks:N}`) rather than fire-and-forget success. C2's approval-broker UX must be designed against the CURRENT decide() contract, not a remembered one.
  2. **The three-proofs bar is proven implementable, twice.** GS-COORD's coordinator-wiring tests and GS-ROLLBACK's deletion-probe record (six controls sabotaged, six red) are live precedents for §5's "green units alone are insufficient" — including a G2A round-1 catch where an exception-subclass ordering bug survived 22 green tests because every taxonomy assertion stopped below the operator surface. C1/C2's §7 rows must be asserted at the outermost surface the operator actually calls.
  3. The remaining external sequencing gate is the operator's **soak → governed default-on** decision (see the Build gate bullet in the preamble).

- **CT-5 (Revision 4 vs the additive-only migration rule) — RESOLVED with no exception.** Revision 4 is strictly additive, nullable, and guarded. It does not rebuild `tool_approvals`, erase historical arguments, archive or rename C0.1 tables, or require credential reprovisioning. `collab.db` remains the live identity source; `state.db` receives only additive enforcement sidecars and six nullable approval columns. Flag-off leaves those additions inert and restores the legacy observable path.

No contradiction found on the core rulings (execution authority stays with the gateway; C0 frozen; projection modeling; property-10-wins) — those align cleanly with the shipped baseline.

---

## 12. Open questions for the operator (not guessed)

Two questions from the prior draft are **FROZEN** and removed from this list: **OQ-4 (context_hash inputs)** — closed, the full input set is normative in §3.4.1; and the **`approve`-authority portion of OQ-1** — closed, `approve` is a reserved control-plane authority per ruling AR-1 (§1.2.1). The remaining questions are defer-safe because each default withholds authority or capability. OQ-8 is a release blocker rather than a guessed number: runtime authorization requires the operator to ratify quantitative performance thresholds and the receipt method first.

Every open question has a named decision owner and a gate-relative deadline; missing the deadline preserves its fail-closed default and blocks only the named acceptance/rollout gate.

- **OQ-1 (residual — configured capability granularity only; owner: operator + C1-4 ticket owner; deadline: before C1-4 acceptance).** The implemented coarse `CapabilityClass` vocabulary is fixed as `read|write|exec|send`; browser access is a profile/network-scope constraint, not a capability class. Should `surfaces.capability_json` store those coarse classes or source-owned operation IDs that resolve through `EffectiveProfile.operationCapabilities`? The schema intentionally carries both class and operation-id projections, so either answer remains additive; C1-4 acceptance is parameterized on the chosen configured input. **The `approve` authority is not part of this question — it is frozen (AR-1, §1.2.1).** *Fail-closed default:* `capability_json` is `'[]'`, and only the intersection of configured capability with the live source-owned profile delegation can execute.
- **OQ-2 (surface transfer; owner: operator; deadline: before any transfer ticket/API is authorized).** Is re-parenting a surface to a different principal ever allowed, or is a new surface always minted? §2.8 assumes immutable ownership; confirm. *Fail-closed default:* ownership is immutable (a transfer is a new surface), the strictest option.
- **OQ-3 (session-grant primitive; owner: operator + C2-8 ticket owner; deadline: before any durable-grant ticket is authorized).** Property 11 forbids "Allow for session" until a real canonical session-grant primitive is designed. Is that primitive in a FUTURE slice, or permanently out? *Fail-closed default:* one-shot only; the durable grant stays forbidden (lint literal, §10) until explicitly designed.
- **OQ-5 (approval/one-shot grant TTL values; owner: operator + C2-4/C2-8 ticket owners; deadline: before C2-4/C2-8 acceptance and R3 canary).** §3.9 proposes 15 minutes for `tool_approvals.expires_at`; §3.1 proposes 60 seconds for `GRANT_TTL_SECONDS`. Confirm both numeric TTLs (and whether surface-credential TTL, §2.4, has a default or is always explicit). *Fail-closed default:* finite 15-minute pending approval and 60-second one-shot grant windows; unset or unbounded values are invalid.
- **OQ-6 (socket-close on revocation; owner: operator + C1-3 ticket owner; deadline: before C1-3 acceptance).** §2.5 says revocation MUST be observable on next resume and SHOULD close live sockets with a `surface_revoked` reason. Is proactive socket-close in C1 scope, or deferred (revocation-on-next-resume only) for this slice? *Fail-closed default:* revocation-on-next-resume is guaranteed; proactive socket-close deferred.
- **OQ-8 (quantitative performance release thresholds; owner: operator + performance evidence owner; deadline: before runtime authorization or R3 canary).** What numeric p95/p99 latency, SQLite lock-wait, error-rate, and projection-lag thresholds gate canary and soak? *Fail-closed default:* no production rollout or default-on decision. The benchmark receipt MUST identify hardware, OS, Node and SQLite versions/pragmas, fixture size, concurrency, warmup, sample count, percentile method, raw measurements, and independently computed thresholds; a model-only timing estimate is not evidence.

---

## 13. Definition of done (for the eventual build, not this PRD)

A C1/C2 slice is DONE when: (a) unit + (b) reachability + (c) built-artifact proofs all pass for each control (§5); its module is removed from `DORMANT` in `reachability.mjs`; the guarded migration is proven independently against disposable copies of both physical databases; every relevant adversarial row (§7) and named negative mutation turns red when its control is sabotaged; flag-off logical byte-identity (SI-4) is proven; and the resulting evidence identifies the exact built artifact hash and preserves failures. Green units or a design-model probe alone are explicitly insufficient.

Revision 4 additions to the C2-1 migration DoD: prove the original `tool_approvals` table SQL, rowids, columns, rows, values, `args_json`, and status bytes are preserved while exactly six nullable columns are added; prove all live C0.1 objects/data and `skill_queue` are untouched; prove the seven gateway sidecars and two collab tables have the declared uniqueness/FK/nullability properties in their respective databases; crash-probe grant-last and deny-first recovery; prove no cross-database FK or atomic-commit assumption; and pass every §10.4 pre-gate extension. C2 exact-action completion additionally requires the real pre-tool execution hook, server-only source/dispatch request binding, current profile/delegation/registry/path rechecks, one-shot consumption, and—before FRONTIER support is claimed—a separately authorized Hermes structured-grant dependency with built-artifact proof.
