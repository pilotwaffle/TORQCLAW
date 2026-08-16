# Phase 2A Gate 1 packet — inert identity schema and diagnostics

**Status:** **IMPLEMENTED + VERIFIED + SOL G2A APPROVED LOCALLY / UNMERGED + UNPUSHED / INERT AND NOT SHIPPED**

**Basis:** local, verified-but-unmerged/unpushed Phase 1 commit `37667e9`. Phase 2A starts only from that commit. This packet supersedes the earlier Phase 2 caller/reconciliation proposal.

## 1. Scope and invariant

Phase 2A is offline schema migration and non-authoritative diagnostics only. It creates no `AuthenticatedCaller`, `WeakSet` issuer, verified carrier, V2 session binding, launcher generation, lifetime mutex, freshness authority, browser session, credential, provisioning, or live protocol path.

> A Phase 2A diagnostic is evidence only. No V1 or future V2 runtime may consume it as authority, freshness, eligibility, startup admission, or a session/caller input.

No live `/ws` parser, `server.ts`, `sessions.resolve()`, C1 helper, root-token path, or production startup behavior may import a Phase 2A module. `MISMATCH`/`INVALID` is recorded only; it never refuses V1 startup or repairs state.

## 2. Exact marker evolution

`auth_runtime_state` remains the exact Phase 1 schema-1 V1 row. The only accepted state-ledger sets in the new binary are:

```text
{gateway-auth-foundation-001}
{gateway-auth-foundation-001,gateway-auth-identity-reconciliation-002}
```

Both require exact catalog shape and checked-in checksums. Any missing, duplicate, partial, unknown, extra, or checksum-mismatched ledger row, or a non-V1 marker, refuses through the existing pre-write fence. `runAuthFoundationMigration` no-ops on either complete set. Old `37667e9` accepts only the foundation-only set and rejects P2A state by design.

## 3. DDL and receipt isolation

Migration IDs are `collab-auth-identity-reconciliation-002` and `gateway-auth-identity-reconciliation-002`.

```sql
-- collab.db; collab_schema_migrations remains untouched
CREATE TABLE IF NOT EXISTS collab_auth_schema_migrations (
  id TEXT PRIMARY KEY,
  checksum_sha256 TEXT NOT NULL CHECK(length(checksum_sha256)=64 AND checksum_sha256 GLOB '[0-9a-f]*'),
  applied_at TEXT NOT NULL
);
ALTER TABLE surfaces ADD COLUMN connection_class TEXT NOT NULL DEFAULT 'none'
  CHECK(connection_class IN ('none','browser_bff','channel_dedicated','agent_node','diagnostic','benchmark_submit','acceptance_submit','fixture_operator'));
ALTER TABLE surfaces ADD COLUMN connection_class_revision INTEGER NOT NULL DEFAULT 1
  CHECK(connection_class_revision > 0);

-- state.db
ALTER TABLE gateway_surface_security ADD COLUMN connection_class TEXT NOT NULL DEFAULT 'none'
  CHECK(connection_class IN ('none','browser_bff','channel_dedicated','agent_node','diagnostic','benchmark_submit','acceptance_submit','fixture_operator'));
ALTER TABLE gateway_surface_security ADD COLUMN connection_class_revision INTEGER NOT NULL DEFAULT 1
  CHECK(connection_class_revision > 0);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gateway_surface_security_v2_tuple
  ON gateway_surface_security(surface_id,surface_kind,surface_role,connection_class,connection_class_revision);
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
```

Both DB migrations validate exact ledger/catalog/`PRAGMA table_info` state before each guarded change. Existing rows become `connection_class='none'`, revision `1`, preserving V1 but rendering them diagnostically ineligible. A wrong-shape column, partial receipt, extra ledger row, or checksum mismatch refuses. Phase 2A creates neither `gateway_v2_session_bindings` nor `auth_reconciliation_receipts`; those authority objects are deferred to Phase 3/4. State declares no cross-DB foreign key.

The collab offline seam supports only the shipped c2850f5 Collaboration Substrate v1 baseline: exact `principals` catalog/columns, the `principals_single_operator` partial index, the self-referential `principals(id)` foreign key, and the exact two recognized `collab_schema_migrations` rows (`20260806_001_collaboration_v1` and `20260811_002_surface_identity_c1`) with valid UTC receipts. Missing, extra, malformed, or ambiguous base objects refuse before the Phase 2A migration, snapshot, or diagnostic write; this validator does not invent or repair a second collab schema truth.

## 4. Canonical checksums and diagnostic hashes

Each migration checksum is exactly:

```text
UTF-8(migrationId) || 0x0A || UTF-8(LF-normalized canonicalProgram)
```

`canonicalProgram` is the deterministic `AUTH_PHASE2A_PROGRAM_V1` serialization of the ordered manifest. Each step frames `kind`, UTF-8 byte length/name, and LF-pinned UTF-8 payload; `assert` payloads identify the exact versioned validator, `ddl` payloads are the exact statements executed, and the empty `receipt-boundary` step binds the receipt position without including its SQL or values. It excludes ledger-receipt inserts, diagnostic-row inserts, wall-clock values, DB paths, and runtime values. Source publishes literal golden vectors `{id, programUtf8Hex, sha256Hex}` and tests recompute byte-for-byte. CRLF, separator, ordering, or receipt-inclusion drift fails.

Tuple diagnostics are non-authoritative. Hash each eligible tuple in field order `principal_id,surface_id,surface_kind,surface_role,connection_class,connection_class_revision`; each field is `u32be(utf8ByteLength)||utf8Bytes`; rows sort by that binary encoding, then SHA-256 applies. Revisions require SQLite `typeof(...)='integer'`, fall in the checked safe positive range, and encode as canonical base-10 ASCII. TEXT or REAL revisions refuse rather than coerce. No delimiter, JSON, locale collation, or numeric coercion is allowed. Ledger hashes use the same length-prefix encoding.

## 5. Eligibility and mappings

Eligible only: principal `status='active'`, surface `state='active'`, positive integer revision, and:

| class | allowed kind / role | diagnostic role |
|---|---|---|
| `browser_bff` | `desktop|mobile` / `operator` | operator |
| `channel_dedicated` | `http` / `agent` | channel |
| `agent_node` | `desktop|mobile|http` / `agent` | node |
| `diagnostic` | non-automation kind and non-automation role | node |
| `benchmark_submit` | `http` / `agent` | channel |
| `acceptance_submit` | `http` / `agent` | channel |
| `none` | legacy | ineligible |

An inactive row or `none` row is ineligible. A data row with a bad non-`none` class mapping produces a diagnostic `INVALID`. Schema or ledger invalidity refuses before any diagnostic write. `fixture_operator` is unconditionally excluded from every production diagnostic. It may exist only through an isolated test helper; this is not a production database field, environment switch, CLI option, or authority input.

No Phase 2A producer writes a non-`none` production class, so zero eligible real tuples is an expected successful diagnostic.

## 6. Offline protocol, recovery, and files

The separate offline CLI requires `--offline`, explicit `--collab-db` and `--state-db` paths, and existing regular files. It uses only existing dependencies. The flag is an operator assertion, not proof that services stopped. The entry must never be imported from startup or live helpers.

The tool obtains exclusive write locking separately on collab then state and refuses if either is unavailable. It does not claim to prove services are off, use `ATTACH`, use a Windows lifetime mutex, or hold overlapping DB transactions.

1. Validate/migrate collab in one collab transaction; commit and release.
2. Read collab tuples/hashes; close read scope.
3. Validate/migrate state in one state `BEGIN IMMEDIATE`; commit.
4. Read state tuples and write one `non_authoritative=1` diagnostic `MATCH`/`MISMATCH`/`INVALID`; commit.

Collab commit followed by state failure/crash is recovered by rerun. It never repairs/provisions/revokes a surface, credential, capability, authority, grant, or session. A diagnostic cannot affect listener behavior.

Diagnostic IDs and timestamps use one checked canonical format. Hash fields are exact lowercase 64-hex. `detail_code` is a bounded enum and contains no raw principal, surface, credential, path, or other identifier.

Allowed: isolated collab migration/read module and minimal export; isolated gateway state migration/diagnostic module; `authRuntimeMarker.ts` exact ledger-set extension; explicit offline CLI; focused tests/offline fixtures. Prohibited: `server.ts`, `sessions.ts`, `collabIdentity.ts`, `surfaceGate.ts`, live C1 helpers, `authz.ts`, `skillDecision.ts`, Phase 4, contracts/generated schemas, Hermes, console, launcher, C2, root-token config, WebAuthn/TLS/BFF, credential issuance, provisioning, revocation, and production services. No caller/factory/binding production module or `ForTest` authority API exists.

## 7. Evidence, mutants, and stop conditions

Required tests: clean-worktree protected-path diff audit; per-DB fresh-current-base/legacy-current-base/idempotent/partial/corrupt/checksum-tampered/extra-ledger/missing-column cases; complete state-ledger-set matrix and old Phase 1 rejection; fault injection at every DDL/receipt boundary with exact rollback/rerun; golden checksum/hash vectors; collab-first/state-failure rerun with no overlapping transaction trace; eligibility matrix including inactive/none/invalid/fixture/zero cases; `non_authoritative=1` only with unchanged V1 startup/root/C1/Phase4 observable behavior and traces; static and built-artifact evidence that Phase 2A is unreachable from server/live helpers/session resolver and has no authority API.

Mutants must fail if they treat diagnostics as authority; issue caller/binding; claim cross-DB snapshot/lifetime mutex; accept incomplete/extra ledgers; include receipt/diagnostic insertion in checksum bytes; use ambiguous hash encoding; coerce TEXT/REAL revisions; include inactive/unmapped tuples; admit fixture operator outside the test helper; repair/provision/revoke to converge; or reach V1 runtime. Protected Phase 4/contracts/Hermes changes also fail.

Stop and return to Gate 1 if implementation needs a verified carrier, caller/factory/binding, V2 frame path, production startup refusal, credential/provisioning/revocation, C2/root-token/cutover/launcher behavior, Windows Credential Manager, lifetime mutex/job/pipe, contracts/generated/Hermes, or protected Phase 4 changes.

Phase 2A exits only with inert migration/diagnostic evidence while V1 production observable behavior and traces remain compatible and diagnostics have no authority effect. Running the offline tool against any real database remains an operator-controlled action and is not authorized by implementation approval.
