# G2A — RE-AUDIT — PRD-TCLAW-COLLAB-PRESENCE-UI-005, Slice S1, defect D-1

## VERDICT: **APPROVE** — D-1 closed, no regression, S1 done, chain may proceed to S2

**Seat:** G2A (final verifier; verdict controls pass/fail)
**Model:** the session routing profile seats G2A = **Claude Opus 5**. I **am** `claude-opus-5`.
**No substitution applies and none is claimed** — the No-False-Delegation record for this slice
remains complete and honest at all seats.
**Audit date:** 2026-08-16
**Branch:** `phase1-server-owned-authority` · **HEAD at audit:** `2d6067b`
**Commit audited:** `2d6067b` — *fix(collab): G2A D-1 — malformed cursor must not kill the gateway
process* (5 files, 157 insertions / 16 deletions)
**Prior verdict re-audited:** `docs/prd-reviews/G2A-OPUS-COLLAB-PRESENCE-UI-005-S1.md` (REJECT on D-1)

**Scope of this re-audit (narrow, as directed):** (i) is D-1 actually closed, (ii) did the fix break
or weaken anything, (iii) did the fix introduce anything new. **All prior-audit findings on
everything else stand unchanged and were not re-litigated.** The prior audit committed to approving
"without a further full cycle" on evidence of a correct fix plus a green `contracts:check`; that
condition is met and exceeded.

**Posture:** read-only on tracked files except three deliberate, restored mutation probes (§4). One
untracked probe test was created and deleted. No commits, no pushes. No untracked operator file was
read, moved, or deleted.

---

## 1. Evidence: executed by me vs inherited

**This audit inherits almost nothing.** I re-executed every gate the orchestrator reported,
including the full suite, rather than accepting the figures.

| # | Command / probe | Result | Source |
|---|---|---|---|
| 1 | `npx vitest run` (full suite) | **115 files / 2037 tests passed, exit 0**, 197s | **executed by me** |
| 2 | `npx vitest run` on collab-surface + auth-v2-phase1 + authz + collab-identity + connection-auth | **5 files / 132 tests passed** | **executed by me** |
| 3 | `pnpm --filter @torqclaw/contracts check` | `OK — 8 schemas match source of truth in 2 checked-in dirs.` | **executed by me** |
| 4 | `cmp` of the two generated `ClientCommand.json` copies | **byte-identical** | **executed by me** |
| 5 | `pnpm reachability` | `PASS: every substantial module is reachable or declared dormant.` | **executed by me** |
| 6 | `pnpm typecheck --force` | **14 successful / 14 total, `Cached: 0`** (fresh compile, not a cache hit) | **executed by me** |
| 7 | **Probe G2A-L1** — compiled `ClientCommandSchema` cursor grammar, 15 values | see §2.1 | **executed by me** |
| 8 | **Probe G2A-L2** — 9 throw-classes × 2 handlers = 18 totality probes via `setCollabSurfaceStoreForTest` | see §2.2 | **executed by me** |
| 9 | **Probe G2A-L2b** — real store: 21-digit cursor, detail-leak scan, T-2 byte-identity × 5 cursor forms, limit-range | see §2.3 / §3 | **executed by me** |
| 10 | **Mutation M-1** — new arm fires before NOT_FOUND | **RED**, restored | **executed by me** |
| 11 | **Mutation M-2** — revert the widened catch to `throw err` | **RED (4 tests)**, restored | **executed by me** |
| 12 | **Mutation M-3** — revert the cursor regex + rebuild `dist` | **RED (2 tests)**, restored + rebuilt | **executed by me** |
| 13 | `git show 2d6067b --name-only` / `--stat` / `--unified=0` deleted-line audit | see §5 | **executed by me** |
| 14 | `git diff b6fd112 HEAD -- tests/auth-v2-phase1.test.ts packages/gateway/src/skillDecision.ts` | **empty** | **executed by me** |
| 15 | `git status --short --untracked-files=no` (final) | **empty** | **executed by me** |

**Inherited and explicitly NOT independently re-derived:** nothing material. The orchestrator's
targeted 24/24, contracts:check, byte-identity, full-suite 2037, typecheck 14/14 and reachability
PASS were all reproduced by me above. The builder-reported falsifiability claims were **not**
inherited — I ran my own mutation probes (§4) rather than trusting the builder's probe report,
per the audit brief.

---

## 2. Obligation (1) — IS D-1 ACTUALLY CLOSED? **YES, both layers, by execution.**

### 2.1 Layer 1 — the compiled schema grammar

`packages/contracts/src/commands.ts:151` now reads
`cursor: z.string().regex(/^(0|[1-9][0-9]*)$/).default('0')`, and both generated copies carry
`"pattern": "^(0|[1-9][0-9]*)$"` in place of the former `"minLength": 1`
(`packages/contracts/generated/ClientCommand.json:369-373`, and the byte-identical hermes copy at
`engines/hermes_kernel/mcp_wrapper/schemas/ClientCommand.json`).

I parsed `ClientCommandSchema` **directly** (not the source — the built `dist` the runtime and
tests actually resolve, per `vitest.config.ts:8-16`):

| Input | Result | Required |
|---|---|---|
| `"abc"` | **rejected** | ✔ |
| `"007"` | **rejected** | ✔ |
| `"-1"` | **rejected** | ✔ |
| `""`, `" 1"`, `"1 "`, `"1.0"`, `"+1"`, `"0x1"`, `"١٢"` (Arabic-Indic digits) | **rejected** | ✔ (additional hardening probes of my own) |
| `"0"` | **accepted**, value `"0"` | ✔ |
| `"42"` | **accepted**, value `"42"` | ✔ |
| `"9007199254740991"` (MAX_SAFE_INTEGER) | **accepted** | ✔ |
| omitted | **accepted**, defaults to `"0"`, which itself satisfies the grammar | ✔ |

**A correction to the audit brief, on my own evidence.** The brief asked me to confirm the schema
rejects "a >20-digit string". **It does not, and it must not** — `"9".repeat(21)` contains no
leading zero and therefore *matches* `^(0|[1-9][0-9]*)$` exactly as `store.parseCursor` does. The
regex is a faithful mirror of the substrate grammar, which is the correct design; the substrate's
**second** check (`Number.isSafeInteger`, `store.ts:2071-2073`) is deliberately *not* expressible as
a regex. **This is precisely why Layer 2 is load-bearing and not merely defence in depth**: a
21-digit cursor is the one INVALID_REQUEST path that remains wire-reachable after the contract fix.
I verified the handler absorbs it (§2.3). Had the builder shipped the regex alone, D-1 would still
be open. It did not.

### 2.2 Layer 2 — no throw can escape EITHER handler

`handleListChannels` (`collabSurface.ts:132-157`) now wraps its body in `try/catch`;
`handleGetChannelTimeline` (`:176-216`) replaces `throw err` with structured returns. I drove **both**
handlers with a store override (`setCollabSurfaceStoreForTest`, `collabSurface.ts:67`) throwing each
of nine classes. Every cell below **resolved**; not one rejected.

| Thrown value | `handleListChannels` | `handleGetChannelTimeline` |
|---|---|---|
| (a) `CollabError`-shaped, `code: 'INVALID_REQUEST'` | resolves `COLLAB_INVALID_REQUEST` | resolves `COLLAB_INVALID_REQUEST` |
| (b) other code, `code: 'CURSOR_OUT_OF_RANGE'` | resolves `COLLAB_UNAVAILABLE` | resolves `COLLAB_UNAVAILABLE` |
| (b2) `code: 'COLLAB_NOT_FOUND'` | resolves `COLLAB_UNAVAILABLE` | resolves `COLLAB_NOT_FOUND` |
| (c) plain `Error('boom')` | resolves `COLLAB_UNAVAILABLE` | resolves `COLLAB_UNAVAILABLE` |
| (d1) thrown **string** | resolves `COLLAB_UNAVAILABLE` | resolves `COLLAB_UNAVAILABLE` |
| (d2) thrown **null** | resolves `COLLAB_UNAVAILABLE` | resolves `COLLAB_UNAVAILABLE` |
| (d3) thrown **undefined** | resolves `COLLAB_UNAVAILABLE` | resolves `COLLAB_UNAVAILABLE` |
| (d4) thrown **number** `42` | resolves `COLLAB_UNAVAILABLE` | resolves `COLLAB_UNAVAILABLE` |
| (d5) object whose `code` **getter throws** | **rejects** — see N-1 | **rejects** — see N-1 |

Case (d) is the one the brief singled out, and it lands correctly: `err?.code` on a thrown string,
`null`, `undefined`, or a number is `undefined`, which fails both `=== 'INVALID_REQUEST'` and
`=== 'COLLAB_NOT_FOUND'` and falls through to the generic arm. Optional chaining also survives
`null`/`undefined` without a TypeError. **No escape.**

Case (d5) is a genuine but **unreachable** edge; adjudicated as informational N-1 in §6, not a defect.

### 2.3 Layer 2, against the real store

Driving the real `CollaborationStore` (in-memory SQLite fixture, bootstrapped operator):

- **21-digit cursor `"9"×21`** — passes the contract, fails `Number.isSafeInteger`, reaches
  `store.ts:2072`. Handler **resolved**:
  `{"code":"COLLAB_INVALID_REQUEST","detail":"Cursor out of representable range: 999999999999999999999"}`.
  **This is the wire-reachable D-1 residue, and Layer 2 absorbs it.**
- **Out-of-range limit on both handlers** (`store.ts:1716`, `:1796`, not wire-reachable — the
  contract clamps 1–100 first, and I confirmed `limit: 0` / `limit: 101` are rejected at parse):
  both resolved `{"code":"COLLAB_INVALID_REQUEST","detail":"limit must be between 1 and 100"}`.
- **`assertChannelVisible` `COLLAB_NOT_FOUND`**: resolved, byte-identical (§3).

**D-1 is closed.** The contract refuses malformed cursors at the wire boundary, and independently,
no store throw of any class reachable from these paths can escape either handler into
`server.ts`'s unprotected `async socket.on('message')`.

---

## 3. Obligation (2) — T-2 REGRESSION CHECK. **No regression. Byte-identity holds.**

### 3.1 The "unchanged byte-for-byte" claim, verified against the diff

`git show 2d6067b -- packages/gateway/src/collabSurface.ts` shows the `COLLAB_NOT_FOUND` arm as a
**context line, not a changed line**. The hunk adds only a three-line comment above the untouched
`return { code: 'COLLAB_NOT_FOUND', detail: err.message };`. Present source at
`collabSurface.ts:194-199`: the predicate `err?.code === 'COLLAB_NOT_FOUND'` and the returned object
are character-identical to the pre-fix version. **Claim verified.**

### 3.2 Byte-identity probe re-run, well-formed AND malformed cursors

Non-member (`outsider`, never added as a member) against a HIDDEN channel vs an ABSENT channel id,
across five cursor forms. Payloads captured from the handler:

| cursor | wire admits? | hidden-channel payload | absent-channel payload | identical? |
|---|---|---|---|---|
| `"0"` | yes | `{"code":"COLLAB_NOT_FOUND","detail":"Request could not be completed"}` | *(same)* | **yes** |
| `"7"` | yes | `{"code":"COLLAB_NOT_FOUND","detail":"Request could not be completed"}` | *(same)* | **yes** |
| `"abc"` | **no** | `{"code":"COLLAB_NOT_FOUND","detail":"Request could not be completed"}` | *(same)* | **yes** |
| `"007"` | **no** | `{"code":"COLLAB_NOT_FOUND","detail":"Request could not be completed"}` | *(same)* | **yes** |
| `"9"×21` | **yes** | `{"code":"COLLAB_NOT_FOUND","detail":"Request could not be completed"}` | *(same)* | **yes** |

The last row is the important one: it is the **only** malformed-cursor form the wire still admits,
and it is byte-identical. **The new `COLLAB_INVALID_REQUEST` code cannot become a membership oracle.**

### 3.3 The ordering that makes this true

`store.ts:1800` calls `assertChannelVisible` (which throws `notFound()`, `store.ts:104-106`, with the
constant message `'Request could not be completed'`); `store.ts:1802` calls `parseCursor` **after**
it. A non-member therefore never reaches `parseCursor` at all. Confirmed by reading the current
source, not inherited. `assertChannelVisible` (`store.ts:2032-2046`) returns the same `notFound()`
for absent-channel, non-member, and inactive-membership — one message, three causes.

### 3.4 Mutation probe M-1 — the byte-identity assertion is load-bearing

**Mutation:** inserted, ahead of the `COLLAB_NOT_FOUND` arm in `handleGetChannelTimeline`, an arm
firing `COLLAB_INVALID_REQUEST` for a `COLLAB_NOT_FOUND` throw when the cursor is malformed — i.e.
exactly the regression where the new code distinguishes the two paths.

**Result: RED.** `tests/collab-surface.test.ts:193` — *"D-1: T-2 byte-identity still holds when the
cursor is malformed AND the channel is hidden vs absent (membership-oracle probe)"* failed with
`expected 'COLLAB_INVALID_REQUEST' to be 'COLLAB_NOT_FOUND'`. 1 failed / 23 passed.

**Restored:** `git checkout -- packages/gateway/src/collabSurface.ts` →
`git status --short packages/gateway/src/collabSurface.ts` **empty**. Confirmed.

---

## 4. Mutation-probe record (all three: red-then-restored)

| Probe | Mutation | Expected | **Observed** | Restore confirmed |
|---|---|---|---|---|
| **M-1** | New `COLLAB_INVALID_REQUEST` arm fires ahead of / instead of `COLLAB_NOT_FOUND` | oracle test goes RED | **RED — 1 failed / 23 passed**, `collab-surface.test.ts:193` | `git checkout` → `git status --short` empty ✔ |
| **M-2** | Revert the widened catch in `handleGetChannelTimeline` to `throw err` (the pre-fix state) | the D-1 totality tests go RED | **RED — 4 failed / 20 passed**, all four malformed-cursor cases, `Serialized Error: { code: 'INVALID_REQUEST' }` thrown from `collabSurface.ts:177` | `git checkout` → `git status --short --untracked-files=no` empty ✔ |
| **M-3** | Revert `cursor` to `z.string().min(1)` **and rebuild `packages/contracts/dist`** | the wire-contract tests go RED | **RED — 2 failed / 22 passed** | `git checkout` of all 3 files + `pnpm --filter @torqclaw/contracts build` → tracked tree empty, regex and `pattern` re-confirmed present ✔ |

**M-3 methodology note.** `vitest.config.ts:8-16` aliases `@torqclaw/contracts` to the built
`dist`, so mutating only `src/commands.ts` would have produced a **falsely green** run — the exact
`verify-the-artifact-not-the-unit-test` trap recorded in project memory. I rebuilt `dist` before
running, which is what made the probe bite. Restoring required `git checkout` of all three contract
files (the build script rewrites both checked-in generated copies) followed by a rebuild; I verified
afterwards that `commands.ts:151` carries the regex and the generated copy carries the `pattern`.

**Answer to (3d) — are the new tests load-bearing or vacuous?** **Load-bearing, verified by my own
mutation, not the builder's probe report.** M-2 turns 4 red, M-3 turns 2 red, M-1 turns the
oracle test red. The 11 new tests are not vacuous. I additionally note the two `handleListChannels`
totality tests use the same `setCollabSurfaceStoreForTest` seam I used independently and assert
`.resolves`, which is the correct falsifiable direction (a rejection fails the assertion rather than
passing silently).

---

## 5. Obligations (4) & (5) — TEST INTEGRITY and SCOPE. **Both clean.**

**Exact file list** (`git show 2d6067b --name-only`), exactly the 5 named files, nothing else:

```
engines/hermes_kernel/mcp_wrapper/schemas/ClientCommand.json
packages/contracts/generated/ClientCommand.json
packages/contracts/src/commands.ts
packages/gateway/src/collabSurface.ts
tests/collab-surface.test.ts
```

- **No forbidden file touched.** `git show 2d6067b --stat --` over `packages/gateway/src/authz.ts`,
  `packages/gateway/src/skillDecision.ts`, `tests/auth-v2-phase1.test.ts`,
  `packages/gateway/src/server.ts`, `docs/prd-reviews/`, and the PRD → **empty output**. Zero
  `docs/` paths in the commit, so **no verdict file and no acceptance criterion was edited** — the
  repo's most-recorded defect class (`unenforced-claim-pattern`) is not present here.
- **Every deleted line accounted for.** 16 deletions: 2 × `"minLength": 1` (generated copies,
  replaced by `pattern`), 1 × the old `cursor:` line, 1 × the single-line `CollabSurfaceError` type
  (reformatted to multi-line with the added union member), 9 × the `handleListChannels` body lines
  (re-indented into the new `try` block, semantically identical), 1 × `throw err` (the fix itself),
  and 1 × `-import type { ClientCommand } from '@torqclaw/contracts';` — merged into
  `+import { ClientCommandSchema, type ClientCommand } from '@torqclaw/contracts';`. **No deleted
  line removes behavior or an assertion.**
- **No test weakened, deleted, or relaxed.** `git show 2d6067b -- tests/` filtered to removed
  assertion lines (`toBe(`, `toEqual(`, `toHaveLength`, `expect(`) → **zero hits**. Test count moves
  13 → 24, strictly additive. No threshold changed.
- **Sentinel intact.** `git diff b6fd112 HEAD -- tests/auth-v2-phase1.test.ts
  packages/gateway/src/skillDecision.ts` → **empty**: the auth-v2-phase1 sentinel is untouched since
  the operator-ruling re-pin, and `skillDecision.ts` (frozen at `c2850f5`) is untouched. I
  **executed** the sentinel suite as part of the 132/132 run: **green**, including the two
  built-process downgrade-fence cases (17.8s and 26.1s).

---

## 6. Obligation (3) — NEW-SURFACE HUNT. What did the fix itself introduce?

### (a) Does `detail` ever carry anything beyond the caller's own input? **No.**

`sendErr(listErr.code, listErr.detail)` (`server.ts:615`, and the timeline arm) forwards `detail`
to the wire verbatim, so the question is real. I enumerated **every** `INVALID_REQUEST` throw site
reachable from these two handlers by reading both store methods end to end:

| Site | Message | Contains server state? | Wire-reachable? |
|---|---|---|---|
| `store.ts:1716` (listChannels limit) | `limit must be between 1 and 100` | **no** — constant | no (contract clamps 1–100) |
| `store.ts:1796` (timeline limit) | `limit must be between 1 and 100` | **no** — constant | no (same) |
| `store.ts:2068` (cursor grammar) | `Cursor must be an unsigned base-10 integer without leading zeroes: ${cursor}` | **no** — echoes caller input only | no (contract regex is identical) |
| `store.ts:2072` (cursor range) | `Cursor out of representable range: ${cursor}` | **no** — echoes caller input only | **yes** (21+ digits) |

Sites at `store.ts:440`, `:943`, `:1430`, `:1946` throw `INVALID_REQUEST` too, but belong to write /
agent paths that neither read handler calls — I confirmed `listChannels` and `getChannelTimeline`
call only `assertChannelVisible`, `parseCursor`, and raw SELECTs. I also ran a **negative leak
assertion**: for a malformed cursor against a channel named `SecretChannelName`, the returned detail
contains neither the channel name, nor the channel id, nor the caller's principal id. **No channel
names, ids the caller did not supply, counts, or principal ids are echoed.**

### (b) Is the new code itself an oracle on any input the wire still admits? **No.**

The complete wire-admissible input space that can reach these error codes:

- **`COLLAB_INVALID_REQUEST`** is reachable on the timeline path only via the 21+-digit cursor —
  and only **after** `assertChannelVisible` has already passed, because `store.ts:1800` precedes
  `:1802`. A caller who sees it therefore already has visibility of that channel; it tells them
  nothing they did not know. On the `listChannels` path it is not wire-reachable at all (the only
  source is the contract-clamped limit). §3.2 confirms this empirically: the 21-digit cursor returns
  byte-identical `COLLAB_NOT_FOUND` for hidden and absent channels alike.
- **`COLLAB_UNAVAILABLE`** is returned for a null store (no pepper provisioned) and for any
  unclassified throw. It carries **no `detail` at all** — deliberately, and correctly: this is the
  arm that would otherwise let a future thrown code become a distinguishing signal. Its emptiness is
  the security property.
- **`COLLAB_NOT_FOUND`** is unchanged and byte-identical across all three denial causes.

The tri-state is a **strict improvement** on the prior surface, where the third state was "the
gateway dies" — itself a maximally loud signal.

### (c) Does the generic arm swallow something that should be loud? **Acceptable, matches the house pattern; recorded as an observability obligation, not a defect.**

A real store corruption (SQLite I/O error, schema drift) now returns a bland `COLLAB_UNAVAILABLE`
with no server-side log. That is a genuine observability gap. I weighed it against three things and
concluded it does not block:

1. It **matches the established house pattern** the fix was told to mirror: `CANCEL_TASK`
   (`server.ts:517-537`) catches equally broadly and equally silently, emitting only a user-facing
   SYSTEM message with no server-side log. Deviating here would be the inconsistency.
2. The alternative — logging `err.message` — is exactly what the comment at `collabSurface.ts:211-214`
   correctly refuses on the wire; a server-side-only log would be safe, but that is a design choice
   with a blast radius beyond S1.
3. The prior state was worse in both directions: loud (process death) *and* unavailable.

**Carried as CO-8** for the S2/S3 lane: add server-side logging for the generic arm when the gateway
gains a structured logger. Not an S1 defect.

### (d) Test vacuity — answered in §4 by my own mutations: **load-bearing.**

### N-1 (INFORMATIONAL, not a defect) — a thrown object with a throwing `code` getter still escapes

`err?.code` is evaluated **inside** the catch block; if `code` is an accessor that throws, the catch
block itself throws and the handler rejects. I confirmed the mechanism in isolation
(`REJECTED nested`) and against both handlers.

**Why this is not a defect:** it is unreachable. `CollabError` (`store.ts:108-115`) declares `code`
as a plain `readonly` data property assigned in the constructor; `grep` for `get code` /
`Object.defineProperty` across `packages/collab/src/` returns **zero hits**. No code path can produce
such an object, and an attacker has no way to inject a thrown value's shape — the store constructs
every error it throws. Recording it because "the handler is total" is a strong claim and this is its
one exception; a future `try { code } catch` hardening would be belt-and-braces, not a fix.

---

## 7. Obligation (6) — were D-2/D-3/D-4 silently "fixed" as scope creep? **No. All three still present.**

| Prior defect | Status | Evidence |
|---|---|---|
| **D-2** — `callerFor` hardcodes `kind: 'operator'` | **still present**, unchanged | `collabSurface.ts:115` — `return { principalId, kind: 'operator' };` |
| **D-3** — principal-status revocation is connect-time only | **still present**, unchanged | `store.ts:2280` — `private runReadCommand<TResult>(fn: () => TResult): TResult { return fn(); }`, still a bare passthrough |
| **D-4** — `getPrincipalPepper()` docstring says "null", type is `Buffer \| undefined` | **still present**, unchanged | `collabIdentity.ts:95-98` — docstring "null exactly when…" above `export function getPrincipalPepper(): Buffer \| undefined` |

The remediation stayed inside its bounds. **No scope creep in either direction** — nothing extra was
fixed, and nothing was quietly dropped.

---

## 8. Carried obligations — refreshed

CO-1 through CO-7 from the prior audit **all stand unchanged**; the D-1 fix discharged none of them
and this re-audit did not re-open any.

| # | Obligation | Owner | Status |
|---|---|---|---|
| **CO-1** | Fix `callerFor`'s hardcoded `kind: 'operator'` before S3's write path lands. | S3 | open (D-2 confirmed still present) |
| **CO-2** | Cover the flag-off `NOT_ENABLED` dispatch residue over a real socket. | S2 | open |
| **CO-3** | Discharge A1's "over WS against a live gateway" half. **A1 remains PARTIAL, not green — do not inherit it as satisfied.** | S2 | open |
| **CO-4** | The §6/§8 gate set contains no handler-robustness or malformed-input criterion — it would have accepted D-1. Add one for every new wire command in S3+. **Reinforced:** `tests/collab-surface.test.ts` now carries such tests, but no *acceptance criterion* requires them, so the gap in the PRD is unclosed. | G1D / S3 | open |
| **CO-5** | §9 per-slice revert story: reverting S1 now requires reverting **three** commits — `df49276`, `a2a3adf`, and `2d6067b`. Keep generated artifacts in one commit per slice going forward. | S2+ | **updated by this audit** |
| **CO-6** | Principal-status revocation is connect-time only on collab read paths (D-3). Pre-existing; route to the auth lane. | auth lane | open |
| **CO-7** | R-3: `WindowsCredentialManagerStore` is still a `NOT_IMPLEMENTED` stub, so S1 fails closed to `COLLAB_IDENTITY_REQUIRED` in production until a real `SecretStore` adapter lands. Not an S1 defect — do not mistake it for one at demo time. | §19 owed | open |
| **CO-8** | **NEW.** The generic `COLLAB_UNAVAILABLE` arm (`collabSurface.ts:156`, `:215`) swallows real store failures with no server-side log. Matches the `CANCEL_TASK` house pattern, so not a defect — but add structured logging when the gateway gains a logger. | S2/S3 | new |
| **CO-9** | **NEW (informational).** N-1: a thrown object with a throwing `code` getter would still escape both handlers. Unreachable today (`CollabError.code` is a data property; zero accessors in `packages/collab/src/`). Revisit only if a non-`CollabError` throw source is ever introduced. | S3+ | new |

---

## 9. Final verdict

# APPROVE

**D-1 is closed, at both layers, on evidence I produced.**

Layer 1: the compiled schema now rejects `"abc"`, `"007"`, `"-1"` and eight further malformed forms
I added, and accepts `"0"`, `"42"`, and `MAX_SAFE_INTEGER`, with both generated copies carrying the
`pattern` and byte-identical to each other. Layer 2 — the layer that actually matters — is total:
across nine throw-classes and both handlers, including a thrown string, `null`, `undefined`, and a
number, **every case resolved to a structured error and none rejected**. The one wire-reachable
INVALID_REQUEST residue the regex cannot cover (a 21-digit cursor, which matches the grammar but
fails `Number.isSafeInteger`) is absorbed by the widened catch — which is exactly why shipping both
layers, rather than the regex alone, was the right call. Had the builder shipped only the contract
fix, I would be rejecting again.

**Nothing regressed.** The `COLLAB_NOT_FOUND` arm is a context line in the diff, not a changed one —
the byte-for-byte claim is true. Hidden-vs-absent payloads are byte-identical across all five cursor
forms I drove, including the only malformed one the wire still admits, and the `store.ts:1800`-before-
`:1802` ordering that guarantees it is intact. Mutation M-1 proves the oracle test would catch a
regression here; M-2 and M-3 prove the new tests are load-bearing rather than decorative. Full suite
**115 files / 2037 tests green, executed by me**, plus fresh `typecheck` 14/14 with zero cache hits,
`contracts:check` OK on 8 schemas, and `reachability` PASS.

**The fix introduced no new surface worth blocking on.** The new `COLLAB_INVALID_REQUEST` code
echoes only the caller's own cursor or a constant limit string — I asserted negatively that it leaks
no channel name, channel id, or principal id — and it cannot act as a membership oracle because it
only ever fires *after* visibility has already been granted. The generic arm's silence and the
throwing-getter edge are recorded honestly as CO-8 and CO-9 rather than waved away, but neither is a
defect: one matches the shipped house pattern, the other has no reachable source.

**Scope was respected exactly.** Five files, zero `docs/` paths, zero forbidden files, zero removed
assertions, no threshold moved, no acceptance criterion edited. D-2/D-3/D-4 are all still in the code
where the prior audit left them — the builder neither crept nor quietly dropped them. The auth-v2
sentinel is untouched since its operator-ruling re-pin and passes under my own execution.

**S1 is done. The chain may proceed to S2**, carrying CO-1 through CO-9 — and in particular **CO-3:
A1 remains PARTIAL, and S2 must not inherit it as green.** Memory may be upgraded on this verdict.

**Posture at close:** tracked working tree clean (`git status --short --untracked-files=no` is
**empty**); all three mutation probes restored via `git checkout` with confirming status checks, and
`packages/contracts/dist` rebuilt to match the restored source. The temporary untracked probe test
was deleted. The 28 pre-existing untracked operator files (`.png`, `.md`, `.log`, `.bak`) were never
read, moved, or touched. No commits, no pushes.

---

*G2A seat filled by `claude-opus-5` — the model the routing profile seats for G2A; no substitution
claimed or applied. All code claims cite file:line and were read at HEAD `2d6067b`. Every gate in
§1 was executed in this session; nothing material was inherited.*
