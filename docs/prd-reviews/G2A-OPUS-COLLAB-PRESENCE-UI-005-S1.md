# G2A — FINAL VERIFICATION AUDIT — PRD-TCLAW-COLLAB-PRESENCE-UI-005, Slice S1

## VERDICT: **REJECT** — 1 blocking defect (D-1), 3 non-blocking

**Seat:** G2A (final verifier; verdict controls pass/fail)
**Model:** the session routing profile seats G2A = **Claude Opus 5**. I **am** `claude-opus-5`.
**No substitution applies and none is claimed** — this satisfies the No-False-Delegation record
without a disclosure caveat, unlike the two prior seats in this chain (G1R C3 and the independent
verifier both disclosed filling Opus-4.7/4.8-named seats).
**Audit date:** 2026-08-16
**Branch:** `phase1-server-owned-authority` · **HEAD at audit:** `865019f`
**Commits audited:** `df49276` (S1 implementation, 7 files, 651 insertions / 1 deletion),
`a2a3adf` (generated hermes `ClientCommand.json` copy, 51 insertions)
**Posture:** read-only on tracked files. Three temporary **untracked** probe files were created
and deleted; **zero tracked files were modified at any point** (`git status --porcelain` filtered
to non-`??` is empty; `git diff --stat` is empty). No commits, no pushes. No untracked operator
file was read, moved, or deleted.

---

## 0. Summary of the decision

S1 is high-quality work. The two-lattice invariant is correctly implemented, the hidden-channel
byte-identity property is real and empirically falsifiable, the H-1 intersection is byte-wise
untouched, the narrowing flag is correctly conjunctive, and no acceptance criterion or test was
edited to fit the implementation. The Builder discharged T-1/T-2/T-3/T-5 and additionally
delivered **T-8**, the obligation G1R C3 handed forward as its NB-1/R-6 gap. I confirmed every
one of those claims against the diff and by executing the gates myself.

I am nevertheless returning **REJECT**, on a single defect that both prior agents missed and that
I proved empirically rather than inferred:

> **A contract-valid `GET_CHANNEL_TIMELINE` frame with a non-numeric `cursor` (e.g. `"abc"`)
> throws `INVALID_REQUEST` out of `handleGetChannelTimeline` into the `async`
> `socket.on('message')` handler, which has no enclosing try/catch. On Node 22 with no
> `unhandledRejection` listener — and this repo has none — that terminates the gateway process.
> One frame, from any authorized operator connection, kills every other live session.**

This is exactly the failure mode `server.ts:239-246` already warns about in a shipped comment
("an uncaught throw inside this async WebSocket message handler would become an unhandled
rejection and could take the whole gateway process down — a one-line DoS against every other live
session"). S1 reintroduced the class that comment exists to prevent.

It is a small fix (one Zod regex, plus a defensive catch), and it is squarely inside S1's own
scope — obligation (3f), resource/DoS sanity of the new read handlers. It is not deferrable to
S2, because the vulnerable code is shipping now and the narrowing flag is the only thing standing
between it and a live gateway. Under §7 verification requirements and the operator's own DoS
posture, I cannot certify S1 as done with a wire-reachable process-kill in the new handlers.

I want to be explicit that this is **not** a security-boundary failure. No data leaks, no
entitlement widens, no lattice is conflated. It is an availability defect. But "one frame kills
the gateway" is not a carryable obligation.

---

## 1. AC-by-AC grading (PRD §6, criteria S1 claims per §4)

S1's scope is **A1** plus the shared **Gate** row. A2–A5 belong to S2–S5 and are correctly not
claimed.

| AC | Text (abbreviated) | Grade | Evidence |
|---|---|---|---|
| **A1(a)** | operator seat lists channels + pages a timeline **over WS against a live gateway** | **PARTIAL** | Handler-level and store-level behavior proven by `tests/collab-surface.test.ts` T-5 + the LIST_CHANNELS membership test, which I ran (13/13). The **live-WS half is not demonstrated** — no socket harness exists for S1. See NB-3 adjudication (§4): accepted as a **carried obligation** discharged by S2, *not* a blocker. |
| **A1(b)** | channel/node seats receive explicit denies (authz tests) | **GREEN** | `authz.ts:155-157` explicit named arms; `node` denies at `:125`. Pinned by `tests/collab-surface.test.ts:225-251`, including a deletion-probe that tests the load-bearing property (operator ALLOW vs channel/node DENY) rather than the vacuous one. Executed by me: green. |
| **A1(c)** | flag off ⇒ commands absent-deny | **PARTIAL** | The predicate `collabSurfaceCommandsEnabled()` is tested directly and is the exact expression both dispatch arms evaluate (`server.ts:605`, `:620`) — I confirmed the call sites are literally that function with no intervening logic. The three-line `if (!pred) { sendErr('NOT_ENABLED'); break; }` residue is untested. Accepted (NB-2, §4). |
| **Gate: full TS suite green** | | **GREEN (inherited) / GREEN (partial, executed)** | 115/115 files, 2026/2026 tests — **inherited from the orchestrator, not re-run by me**. I independently executed `tests/collab-surface.test.ts` (13/13), and `tests/authz.test.ts` + `tests/collab-identity.test.ts` + `tests/connection-auth.test.ts` + `tests/auth-v2-phase1.test.ts` (**108/108**). |
| **Gate: new authz arms tested** | | **GREEN** | As A1(b). |
| **Gate: reachability green** | | **GREEN (executed by me)** | `PASS: every substantial module is reachable or declared dormant.` 119 modules / 6 entry points; 3 pre-existing declared-dormant AUTH-005 CLI modules. `collabSurface.ts` is reachable — it did not need a dormancy declaration. |
| **Gate: `pnpm contracts:check`** | | **GREEN (executed by me)** | `OK — 8 schemas match source of truth in 2 checked-in dirs.` |
| **Gate: checklist-10 honesty sweep** | | **GREEN** | No dead affordance, no invented data. Both handlers publish only real store rows; `COLLAB_UNAVAILABLE` and `COLLAB_IDENTITY_REQUIRED` are honest refusals, not empty fabrications. |

**No AC is graded green on assertion alone.** A1 is graded PARTIAL in two halves precisely
because unit evidence does not reach the wire; that is recorded as carried, not laundered.

Grading note: **D-1 does not change any AC grade.** No §6 criterion covers handler robustness —
which is itself worth recording, because it means the AC set would have accepted a
process-killing defect. That is a PRD gap, carried forward as CO-4.

---

## 2. Evidence: executed by me vs inherited

**Executed personally (this session, on HEAD `865019f`):**

| # | Command | Result |
|---|---|---|
| 1 | `npx vitest run tests/collab-surface.test.ts` | `Test Files 1 passed (1)` · `Tests 13 passed (13)` · 1.44s |
| 2 | `pnpm --filter @torqclaw/contracts check` | `OK — 8 schemas match source of truth in 2 checked-in dirs.` |
| 3 | `pnpm reachability` | `119 modules reachable from 6 entry points` · `PASS` |
| 4 | `npx vitest run` on authz + collab-identity + connection-auth + auth-v2-phase1 | `Test Files 4 passed (4)` · `Tests 108 passed (108)` |
| 5 | `git show df49276` / `git show a2a3adf`, every hunk | audited; findings below |
| 6 | `git diff df49276^ a2a3adf \| grep '^-'` | **exactly one** deleted line (see §3.5) |
| 7 | `diff` of the two generated `ClientCommand.json` copies | **byte-identical** (stronger than the verifier's "identical after key-sorted normalization") |
| 8 | **Probe P-1** — 5 handler-level throw probes (untracked temp test, deleted) | D-1 confirmed; PROBE-D confirmed byte-identity survives the malformed-cursor path |
| 9 | **Probe P-2** — `ClientCommandSchema` acceptance of `cursor` values (untracked temp script, deleted) | `"abc"`, `"007"`, `"-1"`, 100 000-char string **all parse successfully** |
| 10 | **Probe P-3** — Node 22 async-EventEmitter rejection with no listener (untracked temp script, deleted) | **`EXIT CODE: 1`**, process terminated, "STILL ALIVE" never printed |
| 11 | `git diff b6fd112 HEAD --stat -- tests/auth-v2-phase1.test.ts packages/gateway/src/skillDecision.ts docs/PRD-…-005.md` | **empty** — all three untouched |
| 12 | `git status --porcelain \| grep -v '^??'` (final) | **empty** |

**Inherited, explicitly NOT re-run by me:** the full-suite figure (115/115 files, 2026/2026
tests) supplied by the orchestrator. I record it as inherited. My four-suite 108/108 run is a
targeted independent sample of the regression-relevant surface, not a substitute for it.

---

## 3. Adversarial gap hunt — including what came up empty

Naming the probes that found nothing is part of the record; a gap hunt that reports only hits is
not auditable.

### 3.1 Two-lattice invariant, end-to-end — **CLEAN** (deepest probe; no finding)

I tried to obtain a substrate read no principal was entitled to, from every seat.

- **Operator seat, no collab credential (legacy root token).** `authenticateConnection`
  (`connectionAuth.ts:76-80`) returns `binding: null` and — decisively — **never calls
  `resolveSurface`**, which is the only place `connectionAuth` is ever assigned
  (`server.ts:221-223`, the single assignment site; I grepped all 10 references). So
  `server.ts:614` reads `connectionAuth?.principalId ?? null` → `null` → `COLLAB_IDENTITY_REQUIRED`
  at the **first statement** of each handler (`collabSurface.ts:117`, `:145`), before `getStore()`
  and before any SELECT. **The operator seat earns no substrate read.** §2a's "refuse" answer,
  implemented; substitute and synthesize are structurally absent.
- **Channel seat (`channel_service`).** This is the sharpest version, and the verifier found it
  too: `connectionAuth.ts:71` mints a **non-null** synthetic principal `'service:channel-http'`
  that would sail past the null check. I re-derived the defense independently and it is
  two-deep: (i) that branch returns **before** `resolveSurface` runs, so `connectionAuth` stays
  `null` anyway — the verifier's trace understates the protection here; and (ii) `authorize()`
  runs at `server.ts:314-320` and **`return`s on deny before the dispatch switch at `:322`**,
  with the explicit `channel` deny arms at `authz.ts:155-157`. Even if both failed,
  `'service:channel-http'` has no `collab_members` row, so the membership JOIN returns empty.
  **Three independent controls.**
- **Node seat.** `authz.ts:125` denies unconditionally, pre-dispatch.
- **Agent / automation surfaces — the case neither prior agent examined by name.** I traced
  `resolveConnectIdentity` (`collabIdentity.ts:~270-290`): a non-operator surface maps to
  **`role = 'node'`**, so it is denied at `authz.ts:125` — *even though* it carries a valid
  non-null `principalId` in `connectionAuth`. The seat gate is doing real work for a genuinely
  credentialed principal. **Correct, and the strongest evidence the two lattices are not
  conflated.**
- **C0.1 legacy fallback surface.** Returns `auth: null`, so `connectionAuth` is `null` and a
  valid C0.1 operator principal is refused `COLLAB_IDENTITY_REQUIRED`. Fails **closed** — the
  safe direction.
- **Resumed session.** `connectionAuth` is a per-socket closure variable (`server.ts:181`, `let`
  inside the connection handler) assigned only during that socket's CONNECT. It cannot survive
  across sockets; every resume re-authenticates. **No stale-identity carryover.**
- **Substrate read paths.** `listChannels` (`store.ts:1710-1782`) filters
  `m.principal_id = ? AND m.state = 'active'` — a membership JOIN with **no `kind` predicate and
  no operator OR-arm**. `assertChannelVisible` (`store.ts:2032-2046`) consults **only**
  `caller.principalId`. Prohibition #1 observed.

**Result: no seat can obtain a substrate read its principal is not entitled to. Empty.**

### 3.2 Hidden-channel byte-identity under unvaried conditions — **CLEAN** (empirically probed)

The prior mutation probe varied the *code*. I varied the *inputs* the tests did not.

- **Non-member + malformed cursor (PROBE-D, executed).** The ordering question: does
  `parseCursor` run before or after `assertChannelVisible`? If before, a malformed cursor from a
  non-member would return `INVALID_REQUEST` while a well-formed one returns `COLLAB_NOT_FOUND` —
  a **membership oracle**. It does not: `store.ts:1801-1803` calls `assertChannelVisible` **first**,
  `parseCursor` second. Measured output for a non-member, cursor `"abc"`:
  - hidden channel → `{"code":"COLLAB_NOT_FOUND","detail":"Request could not be completed"}`
  - absent channel → `{"code":"COLLAB_NOT_FOUND","detail":"Request could not be completed"}`
  **Byte-identical. No oracle.**
- **Cursor pagination edges.** `nextCursor` falls back to `String(effectiveAfter)` on an empty
  page, and `effectiveAfter = max(requested, member.rejoined_seq)` — so a re-joined member cannot
  page below their rejoin point (H1 clamp intact, and S1 passes the caller through unmodified).
- **Limit bounds.** Clamped at **two** layers: `z.number().int().min(1).max(100)` at the contract
  (I confirmed `limit: 0` and `limit: 101` are both **rejected** at parse), and again at
  `store.ts:1715` / `:1795`. Frame-size is additionally bounded at 64 KiB by the substrate's
  incremental encoder in both read paths. **Enumeration/DoS via limit is closed.**
- **Error paths generally.** `handleGetChannelTimeline` re-wraps `COLLAB_NOT_FOUND` verbatim
  (`code` + `err.message`), never adding a distinguishing string. → but see **D-1** for what
  happens to the errors it does *not* catch.

### 3.3 H-1 approve-authority intersection — **CLEAN** (verified against the diff myself)

I did not accept the verifier's byte-wise claim; I re-derived it. `git diff df49276^ df49276 --
packages/gateway/src/authz.ts` filtered to changed lines yields **10 `+` lines and 0 `-` lines**,
all inside the `role === 'channel'` switch. `authorizeOperator` (`authz.ts:210-242`) **does not
appear in the diff at all**: `if (!surface) return ALLOW;` (`:214`), `currentRole() !== 'operator'`
(`:234`), and `!holdsAuthority('approve')` (`:237`) are unchanged characters. The operator arm is
character-identical apart from purely additive channel arms. **Prohibition #5 observed.**

Note also that `authorizeOperator` returns `ALLOW` for the two new commands by fall-through
(`:241`) — correct and intended: the **seat** permits the class, the **principal** scopes the
data. That is §2a, not a bypass.

### 3.4 Flag semantics and §9 rollback — **CLEAN**

`collabSurfaceCommandsEnabled()` (`collabSurface.ts:49-52`) is `if (!collabEnabled()) return false;`
then the `TORQCLAW_COLLAB_SURFACE_COMMANDS` truthy test — a **conjunction in the correct
direction**, read per-call, never captured at import. Both dispatch arms evaluate it **first** and
answer `NOT_ENABLED` before the handler is reached, so a flag-off command never touches the
substrate. Setting `TORQCLAW_COLLAB_SURFACE_COMMANDS=0` removes the surface without touching
`authz.ts`, so it cannot revert the C0/C1 hardening — §9 satisfied.

I grepped both commits for any text presenting `TORQCLAW_COLLAB_ENABLED=0` as a rollback: **zero
hits** in code, comments, tests, or commit messages. **Prohibition #11 observed.**

### 3.5 Test integrity — **CLEAN** (no softening anywhere)

- Every deleted line across **both** commits, in full: **`-function getCollabDb(): BootstrapDb {`**,
  replaced by `+export function getCollabDb(): BootstrapDb {`. An export widening. **Nothing else
  was deleted in either commit.**
- `docs/PRD-TCLAW-COLLAB-PRESENCE-UI-005.md` is **not in either commit's file list**. **No AC was
  edited to satisfy the implementation** (C3 §7.4 / prohibition — the repo's most-recorded defect
  class). Verified by name-only diff, not by reading the PRD's current text.
- No existing test file was touched. No threshold, count, or assertion was weakened. `tests/` sees
  exactly one addition: the new `collab-surface.test.ts`.
- Full changed-file list across both commits is exactly the 8 expected files — no stray edit,
  no drive-by refactor, no console (`apps/`) or substrate (`packages/collab/`) change.

### 3.6 Resource / DoS sanity of the new read handlers — **DEFECT FOUND (D-1)**

This is obligation (3f) and it is where the audit turned. Full treatment in §5.

### 3.7 Additional probes that came up empty

- **`grantedTools` / authorization-input injection.** Neither command carries any authorization
  field. I probed the runtime schema directly: extra keys (`principalId`, `grantedTools`,
  `authorPrincipalId`) are **stripped** by Zod, so `cmd.data` reaching dispatch contains only
  declared fields. Prohibition #3 satisfied. *(Correction to the verifier's f7: the TS path
  **strips**, it does not **reject** with `SCHEMA_VIOLATION` — `additionalProperties: false` in
  the emitted JSON Schema governs the Python boundary. Same security outcome; the verifier's
  stated mechanism is imprecise. NB-A below.)*
- **Write reachability.** Both handlers are SELECT + `publishOnly` only. `publishOnly` is the
  LIST_APPROVALS pattern — non-sequenced, so no session-cursor pollution and core invariant 2
  (resume by monotonic `seq`) is untouched. No approval state is read or written; core invariant
  5 untouched. No mutation is reachable.
- **Scope creep.** `git show df49276 --stat -- apps/ packages/collab/` is empty. No `POST_CHANNEL`,
  no presence/roster selectors, no `NEXT_PUBLIC_COLLAB_UI`. **S1 = reads only.** Boundary respected.
- **Delivery-guarantee language (prohibition #10).** The module header says "publishOnly SYSTEM
  response frames"; nowhere does any comment, test, or commit message claim delivery. Clean.
- **Secret exposure.** `getPrincipalPepper()` returns the pepper to `collabSurface.ts` only for
  `CollaborationStore` construction; it is never logged, published, or serialized into a frame.
  Clean. *(Docstring/type mismatch noted at NB-B.)*
- **Second DB handle / migration race.** `getCollabDb()` is exported and **shared**, not
  re-opened — explicitly the right call; a second handle to the same file would have raced the
  C1 self-migration.

---

## 4. NB adjudications (verifier's NB-1..NB-4)

| NB | Verifier's finding | **G2A ruling** |
|---|---|---|
| **NB-1** | `callerFor` hardcodes `kind: 'operator'` (`collabSurface.ts:103`) | **ACCEPT with carried fix (CO-1).** I re-derived inertness independently rather than inheriting it: `assertChannelVisible` (`store.ts:2032-2046`) and `listChannels` (`:1710-1782`) never read `caller.kind`; every kind-sensitive check (`assertOperatorCaller` `:1966`, `assertChannelOwner` `:2003`) reads `principals.kind` **from the DB**. Inert on S1's read paths, and the in-code comment says so accurately. But it violates PRD §8's "CallerContext.kind source" rule **in form**, and S3 introduces a write path where a future kind-trusting predicate would make it live. Fix before S3 — not a blocker for S1. |
| **NB-2** | flag-off deny tested at predicate level only | **ACCEPT.** The tested predicate is the exact and only expression both dispatch arms evaluate; I verified the call sites carry no intervening logic. The untested residue is three lines of `if (!pred) { sendErr; break; }`, structurally identical in both arms. Building a live-socket harness for a read-only slice would be disproportionate, and S2 cannot ship without exercising it. **Discharges in S2 (CO-2).** |
| **NB-3** | A1's "over WS against a live gateway" half not demonstrated | **ACCEPT as a carried obligation — this does NOT block S1.** This is the adjudication the orchestrator asked for, so I give the reasoning: the untested layer is *dispatch wiring*, not *authorization or scoping*. Every security-relevant decision (seat gate, flag gate, principal resolution, membership scoping, byte-identity) is proven at the layer that owns it, and the seat gate is proven to run **pre-dispatch** by code ordering I read myself. A live-WS test would demonstrate plumbing, not a new property. S2 is a socket-consuming slice and cannot ship without exercising it. **A1 is graded PARTIAL, not GREEN, and CO-3 carries it to S2 — it must not be inherited as satisfied.** |
| **NB-4** | generated artifacts split across two commits | **ACCEPT, no action.** `df49276` carried source + `packages/contracts/generated/`; `a2a3adf` carried the hermes copy. Against CLAUDE.md §4's "keep generated artifacts separate" preference, but both landed before HEAD, the drift gate is green under my own run, and I confirmed the two copies are **byte-identical**. Cosmetic. Note it slightly complicates §9's "each slice is a separate commit whose revert restores the prior state" — a revert of S1 must revert **both** commits. Recorded as CO-5. |

**Two additional non-blocking items I add:**

- **NB-A (verifier accuracy).** The verifier's f7 states `server.ts:291` "rejects any
  non-conforming frame with `SCHEMA_VIOLATION`" because the schemas emit
  `additionalProperties: false`. On the TS path Zod **strips** unknown keys rather than
  rejecting; `additionalProperties: false` binds the Python boundary. The security conclusion
  (no injection reaches dispatch) is **correct**; the stated mechanism is not. Recorded so it is
  not inherited as a verified fact.
- **NB-B.** `getPrincipalPepper()` (`collabIdentity.ts`) is typed `Buffer | undefined` but its
  docstring says "Returns **null**…". Cosmetic; the `if (!pepper)` guard is correct either way.

---

## 5. Defect list

### **D-1 — BLOCKING (severity: HIGH — availability / remote gateway kill)**

**A contract-valid `GET_CHANNEL_TIMELINE` frame with a malformed `cursor` terminates the gateway
process.**

**Mechanism, in four verified steps:**

1. **The contract admits any non-empty string.** `packages/contracts/src/commands.ts:146` —
   `cursor: z.string().min(1).default('0')`. No grammar constraint. I probed the compiled schema
   directly: `"abc"`, `"007"`, `"-1"`, and a 100 000-character string **all parse successfully**.
   The emitted JSON Schema carries the same gap (`{"type":"string","minLength":1}`, no `pattern`),
   so the Python boundary is equally permissive.
2. **The substrate validates by throwing.** `store.parseCursor` (`store.ts:2066-2075`) throws
   `CollabError('INVALID_REQUEST', …)` on anything not matching `^(0|[1-9][0-9]*)$`, and again on
   a value beyond `Number.isSafeInteger`.
3. **The handler catches only one code.** `collabSurface.ts` `handleGetChannelTimeline` catches
   `err?.code === 'COLLAB_NOT_FOUND'` and **re-throws everything else**. `handleListChannels` has
   **no try/catch at all**.
4. **Nothing above it catches either.** `socket.on('message', async (raw) => {…})`
   (`server.ts:186`) wraps only `JSON.parse` in try/catch (`:188-190`); the dispatch switch is
   **not** enclosed. The rejected promise becomes an unhandled rejection. There is **no
   `unhandledRejection` or `uncaughtException` listener anywhere in `packages/gateway/src/` or
   `ops/`** (grepped: zero hits), and no `--unhandled-rejections` flag in `package.json`, `ops/*.mjs`,
   or `.env.example`. Node 22's default is `throw` ⇒ **process exit**.

**Executed evidence (not inferred):**

- **PROBE-A** — member, `cursor: "abc"` → handler **threw** `INVALID_REQUEST`; return value was
  never produced. **PROBE-B** (`"007"`) and **PROBE-C** (23-digit) — identical.
- **PROBE-E** — `handleListChannels` with an out-of-range limit also throws (contract-clamped
  today, so wire-unreachable — but the handler has no net if any future caller differs).
- **PROBE-3** — an `async` EventEmitter handler that rejects, with no listener, on this exact
  runtime (`node v22.19.0`): **`EXIT CODE: 1`**, process terminated, the "STILL ALIVE" timer never
  fired.

**Failure scenario:** gateway running with `TORQCLAW_COLLAB_ENABLED=1` and
`TORQCLAW_COLLAB_SURFACE_COMMANDS=1`. Any operator-seat connection — including a legitimate
console with a typo, or a paginating client that echoes back a malformed `nextCursor` — sends
`{"action":"GET_CHANNEL_TIMELINE","channelId":"<any>","cursor":"abc","limit":20}`. The frame
passes Gate 2 (schema), passes Gate 3 (operator seat allow), reaches the handler, throws, and the
**entire gateway process exits — killing every other live session, every in-flight task, and every
other connected surface.** Note it does **not** require membership in the channel, because
`parseCursor` throws for a member and `assertChannelVisible` throws `COLLAB_NOT_FOUND` first for a
non-member — so a member of *any* channel, or the channel's owner, triggers it.

**Why this is S1's defect and not pre-existing.** I checked the neighbours. The house pattern is
**explicit per-arm defensive handling**, precisely because there is no outer net: `CANCEL_TASK`
(`server.ts:517-535`) wraps *both* of its async calls in try/catch. `LIST_APPROVALS` and
`GET_SAFE_EXPORT` have no try/catch but are **not wire-reachable-throwable** — their inputs are
fully clamped by the contract (bounded int, enum, `z.uuid()`), so no valid frame can make them
throw. `GET_CHANNEL_TIMELINE` is the **first** command to accept a free-form string that a
downstream layer validates by throwing. S1 introduced the reachable trigger.

**Why it is not covered by any existing gate.** PRD §6 A1 covers seats, flags, and listing; §8's
T-1/T-2/T-3/T-5/T-8 cover identity, byte-identity, seat arms, contiguity, and the flag matrix.
**No AC or T-obligation covers handler robustness or malformed input.** The 13/13 suite passes
because it only ever supplies well-formed cursors (`'0'` and store-returned values). The gate set
would have accepted this. That PRD gap is CO-4.

**Prescribed fix (small, entirely within S1's scope, no AC change required):**

1. `packages/contracts/src/commands.ts:146` — constrain the cursor to the grammar the substrate
   already enforces: `cursor: z.string().regex(/^(0|[1-9][0-9]*)$/).default('0')`. This matches
   repo convention (every other constrained id field uses `z.uuid()`) and converts the crash into
   a clean `SCHEMA_VIOLATION` at Gate 2. Re-run `pnpm --filter @torqclaw/contracts build` and
   `check` so both generated copies pick up the `pattern`.
2. **Defence in depth (do not skip):** widen the `catch` in `handleGetChannelTimeline` to map any
   `CollabError` to a returned `CollabSurfaceError` instead of re-throwing, and wrap
   `handleListChannels`'s body likewise — matching the `CANCEL_TASK` house pattern. A regex alone
   leaves the handler one refactor away from the same crash. **`CURSOR_OUT_OF_RANGE` is a live
   example: it is not thrown on this read path today, but it is a sibling code on the same cursor
   family, and the next slice that reuses this handler shape will meet it.**
3. Add a test: malformed `cursor` returns a structured error and **does not throw**. This is the
   falsifiability pin — without it the fix is an unenforced claim, which is this repo's
   most-recorded defect class.

*(Optional, operator's call: an `unhandledRejection` listener that logs and keeps the process
alive would harden every arm at once. That is a gateway-wide decision outside S1's scope and I do
not require it for this fix.)*

### **D-2 — non-blocking (LOW)** — `callerFor` hardcodes `kind: 'operator'`
See NB-1 / CO-1. Inert today; fix before S3's write path.

### **D-3 — non-blocking (INFORMATIONAL)** — principal-status revocation is connect-time only
`principals.status !== 'active'` is checked in `resolveConnectIdentity` (`collabIdentity.ts:227`,
`:284`) at CONNECT; the read path's `runReadCommand` (`store.ts:2280`) is a passthrough with no
re-check. A principal deactivated mid-connection keeps reading until the socket closes. **This is
pre-existing C0/C1 behavior that S1 inherits, not something S1 introduced.** The *entitlement*
that actually scopes channel data — `collab_members.state` — **is** re-read live on every call
(`store.ts:1726`, `:2042`), so membership revocation bites immediately, which is the security-
relevant half. Recorded as CO-6 for the auth lane, not charged against S1.

### **D-4 — non-blocking (COSMETIC)** — `getPrincipalPepper()` docstring says "null", type is
`Buffer | undefined`. NB-B.

---

## 6. Chain integrity

- **The Builder did not verify its own work into acceptance.** Three distinct seats produced three
  documents: G1R C3 (design, `GATE1-C3.md`), the independent verifier
  (`VERIFY-OPUS-COLLAB-PRESENCE-UI-005-S1.md`, fresh thread, no Builder context, with its own
  executed evidence table and a mutation probe it restored), and this G2A audit. The verifier's
  evidence is independently reproducible and I reproduced its three gate results myself, plus
  108 additional adjacent tests.
- **No AC text was edited to fit the implementation.** The PRD is absent from both commits'
  file lists (verified by name-only diff).
- **Model-lineage record.** G1R C3 and the independent verifier both **disclosed** filling
  Opus-4.7/4.8-named seats with `claude-opus-5`. This G2A seat is profile-seated as Opus 5 and I
  am `claude-opus-5` — **no substitution, nothing to disclose.** The No-False-Delegation record
  for this slice is complete and honest at all three seats.
- **Sentinel non-interference (obligation 5).** `tests/auth-v2-phase1.test.ts` is **untouched**
  since the `b6fd112` operator-ruling re-pin — S1's authz edits are inside that pin's sha and did
  not require re-pinning. I executed the sentinel myself as part of the 108/108 run: **green**.
  `packages/gateway/src/skillDecision.ts` (frozen at `c2850f5`) is **untouched**. The H-1 collab
  test surface is untouched — S1 only *added* T-8 coverage of it.

---

## 7. Carried obligations for S2+

| # | Obligation | Owner |
|---|---|---|
| **CO-1** | Fix `callerFor`'s hardcoded `kind: 'operator'` (derive it, or use `'agent'`) **before S3's write path** lands. | S3 |
| **CO-2** | Cover the flag-off `NOT_ENABLED` dispatch residue over a real socket. | S2 |
| **CO-3** | **Discharge A1's "over WS against a live gateway" half.** A1 is PARTIAL, not green — do **not** inherit it as satisfied. | S2 |
| **CO-4** | The §6/§8 gate set contains **no handler-robustness or malformed-input criterion** — it would have accepted D-1. Add one for every new wire command in S3+. | G1D / S3 |
| **CO-5** | §9's per-slice revert story: reverting S1 requires reverting **both** `df49276` and `a2a3adf`. Keep generated artifacts in one commit per slice going forward. | S2+ |
| **CO-6** | Principal-status revocation is connect-time only on collab read paths (D-3). Pre-existing; route to the auth lane, not to this PRD. | auth lane |
| **CO-7** | R-3 stands: `WindowsCredentialManagerStore` is still a `NOT_IMPLEMENTED` stub, so S1 fails closed to `COLLAB_IDENTITY_REQUIRED` in production until a real `SecretStore` adapter lands. Not an S1 defect — do not mistake it for one at demo time. | §19 owed |

---

## 8. Final verdict

# REJECT

**One blocking defect: D-1.** A contract-valid frame with a malformed `cursor` throws out of the
new read handler into an unprotected `async` WebSocket message handler and terminates the gateway
process on this runtime — proven, not inferred, at three levels (handler throws; contract admits
the input; Node 22 exits on the resulting unhandled rejection).

Everything else in S1 is sound, and I want that on the record so the fix is scoped narrowly rather
than becoming a rewrite. The two-lattice invariant holds against every seat I could construct,
including the agent/automation case neither prior agent examined by name. Hidden-channel
byte-identity holds under conditions the tests never varied — I probed the malformed-cursor path
specifically because it was the most plausible oracle, and it is clean because `assertChannelVisible`
is correctly ordered before `parseCursor`. The H-1 intersection is character-identical apart from
additive arms. T-8 was delivered, closing the gap G1R C3 handed forward. No test, threshold, or
acceptance criterion was weakened anywhere in either commit — the single deleted line across both
is an `export` keyword.

**Remediation is small and bounded:** one Zod regex, one widened `catch`, one test. All three are
inside S1's existing scope and require **no AC edit** — which matters, because editing an AC to
absorb this would be exactly the `unenforced-claim-pattern` defect the C3 packet prohibits.

**What I would need to flip this to APPROVE:** the D-1 fix (all three parts), `contracts:check`
re-green after the schema re-emit, and a test proving a malformed cursor returns a structured
error rather than throwing. On that evidence I would approve without a further full cycle.

**The operator may not yet treat S1 as done, and the chain should not proceed to S2.** Memory is
**not** upgraded on this verdict.

---

*G2A seat filled by `claude-opus-5` — the model the routing profile seats for G2A; no substitution.
Read-only on all tracked files: `git status --porcelain` filtered to non-`??` is empty and
`git diff --stat` is empty at the close of this audit. Three untracked probe files were created
and deleted; the pre-existing untracked operator files (including `test_write_probe.txt`) were
never touched. All code claims cite file:line and were read at HEAD `865019f`.*
