# PRD-TCLAW-COLLAB-GATEWAY-004 — Surface Identity (C1) + Approval Broker (C2)

- Status: **DESIGN ONLY — Revision 4 correction, 2026-08-11.** This full §1–§13 document is the canonical C1/C2 design contract. It incorporates the frozen rulings (identity≠capability≠AUTHORITY; CT-2 `approve` provisioning; H-1 operator-short-circuit subordination; `CTXHASH_V1`; Property-10 apply-time re-validation deferred to C3) and corrects the destructive migration proposal that was pushed in `3220157`. No C1/C2 runtime build is authorized by this document. No runtime source, TrustOS, governed-skill, GS, or paused-lane file is changed by this design lane.
- Scope: **C1 (Surface Identity) and C2 (Approval Broker) only.** C3/C4 and everything in §9 are out of scope.
- Frozen schema baseline: **`af52430a0d719c449a9379866b84c154fc3c3b8a`** (merge of PR #44, C0.1 authenticated identity transport, on `feat/collab-gateway-c1-c2`). The C0 principal bridge (`packages/gateway/src/principalBridge.ts`) landed at `da688c0`, which is **historical only** as a baseline ref — its CONTRACTS (§1.3) remain frozen and are not re-specified. The target is **strictly additive over `af52430`**, with no destructive exception (§1.5).
- **Build gate (operator sequencing, updated 2026-08-11): the governed-skill implementation lane is CLOSED.** GS-COORD shipped (`c824bcd`) and GS-ROLLBACK closed GS-ACCEPT finding F-1 at `39a7707` on 2026-08-10. The repository record reports the merged acceptance re-run as **9 passed / 1 xfailed** (the xfail is minor F-2, empty-body); this PRD does not carry an immutable test receipt, so a builder MUST re-derive that result from the active baseline rather than treat the count as proof. The remaining external gate before any C1/C2 RUNTIME surface is the operator's **soak → governed default-on** decision, followed by separate explicit C1/C2 runtime authorization. See §11 CT-4.
- Feature flag: `TORQCLAW_COLLAB_ENABLED`, read **per-call** (`collabEnabled()`), default **off**. Flag-off behavior is byte-identical to today, including the SEC-1 hole, per C0's rationale.
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
| Which surfaces may RECEIVE / DECIDE an approval; who decided | **Collab identity feeding a Gateway decision** | C2 records evidence in gateway-owned sidecars keyed to `tool_approvals` |

### 1.2.1 The load-bearing distinction — identity ≠ capability ≠ AUTHORITY (FROZEN, normative)

Operator ruling 2026-08-08 (frozen; do not re-litigate). Three layers are kept **structurally distinct**, each stored and checked separately. This is the spine of the C1/C2 security model and the reason `approve` can never be reached through the execution path.

| Layer | Question it answers | Contents | Storage / check seam |
|---|---|---|---|
| **Identity** | WHO / WHERE | `principal_id`, `surface_id`, `session_id`, `task_id`, task origin | collab `principals` + `surfaces` (C1); `sessions` (C0); recorded in the `gateway_approval_bindings` sidecar (§3.1) |
| **Execution CAPABILITY** | WHAT a surface may request/do | `read` / `write` / `exec` / `browser` — **mapped to the existing TORQCLAW execution profiles** `read_only` / `workspace_write` / `browser_research` / `terminal_power` | `surfaces.capability_json` consulted at the `authz.ts` seam (§2.7) |
| **Control-plane AUTHORITY** | WHICH control-plane DECISIONS a surface may make | `approve` (**frozen, reserved now**); `cancel`, `delegate` (**reserved for future**) | a **separate** authority store/check, NEVER the execution-capability path (§2.7.1, CT-2 §3.14) |

**Ruling AR-1 (frozen): `approve` is a reserved control-plane AUTHORITY token, not a tool/execution capability.** It is stored and checked separately from execution capabilities so it can **NEVER** be reached through the execution-capability path. A surface that holds `terminal_power` (or any execution profile) does not thereby hold `approve`. `approve` is frozen into the authority vocabulary as of this revision; `cancel` and `delegate` are reserved names for future authority primitives (each requiring its own threat model when introduced). This **clears C-3** and encodes **CT-2**.

**Vocabulary status:** the `approve` authority token is **RESOLVED and frozen** here. The fine-grained *execution-capability* vocabulary (does `capability_json` mirror `ClientCommand` action names or a coarser `read|write|exec|browser` set) remains open as the residual part of **OQ-1 (§12)** — but the `approve` authority question is no longer open. See §2.7.

**Hard constraints (each a FREEZE blocker if violated):**

1. The gateway `sessions` table is NOT replaced by `collab_session_bindings`. C0 already ruled this out (`principalBridge.ts` header, "WHAT THIS DELIBERATELY DOES NOT DO"). C1 EXTENDS `sessions.resolve()` / `assertResumeAllowed()`; it does not swap, archive, rename, or delete the live C0.1 store.
2. No second execution/event/receipt/approval state machine is created. `events` stays the append-only source of truth; `run_receipts` and the new `approval_deliveries` are **rebuildable, droppable projections** modeled on the `run_receipts` precedent (`schema.sql §9`, `ops/receipts-rebuild.mjs`). Approval lifecycle evidence uses the canonical `tool_approvals` row plus existing `events`; a new approval-event log FAILS review (§6.5).
3. The existing physical `tool_approvals` table and its rows stay canonical for approval state and exact action data. C2 adds exactly six nullable, guarded columns (§3.1); it does not rebuild the table, rewrite history, change rowids, or move approval truth into a sidecar or collab table.
4. Flag-off = documented legacy behavior, byte-for-byte, including the SEC-1 hole for pre-bridge sessions (C0 rationale: enabling a subsystem and changing security behavior are separate, individually-revertable decisions).

### 1.3 What C0 already established (do not re-specify)

- `PrincipalBinding { principalId, surfaceId }`; `SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`.
- `collabEnabled()` reads `TORQCLAW_COLLAB_ENABLED` per-call (never captured at import — the stale-`dist` trap).
- `resolvePrincipalBinding(frame)` → `null` when flag off or no identity; **throws** on a PARTIAL claim (principal without surface, or surface without principal).
- `assertResumeAllowed(owner, caller)`: `owner null` → allow (legacy); `caller null` + `owner set` → refuse; principals differ → refuse (**SEC-1**); principals match → allow **regardless of surface** (cross-surface resume is the whole point).
- `sessions.principal_id`, `sessions.surface_id` exist (nullable), populated on create by `sessions.resolve()`.
- Migration precedent: `storage.ts:107-111` — `PRAGMA table_info(sessions)` guarding `ALTER TABLE ... ADD COLUMN` because `CREATE TABLE IF NOT EXISTS` never re-runs on an existing DB.

### 1.4 Controlling invariant (Revision 4, FROZEN, normative)

A command may cause direct external work only when a server-derived `ConnectionAuthContext`, current gateway-owned auth epoch, current effective execution-capability/profile revision, current scoped authority, and **one unconsumed exact-action grant** all validate in the **same canonical `state.db` serialization interval immediately before `dispatch_started`**. The action digest must match the exact canonical `(request_id, tool_name, args_json)` approved. Revocation or capability narrowing that commits its gateway deny/revision first prevents dispatch; dispatch that commits first is durably recorded and is never automatically replayed.

Consequences pinned by this invariant:

- `ConnectionAuthContext` is **server-derived** (from bind-time credential validation, §2.6 step 2, then pinned to the current `gateway_surface_security` revisions in `gateway_session_auth`, §2.13) — never client-supplied and never trusted from a frame.
- The "one unconsumed exact-action grant" is a first-class record (`gateway_action_grants`, §3.1): a grant names one exact action for one approval, and consuming it is a durable write in the same serialization interval as the dispatch admission check. A consumed, revoked, expired, or absent grant ⇒ no dispatch.
- The revocation/dispatch race has exactly one legal outcome per side: whichever commits first wins, and the loser observes it. There is no window in which both a committed revocation and a subsequent automatic dispatch can hold.
- This invariant is the C2 counterpart of the gateway's existing no-replay discipline (`tool_approvals` first-decision-wins): decisions are never auto-replayed, and grants are never auto-reissued.
- `collab.db` and `state.db` are separate SQLite databases with separate WALs. This PRD claims no cross-database atomic transaction. Widening/provisioning commits identity/config in `collab.db` first and activates the gateway projection/authority **last**; interruption leaves the surface inactive. Revocation or narrowing commits the gateway deny/epoch/revision **first** and records the collab-side mutation second; interruption leaves dispatch denied. Recovery may finish revoke-side bookkeeping, but MUST NOT complete a partial grant or reverse a committed deny.

### 1.5 Revision 4 baseline boundary (strictly additive over `af52430`)

The target state is **strictly additive** over the `af52430` baseline. The physical `state.db` and `collab.db` remain separate. Every baseline table name, column, index, trigger, row, value, and live lookup remains available; in particular:

1. `tool_approvals` is altered in place with exactly six nullable, `PRAGMA table_info`-guarded columns. Its original rows, values, `args_json`, `status`, and SQLite `rowid` ordering are preserved.
2. `principals`, `principal_credentials`, `collab_session_bindings`, `collab_installation`, and `collab_schema_migrations` remain live in `collab.db`; C0.1 authentication and migration discovery continue to read them. No table is renamed, archived, copied as replacement, or deleted.
3. `skill_queue`, tasks, events, episodes, receipts, telemetry, and every unrelated object are data-untouched. Card/export redaction is a read-time projection; C1/C2 performs no blanket at-rest rewrite.

Flag-off makes every new table and column inert. Any irreversible historical erasure or C0.1 retirement is a separate, explicitly authorized future migration, not C1/C2.

---

## 2. C1 — Surface Identity

### 2.1 The four-layer model (identity concepts)

| Layer | Definition | Authority | Storage |
|---|---|---|---|
| **Principal** | WHO owns authority. The unit of trust. | Holds the full authority set. | collab `principals` (C0 substrate) |
| **Surface** | WHERE a principal acts (a device/channel/automation endpoint). | Holds a **SUBSET** of principal authority (capability grant). | `surfaces` (**C1, new**) |
| **Credential** | HOW a surface authenticates. | Proves a surface, not a principal. | `surface_credentials` (**C1, new**) |
| **Session** | Gateway execution + replay context. | Bound to `(principal_id, surface_id)` at create (C0). | `sessions` (C0 columns) + `gateway_session_auth` sidecar (§2.13) |

**Invariant SI-1:** a Surface belongs to exactly one Principal. A compromised Surface exposes only that Surface's capability subset, **never** the full principal authority (§2.7).

**Invariant SI-2:** each of `desktop, mobile, http, telegram, slack, automation` is a **surface kind**, not a principal. Adding a new device or channel adds a `surfaces` row, never a `principals` row. The schema accommodates all six kinds without any per-kind table.

### 2.2 Canonical Surface schema (new table in `collab.db`)

```sql
-- C1: a Surface is where one Principal acts. Belongs to exactly one principal.
-- Additive, guarded migration (see §6.2); NEVER re-specifies sessions/principals.
CREATE TABLE surfaces (
    surface_id        TEXT PRIMARY KEY,               -- SAFE_ID shape (C0 regex reused)
    principal_id      TEXT NOT NULL,                  -- owner; SAFE_ID shape
    surface_kind      TEXT NOT NULL CHECK (surface_kind IN
                        ('desktop','mobile','http','telegram','slack','automation')),
    surface_role      TEXT NOT NULL DEFAULT 'agent'    -- OPERATOR-KIND DISCRIMINATOR (§2.7.1):
                        CHECK (surface_role IN ('operator','agent','automation')),
    display_name      TEXT,                           -- NFC-normalized + trimmed (collab text.ts discipline)
    capability_json   TEXT NOT NULL DEFAULT '[]',     -- SUBSET of principal authority (§2.7)
    state             TEXT NOT NULL DEFAULT 'active'
                        CHECK (state IN ('active','revoked')),
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    revoked_at        DATETIME,
    last_seen_at      DATETIME,
    FOREIGN KEY (principal_id) REFERENCES principals(id),
    CHECK (surface_kind NOT IN ('telegram','slack','automation')
           OR surface_role != 'operator')
);
CREATE INDEX idx_surfaces_principal_state ON surfaces(principal_id, state);
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
CREATE TABLE surface_credentials (
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
CREATE INDEX idx_surface_credentials_surface_state ON surface_credentials(surface_id, state);
```

`credential_id PRIMARY KEY` and `secret_hmac UNIQUE` are load-bearing: the `tq1_<credentialId>` lookup resolves at most one row before constant-work verification, and a duplicate id or HMAC is rejected by SQLite. Negative DDL probes for both collisions are C1 acceptance evidence (§7, C1-2).

> **Note on `expires_at` (contradiction surfaced — see §11 CT-1):** the collab substrate PRD/lint *forbids* `expires_at` and `'expired'` because they were removed from the **`principal_credentials`** model. This `expires_at` lives on **`surface_credentials`** (a different, C1-new table) and on the approval-expiry seam (§3.9). These are distinct tables with a distinct product requirement (surface credential TTL, one-shot-approval TTL). Reviewer must confirm the surface/approval TTL is intended to reintroduce expiry at the SURFACE/APPROVAL layer while the PRINCIPAL-credential layer keeps its no-expiry ruling. Encoded here as an **explicit divergence**, not an oversight.

### 2.4 Expiration

- Surface **credential** expiry is `surface_credentials.expires_at` (NULL = non-expiring). At verify time, an expired credential returns `AUTH_FAILED` on the **same existence-oblivious path** as revoked/unknown (add the `expires_at <= now` check to the state gate that already turns `state != 'active'` into `AUTH_FAILED`, so cost stays constant).
- A Surface itself does not expire; only its credentials do. A surface with all credentials expired is unreachable but its capability record and audit trail persist (recovery, §2.9).

### 2.5 Surface revocation

- `REVOKE_SURFACE`: set `surfaces.state='revoked'`, `revoked_at=now`, and cascade `surface_credentials.state='revoked'` for that surface, in one `BEGIN IMMEDIATE` transaction (collab store atomic-protocol discipline).
- Post-revocation, any live session bound to that `(principal, surface)` MUST be refused on its next resume attempt (§2.6) and — design contract only — SHOULD have its socket closed with a `surface_revoked` close reason. (Socket-close wiring is builder work; the contract is: revocation is observable, not silently deferred.)
- Revocation is **not** the same as a different-principal refusal. A revoked surface belonging to principal A still fails as A's surface; SEC-1 (different-principal) remains a separate, stronger refusal.
- Under the §1.4 invariant, a revocation that COMMITS before a dispatch admission check wins: the check reads current scoped authority in the same serialization interval and refuses. A dispatch that committed first stands, durably recorded, never replayed.

### 2.6 Session binding (EXTEND sessions.resolve / assertResumeAllowed — do NOT replace)

C1 tightens the C0 resume path **without removing any C0 rule**. Today `sessions.resolve()` calls `resolvePrincipalBinding(frame)` then `assertResumeAllowed(owner, caller)`. C1 inserts a **surface-validity gate** between binding-resolution and the C0 principal check:

Ordered resume gate (all conditions evaluated in this order; first refusal wins):
1. `resolvePrincipalBinding(frame)` (C0) — throws on PARTIAL claim; `null` when flag off / no identity.
2. **C1 surface-validity:** if `caller` is non-null, verify the caller's presented credential via `verifyCredential` AND that `caller.surfaceId` resolves to an `active`, non-expired `surfaces` row owned by `caller.principalId`. Failure → `AUTH_FAILED` (existence-oblivious). *(This is new; C0 validated the shape of the binding, not that the surface still exists/authenticates.)* On success, the server derives the `ConnectionAuthContext` and records it in `gateway_session_auth` (§2.13) — this bind-time proof is what makes origin columns trustworthy downstream (H-2, §3.5).
3. **C0 `assertResumeAllowed(owner, caller)`** — unchanged: legacy-owner allow, caller-null refuse, SEC-1 principal-mismatch refuse, principal-match allow regardless of surface.

**Invariant SI-3 (C0 preserved):** cross-surface resume by the same principal still succeeds — step 3's "principals match → allow regardless of surface" is untouched. Step 2 only requires that the *presenting* surface is itself valid; it does not require it to be the *owning* surface. Barry on his phone (valid mobile surface) resuming his desktop session (owned by desktop surface) still works.

**Invariant SI-4 (flag-off byte-identity):** when `collabEnabled()` is false, `caller` is `null`, step 2 is skipped entirely, and the path is byte-identical to today (including the SEC-1 hole for legacy `owner==null` sessions).

### 2.7 Capability assignment (subset-of-principal authority)

- `collab.db.surfaces.capability_json` is a configured request: a JSON array of capability tokens (each `SAFE_ID`-shaped). The shipped `principals` table has no standalone capability set, so this PRD does not pretend a stored principal-capability superset exists. Gateway activation validates the request against the principal role plus the current effective profile/policy/registry contract, then writes only the allowed intersection to `gateway_surface_security`. It is not read across a second WAL during dispatch.
- **Enforcement point (design contract):** the gateway materializes the authorized subset as the **state-owned effective capability/profile revision** in `state.db.gateway_surface_security` (§2.13). `authz.ts` checks that effective set and revision *in addition to* the session `role`, not instead of it. A missing/stale projection or a surface lacking a capability is denied even if its principal holds it. Widening uses grant-last; narrowing/revocation uses deny-first (§1.4), so a cross-database partial failure never opens authority.
- `surfaces.capability_json` holds **execution capabilities only** — the `read` / `write` / `exec` / `browser` set mapped to the TORQCLAW execution profiles `read_only` / `workspace_write` / `browser_research` / `terminal_power` (§1.2.1). It **never** holds `approve` or any control-plane authority token; authority lives in a separate store (§2.7.1).
- **Open question OQ-1 (§12), narrowed:** the exact *execution-capability* vocabulary (does it mirror `ClientCommand` action names, or a coarser set like `read|write|exec|browser`?) remains an open design decision for the reviewer/operator. C1 fixes the *storage and enforcement seam*, not the vocabulary. The `approve` **authority** token is NOT part of this open question — it was frozen as a reserved authority in §1.2.1 (ruling AR-1).
- Fail-closed default: `capability_json` default `'[]'` = deny everything; an absent or revision-mismatched gateway effective projection also denies. Provisioning is an explicit grant.

### 2.7.1 Control-plane AUTHORITY store + H-1 operator short-circuit subordination (FROZEN, normative)

**Separate authority, separate store.** Control-plane authority (`approve`, and the reserved `cancel`/`delegate`) is held on a **distinct authority store** for the surface — the new **`surface_authorities`** table, NOT in `surfaces.capability_json`. The authorization check for `APPROVE_TOOL` reads the surface's held **authority**, never its execution capability set (§1.2.1, ruling AR-1). This is what makes "reachable only through the authority path" structurally true rather than a naming convention.

**Concrete authority store — `state.db.surface_authorities` (NEW C1 table, gateway-owned).** A dedicated table (chosen over a `surfaces.authority_json` column) gives each high-sensitivity grant a clean, indexable, individually-revocable audit grain. **Owner: gateway.** The authorization read and the effective surface/profile revision are therefore in the same `state.db` transaction as the approval decision. Collab owns configured identity; gateway owns effective execution and control-plane authority. Provisioning across the databases follows grant-last, and revocation follows deny-first (§1.4, §6.2).

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
  - `grantAuthority(surfaceId, authority)` — provisioning-time write; **refuses** unless the current gateway projection is live and, for `approve`, both the configured kind and effective role satisfy CT-2. It inserts a new ledger row at the current auth epoch; a live duplicate is an explicit refusal, not a silent no-op.
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
- No `sessions` schema change is needed by C1 — C0 already added `principal_id`/`surface_id`. The Revision 4 auth evidence lives in the `gateway_session_auth` sidecar (§2.13), never in new `sessions` columns.
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

### 2.13 Revision 4 gateway security projection + session-auth sidecar (NEW, gateway-owned)

The baseline `sessions` table and the live C0.1 store stay unchanged (§10.3). `collab.db` remains identity/config truth; `state.db.gateway_surface_security` is the fail-closed gateway enforcement projection used to avoid a cross-WAL authorization read. Missing or stale projection state denies.

```sql
-- C1: gateway-owned effective authorization projection. It is not a second
-- identity registry; activation is grant-last and denial/epoch change is deny-first.
CREATE TABLE IF NOT EXISTS gateway_surface_security (
    surface_id                    TEXT PRIMARY KEY,
    principal_id                  TEXT NOT NULL,
    surface_role                  TEXT NOT NULL
                                    CHECK (surface_role IN ('operator','agent','automation')),
    state                         TEXT NOT NULL DEFAULT 'revoked'
                                    CHECK (state IN ('active','revoked')),
    auth_epoch                    INTEGER NOT NULL CHECK (auth_epoch > 0),
    effective_capability_json     TEXT NOT NULL DEFAULT '[]',
    effective_capability_revision TEXT NOT NULL,
    profile_delegation_json       TEXT NOT NULL DEFAULT '[]',
    profile_revision              TEXT NOT NULL,
    source_identity_revision      TEXT NOT NULL,
    activated_at                  DATETIME,
    revoked_at                    DATETIME
);
```

This row is the **state-owned effective capability/profile revision**. It records the effective capability set and profile delegation the gateway is willing to honor, not merely the collab-configured request. Widening becomes effective only when this row is activated last. Narrowing increments the relevant revision or revokes the row first. Connect, resume, decision, and dispatch all require the current row, principal, role, epoch, effective capability revision, and current profile delegation revision to match.

The server-derived `ConnectionAuthContext` (§1.4) is then recorded in a gateway-owned sidecar keyed by session id:

```sql
-- Revision 4: per-session server-derived auth evidence. Baseline `sessions` is
-- untouched; this sidecar is the ConnectionAuthContext record the §1.4 invariant
-- validates. Written ONLY by the bind-time gate (§2.6 step 2); never client-supplied.
CREATE TABLE IF NOT EXISTS gateway_session_auth (
    session_id        TEXT PRIMARY KEY,               -- = sessions.id
    principal_id      TEXT NOT NULL,
    surface_id        TEXT NOT NULL,
    credential_id     TEXT NOT NULL,                  -- the credential proven at bind (§2.6 step 2)
    auth_epoch        INTEGER NOT NULL,
    capability_revision TEXT NOT NULL,
    profile_revision  TEXT NOT NULL,
    auth_context_json TEXT NOT NULL,                  -- server-derived ConnectionAuthContext evidence
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    closed_at         DATETIME,
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    FOREIGN KEY (surface_id) REFERENCES gateway_surface_security(surface_id)
);
```

- Authoritative session evidence: it records WHO/WHERE was proven at bind time and the gateway revisions observed then. The §1.4 admission transaction compares it with the live `gateway_surface_security` row; the session row alone can never keep stale authority alive.
- Flag-off: never written, never read (SI-4 holds).

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
```

`status` may now be written as `'expired'`; the shipped table has no status CHECK to replace. No migration changes historical `status` or `args_json`. The canonical `args_json` remains the exact action payload used by the existing approval/mint path; cards, exports, logs, and channel/browser responses receive only a generated bounded/redacted view (§3.10). Historical at-rest erasure is outside C1/C2.

The additive C2 state tables below contain binding/grant material but no approval state:

```sql
-- Immutable registration facts only. No status and no decision fields.
CREATE TABLE IF NOT EXISTS gateway_approval_bindings (
    approval_id       TEXT PRIMARY KEY,
    request_id        TEXT NOT NULL,
    session_id        TEXT NOT NULL,
    credential_id     TEXT NOT NULL,
    auth_epoch        INTEGER NOT NULL,
    action_hash       TEXT NOT NULL,
    registration_context_hash TEXT NOT NULL,
    profile_revision  TEXT NOT NULL,
    privacy_revision  TEXT NOT NULL,
    registered_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (approval_id) REFERENCES tool_approvals(approval_id),
    FOREIGN KEY (request_id) REFERENCES tasks(request_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Reserved for NEW protected payloads only after OQ-7 receives explicit approval.
-- The C1/C2 migration creates this empty; it never rewrites legacy args_json into it.
CREATE TABLE IF NOT EXISTS gateway_approval_payloads (
    approval_id       TEXT PRIMARY KEY,
    ciphertext        BLOB NOT NULL,
    key_reference     TEXT NOT NULL,
    payload_digest    TEXT NOT NULL,
    retention_expires_at DATETIME NOT NULL,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (approval_id) REFERENCES tool_approvals(approval_id)
);

-- One exact-action, one-shot grant created only by the winning APPROVE transaction.
CREATE TABLE IF NOT EXISTS gateway_action_grants (
    grant_id          TEXT PRIMARY KEY,
    approval_id       TEXT NOT NULL UNIQUE,
    request_id        TEXT NOT NULL,
    tool_name         TEXT NOT NULL,
    action_hash       TEXT NOT NULL,
    context_hash      TEXT NOT NULL,
    auth_epoch        INTEGER NOT NULL,
    capability_revision TEXT NOT NULL,
    profile_revision  TEXT NOT NULL,
    expires_at        DATETIME NOT NULL,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    consumed_at       DATETIME,
    revoked_at        DATETIME,
    FOREIGN KEY (approval_id) REFERENCES tool_approvals(approval_id),
    FOREIGN KEY (request_id) REFERENCES tasks(request_id)
);
```

**Canonical row shapes (normative):** a newly registered `pending` row has non-null `origin_*` and `expires_at`; its `decided_*`, `decided_at`, and `context_hash` remain null and it has no grant. The winning `approved` or `rejected` decision atomically writes non-null `decided_*`, `decided_at`, and `context_hash` with the guarded status transition; only `approved` creates exactly one grant. An `expired` row retains origin/expiry, keeps `decided_*`, `decided_at`, and `context_hash` null, and has no grant. Pre-C2 rows remain valid without fabricated values.

**Single-writer requirement (M-1/M-2, normative).** Because there is **no DDL CHECK** on `tool_approvals.status`, the four-value enum (`pending|approved|rejected|expired`) has exactly **one centralized writer**. The existing `decideApproval` module owns both decision transitions and the expiry transition. Decision uses the guarded pending UPDATE and writes the canonical `decided_*`, `decided_at`, and `context_hash` in the same transaction. Expiry uses `UPDATE tool_approvals SET status='expired' WHERE status='pending' AND expires_at<=now`; it writes no decision evidence and creates no grant. Decision and expiry race through the same `state.db` writer transaction: the first commit wins, and the loser changes zero rows. No other code path may update approval status.

The absence of a table CHECK is therefore a code-audit and mutation-test obligation. By contrast, new `approval_deliveries` keeps its DDL CHECK on projection-only `delivery_state` because a fresh table can carry that constraint from first ship.

### 3.2 What collab identity decides (and what it does not)

Collab/Surface identity supplies four *inputs* to a gateway-owned decision:
- which surfaces may **RECEIVE** an approval card (delivery targeting, §3.13);
- which surfaces may **DECIDE** it (authorization, property 2);
- which **principal+surface** decided (evidence, property 7);
- where the **originating task** came from (the server-owned task/session context, recorded directly in canonical `tool_approvals.origin_*` at `registerApproval`; immutable exact-action facts are bound in `gateway_approval_bindings`, while baseline `tasks` stays untouched).

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
| 8 | Approval cards get bounded/redacted arg summaries only | The card carries a generated bounded/redacted summary — never raw `args_json`. Reuse the export redactor discipline (`export.ts`): allowlist projection, scrub-then-cap, honest "known secret shapes removed" language. Historical and go-forward exact action data remain unchanged in canonical `args_json`; C1/C2 adds no unprotected copy and performs no blanket at-rest rewrite. | read-time redactor |
| 9 | Approval EXPIRES rather than staying actionable | New rows receive finite `expires_at`. APPROVE requires `status='pending' AND expires_at>canonical_now`; expiry uses `UPDATE ... WHERE status='pending' AND expires_at<=now` in the same centralized writer. A flag-on legacy row with NULL expiry/binding is inert and must be reissued, never silently actionable. | canonical writer + TTL |
| 10 | Approval bound to execution context; changed policy/profile/privacy INVALIDATES a stale approval | **C2 registration→decision:** registration stores a `registration_context_hash` in the immutable binding; decision recomputes it, refuses/expires on mismatch, then stores `tool_approvals.context_hash` as decision evidence. **C2 decision→dispatch:** apply remains synchronous and the §1.4 fence rechecks current epoch/profile/security. **C3:** live re-validation across a future asynchronous decision-delivery→apply seam remains deferred. | C2: registration/decision comparison + decision evidence. **C3: async apply re-check (deferred)** |
| 11 | No "Allow for session" unless a real session-grant primitive exists | Default C2 contract is **one-shot** (`gateway_action_grants.approval_id UNIQUE` — one grant per approval, consumed once). A durable "allow for session" grant is explicitly NOT designed here (OQ-3, §12); UIs must not offer it. | contract + lint literal |
| 12 | Path/profile/security restrictions remain authoritative AFTER approval | Approval grants the exact action; it never bypasses path allowlists, privacy restrictions, policy hash, registry version, or the **current profile delegation**. The synchronous admission fence rechecks the live effective capability/profile revision and downstream restrictions before consuming the grant. | §1.4 transaction + dispatch re-check |

### 3.4 Context binding — `CTXHASH_V1` (C2 registration→decision check; C3 async apply check)

Two operator rulings 2026-08-08 (frozen) govern this section: (a) **OQ-4 is closed** — the context input set and byte serializer are normative; and (b) **Property-10 / C-1** — C2 decision→dispatch stays SYNCHRONOUS, while live re-validation across a future asynchronous decision-delivery→apply seam is DEFERRED to C3. The correction adds the missing C2 registration→decision comparison without inventing an async apply seam.

#### 3.4.1 Canonical `context_hash` input set (FROZEN, normative — clears C-2, closes OQ-4)

`tool+args` alone is TOO WEAK: a TORQCLAW task resolves to an **execution profile** that governs capabilities, tier, path, network, and approval-requirement, so an approval must bind to the resolved profile and privacy context, not merely the tool name. The `context_hash` is computed over **exactly** the following inputs, and **only** these, in a **pinned canonical order** (the order below is the canonical order):

1. **Principal identity** — `origin_principal_id`.
2. **Surface identity** — `origin_surface_id`.
3. **Task identity** — the originating task id.
4. **Task origin** — the origin surface kind / provenance of the blocked task.
5. **Resolved execution profile** — the profile the task resolved to (`read_only` / `workspace_write` / `browser_research` / `terminal_power`), which fixes capabilities/tier/path/network/approval-requirement.
6. **Requested capability / tool** — the tool grant unit (`tool_name`).
7. **Canonical tool arguments** — the **canonical-JSON** form of the arguments (the SAME canonical-JSON serialization already used for idempotency; not free-text, not re-ordered).
8. **Privacy / security context** — the active privacy/redaction posture.
9. **Routing / tier context** — the selected routing/tier context.
10. **Relevant policy revision** — the identifier/revision of the governing policy (path allowlist identity + policy version).

The hash is computed over exactly these ten inputs in this pinned canonical order. **Free-text prompt is deliberately EXCLUDED** (a reworded prompt is not a policy change). This input set is **normative and closed** — it is no longer an open question.

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
- **Encoding:** each field `fN` is its **UTF-8 bytes**. For fields already having a canonical form, that canonical form is what is UTF-8-encoded: field 7 (tool arguments) is the existing **canonical-JSON** serialization (the same one used for idempotency), NOT re-serialized; fields that are enums/ids (profile, tool name, principal/surface/task ids, policy revision id) are their exact stored string; a NULL/absent field is encoded as a zero-length value (`U32BE(0)` with no bytes), which is distinct from an empty string only in that both hash identically — absence and empty are treated as the same zero-length slot by design.
- **Length framing:** each field is preceded by its length as a 4-byte big-endian unsigned integer (`U32BE`). Length-prefix framing (not a delimiter) makes the encoding injective: no field value can forge a field boundary, so `("ab","c")` and `("a","bc")` hash differently.
- **Hash:** SHA-256 over the whole byte stream; the stored `context_hash` (§3.1) is the lowercase-hex digest.

Two independent implementations that agree on the ten field VALUES will produce byte-identical `context_hash_input` and therefore an identical digest. This is what makes C2-5's "independently reproducible" AC mechanically checkable.

**Why adversarial test A9 passes BECAUSE of this set:** A9 changes the profile and/or privacy posture between request and apply. Because **resolved execution profile (5)** and **privacy/security context (8)** are inputs to the hash, any such change produces a different `context_hash`, so the mismatch is detectable by construction. A9 cannot be defeated by a tool/args-only hash — that is exactly the weakness this frozen set removes. (A9 is a **C3** acceptance test — see §3.4.3.)

#### 3.4.2 C2 behavior — registration may wait; decision→dispatch stays SYNCHRONOUS

**Ruling (frozen): in C2 there is no asynchronous decision-delivery→apply gap.** That does not erase the real request/registration→decision wait: an approval may remain pending while profile, policy, registry, routing, privacy, or surface state changes. C2 closes that existing gap as follows:

1. Registration computes `CTXHASH_V1` over the frozen request context and stores it as `gateway_approval_bindings.registration_context_hash`; canonical `tool_approvals.context_hash` remains null while pending.
2. The centralized decision writer resolves the **current** ten inputs and recomputes the digest. A mismatch refuses approval (or atomically expires the still-pending row with an explicit context-invalidated reason); it writes no decider evidence and creates no grant.
3. A match permits the guarded decision transaction to write canonical `decided_*`, `decided_at`, and `context_hash`, with an exact-action grant only for APPROVE.
4. Immediately before `dispatch_started`, the §1.4 transaction rechecks current gateway epoch, effective capability/profile delegation revision, exact action digest, expiry, authority, and downstream path/privacy restrictions before consuming the grant.

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

- **3.5 (prop 1 detail):** "self-approve" is defined structurally: a DECIDE whose current deciding surface equals `origin_surface_id` and is channel/automation is refused. Positive authority never requires origin equality: a **different-origin authorized operator** surface may decide when its current connection/epoch is valid, it has a live `approve` row, and existing resource/task `authz` permits it. Channel/automation surfaces fail both the kind/role gate and the authority lookup.
  - **Dependency H-2 (frozen): property 1 origin-trust depends on the C1-5 bind-time surface-validity gate.** Property 1 reasons over `origin_surface_id`. That record is only **trustworthy** if the presenting credential was validated at connect/bind time — otherwise a surface could present a forged/unvalidated `origin_surface_id` and the "channel-originated" classification would be spoofable. The C1-5 resume/bind surface-validity gate (§2.6 step 2), whose proof is durably recorded in `gateway_session_auth` (§2.13), is what establishes that `origin_surface_id` was proven at connect. **Therefore C2-3 (prop 1 enforcement) explicitly DEPENDS ON C1-5 being landed first** (recorded in the ticket decomposition, §8).
- **3.6 (prop 2 detail):** origin fields are written on canonical `tool_approvals` at registration from the blocked task's server-owned session context; the current deciding connection supplies canonical decision fields inside the winning transition. The positive predicate never binds current connection identity to origin identity. **Origin independent of Authority** is tested with a different-origin authorized operator success case plus cross-channel/non-operator negatives.
- **3.7 (props 3+4):** the existing atomic pending guard remains the core. C2 widens the same transaction to write canonical decision evidence and, for APPROVE only, one grant. Tests prove two simultaneous decisions or decision-vs-expiry yield exactly one terminal transition and never a second evidence tuple or grant.
- **3.8 (prop 5):** `approval_deliveries` writer is separate from `decideApproval`; a delivery insert/ack failure path has no code route to `tool_approvals.status`.
- **3.9 (prop 9 TTL):** new registrations receive a finite TTL (proposed 15 minutes — value is **OQ-5, §12**) from one canonical clock. APPROVE/REJECT requires `status='pending' AND expires_at>canonical_now`; the same writer materializes expiry via `UPDATE ... WHERE status='pending' AND expires_at<=now`. First commit wins. Expired rows have null decision/context evidence and no grant. Under the flag, legacy NULL-expiry or missing-binding rows are inert and return reissue-required; migration does not mutate them.
- **3.10 (prop 8 redaction):** the gateway produces card/export summaries at read time, reusing `export.ts` redactor primitives; honest language only ("known secret shapes removed"), never "safe". Exact legacy and go-forward `args_json` remains canonical and unchanged. `gateway_approval_payloads` remains empty until OQ-7 approves an encryption/key/retention mechanism for newly registered payloads; C1/C2 never creates an unprotected second copy or rewrites history.
- **3.11 (prop 11):** one-shot is the only grant C2 ships (`gateway_action_grants`, one consumable row per approval). **Prohibition statement (normative):** "Allow for session" is PROHIBITED as a shippable grant option — it MUST NOT appear as a grant type in any UI, config, or grant-type enum — until a real canonical session-grant primitive is separately designed (OQ-3, §12). The §10 pre-gate lints this prohibition in two directions: the implementation/config surface must not contain the string, and THIS PRD must contain this prohibition statement (§10, corrected).
- **3.12 (prop 12):** the re-minted `GatewayRequest` still passes through `dispatch.ts` path/profile/privacy gates. Approval widens exactly one action and disables nothing else. The §1.4 transaction recomputes the action digest and requires current auth epoch, **current profile delegation**, effective capability/profile revisions, authority, expiry, and an unconsumed/unrevoked grant before dispatch.

### 3.13 Durable delivery projection `approval_deliveries` (NEW — projection, NOT truth)

Modeled **exactly** on `run_receipts` (`schema.sql §9`): a derived, rebuildable, droppable read-cache. It is never the only copy of anything and can be rebuilt from `tool_approvals` (+ session/surface routing) at any time.

```sql
-- C2: durable delivery PROJECTION. NOT approval truth. Rebuildable from
-- tool_approvals (+ routing). Droppable — modeled on run_receipts (schema §9).
-- A row here NEVER authorizes or represents an approval decision.
CREATE TABLE approval_deliveries (
    id                TEXT PRIMARY KEY,               -- randomUUID, projection row id
    approval_id       TEXT NOT NULL,                  -- = tool_approvals.approval_id
    target_surface_id TEXT NOT NULL,                  -- surface the card was routed to
    delivery_state    TEXT NOT NULL DEFAULT 'pending' -- pending | delivered | acked | failed
                        CHECK (delivery_state IN ('pending','delivered','acked','failed')),
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (approval_id) REFERENCES tool_approvals(approval_id)
);
CREATE INDEX idx_approval_deliveries_approval ON approval_deliveries(approval_id);
CREATE INDEX idx_approval_deliveries_target_state
    ON approval_deliveries(target_surface_id, delivery_state);
```

- A `rebuild` script (analogous to `ops/receipts-rebuild.mjs`) MUST be able to drop and regenerate the **current actionable delivery view** from canonical pending approvals plus current eligible operator surfaces, with no loss of approval truth. Historical transport attempts/acks are observability only and need not reproduce byte-identically; they cannot authorize a decision.
- Reconnect (property 6): on operator-surface reconnect, undelivered/`pending` approvals are re-projected and re-offered; the delivery projection tracks best-effort delivery, the `tool_approvals` row remains the truth.

### 3.14 CT-2 — `approve` authority provisioning rule (FROZEN, normative)

Operator ruling 2026-08-08 (frozen; clears H-3, encodes CT-2). This is the provisioning + enforcement counterpart to the authority/capability split (§1.2.1) and the H-1 subordination (§2.7.1).

**Ruling CT-2 (frozen): the `approve` authority is grantable ONLY to operator-kind surfaces.**
- **Operator-kind predicate (FROZEN, mechanically checkable):** a surface is operator-kind **iff `surfaces.surface_role = 'operator'`** (§2.2, §2.7.1). This is the single normative predicate; it is NOT inferred from `surface_kind`. CT-2's provisioning and decision checks both evaluate this exact column, so "operator surface vs other desktop/http surface" is deterministic, not a judgement call.
- **Grantable to:** operator-kind surfaces only — surfaces with `surface_role = 'operator'` (the operator's own control-plane surfaces; typically provisioned on `desktop`/`http` kinds, but membership is decided by `surface_role`, never by kind alone).
- **NEVER grantable to:** any surface with `surface_role ∈ ('agent','automation')` — this includes every `channel` or `automation` surface (`telegram`, `slack`, `automation`, and any future channel kind), which can never carry `surface_role = 'operator'`. Provisioning `approve` onto a non-operator-role surface is a **provisioning-time FAILURE**, not a silent grant.
- **Cross-channel approval is forbidden.** A decision presented from a channel/automation surface can never carry `approve` authority regardless of which principal owns it.
- **Default is fail-closed:** no surface holds `approve` unless explicitly and validly provisioned; a mis-provisioned or unspecified surface holds **no authority** (mirrors the `capability_json` deny-all default, §2.7).

**Two enforcement points (both required):**
1. **Provisioning time:** `grantAuthority(surfaceId, 'approve')` (§2.7.1) refuses unless `surfaces.surface_role = 'operator'`. A surface with `surface_role ∈ ('agent','automation')` can never come to hold an `approve` row in `surface_authorities`.
2. **Decision time:** `authz.ts` (post-H-1 subordination, §2.7.1) calls `holdsAuthority(surfaceId, 'approve')` — a live `surface_authorities` row with `revoked_at IS NULL` — before any `APPROVE_TOOL` transition. Belt-and-suspenders: even if provisioning were subverted, the decision-time check still refuses a surface with `surface_role != 'operator'` (this is also property 1, §3.5).

**If autonomous approval is ever needed** (e.g. a trusted automation approving low-risk tools), it is a **NEW authority primitive with its own threat model** — designed separately, never reached by incidentally widening a surface's execution capability or by relaxing this rule. Rationale (operator): TORQCLAW already treats approval as unusually sensitive — `APPROVE_TOOL`, approval-history, receipts, and cost are operator-only; approval history is operator-only because it leaks gated tool names + decision timing. CT-2 keeps that narrow posture intact while C2 adds identity evidence around it.

> **Relationship to CT-2 in §11:** §11's CT-2 flagged that capability-gated approval is a *widening* the reviewer must ratify. This ruling **resolves that**: approval authority is widened only to the extent that `approve` is now an explicit reserved authority provisioned to operator-kind surfaces — it is NOT opened to channel/automation surfaces or to role-only grants. The widening the reviewer ratifies is bounded by this rule.

---

## 4. Source-of-truth matrix

| Concept | Authoritative owner / table | Projection / cache | Notes |
|---|---|---|---|
| Principal identity | `collab.db.principals` + live C0.1 tables | — | C0 substrate remains live and unchanged |
| **Surface identity/configuration** | **`collab.db.surfaces` (C1)** | — | globally unique immutable owner; identity/config truth |
| **Surface credential (HMAC)** | **`collab.db.surface_credentials` (C1)** | — | globally unique id/HMAC; plaintext never stored |
| **Configured surface capability** | **`collab.db.surfaces.capability_json` (C1)** | — | requested configuration, never a dispatch-time cross-WAL read |
| **Effective surface capability/profile** | **`state.db.gateway_surface_security` (C1)** | identity-derived enforcement state | state-owned effective capability/profile revision; missing/stale denies |
| Session (execution/replay) | `state.db.sessions` (C0 columns) | — | NOT replaced by collab bindings |
| **Session auth evidence (`ConnectionAuthContext`)** | **`state.db.gateway_session_auth` (C1, §2.13)** | — | server-derived and revision-pinned; C0.1 remains live |
| **Approval authority (who may decide)** | **`state.db.surface_authorities` (C1)** | — | live current-epoch `approve` ledger row; never execution capability |
| Execution status / events | `state.db.tasks` / **`state.db.events`** | `run_receipts` | existing event source of truth; no new lifecycle log |
| **Approval STATE + exact action** | **`state.db.tool_approvals` (canonical)** | read-time redacted card/export | original table/rows/rowid/args retained; six nullable additions only |
| **Approval origin** | **`tool_approvals.origin_*`** | — | written at registration from server-owned session context |
| **Immutable registration binding** | **`state.db.gateway_approval_bindings`** | — | task/session/action/context facts only; no status or decision fields |
| **Decision evidence** | **`tool_approvals.decided_*`, `decided_at`, `context_hash`** | — | same canonical transaction as the winning status UPDATE |
| **Action grant (one-shot consumption, §1.4)** | **`state.db.gateway_action_grants`** | — | exact action + revisions; consumed durably at admission |
| **Approval expiry** | **`tool_approvals.status='expired'` + `expires_at`** | — | centralized writer; expired has null decision/context and no grant |
| **Protected new payload (conditional)** | **`gateway_approval_payloads` only after OQ-7 approval** | read-time redacted card/export | empty by default; no legacy rewrite or unprotected second copy |
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
| Resume surface gate (§2.6 step 2) | step-2 refusal fixtures; `gateway_session_auth` written on success | reached from `sessions.resolve` | booted dist enforces gate with flag on |
| First-decision-wins + evidence (props 3,7) | concurrent decide/expiry → one canonical transition, one evidence tuple, at most one grant | reached from `APPROVE_TOOL` handler and centralized expirer | booted dist records canonical evidence |
| Channel self-approve prevention (prop 1) | channel/automation `decided_surface_id`==`origin_surface_id` refused; channel surface holds no `approve` authority | refusal reached from the `APPROVE_TOOL` authority check (post-H-1 seam, §2.7.1) — depends on C1-5 origin-trust | **booted dist refuses channel self-approve** (channel surface cannot decide its own originated task on a live artifact) |
| Post-approval path/profile re-check (prop 12) | re-minted GatewayRequest still hits `dispatch.ts` path/profile/privacy gates; approval widens only `grantedTools=[tool_name]`; grant row consumed durably (§1.4) | re-check reached on the re-mint/dispatch path from `server.ts:196-202` | **booted dist re-checks path/profile/privacy after approval** (a booted artifact still denies a path/profile-violating tool even once approved) |
| Context binding (§3.4.1, prop 10 **C2 part**) | registration digest stored; decision recomputes current digest, rejects mismatch, stores canonical evidence only on a winner | reached from register + `APPROVE_TOOL` paths | booted dist rejects registration→decision drift and writes winning `context_hash` |
| Context invalidation (§3.4.3, prop 10 **C3 part — DEFERRED**) | context mismatch → explicit failure | reached from async apply/re-mint path (C3) | booted dist fails loudly on stale apply (C3) |
| Delivery projection rebuild (§3.13) | rebuild yields identical delivery view | rebuild script reachable | rebuild runs against booted DB |
| Revision 4 migration (§1.5, §3.1) | six guarded nullable columns; original `tool_approvals` table/rowid/rows/values/args/status preserved; C0.1 + `skill_queue` untouched | migration runs from the real startup path | booted dist over separate migrated DB copies preserves legacy flag-off artifacts and denies missing/stale gateway projections |

---

## 6. Cross-cutting requirements

### 6.1 Feature-flag rollout strategy
- `TORQCLAW_COLLAB_ENABLED`, read **per-call** via `collabEnabled()` (never captured at import — stale-`dist` trap, `principalBridge.ts:64-73`). Flag-off = documented legacy behavior, byte-identical (SI-4).
- Flags are additive and independently revertable: turning the flag off backs out C1/C2 wiring without also silently changing any OTHER security posture. (C0's exact rationale for why closing SEC-1 was bundled behind the same flag rather than shipped unconditionally.)

### 6.2 DB migration strategy (additive, nullable, guarded — with two bounded Revision 4 exceptions)
- All new tables via `CREATE TABLE IF NOT EXISTS`.
- Every column added to an *already-shipped* table via `PRAGMA table_info(<table>)` guard before `ALTER TABLE ... ADD COLUMN`, following `storage.ts:107-111` verbatim (the C0 lesson).
- **IF NOT EXISTS trap (explicit):** an existing DB never re-runs `CREATE`, so it will never pick up new columns from an edited `CREATE`; new columns are ALWAYS nullable + `ALTER`-guarded.
- All new columns nullable so a legacy DB migrates without backfill and pre-C2 rows stay valid.
- **Revision 4 exceptions (versioned, one-shot, §1.5 / §11 CT-5):** (1) the `tool_approvals` compatible REBUILD (every original column and id retained; historical `args_json` → `REDACTED_LEGACY_ARGS_V4`); (2) the C0.1 auth-table ARCHIVE (`c01_archive_` prefix; live names removed; auth denied until explicit reprovision). Both run exactly once under a recorded migration id; everything else stays additive/guarded. A migration that cannot prove column/id preservation FAILS closed and leaves the baseline untouched.

### 6.3 Reachability-gate requirements
- No C1/C2 module ships as an orphan. Each slice removes itself from `DORMANT` in `reachability.mjs` as it gains a real entry point (§5(b)).

### 6.4 No secret-bearing browser/channel credentials
- Surface tokens are `tq1_` bearer secrets and MUST NOT be embedded in browser/channel client code or shipped to a channel adapter as a static secret. Only the HMAC is stored server-side; the plaintext is shown once at issuance. Browser/PWA surfaces obtain credentials through issuance flows, never baked-in secrets. (Design contract; adapter implementations are C3, out of scope.)

### 6.5 No second execution/event/receipt authority
- Restated as a gate: any design that introduces a parallel event log, a second approval state table, or a collab-owned execution status FAILS review. `events` stays the single append-only source of truth. `gateway_approval_events` (§3.1) is bounded to per-approval lifecycle evidence; generalizing it into an event stream trips this gate.

### 6.6 Rollback behavior
- Flag-off is the primary rollback (§6.1). Tables remain (additive, inert). Dropping `approval_deliveries` is safe by design (projection).
- **Revision 4:** the compatible rebuild and the C0.1 archive are one-shot migrations, not flag-revertable — their rollback story is the migration's own fail-closed guarantee (§6.2: no proof of preservation ⇒ baseline untouched) plus the pre-migration DB backup. The archive itself preserves the C0.1 history it removes from live names.

### 6.7 Observability
- Metrics/audit for: surface issuance/revocation counts, credential verify outcomes (bucketed as AUTH_FAILED only — never leak hit/miss distinction, mirroring collab rate-limit privacy), approvals by state incl. `expired`, grant consumption/revocation outcomes (§1.4), context-invalidation events (property-10 failures are a first-class observable), delivery projection rebuild runs, Revision-4 migration completion (one-time, with counts of rows preserved/archived/redacted).

### 6.8 Operator-facing failure states
- Enumerated and honest: `AUTH_FAILED` (surface invalid/revoked/expired — existence-oblivious), SEC-1 refusal (different principal), capability-denied, authority-denied, approval-expired, grant-consumed / grant-revoked (§1.4 — an attempted dispatch on a consumed or revoked grant is an explicit refusal, never a silent no-op), **approval-context-invalidated** (property-10, explicit — never a silent no-op; C3), delivery-failed (projection state, never an approval state), reprovision-required (an archived C0.1 credential presented post-migration).

### 6.9 Progressive disclosure in eventual UI contracts (contract only; UI out of scope)
- Approval cards expose bounded/redacted summaries first, with the authoritative full receipt reachable via existing `GET_RECEIPT` (operator-only). The UI itself, WCAG, and PWA are out of scope (§9). Only the DATA contract the UI would consume is specified here.

---

## 7. Adversarial scenario matrix

**Slice-tag semantics (normative).** Each row carries a **Slice** tag (C1 / C2 / C3). **Only rows tagged for the CURRENT slice are acceptance gates for that slice**; rows tagged for a later slice are **forward-looking coverage** recorded now for completeness, not acceptance tests for the current slice. In particular **A9 is tagged C3** and is explicitly NOT a C2 acceptance test (§3.4.2/§3.4.3): C2 apply is synchronous, so the stale-apply window A9 attacks does not exist until C3 introduces async/offline delivery. This matrix is therefore an adversarial *scenario* matrix, not a flat "every row is a required test of every slice" list.

| # | Slice | Scenario | Setup | Attack | Required outcome |
|---|---|---|---|---|---|
| A1 | C1 | Cross-principal resume | Session owned by principal B; A holds a valid surface | A presents A's credential + B's `sessionId` | Refuse (SEC-1, C0 step 3). No resume. |
| A2 | C1 | Revoked surface reconnect | Surface revoked, token still known | Reconnect with old token | `AUTH_FAILED`, existence-oblivious (§2.6 step 2). |
| A3 | C1 | Expired credential reconnect | Credential `expires_at` in past | Reconnect | `AUTH_FAILED`, same path as A2. |
| A4 | C2 | Channel attempts APPROVE_TOOL | Channel-role/surface session | Send `APPROVE_TOOL` | Deny (`authz.ts` default-deny; prop 1). No state change. |
| A5 | C2 | Unauthorized operator surface approves | Operator principal, surface lacks `approve` authority | `APPROVE_TOOL` | Authority-denied (`holdsAuthority` false; SI-1). No transition. |
| A6 | C2 | Two operator surfaces approve simultaneously | One `pending` approval | Two concurrent `APPROVE` | Exactly one transition; one evidence tuple; one grant row; other → `null` (props 3,4,7,11). |
| A7 | C2 | Approval replayed | Already-decided approval | Re-send same `APPROVE` | No-op, `info.changes===0` (prop 4). No second grant row (`approval_id UNIQUE`). |
| A8 | C2 | Approval expires while offline | `pending`, `expires_at` passed, operator offline | Operator reconnects and tries to decide | Approval is `expired`; decide refused; explicit expired failure (prop 9). |
| A9 | C3 | Policy/profile/privacy change before approval | `pending` approval; profile/privacy changed after request | Deliver old decision, apply | **C3 — requires the async seam.** Context mismatch → INVALIDATED, explicit failure (§3.4.3, prop 10 wins over 6). NOT a C2 acceptance test: C2 apply is synchronous (§3.4.2), so there is no stale-apply window; A9 becomes reachable only once C3 introduces async/offline delivery. C2 stores `context_hash` as evidence (§3.4.1); C3 re-validates it. |
| A10 | C2 | Approval delivery lost/restarted | Delivery projection row `failed`/missing | Gateway restarts | Approval still `pending` (truth intact); re-projected & re-delivered (prop 6, prop 5). |
| A11 | C1 | Stale built artifact bypasses control | New control in TS source, stale `dist` | Boot stale artifact | Three-proofs (c) FAILS the landing; control proven only when booted dist enforces it (§5). |
| A12 | C1 | Feature flag off | `TORQCLAW_COLLAB_ENABLED` unset | Normal traffic | Byte-identical legacy behavior incl. SEC-1 hole for legacy sessions (SI-4). |

Acceptance-gate rows by slice: **C1 gates = A1, A2, A3, A11, A12**; **C2 gates = A4, A5, A6, A7, A8, A10**; **C3 (forward-looking, not gated now) = A9**.

Revision 4 adds two migration-time adversarial obligations, gated under the C2-1 ticket AC rather than as new matrix rows: an archived C0.1 credential presented post-migration MUST refuse on the reprovision-required path, and a dispatch attempted against a consumed or revocation-committed grant MUST refuse per the §1.4 invariant (revocation-commits-first).

---

## 8. Ticket decomposition, acceptance, and FREEZE criteria

Each ticket is independently gated by the three-proofs bar (§5) where a runtime control exists.

### C1 tickets
- **C1-1 Surface schema + guarded migration** — `surfaces` table, `PRAGMA table_info` migration, `surface_kind` CHECK. AC: additive migration proven on a legacy DB (IF-NOT-EXISTS trap test); six kinds accepted, seventh rejected.
- **C1-2 Surface credential issuance + verify (reuse credentials.ts)** — `surface_credentials`, issuance flow, existence-oblivious verify incl. expiry. AC: HMAC-count equality across hit/miss/revoked/expired/malformed; plaintext shown once; secret Buffer zeroed.
- **C1-3 Surface revocation + expiration** — `REVOKE_SURFACE` cascade; credential TTL. AC: A2/A3 outcomes; revoked/expired reach the same AUTH_FAILED path.
- **C1-4 Capability assignment + enforcement seam (incl. H-1 subordination + authority store)** — `capability_json`, `authz.ts` consultation, the separate control-plane authority store **`surface_authorities`** (§2.7.1) with its `holdsAuthority`/`grantAuthority` API, the **`surfaces.surface_role` operator-kind predicate** (§2.2, §2.7.1), and the **H-1 operator short-circuit subordination** (intersect operator authority with the presenting surface's held authority/capability; §2.7.1). AC: A5 outcome; fail-closed default `'[]'` (execution capability) AND no-live-row default (authority — absent/revoked `surface_authorities` row ⇒ no `approve`); `grantAuthority('approve')` refused unless `surface_role = 'operator'`; `holdsAuthority` decides `APPROVE_TOOL` against a live row only; H-1 — a compromised operator surface does NOT inherit full principal authority under the flag, and flag-off is byte-identical operator `ALLOW`. (Execution-capability vocabulary depends on the narrowed OQ-1; the `approve` authority is already frozen, AR-1.)
- **C1-5 Resume surface gate (extend sessions.resolve) + session-auth sidecar** — step-2 gate between C0 binding-resolution and `assertResumeAllowed`; on success, derive and record the server-side `ConnectionAuthContext` in `gateway_session_auth` (§2.13). AC: SI-3 (cross-surface resume still works), SI-4 (flag-off byte-identity — sidecar never written/read flag-off), A1/A2/A3; the sidecar row exists for every flag-on bind and is the H-2 origin-trust anchor.
- **C1-6 Audit/provenance** — secret-free audit rows for all C1 mutations. AC: no token/HMAC in any audit row.

### C2 tickets
- **C2-1 tool_approvals Revision-4 migration (compatible rebuild + sidecars + 'expired' + C0.1 archive)** — the §1.5/§3.1 versioned migration: rebuild `tool_approvals` compatibly; create the four §3.1 sidecars and `gateway_task_owners`/`gateway_session_auth`; archive the C0.1 auth tables. AC: rebuild retains every original column and every `approval_id`; historical `args_json` reads back as exactly `REDACTED_LEGACY_ARGS_V4`; pre-C2 rows valid; the enum is enforced in code (single writer, M-1/M-2); archived C0.1 credentials refuse auth with the reprovision-required failure; migration is one-shot under a recorded id and fails closed leaving the baseline untouched if preservation cannot be proven.
- **C2-2 Decision evidence (props 2,7)** — origin at register (bindings sidecar), decided at decide, in the same transaction as the guarded UPDATE. AC: A6 (one evidence tuple under concurrency).
- **C2-3 Authority vs origin + channel self-approve guard (props 1,2)** — authority-gated decide (reads `approve` authority per §2.7.1, never execution capability); structural self-approve refusal (§3.5); CT-2 channel/automation exclusion (§3.14). AC: A4, A5. **DEPENDS ON C1-5** (H-2, §3.5): `origin_surface_id` origin-trust is only sound once the C1-5 bind-time surface-validity gate has validated the presenting credential at connect. C2-3 MUST NOT land before C1-5.
- **C2-4 Approval expiry (prop 9)** — `expires_at` + `pending→expired` sweep/lazy-check. AC: A8; expiry replay-harmless. (Depends on OQ-5 TTL value.)
- **C2-5 Context binding — compute + STORE `context_hash` at decide (prop 10, C2 part; §3.4.1–3.4.2)** — compute `context_hash` over the FROZEN §3.4.1 input set and store it as evidence on the bindings sidecar at decide time. C2 apply is synchronous (§3.4.2), so C2 does NOT re-validate. AC: `context_hash` is computed over exactly the ten frozen inputs in canonical order **using the FROZEN `CTXHASH_V1` length-prefix byte serializer (§3.4.1)** and stored on decide; the digest is **independently reproducible** — a second implementation of the `CTXHASH_V1` serializer over the same ten field values yields the byte-identical digest; no async seam is invented. **Input list AND byte serializer are FROZEN (OQ-4 closed; `CTXHASH_V1` pinned) — no dependency.** *Apply-time re-validation (A9, property-10-wins) is DEFERRED to a C3 ticket (§3.4.3), not C2-5.*
- **C2-6 Redacted approval card summaries (prop 8)** — gateway-side bounded/redacted summary reusing export redactor; persisted only in `gateway_approval_payloads`. AC: raw args never on the wire and never persisted un-redacted; honest language.
- **C2-7 approval_deliveries projection + rebuild (props 5,6)** — projection table + rebuild script. AC: A10; rebuild yields identical delivery view; dropping the table loses no approval truth.
- **C2-8 One-shot-only contract enforcement (prop 11 + §1.4 grant consumption)** — no "Allow for session"; lint literal; `gateway_action_grants` one-row-per-approval with durable consumption at dispatch admission. AC: consistency pre-gate (§10) forbids the phrase on the implementation surface; a consumed or revoked grant refuses dispatch explicitly; revocation-commits-first proven under concurrency.

### FREEZE criteria ("done for review")
This PRD is frozen for G1R when: all sections §1–§10 present; the source-of-truth matrix (§4) and the 12 properties (§3.3) and the adversarial matrix (§7) are complete; the consistency pre-gate spec (§10) enumerates required literals; every hard constraint (§1.2) is stated as a gate; the Revision 4 baseline embeds (§10.1–10.3) are byte-verbatim against the baseline ref; and all open questions (§12) are listed rather than silently resolved. FREEZE does NOT require any code — this is a specification.

---

## 9. Explicitly OUT OF SCOPE

- C3 channel adapters; Telegram; Slack.
- C4 Task Rooms.
- Operator UI / PWA; WCAG accessibility.
- Unified search.
- Governed automation.
- Live destructive restore.
- Replacement of gateway `sessions` / `events` / `receipts`.
- Wholesale collab activation (the 7.7k-line switch-on `reachability.mjs:60-68` explicitly forbids).
- Redesign of the collab substrate DDL — the §10.1 baseline embeds are verbatim FIXTURES of what shipped at the baseline ref, quoted for the pre-gate; they are not proposals and nothing in them is being re-specified.
- Fine-grained **execution-capability** vocabulary finalization, surface transfer semantics, and TTL numeric values remain OPEN QUESTIONS (§12), not in-scope decisions. (The `approve` **authority** and the **context-hash input set** are NO LONGER open — both frozen: AR-1 §1.2.1 and §3.4.1 respectively.)
- **C3-scoped and out of C2:** live apply-time `context_hash` re-validation / property-10-wins (§3.4.3) and adversarial test A9 — deferred to C3's async/offline delivery seam.

---

## 10. Consistency pre-gate (SPECIFY, do not implement)

A deterministic linter analogous to `scripts/lint_collaboration_prd.py`, run over THIS PRD. It must (PASS required before treating the PRD as review-ready):

**Required literals present** (missing any → FAIL):
- Four-layer model terms: `Principal`, `Surface`, `Credential`, `Session`.
- Six surface kinds: `desktop`, `mobile`, `http`, `telegram`, `slack`, `automation`.
- C0 frozen symbols: `resolvePrincipalBinding`, `assertResumeAllowed`, `collabEnabled`, `SAFE_ID`, `da688c0`.
- Credential reuse: `tq1_`, `HMAC-SHA-256`, `existence-oblivious`, `credentials.ts`.
- Approval state set: `pending`, `approved`, `rejected`, `expired`.
- **Identity/capability/authority split (frozen):** the three-layer distinction MUST be present — `identity`, execution `capability`, and control-plane `authority`; and `approve` MUST be described as a reserved control-plane AUTHORITY (ruling `AR-1`), never an execution capability. Execution capabilities MUST map to the profiles `read_only`, `workspace_write`, `browser_research`, `terminal_power`.
- **CT-2 provisioning rule (frozen):** the literal that `approve` is grantable ONLY to operator-kind surfaces and NEVER to channel/automation surfaces; `cross-channel approval` forbidden.
- **H-1 subordination (frozen):** `authz.ts` operator short-circuit is subordinated — operator authority `INTERSECTED` with surface-held authority; the corrected layering `principal authority → surface / session authority → requested capability → specific operation → specific resource / task` present.
- **Property-10 ruling literal:** `property 10 WINS over property 6` (or exact normative phrasing) AND `context_hash`. The C2/C3 split MUST be present: C2 apply is `synchronous` (`server.ts:185-202`, no decide→apply seam; `context_hash` STORED as evidence), property-10 apply-time re-validation `DEFERRED to C3`, and the collision `latent-until-C3`.
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
- Any claim of a second event log / second approval authority (e.g. `collab_session_bindings` used as the session store).
- `collab_events` / collab channel commands (would mean C3 scope leaked in). *(Revision 4 scoping note: the §10.1 baseline embeds below necessarily contain these names as verbatim quotations of the shipped baseline DDL — the scan is scoped so fixture embeds inside this section are never counted as scope leaks; they are quotations, not proposals.)*

**Structural parity checks:**
- Source-of-truth matrix (§4) contains a row for each of: Surface, SurfaceCredential, surface capability, approval origin, approval authority, approval delivery, approval expiry, decision evidence, context binding.
- All 12 approval properties present in §3.3 (numbered 1–12).
- All 12 adversarial rows present in §7 (A1–A12).
- Every ticket (§8) has an acceptance criterion line.

The linter is `scripts/lint_collab_gateway_prd.py` (implemented for the checks above; it exits non-zero on any finding and prints missing/forbidden literals). The **Revision 4 extensions** in §10.4 are SPECIFIED here and implemented as builder work with the C2-1 migration ticket.

### 10.1 Embedded baseline fixture — BASELINE_STATE_DB_AF52430 (verbatim)

The following two embedded source texts are verbatim from the active commit. The (extended, §10.4) linter compares them to read-only `git show` output at the supplied baseline ref, executes their SQLite DDL, and derives sqlite_master, table_info, FK, index, and trigger evidence from that fixture. No replacement schema is synthesized.

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
  "principals": {"target":"principals", "action":"unchanged", "columns":"verbatim", "data":"preserve"},
  "sessions": {"target":"sessions", "key":"id", "action":"unchanged", "sidecar":"gateway_session_auth"},
  "events": {"target":"events", "key":"seq", "fk":"session_id -> sessions(id)", "action":"unchanged"},
  "tasks": {"target":"tasks", "key":"request_id", "action":"unchanged", "sidecar":"gateway_task_owners"},
  "tool_approvals": {"target":"tool_approvals", "action":"rebuild compatible", "columns":"every original column retained", "args_json":"REDACTED_LEGACY_ARGS_V4", "sidecars":["gateway_approval_bindings","gateway_approval_payloads","gateway_action_grants","gateway_approval_events"]},
  "c01_auth": {"source":["principal_credentials","collab_session_bindings","collab_installation","collab_schema_migrations"], "archive_prefix":"c01_archive_", "live_names":"removed", "auth":"denied until explicit reprovision"},
  "unrelated_objects": {"action":"exact clone", "data":"preserve"}
}
STATE_DB_MAP_V4_END

### 10.4 Revision 4 pre-gate extensions (SPECIFY — implemented with ticket C2-1)

The shipped `scripts/lint_collab_gateway_prd.py` implements the Rev-3 checks and MUST stay green over this document at all times. The following EXTENSIONS are additionally required before the C2-1 migration may land (they gate the migration, not the PRD's freeze):

1. **Baseline verbatim check:** the §10.1 embedded blocks (between their `_BEGIN`/`_END` sentinels) byte-match read-only `git show` output at `baseline_ref` for the gateway schema and the collab migration DDL. Any drift → FAIL (the fix is a reviewed baseline bump, never a silent re-quote).
2. **Fixture execution:** execute the embedded DDL into an in-memory SQLite fixture; derive `sqlite_master`, `table_info`, FK, index, and trigger evidence from that fixture. No replacement schema is synthesized.
3. **Expectation check:** the §10.2 expectations (columns, FKs, `required_baseline_objects`) hold against the fixture.
4. **Map coverage:** every object in §10.2 `required_baseline_objects` is covered by a §10.3 map entry or by `unrelated_objects`; the map's sidecar/table names match the §2.13/§3.1 DDL exactly.
5. **Sentinel literal:** the exact redaction sentinel `REDACTED_LEGACY_ARGS_V4` is present in §10.3 and §3.1.
6. **Scoped scans:** the C3-leak and session-store scans remain scoped so the §10.1 fixture embeds are never counted as in-scope claims (they are verbatim quotations of the shipped baseline).

---

## 11. Contradictions found between operator spec and shipped baseline

- **CT-1 (`expired` / `expires_at` reintroduction).** The collab substrate lint (`scripts/lint_collaboration_prd.py:368-369`) FORBIDS `'expired'` and `expires_at` because they were removed from the **`principal_credentials`** model. The operator's C2 spec REQUIRES `'expired'` on `tool_approvals` and TTL/`expires_at` on surface credentials. **No actual conflict** — different tables (`tool_approvals` and `surface_credentials` vs `principal_credentials`) — but it is a real, deliberate divergence a reviewer could mistake for a violation. Surfaced in §2.3 and flagged here. The substrate linter must NOT be run over this PRD (it targets the substrate doc); the C2 linter (§10) is the correct gate.
- **CT-2 (approval authority currently operator-only) — RESOLVED by operator ruling 2026-08-08.** `authz.ts` `case 'APPROVE_TOOL'` is operator-only today, and `LIST_APPROVALS`/`GET_SAFE_EXPORT` are explicitly operator-only with strong stated rationale. The prior draft proposed *capability-gated* approval, which read as an unbounded widening the reviewer had to ratify. **The frozen ruling resolves this and CORRECTS the framing:** approval is gated on a **reserved control-plane AUTHORITY** (`approve`), NOT an execution capability (ruling AR-1, §1.2.1) — and that authority is grantable **ONLY to operator-kind surfaces**, NEVER to channel/automation surfaces, with cross-channel approval forbidden (ruling CT-2, §3.14). The net posture change vs. today is narrow and bounded: `approve` moves from "operator *role*" to "operator-kind *surface* holding the `approve` authority," which is if anything **stricter** (a compromised operator surface without the authority, or any non-operator surface, is refused — see also H-1, §2.7.1). This is no longer an open "should we relax?" ruling for the reviewer; it is a frozen decision to be verified.
- **CT-3 (status has no CHECK constraint).** `schema.sql §8` declares `tool_approvals.status TEXT NOT NULL DEFAULT 'pending'` with NO CHECK. Adding `'expired'` therefore needs no constraint change; the enum is only enforced in code — the operator's phrasing "add 'expired' as a migration" is satisfied by the new *writer* logic, not a DDL constraint edit. Revision 4 note: the compatible REBUILD (§3.1) deliberately does NOT add a CHECK either — the single-writer rule (M-1/M-2) remains the enforcement point, so pre-migration and post-migration enforcement are identical in kind. Noted so nobody looks for a CHECK to alter.

- **CT-4 (baseline freshness across concurrently-moving lanes) — RESOLVED for the governed-skill lane, 2026-08-11; the discipline it taught is retained.** The original CT-4 flagged that the governed-skill lane (GS-COORD) held uncommitted work rewriting `skill_queue.decide()` and its collaborators, so any behavior this PRD quoted could be superseded by the time of build. That lane has since **fully shipped**: GS-COORD merged (`c824bcd`), GS-ACCEPT ran live acceptance, its blocking finding (F-1, governed rollback not end-to-end) was closed by GS-ROLLBACK, and the whole lane is merged and pushed to public `master` as `39a7707` (2026-08-10) with the GS-ACCEPT re-run green on the merged tree.

  What a C1/C2 builder must now take from this:
  1. **Re-read the shipped baseline at build time; do not quote this PRD's citations as current.** In particular, `skill_queue.decide()`'s failure arms were EXTRACTED into one shared mapper (`governed_skills.map_activation_failure`) with golden-pinned byte-identical shapes, and a governed rollback surface (`rollback_skill` / `list_skill_versions` MCP tools) now exists. A governed APPROVE returns fail-fast/retryable shapes (e.g. `{ok:false, code:"SKILL_RUNTIME_BUSY", retryable:true, status:"pending", activeTasks:N}`) rather than fire-and-forget success. C2's approval-broker UX must be designed against the CURRENT decide() contract, not a remembered one.
  2. **The three-proofs bar is proven implementable, twice.** GS-COORD's coordinator-wiring tests and GS-ROLLBACK's deletion-probe record (six controls sabotaged, six red) are live precedents for §5's "green units alone are insufficient" — including a G2A round-1 catch where an exception-subclass ordering bug survived 22 green tests because every taxonomy assertion stopped below the operator surface. C1/C2's §7 rows must be asserted at the outermost surface the operator actually calls.
  3. The remaining external sequencing gate is the operator's **soak → governed default-on** decision (see the Build gate bullet in the preamble).

- **CT-5 (Revision 4 vs the additive-only migration rule) — deliberate, bounded divergence.** §6.2's baseline discipline is "additive, nullable, guarded." Revision 4 introduces exactly two exceptions (§1.5): the `tool_approvals` compatible REBUILD and the C0.1 auth ARCHIVE. Both are versioned, one-shot, fail-closed migrations with preservation proofs (§6.2, C2-1 AC). Flagged here so a reviewer does not read §6.2 as violated: the exceptions are the ruling, not an oversight. The reviewer ratifies exactly two things — that the rebuild's column/id preservation contract is sufficient compatibility, and that archiving (rather than migrating) C0.1 auth with reprovision-required is the intended auth posture.

No contradiction found on the core rulings (execution authority stays with the gateway; C0 frozen; projection modeling; property-10-wins) — those align cleanly with the shipped baseline.

---

## 12. Open questions for the operator (not guessed)

Two questions from the prior draft are **FROZEN** and removed from this list: **OQ-4 (context_hash inputs)** — closed, the full input set is normative in §3.4.1; and the **`approve`-authority portion of OQ-1** — closed, `approve` is a reserved control-plane authority per ruling AR-1 (§1.2.1). Revision 4 closes nothing further and opens nothing new — the remaining questions (plus the narrowed OQ-1 residual) are all **defer-safe**: each has a stated fail-closed default so the slice can proceed and freeze without guessing. Each is safe to leave open because the default withholds authority/capability rather than granting it.

- **OQ-1 (residual — fine-grained EXECUTION-capability vocabulary only).** Does `surfaces.capability_json` use `ClientCommand` action names (fine-grained) or a coarse `read|write|exec|browser` set (mapped to the execution profiles, §1.2.1)? §2.7 fixes the storage/enforcement seam but not the vocabulary. **The `approve` authority is NOT part of this question — it is frozen (AR-1, §1.2.1).** *Fail-closed default:* `capability_json` defaults to `'[]'` (deny-all), so an undecided vocabulary grants no execution capability. Blocks C1-4 vocabulary finalization only, not the seam.
- **OQ-2 (surface transfer).** Is re-parenting a surface to a different principal ever allowed, or is a new surface always minted? §2.8 assumes immutable ownership; confirm. *Fail-closed default:* ownership is immutable (a transfer is a new surface), the strictest option.
- **OQ-3 (session-grant primitive).** Property 11 forbids "Allow for session" until a real canonical session-grant primitive is designed. Is that primitive in a FUTURE slice, or permanently out? Affects whether C2-8's forbidden-literal is temporary or permanent. *Fail-closed default:* one-shot only; the durable grant stays forbidden (lint literal, §10) until explicitly designed.
- **OQ-5 (approval TTL value).** §3.9 proposes 15 minutes for `tool_approvals.expires_at`. Confirm the numeric TTL (and whether surface-credential TTL, §2.4, has a default or is always explicit). *Fail-closed default:* the finite 15-minute TTL (an unset/longer TTL would only widen the actionable window, so the shorter default is the safe placeholder).
- **OQ-6 (socket-close on revocation).** §2.5 says revocation MUST be observable on next resume and SHOULD close live sockets with a `surface_revoked` reason. Is proactive socket-close in C1 scope, or deferred (revocation-on-next-resume only) for this slice? *Fail-closed default:* revocation-on-next-resume is guaranteed (already normative); proactive socket-close deferred — the guaranteed path already denies the revoked surface, so deferral does not leave authority open.

---

## 13. Definition of done (for the eventual build, not this PRD)

A C1/C2 slice is DONE when: (a) unit + (b) reachability + (c) built-artifact proofs all pass for each of its controls (§5); its module is removed from `DORMANT` in `reachability.mjs`; the guarded migration is proven on a legacy DB; the relevant adversarial rows (§7) pass as tests; and flag-off byte-identity (SI-4) is proven. Green units alone are explicitly insufficient.

Revision 4 additions to the C2-1 migration's DoD: the compatible rebuild is proven on a COPY of a real baseline DB with row-count and `approval_id`-preservation assertions; the historical `args_json` sentinel replacement is proven byte-exact; the `c01_archive_*` tables exist with their data and the live old auth names are absent; a booted artifact refuses an archived credential with the reprovision-required failure; and the §10.4 pre-gate extensions pass against the migrated fixture.
