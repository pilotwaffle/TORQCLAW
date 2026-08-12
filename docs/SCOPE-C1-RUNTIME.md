# SCOPE — C1 Surface Identity RUNTIME

Branch `c1-runtime-work`, worktree `E:/TorqClaw-worktrees/c1-runtime`.
Spec: `docs/prd-reviews/PRD-TCLAW-COLLAB-GATEWAY-004.md` (revision 4, adopted).
Operator authorization for the C1 runtime build recorded 2026-08-11.

**NOT merged, NOT pushed.** No C2 work. A4–A10 untouched.

---

## 1. Status: all six C1 tickets landed

| Ticket | Commit | What landed |
|---|---|---|
| C1-1 surfaces + guarded migration | `414e773` | six-kind CHECK, `surface_role` discriminator defaulting `'agent'`, `capability_json` default `'[]'`, kind/role cross-CHECK |
| C1-2 credentials + verify | `de8b5c9` | `tq1_` issuance reusing `credentials.ts`, existence-oblivious verify incl. the expiry gate, plaintext once, buffer zeroed |
| C1-3 revocation cascade | `a5120be` | deny-first two-database coordinator, credential cascade on the same AUTH_FAILED path |
| C1-4 authority + H-1 | `a5120be`, `26162de` | `surface_authorities` store, grant/revoke/holds, CT-2 provisioning gate, H-1 subordination in `authz.ts` |
| C1-5 resume gate + origin | `624ede3` | ordered §2.6 3-step gate, request-keyed `gateway_task_origins` |
| C1-6 secret-free audit | `de8b5c9`, `26162de` | `collab_surface_audit` with write-time secret-key refusal |
| (ride-along) test harness | `4cf74de` | cross-process build-lock contention fix — see §5 |

## 2. Gates

| Gate | Result |
|---|---|
| TS suite | **1529 passed / 0 failed / 74 files** (post-G2A-round-1) |
| Reachability | **PASS — 99 modules** (baseline 95; +4 C1 modules), `skillTrust.ts` still the only declared dormant |
| Gateway build | clean (`turbo run build --filter=@torqclaw/gateway...`, 6/6) |
| Built-artifact (§5(c)) | **4/4** — self-migration of BOTH databases, accept/refuse, task-origin schema, A11 stale-dist |
| SI-4 flag-off | byte-identical wire transcript, **0 rows** in all three C1 state tables |
| Existing `authz.test.ts` | 61/61 — H-1 preserved every legacy decision |

**No DORMANT entry was added.** §5(b) wants slices removed from that list as
they gain entry points; all four new modules are transitively reachable from
`packages/gateway/src/server.ts`.

### Excluded from the run, with cause

Two paths are excluded and are **not** C1 regressions — both fail
identically on `master` in this worktree:

- `tests/failover/**`, `tests/collab-connect-dataflow.test.ts` — the
  worktree's Python venv is broken (`ModuleNotFoundError:
  pywin32_bootstrap`); the same tests fail on the main repo checkout.

**Correction (G2A round 1): the round-1 record also excluded
`tests/collab/harness.test.ts`, and that was an over-claim.** It passes —
19/19 in G2A's run and in re-verification here, and green in the full suite.
The single observed failure was a one-off timing blip on a 1M-UUID loop
under parallel load, not a standing condition. It is now un-excluded and
counted in the numbers above.

## 3. Deletion probes

Per `docs/SCOPE-GS-ROLLBACK.md` §8. Sabotage, confirm RED, restore.

| # | Deleted control | Result |
|---|---|---|
| 1 | Expiry moved OUT of the constant-cost credential gate | **GREEN first — see below**, then **RED** after strengthening |
| 2 | CT-2 `approve` provisioning gate disabled | **RED** — 2 failures (agent-role grant, channel-kind grant) |
| 3 | Epoch match dropped from `holdsAuthority` | **RED** — epoch-drift case |
| 4 | Step-2 live-projection requirement removed | **RED** — grant-last inert surface accepted |
| 5 | H-1 subordination removed (`return ALLOW`) | **RED** — 6 failures |

### Probe 1 is the finding worth keeping

Sabotaging the expiry gate so an expired credential is reported as
**non-existent** left the suite GREEN. HMAC-operation-count equality cannot
see that bug: the decoy compare simply replaces the real compare, so the
count stays at two while the work differs — an expired credential would skip
the real row's compare and become distinguishable from a revoked one by the
DB read it no longer performs.

The test now pins the **mechanism**, not just the cost: an expired
credential must still resolve to a real record whose stored HMAC is the
compare target, with only its reported state differing; an unknown id is the
only case yielding `undefined`. Re-probed: RED. Restored: green.

## 4. Defence-in-depth findings (recorded, not hidden)

Two controls could not be demonstrated in isolation because a second layer
independently refuses. Both are real robustness, but they mean a green
result on those paths proves less than it appears to:

1. **A11 could not be shown via the step-2 projection check.** With that
   check neutered in `dist`, an inert surface is still refused — the C0.1
   fallback looks the credential up in `principal_credentials`, does not
   find it, and refuses. Nor via a revoked surface: deny-first revocation
   kills the projection too. A11 therefore targets the credential-state
   gate, the one control with no second layer behind it.
2. **Probe 4 left A2 green.** The collab-side revocation cascade catches a
   revoked surface independently of the projection check.

## 5. The harness change, and why it is in this lane

C1 added two built-artifact test files, taking concurrent
`ensureGatewayBuild()` callers from four to six and exposing three latent
defects in the shared lock (Windows `EPERM` on `mkdir`, a throwing
`reclaimLock`, and six serialised `--force` rebuilds blowing the 180s
deadline). Left alone, C1 would have made the shared gate measurably
flakier for every other lane.

The freshness fast path does not weaken the built-artifact proof: the
artifact is still built from current source by whichever worker finds it
stale, and every other worker positively verifies no source file is newer
than the dist it boots. Verified in both directions — touching `server.ts`
makes the check fail and triggers a real rebuild. `collab-build-lock.test.ts`,
which tests the lock itself, deliberately bypasses the fast path and stays
6/6 green.

## 6. Design decisions a reviewer should check

1. **C1 gets its own recorded migration**, not an addition to
   `runCollaborationMigration`, which returns a complete no-op once its id is
   recorded (`migration.ts:44-50`). Folding C1 in would mean no existing
   installation ever sees the tables — the IF-NOT-EXISTS trap §2.10 names.
   Pinned by a test that re-runs the C0 migration and proves it does not
   create them.
2. **A new `collab_surface_audit` table** rather than new kinds on
   `collab_audit`, whose `kind` CHECK enumerates only C0 values. Adding kinds
   means replacing that CHECK — a destructive rebuild of a shipped table,
   forbidden by §1.5.
3. **The C0.1 fallback is retained** in `resolveConnectIdentity`. C1 is
   additive; an installation authenticating yesterday must authenticate
   today. The fallback yields no `ConnectionAuthContext`, so such a
   connection holds no C1 capability or authority and every C1 check it meets
   denies fail-closed.
4. **H-1 gates only `APPROVE_TOOL`.** C1 introduces exactly one authority
   token; gating unspecified commands would be scope drift with real lockout
   risk. Other operator commands intersect against a surface layer that
   currently constrains only `approve`.
5. **Secret-free audit is enforced at write time**, not by convention — a
   forbidden-key walk refuses the write. A documented-only convention is the
   unenforced-claim pattern this repo keeps re-learning.
6. **Surface context is read LIVE per command** — both the authority check
   and the role check.

   **Correction (G2A round 1).** The round-1 record claimed this was already
   true and it was only half true: `holdsAuthority` was always a live
   closure, but `surfaceRole` was a value copied from `connectionAuth` at
   connect and never refreshed. The sentence "never cached on the
   connection" was therefore accurate about the authority and wrong about
   the role. G2A reproduced the consequence live — see §8. Both are now
   functions closing over `state.db`.

## 7. Owed / explicitly out of scope

- **All of C2** (A4–A10): approval broker, `tool_approvals` columns,
  `gateway_action_grants`, `CTXHASH_V1`, delivery projection. C2-3 depends on
  C1-5, which is now landed.
- **`gateway_profile_delegations`** (§2.13) is specified but not created:
  no C1 ticket names it and nothing in C1 reads it. `captureTaskOrigin`
  therefore records auth epoch and capability revision but no
  `delegation_id`; C2 must add the column via the guarded-ALTER helper
  already provided (`addStateColumnIfMissing`).
- **Socket-close on revocation** (§2.5 "SHOULD have its socket closed with
  `surface_revoked`") is not wired. Revocation is observable at the next
  command and at resume, which is the contract's hard requirement; the
  proactive close is builder work left for C3's channel lane.
- **OQ-1** (capability classes vs exact operation ids) remains open. Storage
  supports both (`allowed_operation_ids_json` exists); no enforcement reads
  operation ids yet.
- **Wall-clock timing fixture** for existence-oblivious verify remains OWED
  from C0 — this slice asserts HMAC-operation counts plus the mechanism
  (probe 1), not wall-clock.

## 8. G2A round 1 — APPROVE-WITH-NOTES, two MINOR defects fixed

Verdict: no blocking defects. Two MINOR defects and two cosmetic notes,
all fixed on `c1-runtime-work`.

### DEFECT 1 (reproduced live by G2A) — stale `surfaceRole` defeated CT-2 demotion

`surfaceAuthz.holdsAuthority` was a live closure, but `surfaceAuthz.surfaceRole`
was copied from `connectionAuth` at connect (`server.ts:157`) and consumed at
`authz.ts:213` — never refreshed for the life of the socket.

The reachable consequence: an operator-role surface with a live `approve`
grant connects; the operator then DEMOTES it to `agent` through
`activateSurfaceProjection`'s `ON CONFLICT DO UPDATE` path **without**
revoking. The projection then says `agent`, but `revoked_at` is NULL and the
epoch is unchanged, so `holdsAuthority` stays true — and the connection's
stale `'operator'` role sails through the belt-and-suspenders check.
`authorize()` returned **ALLOW** for `APPROVE_TOOL`.

Fixed structurally on **both** routes G2A offered, belt AND suspenders:

- **(b) at the source.** `activateSurfaceProjection` now bumps `auth_epoch`
  on ANY role change, inside a transaction that reads the previous row and
  writes the new one atomically. Because `holdsAuthority` matches on the
  current epoch, every live grant dies at the authority seam itself — the
  invalidation no longer depends on each caller remembering to revoke first.
  The bump is deliberately **surgical**: a re-activation that does not change
  the role leaves the epoch and grants intact, because gratuitously
  destroying live grants on ordinary capability widening would make
  provisioning unusable and teach operators to route around the control.
- **(a) at the decision.** `SurfaceAuthzContext.surfaceRole` (a value) became
  `currentRole()` (a function). `server.ts` supplies
  `liveSurfaceSecurity(db, surfaceId)?.surfaceRole ?? null`; null denies.

Tests: `tests/collab-h1-operator-subordination.test.ts` gained three cases —
demotion-without-revocation on an already-open connection is refused
(**RED before fix: `expected true to be false`; GREEN after**), the epoch
bump kills the grant at the authority seam (**RED before: `expected 1 to be
greater than 1`; GREEN after**), and a same-role re-activation preserves the
epoch and grant. The suite's `ctxFor` helper now mirrors production by
reading the role live; only the deliberate role-mismatch case passes a
claimed role.

### DEFECT 2 — `collab.db` had no production migration caller

`getCollabDb()` opened the database but never migrated it. Neither C1
migration — nor **C0's `runCollaborationMigration`** — had any production
caller, and the built-artifact test had to create all three schemas by hand,
which is exactly why the gap survived: the test proved the tables could
exist, not that the shipped artifact could create them.

Fixed at the initialization seam: `getCollabDb()` now runs all **three**
migrations once, when the handle is first opened, so the fix is not
C1-partial. Each is independently guarded and idempotent. Failures are
swallowed by design — this is the connect path, and an unmigrated database
simply authenticates nobody (AUTH_FAILED, indistinguishable from an unknown
credential) rather than crashing the gateway.

The built-artifact test was strengthened to match: `bootAndMigrate()` boots
the real artifact against an empty data dir and asserts it created
`principals`/`principal_credentials` (C0), `surfaces`/`surface_credentials`
(C1-1/C1-2), `collab_surface_audit` (C1-6), exactly three rows in
`collab_schema_migrations`, and all three `state.db` C1 tables — before any
data is seeded. A second boot proves idempotency (still 3 rows). The collab
migrations are no longer imported by that test file at all, so the
hand-seeding cannot quietly return.

### NOTES (both fixed)

- `ops/reachability.mjs:68-78` said C1 "remains a future slice" — stale.
  Now records that C1 is reachable on its own (`server.ts → collabIdentity
  → surfaceGate → surfaceSecurity`, plus collab's `surfaces.ts` /
  `surfaceStore.ts`) while C2/C3/C4 remain future.
- The excluded-files list over-claimed: `tests/collab/harness.test.ts`
  passes 19/19. Un-excluded; §2 corrected.

### Post-fix gates

| Gate | Result |
|---|---|
| TS suite | **1529 passed / 0 failed / 74 files** |
| `collab-h1-operator-subordination` | 13/13 (was 10; +3 demotion cases) |
| `authz.test.ts` | 61/61 |
| Built-artifact | 4/4 (was 3; +self-migration proof) |
| Reachability | PASS — 99 modules |
| Gateway build | clean, 6/6 |
