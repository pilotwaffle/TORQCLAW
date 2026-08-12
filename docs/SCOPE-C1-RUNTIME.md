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
| TS suite | **1506 passed / 0 failed / 73 files** |
| Reachability | **PASS — 99 modules** (baseline 95; +4 C1 modules), `skillTrust.ts` still the only declared dormant |
| Gateway build | clean (`turbo run build --filter=@torqclaw/gateway...`, 6/6) |
| Built-artifact (§5(c)) | 3/3 — accept/refuse on booted dist, C1 migration self-run, A11 stale-dist |
| SI-4 flag-off | byte-identical wire transcript, **0 rows** in all three C1 state tables |
| Existing `authz.test.ts` | 61/61 — H-1 preserved every legacy decision |

**No DORMANT entry was added.** §5(b) wants slices removed from that list as
they gain entry points; all four new modules are transitively reachable from
`packages/gateway/src/server.ts`.

### Excluded from the run, with cause

Three files are excluded and are **not** C1 regressions — all three fail
identically on `master` in this worktree:

- `tests/failover/**`, `tests/collab-connect-dataflow.test.ts` — the
  worktree's Python venv is broken (`ModuleNotFoundError:
  pywin32_bootstrap`); the same tests fail on the main repo checkout.
- `tests/collab/harness.test.ts` — a 1M-UUID loop asserting `< 30000ms`,
  observed at ~48s under parallel load. Machine-speed assertion, not logic.

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
6. **Surface context is rebuilt per command**, never cached on the
   connection, so a revocation committing first is seen by the next command
   (§1.4).

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
