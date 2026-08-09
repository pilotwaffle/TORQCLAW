# PRD-TCLAW-COLLAB-GATEWAY-004 — Surface Identity (C1) + Approval Broker (C2)

- Status: **DESIGN ONLY — revised per operator REVISE-PRD #2, 2026-08-08 — six enforceability fixes (G1R REVISE-PRD + operator REVISE-PRD #2 closed).** No code changes are authorized by this document; it specifies contracts a reviewer gates and builders later implement. This revision encodes the four FROZEN operator rulings (identity≠capability≠AUTHORITY split; CT-2 `approve`-authority provisioning; H-1 operator short-circuit subordination; OQ-4 context_hash inputs; Property-10 apply-time re-validation deferred to C3) and closes the eight-item G1R minimal revision list. Architecture was ratified sound; these are enforceability/scoping fixes, not a redesign.
- Scope: **C1 (Surface Identity) and C2 (Approval Broker) only.** C3/C4 and everything in §9 are out of scope.
- Frozen baseline: **C0 principal bridge, commit `da688c0`** (`packages/gateway/src/principalBridge.ts`). C1/C2 build ON C0's contracts and never re-specify them.
- **Build gate (operator sequencing ruling, 2026-08-09): the C1/C2 RUNTIME build is blocked on GS-ACCEPT passing.** This PRD's design work is explicitly authorized to proceed in parallel — that is what it is — but no C1/C2 runtime surface may be added until the governed-skill lane closes: **GS-COORD → GS-ACCEPT → soak → C1 runtime.** Rationale: no new runtime surface on an unvalidated foundation. GS-COORD is implemented and green (290 passed / 2 skipped) but **uncommitted and un-G2A'd** in worktree `E:/TorqClaw-worktrees/gs-coord` (branch `gs-coord-work`, base `da688c0`). See `docs/HANDOFF-GS-COORD.md` and §11 CT-4.
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
| Which surfaces may RECEIVE / DECIDE an approval; who decided | **Collab identity feeding a Gateway decision** | C2 records evidence on `tool_approvals` |

### 1.2.1 The load-bearing distinction — identity ≠ capability ≠ AUTHORITY (FROZEN, normative)

Operator ruling 2026-08-08 (frozen; do not re-litigate). Three layers are kept **structurally distinct**, each stored and checked separately. This is the spine of the C1/C2 security model and the reason `approve` can never be reached through the execution path.

| Layer | Question it answers | Contents | Storage / check seam |
|---|---|---|---|
| **Identity** | WHO / WHERE | `principal_id`, `surface_id`, `session_id`, `task_id`, task origin | collab `principals` + `surfaces` (C1); `sessions` (C0); recorded on `tool_approvals.origin_*` |
| **Execution CAPABILITY** | WHAT a surface may request/do | `read` / `write` / `exec` / `browser` — **mapped to the existing TORQCLAW execution profiles** `read_only` / `workspace_write` / `browser_research` / `terminal_power` | `surfaces.capability_json` consulted at the `authz.ts` seam (§2.7) |
| **Control-plane AUTHORITY** | WHICH control-plane DECISIONS a surface may make | `approve` (**frozen, reserved now**); `cancel`, `delegate` (**reserved for future**) | a **separate** authority store/check, NEVER the execution-capability path (§2.7.1, CT-2 §3.14) |

**Ruling AR-1 (frozen): `approve` is a reserved control-plane AUTHORITY token, not a tool/execution capability.** It is stored and checked separately from execution capabilities so it can **NEVER** be reached through the execution-capability path. A surface that holds `terminal_power` (or any execution profile) does not thereby hold `approve`. `approve` is frozen into the authority vocabulary as of this revision; `cancel` and `delegate` are reserved names for future authority primitives (each requiring its own threat model when introduced). This **clears C-3** and encodes **CT-2**.

**Vocabulary status:** the `approve` authority token is **RESOLVED and frozen** here. The fine-grained *execution-capability* vocabulary (does `capability_json` mirror `ClientCommand` action names or a coarser `read|write|exec|browser` set) remains open as the residual part of **OQ-1 (§12)** — but the `approve` authority question is no longer open. See §2.7.

**Hard constraints (each a FREEZE blocker if violated):**

1. The gateway `sessions` table is NOT replaced by `collab_session_bindings`. C0 already ruled this out (`principalBridge.ts` header, "WHAT THIS DELIBERATELY DOES NOT DO"). C1 EXTENDS `sessions.resolve()` / `assertResumeAllowed()`; it does not swap them.
2. No second execution/event/receipt/approval state machine is created. `events` stays the append-only source of truth; `run_receipts` and the new `approval_deliveries` are **rebuildable, droppable projections** modeled on the `run_receipts` precedent (`schema.sql §9`, `ops/receipts-rebuild.mjs`).
3. `tool_approvals` stays canonical for approval state. C2 adds columns and one status value (`'expired'`) by guarded migration; it does not move approval truth into a collab table.
4. Flag-off = documented legacy behavior, byte-for-byte, including the SEC-1 hole for pre-bridge sessions (C0 rationale: enabling a subsystem and changing security behavior are separate, individually-revertable decisions).

### 1.3 What C0 already established (do not re-specify)

- `PrincipalBinding { principalId, surfaceId }`; `SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`.
- `collabEnabled()` reads `TORQCLAW_COLLAB_ENABLED` per-call (never captured at import — the stale-`dist` trap).
- `resolvePrincipalBinding(frame)` → `null` when flag off or no identity; **throws** on a PARTIAL claim (principal without surface, or surface without principal).
- `assertResumeAllowed(owner, caller)`: `owner null` → allow (legacy); `caller null` + `owner set` → refuse; principals differ → refuse (**SEC-1**); principals match → allow **regardless of surface** (cross-surface resume is the whole point).
- `sessions.principal_id`, `sessions.surface_id` exist (nullable), populated on create by `sessions.resolve()`.
- Migration precedent: `storage.ts:107-111` — `PRAGMA table_info(sessions)` guarding `ALTER TABLE ... ADD COLUMN` because `CREATE TABLE IF NOT EXISTS` never re-runs on an existing DB.

---

## 2. C1 — Surface Identity

### 2.1 The four-layer model (identity concepts)

| Layer | Definition | Authority | Storage |
|---|---|---|---|
| **Principal** | WHO owns authority. The unit of trust. | Holds the full authority set. | collab `principals` (C0 substrate) |
| **Surface** | WHERE a principal acts (a device/channel/automation endpoint). | Holds a **SUBSET** of principal authority (capability grant). | `surfaces` (**C1, new**) |
| **Credential** | HOW a surface authenticates. | Proves a surface, not a principal. | `surface_credentials` (**C1, new**) |
| **Session** | Gateway execution + replay context. | Bound to `(principal_id, surface_id)` at create (C0). | `sessions` (C0 columns) |

**Invariant SI-1:** a Surface belongs to exactly one Principal. A compromised Surface exposes only that Surface's capability subset, **never** the full principal authority (§2.7).

**Invariant SI-2:** each of `desktop, mobile, http, telegram, slack, automation` is a **surface kind**, not a principal. Adding a new device or channel adds a `surfaces` row, never a `principals` row. The schema accommodates all six kinds without any per-kind table.

### 2.2 Canonical Surface schema (new table)

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
    last_seen_at      DATETIME
);
CREATE INDEX idx_surfaces_principal_state ON surfaces(principal_id, state);
```

Rationale for column choices, each pinned by a test:
- `surface_kind` CHECK enumerates exactly the six kinds (SI-2). A seventh kind is a reviewed schema change, not silent free text.
- **`surface_role` is the normative "operator-kind surface" discriminator** (FROZEN predicate, §2.7.1). `surface_kind` (device/channel type) is NOT sufficient to decide operator-kind: two `desktop` surfaces can differ in whether they are the operator's control-plane surface. `surface_role ∈ ('operator','agent','automation')` is the authoritative predicate CT-2 checks (`operator-kind surface ⇔ surface_role = 'operator'`), and it defaults to `'agent'` (fail-closed: a mis-provisioned surface is never operator-kind). The CHECK enumerates exactly three roles; a new role is a reviewed schema change.
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
    secret_hmac       BLOB NOT NULL,                  -- HMAC-SHA-256(principalPepper, token bytes); NEVER the token
    state             TEXT NOT NULL DEFAULT 'active'
                        CHECK (state IN ('active','revoked')),
    issued_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at        DATETIME,                        -- NULL = non-expiring; §2.4
    revoked_at        DATETIME
);
CREATE INDEX idx_surface_credentials_surface_state ON surface_credentials(surface_id, state);
```

> **Note on `expires_at` (contradiction surfaced — see §11 CT-1):** the collab substrate PRD/lint *forbids* `expires_at` and `'expired'` because they were removed from the **`principal_credentials`** model. This `expires_at` lives on **`surface_credentials`** (a different, C1-new table) and on **`tool_approvals`** (§3.9). These are distinct tables with a distinct product requirement (surface credential TTL, one-shot-approval TTL). Reviewer must confirm the surface/approval TTL is intended to reintroduce expiry at the SURFACE/APPROVAL layer while the PRINCIPAL-credential layer keeps its no-expiry ruling. Encoded here as an **explicit divergence**, not an oversight.

### 2.4 Expiration

- Surface **credential** expiry is `surface_credentials.expires_at` (NULL = non-expiring). At verify time, an expired credential returns `AUTH_FAILED` on the **same existence-oblivious path** as revoked/unknown (add the `expires_at <= now` check to the state gate that already turns `state != 'active'` into `AUTH_FAILED`, so cost stays constant).
- A Surface itself does not expire; only its credentials do. A surface with all credentials expired is unreachable but its capability record and audit trail persist (recovery, §2.9).

### 2.5 Surface revocation

- `REVOKE_SURFACE`: set `surfaces.state='revoked'`, `revoked_at=now`, and cascade `surface_credentials.state='revoked'` for that surface, in one `BEGIN IMMEDIATE` transaction (collab store atomic-protocol discipline).
- Post-revocation, any live session bound to that `(principal, surface)` MUST be refused on its next resume attempt (§2.6) and — design contract only — SHOULD have its socket closed with a `surface_revoked` close reason. (Socket-close wiring is builder work; the contract is: revocation is observable, not silently deferred.)
- Revocation is **not** the same as a different-principal refusal. A revoked surface belonging to principal A still fails as A's surface; SEC-1 (different-principal) remains a separate, stronger refusal.

### 2.6 Session binding (EXTEND sessions.resolve / assertResumeAllowed — do NOT replace)

C1 tightens the C0 resume path **without removing any C0 rule**. Today `sessions.resolve()` calls `resolvePrincipalBinding(frame)` then `assertResumeAllowed(owner, caller)`. C1 inserts a **surface-validity gate** between binding-resolution and the C0 principal check:

Ordered resume gate (all conditions evaluated in this order; first refusal wins):
1. `resolvePrincipalBinding(frame)` (C0) — throws on PARTIAL claim; `null` when flag off / no identity.
2. **C1 surface-validity:** if `caller` is non-null, verify the caller's presented credential via `verifyCredential` AND that `caller.surfaceId` resolves to an `active`, non-expired `surfaces` row owned by `caller.principalId`. Failure → `AUTH_FAILED` (existence-oblivious). *(This is new; C0 validated the shape of the binding, not that the surface still exists/authenticates.)*
3. **C0 `assertResumeAllowed(owner, caller)`** — unchanged: legacy-owner allow, caller-null refuse, SEC-1 principal-mismatch refuse, principal-match allow regardless of surface.

**Invariant SI-3 (C0 preserved):** cross-surface resume by the same principal still succeeds — step 3's "principals match → allow regardless of surface" is untouched. Step 2 only requires that the *presenting* surface is itself valid; it does not require it to be the *owning* surface. Barry on his phone (valid mobile surface) resuming his desktop session (owned by desktop surface) still works.

**Invariant SI-4 (flag-off byte-identity):** when `collabEnabled()` is false, `caller` is `null`, step 2 is skipped entirely, and the path is byte-identical to today (including the SEC-1 hole for legacy `owner==null` sessions).

### 2.7 Capability assignment (subset-of-principal authority)

- `surfaces.capability_json` is a JSON array of capability tokens (each `SAFE_ID`-shaped). It is a **subset** of the principal's authority. The authority set itself is principal-owned (collab); C1 only records the surface's slice.
- **Enforcement point (design contract):** a surface's capability set is consulted at the gateway authorization seam (`authz.ts`) *in addition to* the session `role`, not instead of it. A surface lacking a capability is denied even if its principal holds it. This is the mechanism that makes SI-1 real: a stolen `telegram` surface credential grants only what that telegram surface was provisioned, never the operator's full authority.
- `surfaces.capability_json` holds **execution capabilities only** — the `read` / `write` / `exec` / `browser` set mapped to the TORQCLAW execution profiles `read_only` / `workspace_write` / `browser_research` / `terminal_power` (§1.2.1). It **never** holds `approve` or any control-plane authority token; authority lives in a separate store (§2.7.1).
- **Open question OQ-1 (§12), narrowed:** the exact *execution-capability* vocabulary (does it mirror `ClientCommand` action names, or a coarser set like `read|write|exec|browser`?) remains an open design decision for the reviewer/operator. C1 fixes the *storage and enforcement seam*, not the vocabulary. The `approve` **authority** token is NOT part of this open question — it was frozen as a reserved authority in §1.2.1 (ruling AR-1).
- Fail-closed default: `capability_json` default `'[]'` = deny everything. Provisioning is an explicit grant.

### 2.7.1 Control-plane AUTHORITY store + H-1 operator short-circuit subordination (FROZEN, normative)

**Separate authority, separate store.** Control-plane authority (`approve`, and the reserved `cancel`/`delegate`) is held on a **distinct authority store** for the surface — the new **`surface_authorities`** table, NOT in `surfaces.capability_json`. The authorization check for `APPROVE_TOOL` reads the surface's held **authority**, never its execution capability set (§1.2.1, ruling AR-1). This is what makes "reachable only through the authority path" structurally true rather than a naming convention.

**Concrete authority store — `surface_authorities` (NEW C1 table, gateway-owned).** A dedicated table (chosen over a `surfaces.authority_json` column) because control-plane authority grants are the highest-sensitivity records in the system and a per-authority row gives a clean, indexable, individually-revocable audit grain — each grant/revoke is one row event, not an opaque JSON blob rewrite. **Owner: gateway.** Authority enforcement is the `authz.ts` control-plane check, which is gateway-owned execution-authority territory; collab owns identity, the gateway owns which control-plane decisions a surface may make. Keeping the authority store gateway-side means the `APPROVE_TOOL` authorization read never crosses the identity/execution boundary.

```sql
-- C1: SEPARATE control-plane AUTHORITY store (§2.7.1, ruling AR-1). Gateway-owned.
-- NEVER the execution-capability path — a row here is the ONLY way a surface holds
-- `approve`. Additive, guarded migration (§6.2). One row = one authority grant.
CREATE TABLE IF NOT EXISTS surface_authorities (
    surface_id        TEXT NOT NULL,                  -- the surface holding the authority (SAFE_ID)
    authority         TEXT NOT NULL                   -- reserved control-plane authority token
                        CHECK (authority IN ('approve','cancel','delegate')),
    granted_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    revoked_at        DATETIME,                        -- NULL = live; non-NULL = revoked (fail-closed)
    PRIMARY KEY (surface_id, authority)
);
CREATE INDEX IF NOT EXISTS idx_surface_authorities_surface ON surface_authorities(surface_id);
```

- **Serialization format:** authority is a set of enum tokens, one row per token — NOT serialized JSON. The `authority` CHECK pins the vocabulary (`approve` frozen; `cancel`/`delegate` reserved). No free-text authority can be written.
- **Read/write API sketch (design contract; builder implements at the gateway seam):**
  - `grantAuthority(surfaceId, authority)` — provisioning-time write; **refuses** unless the target `surfaces.surface_role = 'operator'` for the `approve` authority (CT-2 provisioning gate, §3.14). One guarded `INSERT ... ON CONFLICT DO NOTHING`.
  - `revokeAuthority(surfaceId, authority)` — sets `revoked_at = now` (never deletes; audit trail persists).
  - `holdsAuthority(surfaceId, authority): boolean` — decision-time read used by `authz.ts`; returns true **only** for a row with matching `(surface_id, authority)` AND `revoked_at IS NULL`. This is the single authority read seam for `APPROVE_TOOL`.
- **Fail-closed default:** a surface with NO matching live `surface_authorities` row holds NO authority. Absence, a revoked row, an unknown surface, or a malformed lookup all resolve to "no authority" → `APPROVE_TOOL` denied. Authority is never implied by execution capability, role, or surface kind.
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

### 2.10 Migration / backward-compat

- New tables via **guarded** migration (§6.2), following the exact `storage.ts:107-111` precedent. `CREATE TABLE IF NOT EXISTS surfaces (...)` plus, for any column added to `surfaces`/`surface_credentials` *after their first ship*, a `PRAGMA table_info` guard before `ALTER TABLE ... ADD COLUMN`.
- **IF NOT EXISTS trap (called out):** an existing DB that already has `surfaces` will NOT pick up a new column from a re-run `CREATE`. Every post-first-ship column is nullable + `ALTER`-guarded.
- No `sessions` schema change is needed by C1 — C0 already added `principal_id`/`surface_id`.

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

---

## 3. C2 — Approval Broker

### 3.1 Foundation: EXTEND `tool_approvals`, do not fork it

`tool_approvals` (`schema.sql §8`) stays canonical. `approvals.ts::decideApproval` already performs `UPDATE ... WHERE approval_id=? AND status='pending'` — **first-decision-wins and replay-harmless are ALREADY enforced at this seam** (properties 3 and 4 partially hold today). C2 EXTENDS this row and its handler; it does not introduce a parallel approval store.

New state value and columns, added by guarded migration (§6.2):

Each ALTER below is **GUARDED** per the §6.2 migration guard — every `ADD COLUMN` is wrapped in a `PRAGMA table_info(tool_approvals)` existence check before it runs, exactly per the `storage.ts:107-111` precedent (which does the same for `sessions.principal_id`/`surface_id`). The bare `ALTER` lines are shown for readability; the actual migration is the guarded form immediately below them.

```sql
-- C2 EXTENDS tool_approvals (schema.sql §8). Canonical approval STATE stays here.
-- status gains 'expired'. New columns record collab decision evidence + context.
-- EACH ALTER IS GUARDED (PRAGMA table_info check before ALTER ADD COLUMN) per
-- storage.ts:107-111 — the table ships with IF NOT EXISTS so an existing DB never
-- re-runs CREATE and needs explicit, guarded ADD COLUMN. See §6.2.
--   status: pending | approved | rejected | expired   (was pending|approved|rejected)

-- Intended columns (each added only if absent):
--   origin_principal_id   TEXT  -- who ORIGINATED the task (nullable pre-C2)
--   origin_surface_id     TEXT
--   decided_principal_id  TEXT  -- who DECIDED (property 7)
--   decided_surface_id    TEXT
--   expires_at            DATETIME  -- one-shot TTL (property 9)
--   context_hash          TEXT  -- approval-relevant context digest (property 10; §3.4.1)

-- GUARDED migration form (this is what actually runs — modeled on storage.ts:107-111):
const cols = db.prepare(`PRAGMA table_info(tool_approvals)`).all(); // { name }[]
const add = (name, ddl) => { if (!cols.some(c => c.name === name)) db.exec(ddl); };
add('origin_principal_id',  `ALTER TABLE tool_approvals ADD COLUMN origin_principal_id  TEXT`);
add('origin_surface_id',    `ALTER TABLE tool_approvals ADD COLUMN origin_surface_id    TEXT`);
add('decided_principal_id', `ALTER TABLE tool_approvals ADD COLUMN decided_principal_id TEXT`);
add('decided_surface_id',   `ALTER TABLE tool_approvals ADD COLUMN decided_surface_id   TEXT`);
add('expires_at',           `ALTER TABLE tool_approvals ADD COLUMN expires_at           DATETIME`);
add('context_hash',         `ALTER TABLE tool_approvals ADD COLUMN context_hash         TEXT`);
```

The status CHECK cannot be altered in place in SQLite; since the current DDL declares `status TEXT NOT NULL DEFAULT 'pending'` **without** a CHECK constraint, `'expired'` is admissible by writing it — the enum is enforced in code (the decider/expirer only ever writes the four legal values). Reviewer note: if a CHECK is later desired, it requires a table rebuild, out of scope here.

**Single-writer requirement (M-1/M-2, normative).** Because there is **no DDL CHECK** on `tool_approvals.status`, the four-value enum (`pending|approved|rejected|expired`) has **no schema-level enforcement point** — the only thing keeping the column legal is code discipline. The PRD therefore **normatively requires that `tool_approvals.status` has exactly ONE centralized writer**: the existing `decideApproval` guarded UPDATE (extended in C2 for the evidence columns) plus the single expiry transition it also owns (the `pending→expired` sweep/lazy-check, §3.9), which share the same writer module. No other code path may `UPDATE ... status` on `tool_approvals`. This single enforcement point is what substitutes for the missing DDL CHECK; a reviewer must verify no second writer exists (a `grep`-able invariant). By contrast, the NEW `approval_deliveries` table (§3.13) **keeps its DDL CHECK** on `delivery_state` (`CHECK (delivery_state IN ('pending','delivered','acked','failed'))`) because a fresh `CREATE TABLE` can carry the constraint from the start.

### 3.2 What collab identity decides (and what it does not)

Collab/Surface identity supplies four *inputs* to a gateway-owned decision:
- which surfaces may **RECEIVE** an approval card (delivery targeting, §3.13);
- which surfaces may **DECIDE** it (authorization, property 2);
- which **principal+surface** decided (evidence, property 7);
- where the **originating task** came from (origin, recorded at `registerApproval`).

The **state transition itself** remains the gateway's `decideApproval` guarded UPDATE. Collab never writes `tool_approvals.status`.

### 3.3 The twelve properties as testable contracts

| # | Property | Contract | Enforcement seam |
|---|---|---|---|
| 1 | Channel-originated task cannot self-approve | If `origin_surface_id` is a channel/automation surface, a DECIDE from that same surface (or a surface lacking `approve` capability) is refused. | `authz.ts` + C2 broker check |
| 2 | Origin ⟂ Authority | Approval *origin* (who submitted) and approval *authority* (who may decide) are independent columns; deciding is gated on capability, never on being the originator. | separate columns + capability check |
| 3 | Only first valid decision changes state | Reuse existing `UPDATE ... WHERE status='pending'` (`approvals.ts:52-56`). At most one transition fires. | **already holds** — C2 adds evidence columns to the SAME update |
| 4 | Duplicate/replayed decisions harmless | Second decide → `info.changes===0` → `null`, no side effect. | **already holds** (`approvals.ts:58`) |
| 5 | Delivery failure never becomes approval | `approval_deliveries` is a projection; a delivery-row failure cannot write `tool_approvals.status`. Delivery and decision are separate tables with separate writers. | table separation (§3.13) |
| 6 | Delivery survives operator-surface disconnect/reconnect | An undelivered/`pending` approval is re-derivable and re-deliverable on reconnect from `tool_approvals` + `approval_deliveries` (projection is rebuildable). | reconnect re-projects |
| 7 | Decision evidence records principal+surface | `decided_principal_id`/`decided_surface_id` written **in the same guarded UPDATE** as the status change (atomic with the transition). | new columns (§3.1) |
| 8 | Approval cards get bounded/redacted arg summaries only | The card carries a bounded, redacted summary — never raw `args_json`. Reuse the export redactor discipline (`export.ts`): allowlist projection, scrub-then-cap, honest "known secret shapes removed" language. `LIST_APPROVALS` already excludes `args_json` (`approvals.ts:99-101`). | redactor reuse |
| 9 | Approval EXPIRES rather than staying actionable | `expires_at` set at `registerApproval`; a sweep (or lazy check at decide-time) transitions `pending→expired` via `UPDATE ... WHERE status='pending' AND expires_at<=now`. An expired approval is not decidable. | new status + TTL |
| 10 | Approval bound to execution context; changed policy/profile/privacy INVALIDATES a stale approval | **C2:** `context_hash` (over the §3.4.1 FROZEN input set) is computed + STORED at decide time as evidence — C2 apply is SYNCHRONOUS (`server.ts:185-202`), so there is no decide→apply seam and no re-validation in C2. **C3:** live apply-time re-validation (property-10-wins over 6) once async/offline delivery creates a real decide≠apply seam. See §3.4. | C2: context_hash stored at decide. **C3: apply-time re-check (deferred)** |
| 11 | No "Allow for session" unless a real session-grant primitive exists | Default C2 contract is **one-shot**. A durable "allow for session" grant is explicitly NOT designed here (OQ-3, §12); UIs must not offer it. | contract + lint literal |
| 12 | Path/profile/security restrictions remain authoritative AFTER approval | Approval grants the specific tool; it never bypasses path allowlists, profile gates, or privacy restrictions enforced downstream in `dispatch.ts`. Those re-check on the re-minted run. | dispatch re-check (unchanged) |

### 3.4 Context binding — the `context_hash` (FROZEN inputs; C2 computes+stores, C3 re-validates)

Two operator rulings 2026-08-08 (frozen) govern this section: (a) **OQ-4 is closed** — the `context_hash` input set is now fully specified and normative (no "mechanism normative, inputs TBD"); and (b) **Property-10 / C-1** — C2 apply stays SYNCHRONOUS and live apply-time re-validation is DEFERRED to C3. Both are encoded below.

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

#### 3.4.2 C2 behavior — SYNCHRONOUS apply, no decide→apply seam (Property-10 / C-1 ruling, clears C-1 + L-2)

**Ruling (frozen): in C2 there is NO decide→apply gap.** Today `decideApproval` and `mintGrantedRequest` run in the **same `server.ts` tick** — the `APPROVE_TOOL` handler calls `decideApproval(...)` (`server.ts:185`) and, on APPROVE, immediately `mintGrantedRequest(...)` and `dispatch(...)` within the same synchronous case (`server.ts:185-202`). The decision IS the application; there is no interval in which context could drift between deciding and applying.

Therefore:
- **In C2, `context_hash` is computed and STORED at decide time as evidence** on the canonical `tool_approvals.context_hash` column (§3.1). It records the exact context the decision was made under.
- **In C2, `context_hash` is NOT re-validated at a separate apply time** — because there is no separate apply time. Live apply-time re-validation (Property 10 in its full form) is **EXPLICITLY NOT a C2 invariant**.
- **C2 must NOT invent an async/offline seam solely to make A9 pass.** Manufacturing a decide≠apply gap that does not exist today would add attack surface for no C2 benefit.

#### 3.4.3 Property 10 deferred to C3 — the real decide≠apply seam (property-6-vs-10 collision is latent-until-C3)

The property-6-vs-10 collision (durable delivery of a *stale-but-delivered* decision) only becomes real in **C3**, where async/offline delivery introduces a genuine `decide != apply` seam (operator decides while offline; the decision is delivered and applied later). **Property-10 live apply-time re-validation is DEFERRED to C3.** At that point:
- Recompute the current `context_hash` (over the §3.4.1 frozen inputs) at the moment the decision would take effect.
- Equal to the stored hash → apply normally.
- Materially different → the stale approval is **INVALIDATED**: transition `pending→expired` (or, if already `approved`, refuse to act and surface it) and emit an **EXPLICIT operator-facing failure state** — NOT a silent no-op.
- **Ruling: property 10 WINS over property 6** at the collision point. Durable delivery (6) guarantees the decision is not *lost*; it does not guarantee it is still *valid*. This ruling is recorded now but is a **C3** invariant.

**The property-6-vs-10 collision is therefore LATENT-UNTIL-C3.** In C2, property 6 (durable delivery survives reconnect) holds without colliding with anything, because C2 has no seam in which a delivered decision can go stale before apply.

**Source-of-truth note:** `context_hash` is stored on the canonical `tool_approvals` row (not the delivery projection), so both the C2 evidence write and the C3 re-validation read authoritative state. `approval_deliveries` can be dropped and rebuilt without affecting either.

### 3.5–3.12 Property detail (see the table in §3.3; expanded contracts)

- **3.5 (prop 1 detail):** "self-approve" is defined structurally: a DECIDE whose `decided_surface_id === origin_surface_id` AND whose surface is a channel/automation kind is refused. An operator surface deciding its own operator-originated task is allowed (operators are the approval authority today, `authz.ts` `case 'APPROVE_TOOL'`). Combined with CT-2 (§3.14) — channel/automation surfaces can never hold `approve` — a channel-originated task cannot self-approve on two independent grounds (structural self-approve refusal + absence of `approve` authority).
  - **Dependency H-2 (frozen): property 1 origin-trust depends on the C1-5 bind-time surface-validity gate.** Property 1 reasons over `origin_surface_id`. That column is only **trustworthy** if the presenting credential was validated at connect/bind time — otherwise a surface could present a forged/unvalidated `origin_surface_id` and the "channel-originated" classification would be spoofable. The C1-5 resume/bind surface-validity gate (§2.6 step 2) is what establishes that `origin_surface_id` was proven at connect. **Therefore C2-3 (prop 1 enforcement) explicitly DEPENDS ON C1-5 being landed first** (recorded in the ticket decomposition, §8).
- **3.6 (prop 2 detail):** the origin columns are written at `registerApproval` (from the blocked task's session binding); the decide columns at `decideApproval`. Nothing couples them.
- **3.7 (props 3+4):** no new code required for the core guard — the existing atomic `UPDATE` is the mechanism; C2 only widens the SET clause to include evidence. A test must prove two simultaneous decides still yield exactly one transition WITH exactly one evidence tuple.
- **3.8 (prop 5):** `approval_deliveries` writer is separate from `decideApproval`; a delivery insert/ack failure path has no code route to `tool_approvals.status`.
- **3.9 (prop 9 TTL):** `expires_at` default is a fixed TTL (proposed 15 minutes — value is **OQ-5, §12**). Expiry transition is idempotent and replay-harmless (same `WHERE status='pending'` guard shape).
- **3.10 (prop 8 redaction):** the card summary is produced by the gateway (never assembled client-side), reusing `export.ts` redactor primitives; honest language only ("known secret shapes removed"), never "safe".
- **3.11 (prop 11):** one-shot is the only grant C2 ships. **Prohibition statement (normative):** "Allow for session" is PROHIBITED as a shippable grant option — it MUST NOT appear as a grant type in any UI, config, or grant-type enum — until a real canonical session-grant primitive is separately designed (OQ-3, §12). The §10 pre-gate lints this prohibition in two directions: the implementation/config surface must not contain the string, and THIS PRD must contain this prohibition statement (§10, corrected).
- **3.12 (prop 12):** the re-minted GatewayRequest still passes through `dispatch.ts` path/profile/privacy gates. Approval widens exactly one grant unit (`grantedTools=[tool_name]`, per `schema.sql §8` comment); it disables nothing else.

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
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_approval_deliveries_approval ON approval_deliveries(approval_id);
```

- A `rebuild` script (analogous to `ops/receipts-rebuild.mjs`) MUST be able to drop and regenerate `approval_deliveries` from canonical state, with no loss of approval truth. This is the acceptance proof that the projection is not load-bearing for correctness.
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
| Principal identity | collab `principals` | — | C0 substrate |
| **Surface** | **`surfaces` (C1)** | — | authoritative; backed up with DB |
| **Surface credential (HMAC)** | **`surface_credentials` (C1)** | — | plaintext never stored; re-issue, never retrieve |
| **Surface capability** | **`surfaces.capability_json` (C1)** | — | subset of principal authority |
| Session (execution/replay) | gateway `sessions` (C0 columns) | — | NOT replaced by collab bindings |
| Execution status / events | gateway `tasks` / **`events` (source of truth)** | `run_receipts` | unchanged |
| **Approval STATE** | **gateway `tool_approvals` (canonical)** | — | C2 extends; state never leaves this table |
| **Approval origin** | **`tool_approvals.origin_* (C2)`** | — | written at registerApproval |
| **Approval authority (who may decide)** | **`surface_authorities` (C1, separate authority store §2.7.1)** consulted at the `authz.ts` authority-check seam (post-H-1 subordination) | — | held-authority lookup, NEVER `capability_json`/the execution-capability path (AR-1); computed against the presenting surface's held `approve` authority |
| **Decision evidence** | **`tool_approvals.decided_* (C2)`** | — | atomic with the status UPDATE |
| **Approval expiry** | **`tool_approvals.status='expired'` + `expires_at` (C2)** | — | one-shot TTL |
| **Approval-context binding** | **`tool_approvals.context_hash` (C2)** | — | stored as evidence at decide (C2); apply-time re-validation deferred to C3 (§3.4) |
| **Approval delivery** | **`approval_deliveries` (C2) — PROJECTION** | (is the projection) | rebuildable, droppable; never truth |
| Receipts | `run_receipts` (projection) | (is the projection) | precedent for `approval_deliveries` |

Explicit statement: **gateway owns execution / events / receipts / approval-STATE; collab owns identity (principals, surfaces, credentials, capability); all new C1/C2 tables are additive.** No existing authoritative table is repurposed or replaced.

---

## 5. Three-proofs acceptance (operator-mandated, load-bearing)

**Baseline test-count note (local, verified).** The public README shows 991 TS / 186 Py, but THIS working tree is **ahead** of the README: **1498 TS tests at/after `da688c0`** (the frozen C0 baseline this PRD builds on), with more after subsequent collab slices. Where this PRD references the baseline gate, cite the **LOCAL verified count (1498 TS at/after `da688c0`)**, not the README's stale 991. **Discipline note:** a green general gate (all 1498 passing) is **necessary but NOT sufficient** for a security property — do not over-read a green count. Each security-relevant control still needs a **property-specific adversarial proof** (the three-proofs bar below; the §7 adversarial matrix). "The suite is green" never substitutes for "this specific control refused this specific attack on a booted artifact."

Every C1/C2 control, where applicable, requires all three of the following. **A control is NOT landed on green units alone.**

1. **(a) Unit behavior** — the control's logic proven in isolation (e.g. existence-oblivious verify count; first-decision-wins; context-hash mismatch invalidates).
2. **(b) Runtime REACHABILITY** — `pnpm reachability` (`ops/reachability.mjs`) must prove real running code reaches the control. The gate walks the import graph transitively from declared entry points; a module wired to nothing FAILS even with green units. **As each C1/C2 slice gains a real runtime entry point, it is removed from the `DORMANT['packages/collab']` declaration** (`reachability.mjs:60-68`, which already names the C0→C1→C2→C3→C4 order). New gateway modules under `packages/gateway/src` must be transitively reachable from `packages/gateway/src/server.ts`.
3. **(c) BUILT-ARTIFACT enforcement** — boot the built `dist`/binary and prove the control is active there, not merely in TS source. This is the **stale-`dist` auth-hole lesson** cited directly in `principalBridge.ts:69` and `reachability.mjs` — a control present in source but stale in the shipped artifact is not landed. Reuse the built-artifact boot harness pattern (`ops/runtime-build.mjs`, `ops/reachability.mjs`).

Per-control proof obligations (illustrative, not exhaustive — the ticket acceptance criteria in §8 pin the full set):

| Control | (a) unit | (b) reachability | (c) built artifact |
|---|---|---|---|
| Surface credential verify (existence-oblivious) | HMAC-count equality across hit/miss/revoked/expired/malformed | reached from `server.ts` connect path | booted dist refuses revoked surface |
| Resume surface gate (§2.6 step 2) | step-2 refusal fixtures | reached from `sessions.resolve` | booted dist enforces gate with flag on |
| First-decision-wins + evidence (props 3,7) | concurrent decide → one transition, one evidence tuple | reached from `APPROVE_TOOL` handler | booted dist records evidence |
| Channel self-approve prevention (prop 1) | channel/automation `decided_surface_id`==`origin_surface_id` refused; channel surface holds no `approve` authority | refusal reached from the `APPROVE_TOOL` authority check (post-H-1 seam, §2.7.1) — depends on C1-5 origin-trust | **booted dist refuses channel self-approve** (channel surface cannot decide its own originated task on a live artifact) |
| Post-approval path/profile re-check (prop 12) | re-minted GatewayRequest still hits `dispatch.ts` path/profile/privacy gates; approval widens only `grantedTools=[tool_name]` | re-check reached on the re-mint/dispatch path from `server.ts:196-202` | **booted dist re-checks path/profile/privacy after approval** (a booted artifact still denies a path/profile-violating tool even once approved) |
| Context binding — store as evidence (§3.4.1, prop 10 **C2 part**) | `context_hash` over the frozen input set is computed + stored at decide time | reached from `APPROVE_TOOL` decide path | booted dist writes `context_hash` on decide |
| Context invalidation (§3.4.3, prop 10 **C3 part — DEFERRED**) | context mismatch → explicit failure | reached from async apply/re-mint path (C3) | booted dist fails loudly on stale apply (C3) |
| Delivery projection rebuild (§3.13) | rebuild yields identical delivery view | rebuild script reachable | rebuild runs against booted DB |

---

## 6. Cross-cutting requirements

### 6.1 Feature-flag rollout strategy
- `TORQCLAW_COLLAB_ENABLED`, read **per-call** via `collabEnabled()` (never captured at import — stale-`dist` trap, `principalBridge.ts:64-73`). Flag-off = documented legacy behavior, byte-identical (SI-4).
- Flags are additive and independently revertable: turning the flag off backs out C1/C2 wiring without also silently changing any OTHER security posture. (C0's exact rationale for why closing SEC-1 was bundled behind the same flag rather than shipped unconditionally.)

### 6.2 DB migration strategy (additive, nullable, guarded)
- All new tables via `CREATE TABLE IF NOT EXISTS`.
- Every column added to an *already-shipped* table via `PRAGMA table_info(<table>)` guard before `ALTER TABLE ... ADD COLUMN`, following `storage.ts:107-111` verbatim (the C0 lesson).
- **IF NOT EXISTS trap (explicit):** an existing DB never re-runs `CREATE`, so it will never pick up new columns from an edited `CREATE`; new columns are ALWAYS nullable + `ALTER`-guarded. This is why `tool_approvals`' six new columns (§3.1) are ADD COLUMN, not a re-declared CREATE.
- All new columns nullable so a legacy DB migrates without backfill and pre-C2 rows stay valid.

### 6.3 Reachability-gate requirements
- No C1/C2 module ships as an orphan. Each slice removes itself from `DORMANT` in `reachability.mjs` as it gains a real entry point (§5(b)).

### 6.4 No secret-bearing browser/channel credentials
- Surface tokens are `tq1_` bearer secrets and MUST NOT be embedded in browser/channel client code or shipped to a channel adapter as a static secret. Only the HMAC is stored server-side; the plaintext is shown once at issuance. Browser/PWA surfaces obtain credentials through issuance flows, never baked-in secrets. (Design contract; adapter implementations are C3, out of scope.)

### 6.5 No second execution/event/receipt authority
- Restated as a gate: any design that introduces a parallel event log, a second approval state table, or a collab-owned execution status FAILS review. `events` stays the single append-only source of truth.

### 6.6 Rollback behavior
- Flag-off is the primary rollback (§6.1). Tables remain (additive, inert). No migration is destructive; no rollback requires dropping a column. Dropping `approval_deliveries` is safe by design (projection).

### 6.7 Observability
- Metrics/audit for: surface issuance/revocation counts, credential verify outcomes (bucketed as AUTH_FAILED only — never leak hit/miss distinction, mirroring collab rate-limit privacy), approvals by state incl. `expired`, context-invalidation events (property-10 failures are a first-class observable), delivery projection rebuild runs.

### 6.8 Operator-facing failure states
- Enumerated and honest: `AUTH_FAILED` (surface invalid/revoked/expired — existence-oblivious), SEC-1 refusal (different principal), capability-denied, approval-expired, **approval-context-invalidated** (property-10, explicit — never a silent no-op), delivery-failed (projection state, never an approval state).

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
| A6 | C2 | Two operator surfaces approve simultaneously | One `pending` approval | Two concurrent `APPROVE` | Exactly one transition; one evidence tuple; other → `null` (props 3,4,7). |
| A7 | C2 | Approval replayed | Already-decided approval | Re-send same `APPROVE` | No-op, `info.changes===0` (prop 4). |
| A8 | C2 | Approval expires while offline | `pending`, `expires_at` passed, operator offline | Operator reconnects and tries to decide | Approval is `expired`; decide refused; explicit expired failure (prop 9). |
| A9 | C3 | Policy/profile/privacy change before approval | `pending` approval; profile/privacy changed after request | Deliver old decision, apply | **C3 — requires the async seam.** Context mismatch → INVALIDATED, explicit failure (§3.4.3, prop 10 wins over 6). NOT a C2 acceptance test: C2 apply is synchronous (§3.4.2), so there is no stale-apply window; A9 becomes reachable only once C3 introduces async/offline delivery. C2 stores `context_hash` as evidence (§3.4.1); C3 re-validates it. |
| A10 | C2 | Approval delivery lost/restarted | Delivery projection row `failed`/missing | Gateway restarts | Approval still `pending` (truth intact); re-projected & re-delivered (prop 6, prop 5). |
| A11 | C1 | Stale built artifact bypasses control | New control in TS source, stale `dist` | Boot stale artifact | Three-proofs (c) FAILS the landing; control proven only when booted dist enforces it (§5). |
| A12 | C1 | Feature flag off | `TORQCLAW_COLLAB_ENABLED` unset | Normal traffic | Byte-identical legacy behavior incl. SEC-1 hole for legacy sessions (SI-4). |

Acceptance-gate rows by slice: **C1 gates = A1, A2, A3, A11, A12**; **C2 gates = A4, A5, A6, A7, A8, A10**; **C3 (forward-looking, not gated now) = A9**.

---

## 8. Ticket decomposition, acceptance, and FREEZE criteria

Each ticket is independently gated by the three-proofs bar (§5) where a runtime control exists.

### C1 tickets
- **C1-1 Surface schema + guarded migration** — `surfaces` table, `PRAGMA table_info` migration, `surface_kind` CHECK. AC: additive migration proven on a legacy DB (IF-NOT-EXISTS trap test); six kinds accepted, seventh rejected.
- **C1-2 Surface credential issuance + verify (reuse credentials.ts)** — `surface_credentials`, issuance flow, existence-oblivious verify incl. expiry. AC: HMAC-count equality across hit/miss/revoked/expired/malformed; plaintext shown once; secret Buffer zeroed.
- **C1-3 Surface revocation + expiration** — `REVOKE_SURFACE` cascade; credential TTL. AC: A2/A3 outcomes; revoked/expired reach the same AUTH_FAILED path.
- **C1-4 Capability assignment + enforcement seam (incl. H-1 subordination + authority store)** — `capability_json`, `authz.ts` consultation, the separate control-plane authority store **`surface_authorities`** (§2.7.1) with its `holdsAuthority`/`grantAuthority` API, the **`surfaces.surface_role` operator-kind predicate** (§2.2, §2.7.1), and the **H-1 operator short-circuit subordination** (intersect operator authority with the presenting surface's held authority/capability; §2.7.1). AC: A5 outcome; fail-closed default `'[]'` (execution capability) AND no-live-row default (authority — absent/revoked `surface_authorities` row ⇒ no `approve`); `grantAuthority('approve')` refused unless `surface_role = 'operator'`; `holdsAuthority` decides `APPROVE_TOOL` against a live row only; H-1 — a compromised operator surface does NOT inherit full principal authority under the flag, and flag-off is byte-identical operator `ALLOW`. (Execution-capability vocabulary depends on the narrowed OQ-1; the `approve` authority is already frozen, AR-1.)
- **C1-5 Resume surface gate (extend sessions.resolve)** — step-2 gate between C0 binding-resolution and `assertResumeAllowed`. AC: SI-3 (cross-surface resume still works), SI-4 (flag-off byte-identity), A1/A2/A3.
- **C1-6 Audit/provenance** — secret-free audit rows for all C1 mutations. AC: no token/HMAC in any audit row.

### C2 tickets
- **C2-1 tool_approvals migration (columns + 'expired')** — six new columns, `'expired'` value. AC: guarded ALTERs on legacy DB; pre-C2 rows valid; enum enforced in code.
- **C2-2 Decision evidence (props 2,7)** — origin at register, decided at decide, in the same guarded UPDATE. AC: A6 (one evidence tuple under concurrency).
- **C2-3 Authority vs origin + channel self-approve guard (props 1,2)** — authority-gated decide (reads `approve` authority per §2.7.1, never execution capability); structural self-approve refusal (§3.5); CT-2 channel/automation exclusion (§3.14). AC: A4, A5. **DEPENDS ON C1-5** (H-2, §3.5): `origin_surface_id` origin-trust is only sound once the C1-5 bind-time surface-validity gate has validated the presenting credential at connect. C2-3 MUST NOT land before C1-5.
- **C2-4 Approval expiry (prop 9)** — `expires_at` + `pending→expired` sweep/lazy-check. AC: A8; expiry replay-harmless. (Depends on OQ-5 TTL value.)
- **C2-5 Context binding — compute + STORE `context_hash` at decide (prop 10, C2 part; §3.4.1–3.4.2)** — compute `context_hash` over the FROZEN §3.4.1 input set and store it as evidence on the `tool_approvals` row at decide time. C2 apply is synchronous (§3.4.2), so C2 does NOT re-validate. AC: `context_hash` is computed over exactly the ten frozen inputs in canonical order **using the FROZEN `CTXHASH_V1` length-prefix byte serializer (§3.4.1)** and stored on decide; the digest is **independently reproducible** — a second implementation of the `CTXHASH_V1` serializer over the same ten field values yields the byte-identical digest; no async seam is invented. **Input list AND byte serializer are FROZEN (OQ-4 closed; `CTXHASH_V1` pinned) — no dependency.** *Apply-time re-validation (A9, property-10-wins) is DEFERRED to a C3 ticket (§3.4.3), not C2-5.*
- **C2-6 Redacted approval card summaries (prop 8)** — gateway-side bounded/redacted summary reusing export redactor. AC: raw `args_json` never on the wire; honest language.
- **C2-7 approval_deliveries projection + rebuild (props 5,6)** — projection table + rebuild script. AC: A10; rebuild yields identical delivery view; dropping the table loses no approval truth.
- **C2-8 One-shot-only contract enforcement (prop 11)** — no "Allow for session"; lint literal. AC: consistency pre-gate (§10) forbids the phrase.

### FREEZE criteria ("done for review")
This PRD is frozen for G1R when: all sections §1–§10 present; the source-of-truth matrix (§4) and the 12 properties (§3.3) and the adversarial matrix (§7) are complete; the consistency pre-gate spec (§10) enumerates required literals; every hard constraint (§1.2) is stated as a gate; and all open questions (§12) are listed rather than silently resolved. FREEZE does NOT require any code — this is a specification.

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
- Fine-grained **execution-capability** vocabulary finalization, surface transfer semantics, and TTL numeric values remain OPEN QUESTIONS (§12), not in-scope decisions. (The `approve` **authority** and the **context-hash input set** are NO LONGER open — both frozen this revision: AR-1 §1.2.1 and §3.4.1 respectively.)
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
- `collab_events` / collab channel commands (would mean C3 scope leaked in).

**Structural parity checks:**
- Source-of-truth matrix (§4) contains a row for each of: Surface, SurfaceCredential, surface capability, approval origin, approval authority, approval delivery, approval expiry, decision evidence, context binding.
- All 12 approval properties present in §3.3 (numbered 1–12).
- All 12 adversarial rows present in §7 (A1–A12).
- Every ticket (§8) has an acceptance criterion line.

The linter is a `scripts/lint_collab_gateway_prd.py`-shaped script (design contract; not written here). Like the substrate linter it exits non-zero on any finding and prints missing/forbidden literals.

---

## 11. Contradictions found between operator spec and shipped baseline

- **CT-1 (`expired` / `expires_at` reintroduction).** The collab substrate lint (`scripts/lint_collaboration_prd.py:368-369`) FORBIDS `'expired'` and `expires_at` because they were removed from the **`principal_credentials`** model. The operator's C2 spec REQUIRES `'expired'` on `tool_approvals` and TTL/`expires_at` on surface credentials. **No actual conflict** — different tables (`tool_approvals` and `surface_credentials` vs `principal_credentials`) — but it is a real, deliberate divergence a reviewer could mistake for a violation. Surfaced in §2.3 and flagged here. The substrate linter must NOT be run over this PRD (it targets the substrate doc); the C2 linter (§10) is the correct gate.
- **CT-2 (approval authority currently operator-only) — RESOLVED by operator ruling 2026-08-08.** `authz.ts` `case 'APPROVE_TOOL'` is operator-only today, and `LIST_APPROVALS`/`GET_SAFE_EXPORT` are explicitly operator-only with strong stated rationale. The prior draft proposed *capability-gated* approval, which read as an unbounded widening the reviewer had to ratify. **The frozen ruling resolves this and CORRECTS the framing:** approval is gated on a **reserved control-plane AUTHORITY** (`approve`), NOT an execution capability (ruling AR-1, §1.2.1) — and that authority is grantable **ONLY to operator-kind surfaces**, NEVER to channel/automation surfaces, with cross-channel approval forbidden (ruling CT-2, §3.14). The net posture change vs. today is narrow and bounded: `approve` moves from "operator *role*" to "operator-kind *surface* holding the `approve` authority," which is if anything **stricter** (a compromised operator surface without the authority, or any non-operator surface, is refused — see also H-1, §2.7.1). This is no longer an open "should we relax?" ruling for the reviewer; it is a frozen decision to be verified.
- **CT-3 (status has no CHECK constraint).** `schema.sql §8` declares `tool_approvals.status TEXT NOT NULL DEFAULT 'pending'` with NO CHECK. Adding `'expired'` therefore needs no constraint change (§3.1), but the enum is only enforced in code — the operator's phrasing "add 'expired' as a migration" is satisfied by the new *writer* logic, not a DDL constraint edit. Noted so nobody looks for a CHECK to alter.

- **CT-4 (an uncommitted transaction rewrite touches the shipped baseline this PRD builds on).** Not a design contradiction — a *baseline-freshness* hazard. The governed-skill lane (GS-COORD) holds ~1,674 uncommitted lines in worktree `E:/TorqClaw-worktrees/gs-coord` (branch `gs-coord-work`, base `da688c0`) that rewrite `skill_queue.decide()`, `governed_skills.py`, `verified_skill_store.py` (prepare/commit/abort journal protocol for BOTH `activate()` and `rollback()`), `skill_publisher.py` (reversible publication), and **`runtime_quiescence.py`'s `ActivationCoordinator.run()`**. It is green (290 passed / 2 skipped vs. a 277/1 master baseline) but has had **no G2A** and is not merged.

  Why a C1/C2 reviewer should care, despite zero scope overlap:
  1. **`da688c0` is this PRD's frozen baseline and GS-COORD's base.** Whichever merges second rebases onto the other. GS-COORD merges first per the §Build-gate ruling, so C1/C2 should re-read the shipped baseline after that merge rather than trusting quotes taken today.
  2. **It changes an operator-facing approval path.** `skill_queue.decide()` becomes fail-fast/retryable-`pending`: a governed APPROVE no longer leaves `pending` until the coordinated activation is published, cache-coherent, committed and verified; a busy runtime returns `{ok:false, code:"SKILL_RUNTIME_BUSY", retryable:true, status:"pending", activeTasks:N}`. C2's approval-broker UX should not assume today's fire-and-forget `APPROVE_SKILL` semantics (`server.ts:160-168` currently emits success unconditionally after `approveSkill()` returns).
  3. **It independently validates this PRD's §5/§13 bar.** GS-COORD's `test_activation_coordinator_wiring.py` is an invariant-path test that spies on `ActivationCoordinator.run` itself; bypassing the coordinator *while keeping the import* fails all 13 of its tests. That is the concrete form of "green units alone are explicitly insufficient" — a useful precedent for C1/C2's three-proofs acceptance, and evidence the bar is implementable rather than aspirational.

  No action required of this PRD's design. Flagged so the eventual builder re-verifies the baseline post-merge instead of quoting a superseded `skill_queue.decide()`.

No contradiction found on the core rulings (execution authority stays with the gateway; C0 frozen; projection modeling; property-10-wins) — those align cleanly with the shipped baseline.

---

## 12. Open questions for the operator (not guessed)

Two questions from the prior draft are now **FROZEN** and removed from this list: **OQ-4 (context_hash inputs)** — closed, the full input set is normative in §3.4.1; and the **`approve`-authority portion of OQ-1** — closed, `approve` is a reserved control-plane authority per ruling AR-1 (§1.2.1). The remaining four questions (plus the narrowed OQ-1 residual) are all **defer-safe**: each has a stated fail-closed default so the slice can proceed and freeze without guessing. Each is safe to leave open because the default withholds authority/capability rather than granting it.

- **OQ-1 (residual — fine-grained EXECUTION-capability vocabulary only).** Does `surfaces.capability_json` use `ClientCommand` action names (fine-grained) or a coarse `read|write|exec|browser` set (mapped to the execution profiles, §1.2.1)? §2.7 fixes the storage/enforcement seam but not the vocabulary. **The `approve` authority is NOT part of this question — it is frozen (AR-1, §1.2.1).** *Fail-closed default:* `capability_json` defaults to `'[]'` (deny-all), so an undecided vocabulary grants no execution capability. Blocks C1-4 vocabulary finalization only, not the seam.
- **OQ-2 (surface transfer).** Is re-parenting a surface to a different principal ever allowed, or is a new surface always minted? §2.8 assumes immutable ownership; confirm. *Fail-closed default:* ownership is immutable (a transfer is a new surface), the strictest option.
- **OQ-3 (session-grant primitive).** Property 11 forbids "Allow for session" until a real canonical session-grant primitive is designed. Is that primitive in a FUTURE slice, or permanently out? Affects whether C2-8's forbidden-literal is temporary or permanent. *Fail-closed default:* one-shot only; the durable grant stays forbidden (lint literal, §10) until explicitly designed.
- **OQ-5 (approval TTL value).** §3.9 proposes 15 minutes for `tool_approvals.expires_at`. Confirm the numeric TTL (and whether surface-credential TTL, §2.4, has a default or is always explicit). *Fail-closed default:* the finite 15-minute TTL (an unset/longer TTL would only widen the actionable window, so the shorter default is the safe placeholder).
- **OQ-6 (socket-close on revocation).** §2.5 says revocation MUST be observable on next resume and SHOULD close live sockets with a `surface_revoked` reason. Is proactive socket-close in C1 scope, or deferred (revocation-on-next-resume only) for this slice? *Fail-closed default:* revocation-on-next-resume is guaranteed (already normative); proactive socket-close deferred — the guaranteed path already denies the revoked surface, so deferral does not leave authority open.

---

## 13. Definition of done (for the eventual build, not this PRD)

A C1/C2 slice is DONE when: (a) unit + (b) reachability + (c) built-artifact proofs all pass for each of its controls (§5); its module is removed from `DORMANT` in `reachability.mjs`; the guarded migration is proven on a legacy DB; the relevant adversarial rows (§7) pass as tests; and flag-off byte-identity (SI-4) is proven. Green units alone are explicitly insufficient.
