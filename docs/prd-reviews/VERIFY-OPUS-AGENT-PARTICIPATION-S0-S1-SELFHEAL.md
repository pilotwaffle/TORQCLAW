# G1R Independent Verification — S1 agent identity · operator C1 self-heal · S0 argument-scoped grants

**Seat:** G1R — Independent Verifier.
**Model disclosure:** The routing profile names **Opus 5** for this seat and I **am** `claude-opus-5`.
**No substitution was made.** Fresh thread, no authoring context.

**Repo:** `E:\TorqClaw` · **Branch:** `phase1-server-owned-authority` · **HEAD:** `a676736`
**Diff range:** `8798bca..a676736` (three commits: `7ac78fb`, `12ea0fc`, `a676736`)
**Date:** 2026-08-17.

---

## VERDICT: **REQUEST_CHANGES**

**Two of the three slices earn approval on execution. The third — the operator C1 self-heal
(`12ea0fc`) — carries a defect I reproduced empirically on the real booted gateway, twice.**

- **S1 agent identity (`7ac78fb`) — APPROVE.** The authz widening is exactly one action wide,
  `agentCollabWrite` is provably not client-influencable, `automation_surface` is genuinely
  excluded, and the builder's `getPrincipalKind` removal argument holds. Its tests are real
  deletion-probes driving the real path.
- **S0 argument-scoped grants (`a676736`) — APPROVE WITH ONE CONDITION.** The scope expansion
  was necessary and I verified the argument from source. SI-4 is genuinely preserved by the
  evidence gate, not by coincidence. FRONTIER is untouched. **But its behavioral tests do not
  test the shipped closure** — 13 of 14 pass against the unfixed code (proved by mutation).
- **Operator C1 self-heal (`12ea0fc`) — BLOCKED on B-SH-1.** The `already` guard reads only
  `surfaces`, so **any** incomplete provision state permanently disables the self-heal and
  permanently bricks the operator's ability to post. I reproduced two distinct poison states
  end-to-end on the booted artifact.

**The self-heal is NOT principal synthesis** — that question I answer cleanly in its favor,
with evidence, below. The blocker is durability, not authority.

---

## BLOCKERS

### B-SH-1 — A partially-provisioned surface PERMANENTLY bricks the operator, and the self-heal will never retry

**Slice:** `12ea0fc` (operator C1 self-heal).
**Severity:** BLOCKER. Reproduced empirically, twice, on the real gateway over a real websocket.

**The mechanism.** `ensureOperatorSurfaceProvisioned`
(`packages/gateway/src/collabIdentity.ts:328-332`) opens with:

```
const already = collabDb
  .prepare('SELECT 1 FROM surfaces WHERE principal_id = ? AND surface_role = ?')
  .get(operatorPrincipalId, 'operator');
if (already) return; // already provisioned by an earlier connect
```

That guard consults **only** `collab.db`'s `surfaces` table. But a complete provision requires
**three** writes across **two** databases:

1. `INSERT INTO surfaces` (collab.db) — inside `tx()`
2. `INSERT INTO surface_credentials` (collab.db) — inside `tx()`
3. `activateSurfaceProjection(stateDb, …)` (**state.db**) — **outside `tx()`**, line 375

Writes 1–2 are atomic with each other. **Write 3 is not atomic with them.** It is a separate
database, executed after `tx()` returns, at `collabIdentity.ts:375-384`. Any failure between
the commit of `tx()` and the completion of write 3 — a thrown `AuthorityError`, a closed
handle, a disk error, or simply the process dying — leaves collab.db provisioned and state.db
empty.

**Why that state is permanent.** On the next connect:
- `validatePresentingSurface` runs first (`collabIdentity.ts:428`). It calls
  `liveSurfaceSecurity(deps.stateDb, verified.surfaceId)` (`surfaceGate.ts:105-106`) and
  **returns null when the projection is absent** — `if (live === null) return null;`.
- So `ctx` is null and control falls to the legacy branch, which calls
  `ensureOperatorSurfaceProvisioned` again.
- The `already` guard now finds the orphaned `surfaces` row and **returns immediately**,
  never re-attempting write 3.
- `ctx2` is therefore null too, and the function returns `{ …, auth: null }` — the exact
  pre-fix broken state, now unrecoverable by the self-heal for the life of the install.

**Empirical proof — probe 1 (partial provision).** I seeded exactly what `tx()` commits
(`surfaces` + `surface_credentials` rows, correct `secret_hmac`), with `activateSurfaceProjection`
never having run, then booted the real gateway and connected the real operator credential:

```
G1R-PROBE FRAMES: [{"type":"CONNECTED",…},{"type":"ERROR","code":"COLLAB_IDENTITY_REQUIRED"}]
G1R-PROBE: messageEvents=0 surfacesRows=1 stateProjections=0
```

The operator is refused `COLLAB_IDENTITY_REQUIRED` and **zero** message events commit. The
`stateProjections=0` reading confirms the self-heal did not retry write 3.

**Empirical proof — probe 2 (orphan surfaces row, no credential link).** A `surfaces` row with
no matching `surface_credentials` row produces the identical permanent failure:

```
G1R-PROBE2 FRAMES: [{"type":"CONNECTED",…},{"type":"ERROR","code":"COLLAB_IDENTITY_REQUIRED"}]
G1R-PROBE2 messageEvents=0
```

**On the builder's disclosed race — the disclosure is accurate but incomplete, and the
conclusion is right for the wrong reason.** I tested the losing writer's transaction directly:

```
LOSER THREW: SQLITE_CONSTRAINT_UNIQUE
surfaces rows:            [ { surface_id: 's-win' } ]     ← loser's row rolled back
surface_credentials rows: [ { credential_id: 'c1', surface_id: 's-win' } ]
```

`surface_credentials.secret_hmac` is `BLOB NOT NULL **UNIQUE**` and `credential_id` is the
PRIMARY KEY (`packages/collab/src/surfaces.ts:85-95`), so the loser conflicts and
`better-sqlite3`'s `db.transaction()` rolls **both** its INSERTs back atomically. **The
concurrency race the builder disclosed does NOT produce a half-written surface — that specific
degradation is genuinely safe, as claimed.** But the builder's framing ("swallowed by
try/catch, falls back to legacy for ONE connection") treats the race as the only partial-write
vector. **It is not.** The un-transacted cross-database write 3 is, and it produces a state
that is not one-connection-degraded but permanently bricked.

**Failure scenario.** Fresh install, `TORQCLAW_COLLAB_ENABLED=1`. Operator connects for the
first time. `tx()` commits. The gateway is killed (Ctrl-C, OOM, host restart, deploy) before
`activateSurfaceProjection` completes — a window of one cross-database write on the connect
path. From then on the operator can never post to any channel, on any connection, forever. The
self-heal that exists to fix exactly this class of breakage is the thing that refuses to run.
The operator's symptom is identical to the pre-fix bug the slice was written to close.

**Suggested fix.** Make the guard reflect what "already provisioned" actually means — all
three writes, across both databases. Minimum:

```
const already = collabDb.prepare(
  `SELECT 1 FROM surfaces s
     JOIN surface_credentials sc ON sc.surface_id = s.surface_id
    WHERE s.principal_id = ? AND s.surface_role = 'operator'
      AND s.state = 'active' AND sc.state = 'active'`
).get(operatorPrincipalId);
if (already && liveSurfaceSecurity(stateDb, <thatSurfaceId>) !== null) return;
```

and, when the collab rows exist but the projection does not, **re-run
`activateSurfaceProjection` for the existing `surface_id`** rather than returning. That is
idempotent by construction — `activateSurfaceProjection` is already an
`INSERT … ON CONFLICT(surface_id) DO UPDATE` (`surfaceSecurity.ts:258-270`) — so the repair is
safe to run on every connect. Note the role-change epoch bump at `surfaceSecurity.ts:246-252`
is not triggered here, because the re-activation carries the same `surface_role`.

**Falsifiability requirement for the fix.** The probe must seed the partial state and assert
the operator's message **commits** (`messageEvents === 1`), not that a frame was emitted — and
must be shown RED against the current `already` guard. My probe 1 above is exactly that test
and is currently RED; it can be adopted directly. It ran on the real booted gateway, so it
satisfies the "verify the artifact, not the unit test" rule.

---

### B-S0-1 — The S0 fence's behavioral tests do not exercise the shipped closure; 13 of 14 pass against the unfixed code

**Slice:** `a676736` (S0).
**Severity:** BLOCKER (test integrity), not a runtime defect. The **code** is correct; the
**evidence** does not establish it.

**This is instance seven of the program's recurring pattern**, and it is simultaneously
instance six of the "tested the wrong unit" pattern — the two failure modes coincide here.

`tests/collab-c2-s0-flag-independent-fence.test.ts:148-159` defines:

```
function localEdgeAdmissionCheck(requestId, toolName, args) {
  const carriesGrant = db.prepare(
    'SELECT 1 FROM gateway_action_grants WHERE dispatch_request_id = ?').get(requestId) !== undefined;
  if (!carriesGrant) return { ok: true };
  const result = admitToolCall(db, { dispatchRequestId: requestId, toolName, args, path: 'LOCAL_EDGE' });
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}
```

This is a **hand-rolled replica** of the `setToolAdmissionCheck` closure at
`packages/gateway/src/server.ts:167-176`, not the closure itself. It is a copy that *already
has the fix applied*. No behavioral assertion in the file can observe a regression in the
shipped closure, because no behavioral assertion ever calls it. **The builder discloses this
honestly in the comment at lines 143-146** ("without booting a real Fastify server per test"),
which is to the builder's credit — but disclosure is not coverage.

**Proved by mutation, not by argument.** I restored the removed gate to the real
`server.ts:168`:

```
setToolAdmissionCheck((requestId, toolName, args) => {
  if (!collabEnabled()) return { ok: true }; // G1R MUTATION PROBE
```

I confirmed the mutation applied by grepping the file (not by trusting an exit code, and not
through `python3`, which does not exist on this host). Result:

```
Test Files  1 failed (1)
     Tests  1 failed | 13 passed (14)
```

**Exactly one test caught it — `STRUCTURAL: the setToolAdmissionCheck closure does not gate on
collabEnabled()` (line 309), a `readFileSync` + `.not.toContain('collabEnabled')` source-text
assertion.** All 13 behavioral tests stayed green against the reintroduced hole.

**Why this matters more than "there is at least one guard."** The surviving guard is a regex
over source text. It fails against a semantically identical reintroduction that does not use
the literal token `collabEnabled` — e.g. hoisting the flag read to a module constant, wrapping
it as `isCollabOn()`, or gating on `process.env.TORQCLAW_COLLAB_ENABLED` directly. **The fence
is currently protected by grep, not by execution.** G1R Gate-1's own B-1 fix requirement (2)
was explicit: *"the falsifiability probe must exercise the LOCAL_EDGE handle the assertion
reads … Then remove the fence and show the test turns RED."* That requirement is not met for
the consumer half.

**Mitigating facts, stated fairly.** The producer half *is* covered end-to-end: the
`describe` block at line 347 boots the real gateway and asserts a real `gateway_action_grants`
row is minted with the flag unset. And `tests/collab-c2-flag-on-e2e.test.ts` drives the real
closure on a booted artifact (flag-on). So the shipped closure is not wholly untested — it is
untested **in the flag-off configuration the slice exists to fix**.

**Suggested fix.** Extend the existing booted-gateway `describe` (line 347, which already has
the harness wired) with one flag-off case that drives a real LOCAL_EDGE dispatch carrying a
C2 grant and asserts, by **side-effect absence**, that a mismatched-args invocation does not
execute the tool. Then show it RED against the reintroduced gate. One test closes this.

---

## RULING — `allowedCapabilityClasses: ['read','write','exec','send']`

**Correct as written? NO — narrow it now.** Recommendation: **`[]`**.

**Verified fact.** `allowed_capability_classes_json` is written by `activateSurfaceProjection`
(`surfaceSecurity.ts:276`) and read back by `liveSurfaceSecurity` (`surfaceSecurity.ts:307`,
`:328`). Across all of `packages/gateway/src`, **no code path consults the returned
`allowedCapabilityClasses` array as an authorization gate.** I grep-verified every occurrence;
the only readers are the projection round-trip and the migration/marker column manifests. So
granting all four classes changes **no** live behavior today. The builder's flag was correctly
raised and the field is correctly identified as currently inert.

**Why the builder's justification does not survive.** The stated rationale is "preserving the
operator's prior unconditional legacy authority." That framing is wrong on the facts: the
operator had **no** capability-class authority before this slice, because the operator had **no
surface row at all** — that absence is the entire defect being fixed. There is nothing to
preserve. The self-heal is not restoring a prior grant; it is **choosing a value for a field
that has never had one for this principal**. Choosing the maximum is a decision, not a
continuation.

**Why `[]` is right and `['read','write','exec','send']` is a latent widening.** The field is
dormant *today*. The moment any future slice adds `if (!live.allowedCapabilityClasses.includes(cls)) deny`,
every self-healed operator surface silently arrives pre-authorized for `exec` — the highest-
consequence class in the enum — and does so through a **connect-path auto-provisioning
routine** that no human ever reviewed for that specific install. That is the program's own
unenforced-claim pattern running in reverse: a value that means nothing now, that will mean
everything later, written by a self-heal.

Two further points make `[]` the safe default rather than a merely cautious one:

1. **`[]` is the schema's own default** — `allowed_capability_classes_json TEXT NOT NULL
   DEFAULT '[]'` (`surfaceSecurity.ts:75`, `authIdentityMigration.ts:43`). Matching the
   declared default is the smaller, more legible change.
2. **Fail-closed is this repo's stated posture for exactly this axis.** G1R Gate-1 §2A.4
   records `capability.ts:172`'s rule verbatim: *"P6: fail-closed default … UNKNOWN NEVER
   MEANS READ."* An empty capability set is the fail-closed value; a full one is its inverse.

If a future enforcement gate needs the operator to hold capability classes, that gate's own
slice should provision them deliberately, through a reviewed path, with its own tests —
`activateSurfaceProjection`'s `ON CONFLICT DO UPDATE` makes widening later trivial and safe.
**Narrowing later, after installs have accumulated `exec`-bearing self-healed rows, is not
trivial.** Take the reversible direction.

**Note:** this is a judgment ruling on a currently-inert field, not a live vulnerability. It
does not independently block the slice; it should be folded into the B-SH-1 fix.

---

## A. THE SELF-HEAL — is it principal synthesis?

### **NO. It is projection of an already-verified principal. This is refuted cleanly.**

**It runs ONLY after cryptographic verification. Traced in full.**

`resolveConnectIdentity` (`collabIdentity.ts:418-489`) reaches the self-heal only via:

1. `getSecretStore().get(PRINCIPAL_PEPPER_SECRET_NAME)` — `if (!pepper) return null` (`:422-423`).
   No pepper, no path.
2. `validatePresentingSurface(...)` returns null (C1 miss) — `:428-431`.
3. `verifyLegacySurfaceAuthority(credential)` returns non-null — `:446`. **This is the
   cryptographic gate.** Inside it (`:248-273`): `verifyCredential(credential, pepper, lookup)`
   and `if (!result.ok) return null` (`:257-258`). `verifyCredential`
   (`packages/collab/src/credentials.ts:205-241`) computes `hmacSha256(principalPepper,
   presentedBytes)` and `safeCompare32` against the stored `secret_hmac`; a mismatch, an
   unparseable token, an unknown id, or a non-`active` credential state all return
   `{ok:false}`.
4. Then `if (!authority || authority.principalStatus !== 'active') return null` (`:261`).
5. Only then, at `:455`: `if (legacy.principalKind === 'operator')`.

**No unverified caller can trigger it.** Every input to the self-heal
(`legacy.binding.surfaceId`, `legacy.binding.principalId`) is derived from the verified
`result.credentialId` and a DB read keyed on it — never from a client frame. `ConnectFrameSchema`
(`packages/contracts/src/commands.ts:225-239`) carries only `role`/`expectedRole` (compatibility
assertions), `token`, `sessionId`, `clientInfo`, and `auth: {kind, credential}`. **There is no
`principalId`, no `authClass`, and no `principalKind` field on the wire at all.**

**Can it provision for a NON-operator? No — three independent barriers.**

1. **The explicit gate**, `collabIdentity.ts:455`: `if (legacy.principalKind === 'operator')`.
   `principalKind` comes from `principalAuthorityForCredential`'s
   `SELECT … p.kind AS principalKind … JOIN principals p ON p.id = pc.principal_id`
   (`:176-186`) — a DB read on the row the verified credential points at, not a caller
   assertion. Its enclosing condition is `legacy !== null` (`:447`), i.e. post-verification.
   There is no `else`, no default, and no fallthrough that reaches the provisioning call.
2. **A second DB check inside the function**, `:334-337`:
   `SELECT secret_hmac … WHERE id = ? AND principal_id = ?` — `if (!credRow) return`. The
   credential must belong to that exact principal.
3. **The schema itself.** `CREATE UNIQUE INDEX principals_single_operator`
   (`packages/collab/src/migration.ts:70`) permits **at most one** operator-kind principal per
   installation. Even a hypothetical gate bypass could not manufacture a second operator.

**The no-new-secret property: VERIFIED TRUE.** The `surface_credentials` INSERT
(`:354-360`) binds `legacyCredentialId` (the *existing* `principal_credentials.id`) and
`credRow.secretHmac` — the bytes read verbatim at `:334-336`. There is no call to
`issueSurfaceCredential`, no `randomUUID()` used as a secret (the one `randomUUID()` at `:339`
is the non-secret `surface_id`), no HMAC recomputation, and no re-derivation. The value is
never logged and never returned — the function's return type is `void`, and both
`writeSurfaceAudit`'s payloads (`:361-367`) carry only ids and metadata, never the hmac.
`verifySurfaceToken` (`packages/collab/src/surfaces.ts:193+`) recomputes the HMAC from the
presented token bytes and compares against whatever `secretHmac` the lookup returns, so the
same physical token verifies against either table under the identical pepper. **The builder's
claim is accurate in every part.**

**Verdict on §2a:** the subject before and after is the same already-verified principal, with
the same secret, projected into the table C1 reads. This is not synthesis, and I say so
plainly.

---

## B. S1's AUTHZ BRANCH

**Does the node arm admit ONLY `POST_CHANNEL_MESSAGE`? YES.** `authz.ts` node branch:

```
if (role === 'node') {
  if (cmd.action === 'POST_CHANNEL_MESSAGE' && ctx.agentCollabWrite === true) return ALLOW;
  return DENY_NOT_PERMITTED;
}
```

The conjunction is on a strict `=== true` (so `undefined`/truthy-but-not-true both deny) and
an exact action-string equality. Every other action falls to the unconditional
`DENY_NOT_PERMITTED`. Pinned behaviorally by
`tests/agent-participation-s1-authz.test.ts` (`SUBMIT_PROMPT` and `APPROVE_TOOL` both deny
with `agentCollabWrite: true`).

**Can a client influence `agentCollabWrite`? NO — traced to a verified source.**

`server.ts:390`: `const agentCollabWrite = agentCollabPrincipalId !== null && agentParticipationEnabled();`

- `agentParticipationEnabled()` (`collabSurface.ts`) reads `process.env` only, and requires
  `collabSurfaceCommandsEnabled()` first — server-side config, unreachable from the wire.
- `agentCollabPrincipalId` is set at exactly one site, `server.ts:301`, inside the
  post-authentication block, guarded by
  `agentParticipationEnabled() && isAgentSurfaceCaller(caller.authClass, caller.binding)`.
  Its value is `caller.binding!.principalId`.
- `caller` is the return of `authenticateConnection`, whose surface arm is the `resolveSurface`
  closure (`server.ts:257-262`) → `resolveConnectIdentity(credential)` → the verified chain in
  §A above. `caller.authClass` is produced **only** inside `collabIdentity.ts` (the C1 and
  legacy branches) or as hardcoded literals `'channel_service'` / `'legacy_gateway'` in
  `connectionAuth.ts:69,77,80`. It is never read from a frame.
- The ConnectFrame schema carries no field that could reach it (see §A).

**Confirmed: not client-influencable.** A client's only lever is *which credential it
presents*, and that must pass HMAC verification against a principal whose DB `kind` is
`'agent'`.

**Does `authClass` ever disagree with the DB kind? NO — the builder's reasoning holds.**
Both `authClass` values that can yield `'agent_surface'` are computed in `collabIdentity.ts`
from the same synchronous read that produced `role`:
- C1 branch (`:437-441`): `operator = authority.principalKind === 'operator' && ctx.surfaceRole === 'operator'`;
  `authClass = operator ? 'operator_surface' : ctx.surfaceRole === 'automation' ? 'automation_surface' : 'agent_surface'`.
- Legacy branch (`:480-481`): `authClass = legacy.principalKind === 'operator' ? 'operator_surface' : 'agent_surface'`,
  where `principalKind` is the DB `p.kind`.

A re-read in `server.ts` would query the **same** `collab.db` handle (`getCollabDb()` caches a
single handle for the module's lifetime, `:148-159`) within the same synchronous connect turn.
No reachable input can make the two reads disagree. **The removal is correct, and the builder's
mutation finding is sound.** Defence-in-depth is preserved differently and better: `binding != null`
is a second required conjunct in `isAgentSurfaceCaller`, and `assertChannelVisible` in the
substrate independently decides membership.

**Is `automation_surface` genuinely excluded? YES.** `isAgentSurfaceCaller` requires the exact
string `'agent_surface'`. A C1 surface with `surfaceRole === 'automation'` takes the
`'automation_surface'` arm at `collabIdentity.ts:439-440` and returns false. This is pinned by a
dedicated test that names it as the distinguishing case
(`tests/agent-participation-s1-authz.test.ts:29-35`) — and correctly notes that `role` alone
cannot tell them apart, which is exactly why `authClass` is the right gate.

**Manifest re-pin:** `authz.ts`'s SHA moved
`cb2b76b4…` → `e638b97e…` in `tests/auth-v2-phase1.test.ts:779`, with the change documented
in the surrounding comment and the "never delete this pin" instruction preserved. Correct
handling of a protected-manifest file. `tests/auth-v2-phase1.test.ts` passes 49/49.

---

## C. S0's FLAG REMOVALS

**Was the three-gate expansion necessary? YES — verified from source, not accepted on
assertion.** `INSERT INTO gateway_action_grants` appears exactly **once** in the entire
codebase: `packages/gateway/src/approvalWriter.ts:513`, inside `decideC2Approval`'s APPROVE
arm. Its only caller is `c2Broker.ts:312`, inside `decideApprovalC2`. Therefore with
`decideApprovalC2` still flag-gated, **no grant row could ever be minted**, `carriesGrant`
would be permanently false in the consumer, and removing only the `server.ts` gate would have
produced a fence that is syntactically un-flagged and semantically still vacuous. **The builder
expanded scope for a correct reason and the expansion was required, not opportunistic.** This
matches G1R Gate-1's own §2A.2 finding that "removing only one leaves the seam inert via the
other."

**Is SI-4 preserved, and is the distinction real? YES to both — this is not a fixture
coincidence.** The mechanism is structurally independent of the removed flag:

- `registerApprovalC2` → `resolveContext` (`c2Broker.ts:69-79`) → `taskOrigin(db, req.id)`;
  `if (!origin) return null`.
- `gateway_task_origins` rows are written **only** by `recordTaskOrigin`
  (`server.ts:93-115`), whose **first line is `if (!collabEnabled() || auth === null) return;`**
  — that gate was **not** removed by this slice.
- So with the flag off, no origin row is ever written, `resolveContext` returns null,
  `registerApprovalC2` returns null, and the caller (`dispatch.ts:355`) falls to the legacy
  registration. **No C2 row is written.**

The distinction the builder draws — *the flag gate was removed, the evidence gate remains* — is
therefore **real and load-bearing**, not an artifact of the test fixtures. Confirmed
empirically: `tests/collab-c2-flag-off-identity.test.ts` passes both the APPROVE and REJECT
byte-identity transcripts on the booted artifact.

**A second evidence gate independently guarantees it.** `resolveContext` also requires
`liveProfileDelegation(db, origin.surfaceId, profile.profileId)` (`c2Broker.ts:79`). I verified
that `grantProfileDelegation` (`surfaceSecurity.ts:517`) — the sole writer of
`gateway_profile_delegations` — has **zero production callers** anywhere in `packages/`,
`ops/`, or `apps/`. So even a task that acquires an origin still cannot complete C2
registration in a default install. SI-4 is double-protected.

**Is the `!carriesGrant ⇒ ok:true` gap correctly characterized? YES, and the TODO is in the
right place.** The arm is preserved verbatim at `server.ts:169-170` with a `TODO(S3/cron
prerequisite)` naming the exact missing signal. I confirm the characterization on two points:

- **The gap is real.** A future cron or auto-reply caller reaching this seam with a populated
  `grantedTools` and no grant row would be admitted, exactly as G1R Gate-1's B-1 fix
  requirement (ii) anticipated.
- **It is not reachable today.** There is no unattended-run caller in the tree — no cron
  scheduler, no auto-reply loop — so no caller can currently exploit it. Closing it now would
  require inventing the `isUnattendedRun(requestId)` signal the TODO names, which does not
  exist; and refusing on `!carriesGrant` unconditionally would break the D-3/SI-4 legacy arm
  that `tests/collab-c2-flag-off-identity.test.ts` pins. **Deferring is the correct call**, and
  the TODO sits at the exact line a future implementer must edit. This is honest scoping, not
  an unenforced claim — the slice does not assert the gap is closed.

**Is FRONTIER untouched? YES.** `dispatch.ts:505-508`:

```
function frontierGrantFenced(req: GatewayRequest, diag: RouterDiagnostics): boolean {
  return diag.tier === ComputeTier.FRONTIER
    && (req.payload.grantedTools?.length ?? 0) > 0;
}
```

No `collabEnabled()` term; the diff range does not touch `dispatch.ts` at all. Both call sites
(`:262`, `:558`) route to `refuseFrontierGrantedRun`. `tests/frontier-grant-fence-unconditional.test.ts`
passes, and `tests/collab-c2-flag-on-e2e.test.ts` confirms the refusal on the booted artifact
for both the legacy-dispatch and provider-failover legs.

**B-7 (boot sweeps).** The three sweeps are correctly hoisted out of `if (collabEnabled())`
(`server.ts`, post-`connectBridge` block), wrapped in their own try/catch that logs and
continues. The delivery-projection rebuild stays flag-gated, and the comment states why
(UI-delivery routing, out of scope). That split is defensible and correctly scoped to the task.

---

## D. INTERACTION BETWEEN THE THREE SLICES

**Does the self-heal make `connectionAuth` non-null for operators in a way that changes S0's
`carriesGrant` behavior? YES it changes reachability — but NO, it does not open anything.**
This is the sharpest interaction in the range and it lands safe, on a fact the builder did not
cite:

- Pre-self-heal: operator `connectionAuth === null` ⇒ `recordTaskOrigin` returns early ⇒ no
  origin ⇒ C2 registration always declined ⇒ no grant ⇒ `carriesGrant` always false for
  operator traffic.
- Post-self-heal (flag on): `connectionAuth` is now **non-null** for the operator ⇒
  `recordTaskOrigin` **does** capture an origin ⇒ `resolveContext`'s first gate now passes.
  This is a genuine expansion of what C2 registration can reach.
- **But it still stops at the second gate.** `liveProfileDelegation` returns null, because
  `grantProfileDelegation` has **no production caller** (verified above). So
  `resolveContext` still returns null, registration still declines to legacy, no grant row is
  minted, and `carriesGrant` stays false. **Net behavioral change today: none.**

**This is safe by accident, not by design, and it should be recorded as such.** The moment a
future slice wires `grantProfileDelegation` into a production path, operator traffic will begin
minting real C2 grants and flowing through the exact-action fence for the first time — a
material change in approval semantics, arriving as a side effect of two unrelated slices
composing. It is not a defect now. It is a landmine for whoever ships profile delegation, and
they will not be looking here. **Recommend a note in that slice's scope, not a change here.**

**Other scenarios constructed — all safe:**

- **An agent connection hitting the operator self-heal.** Cannot occur. The self-heal's gate
  is `legacy.principalKind === 'operator'` (`collabIdentity.ts:455`) and agent credentials take
  the untouched legacy return at `:480-482`. Verified by test A1-a/A1-b, which drive real agent
  credentials end-to-end and never produce a `surfaces` row for the agent.
- **`agentCollabPrincipalId` vs `connectionAuth.principalId` disagreement.** For a legacy-path
  agent (the only kind `createAgent` mints), `connectionAuth` is null and
  `agentCollabPrincipalId` holds the verified id, so `agentCollabPrincipalId ?? connectionAuth?.principalId`
  (`server.ts:751`) resolves to the agent. For a hypothetical C1 agent surface, both derive
  from the **same** `ctx`/`binding` in the same `resolveConnectIdentity` call, so they cannot
  diverge. For an operator, `agentCollabPrincipalId` is structurally always null
  (`isAgentSurfaceCaller` rejects `'operator_surface'`), so the `??` falls through to the
  unchanged 005 S3 behavior. **No disagreement is reachable.**
- **A self-healed operator whose new surface changes the approval path.** The self-healed
  surface is `role: 'operator'`, and `authorizeOperator` never reads `agentCollabWrite`
  (pinned by test). `holdsAuthority` requires a `surface_authorities` row, which the self-heal
  does not write — so the self-healed operator gains **no** `approve` authority it did not
  have. This correctly respects the frozen Collab-Gateway-004 ruling that `approve` is reserved
  operator-surface authority provisioned deliberately.
- **`connection_class` default.** The self-heal's `INSERT INTO surfaces` omits
  `connection_class`, taking the schema default `'none'`. `authReconciliationDiagnostic.ts:120`
  maps `'none'` to `{tuple: null, invalid: false, detail: 'LEGACY_NONE_CLASS'}` — explicitly
  **not** invalid. No diagnostic poisoning. Safe.

---

## THE PATTERN HUNT — would each new test fail against unfixed code?

**Method:** source inspection of every new test, plus one applied mutation on `server.ts`
(verified applied by grep, per the rule that an exit code is not proof, and never through
`python3`, which does not exist on this host).

| Test file | Fails against unfixed code? |
|---|---|
| `tests/agent-participation-s1-authz.test.ts` (13) | **YES.** Drives the real `authorize()` and real `isAgentSurfaceCaller`. Every assertion inverts if the node branch is removed; the deletion-probe at the end pins node-with-flag ≠ node-without-flag on the same command. |
| `tests/agent-participation-s1.test.ts` (5) | **YES.** A1-d asserts refusal with the flag unset; A1-e flips the flag on the identical setup and asserts success — a genuine paired deletion-probe, not an always-error. |
| `tests/collab-operator-c1-self-heal.test.ts` (3) | **YES.** The positive control asserts the precondition (`operatorSurfaceRole === null`) before boot, then asserts both the committed `surfaces` row and `liveSurfaceProjectionCount === 1` after. Without the self-heal this is red. |
| `tests/collab-c2-s0-flag-independent-fence.test.ts` — 3 STRUCTURAL tests | **YES**, but only against the literal token `collabEnabled`. Text-matching, not execution. |
| `tests/collab-c2-s0-flag-independent-fence.test.ts` — booted-gateway producer test (line 369) | **YES.** Boots the real gateway with the flag unset and asserts a real grant row. |
| `tests/collab-c2-s0-flag-independent-fence.test.ts` — **the remaining behavioral tests** | **NO — see B-S0-1.** They call the replica `localEdgeAdmissionCheck`, not the shipped closure. Mutation proved 13 of 14 stay green with the gate restored. |

### Tests that pass against unfixed code (named, as required)

All in `tests/collab-c2-s0-flag-independent-fence.test.ts`, all via the `localEdgeAdmissionCheck`
replica at line 148:

1. `the premise: collabEnabled() is FALSE when unset (the default)` (:197)
2. `POSITIVE CONTROL admits matching args; SAME dispatch request with DIFFERENT args is refused action-binding-mismatch, flag UNSET` (:207)
3. `a SECOND use of the same grant (even with the correct args) is refused grant-consumed, flag UNSET` (:233)
4. `the flag-unset path reaches admitToolCall for real: an UNKNOWN dispatch id refuses grant-missing, not a silent {ok:true}` (:241) — note the title overclaims: it asserts `ok === true` for an unknown id, which is the legacy arm, and does **not** demonstrate that `admitToolCall` was reached
5. `the low-level writer … mints a real grant row` (:254) — self-disclosed as not the real path
6. `a dispatch request that never carries a grant (legacy connection) is still admitted` (:494)
7. `revokeInertGrants revokes an inert grant with the flag UNSET, and the revoked grant is then refused` (:512) — calls `revokeInertGrants` directly, not the boot block
8. `sweepExpiredApprovals expires a stale pending approval with the flag UNSET` (:537) — same
9. `sweepExpiredGrants revokes a TTL-elapsed unconsumed grant with the flag UNSET` (:568) — same

Items 7–9 test that the sweep **functions** work flag-independently (they always did — they
never read the flag); the B-7 fix was to the **boot-block call sites**, covered only by the
structural test at :584. Same shape as B-S0-1, lower severity because the recovery path is not
an admission control.

### Do the new tests drive the real path?

**Genuinely real (booted gateway, real websocket, real connect → resolve → authorize →
handler → DB read-back):**
- `tests/agent-participation-s1.test.ts` — all 5 (`launchGateway` + `wsRoundtrip`, asserts
  `collab_events.actor_principal_id` from the DB, not the wire ack)
- `tests/collab-operator-c1-self-heal.test.ts` — all 3 (seeds exactly what `bootstrapOperator`
  produces, asserts both DBs after)
- `tests/collab-c2-s0-flag-independent-fence.test.ts` — the `describe` at :347 only

**Real but pure-function (correct for their layer, and honestly scoped):**
- `tests/agent-participation-s1-authz.test.ts` — imports and calls the production `authorize`
  and `isAgentSurfaceCaller`, not copies.

**Not the real path:** the `localEdgeAdmissionCheck` replica (B-S0-1).

**No fixture in this range constructs identity directly to bypass the connect path.** The
self-heal and S1 tests both seed only what a real install contains and let the gateway derive
everything — this is the correction the program's five prior "wrong unit" defects called for,
and S1 and the self-heal both got it right.

---

## GATE RESULTS — all run by me, this session, on `a676736`

| Gate | Result |
|---|---|
| `npx vitest run tests/collab-c2-s0-flag-independent-fence.test.ts tests/collab-operator-c1-self-heal.test.ts tests/agent-participation-s1.test.ts tests/agent-participation-s1-authz.test.ts` | **PASS — 35/35, 4 files** |
| `npx vitest run tests/collab-c2-flag-off-identity.test.ts tests/frontier-grant-fence-unconditional.test.ts tests/authz.test.ts tests/auth-v2-phase1.test.ts tests/collab-surface-post.test.ts` | **PASS — 147/147, 5 files** |
| `npx vitest run` (full suite) | **PASS — 2184/2184 effective.** First run: 2183 passed / 1 failed — `tests/collab-c2-flag-on-e2e.test.ts` failed on a **stale `packages/bridge/dist`** (`SyntaxError: … does not provide an export named 'classifyCapability'`), a named trap, not a defect. After `pnpm --filter @torqclaw/bridge build` + `pnpm --filter @torqclaw/gateway build`, that file passes 4/4. The known `tests/failover/controller-timeout.test.ts` flake did not fire. |
| `npx tsc --noEmit -p packages/gateway/tsconfig.json` | **PASS — exit 0, no diagnostics** |
| `pnpm reachability` | **PASS — 120 modules reachable from 6 entry points; 3 declared dormant** |
| **Mutation probe** (restored `if (!collabEnabled()) return { ok: true }` at `server.ts:168`, applied-ness verified by grep) | **1 failed / 13 passed** — only the structural test caught it. See B-S0-1. |
| **Empirical probe 1** — partial provision (collab rows present, state.db projection absent), real booted gateway | **RED — `COLLAB_IDENTITY_REQUIRED`, `messageEvents=0`, `stateProjections=0`.** See B-SH-1. |
| **Empirical probe 2** — orphan `surfaces` row with no `surface_credentials` link, real booted gateway | **RED — `COLLAB_IDENTITY_REQUIRED`, `messageEvents=0`.** See B-SH-1. |
| **Rollback probe** — loser's transaction on `UNIQUE(secret_hmac)` / PK `credential_id` | Loser throws `SQLITE_CONSTRAINT_UNIQUE`; **both INSERTs roll back atomically**. The disclosed race is safe as claimed. |

**Tree state:** all probe files deleted, the `server.ts` mutation reverted from backup.
`git diff --stat` is **empty**; `git status --short` shows **no** modified or added files under
`packages/` or `tests/`. The only file I created is this verdict document. I did not commit.
I did not touch `ops/` or `packages/collab/src/bootstrap.ts` (concurrent builder), nor
`E:\TORQ-CONSOLE`, `E:\TORQ-BUZZ`, `.torq-console-*`, or `~/.torqclaw/*`.

---

## WHAT EARNS APPROVAL, PLAINLY

Two of these three slices are good work and I want that on the record with the same force as
the blockers.

**S1 is the strongest slice in the range.** The authority reasoning is correct at every layer:
it widens exactly one action, it gates on a signal that is provably server-derived, it keeps
the gateway SEAT decision separate from the substrate SUBJECT decision, and it correctly
identifies that `automation_surface` collapses to the same `node` role and must still be
excluded. The `getPrincipalKind` removal is the rare case of a builder deleting a check for
the right reason and proving it by mutation rather than asserting it. Its tests drive the real
connect path and read back committed DB rows.

**S0's code is correct and its scope expansion was necessary**, which I verified from source
rather than taking on trust. The SI-4 preservation argument is not a fixture coincidence — it
rests on `recordTaskOrigin`'s own surviving flag gate and, independently, on
`grantProfileDelegation` having no production caller. The `!carriesGrant` TODO is honest
scoping of a gap that genuinely cannot be closed until an unattended-run signal exists.

**The self-heal's central claim — that it is projection, not synthesis — is true**, and I
refuted the synthesis charge on evidence rather than deferring to the builder's comment. Its
defect is not in the authority model. It is that a three-write, two-database provisioning
routine guards its idempotence on one of the three writes.

---

## RECOMMENDED NEXT STEP

1. **Fix B-SH-1** — make the `already` guard consult all three writes and re-run
   `activateSurfaceProjection` when the projection is missing for an existing surface. Adopt
   probe 1 as the regression test; it is currently RED and runs on the booted artifact.
2. **Fix B-S0-1** — add one flag-off booted-gateway case to the existing `describe` at
   `tests/collab-c2-s0-flag-independent-fence.test.ts:347` that drives the shipped
   `setToolAdmissionCheck` closure and asserts side-effect absence on mismatched args. Show it
   RED against the restored gate.
3. **Apply the capability-classes ruling** — change `['read','write','exec','send']` to `[]` at
   `collabIdentity.ts:380`, folded into the B-SH-1 fix.
4. **Record the D-interaction note** in whichever future slice wires `grantProfileDelegation`.
5. Re-run all gates on the merged tree, then G2A.

**Owner approval is required before any commit, push, or merge.** I made no source change that
survives this session.
