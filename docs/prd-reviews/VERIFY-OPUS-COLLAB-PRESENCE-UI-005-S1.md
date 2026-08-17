# INDEPENDENT VERIFIER — PRD-TCLAW-COLLAB-PRESENCE-UI-005, Slice S1

**Verdict: READY_FOR_G2A** — 0 blocking, 4 non-blocking.

**Review date:** 2026-08-16
**Branch:** `phase1-server-owned-authority` · **HEAD:** `a2a3adf`
**Commits reviewed:** `df49276` (S1 feature, 7 files / 651 insertions), `a2a3adf` (generated hermes schema copy, 51 insertions)
**Adjacent, explicitly out of scope-creep judgment:** `b6fd112` (auth-v2 sentinel re-pin, operator ruling, already executed).

---

## MODEL SUBSTITUTION DISCLOSURE — read before weighting this verdict

> The operator's routing profile (`CLAUDE.md` §2) names **Opus 4.8** for the independent-verifier /
> G2A-adjacent seat. **Opus 4.8 is not invocable in this environment.** This verification was
> produced by a **fresh `claude-opus-5` thread with no Builder context** — I did not write, plan, or
> review the S1 code before this session, and I read the PRD and the G1R C3 packet as inputs rather
> than inheriting any judgment from the build lane.
>
> I am filling the **independent-verifier ROLE**; I make no claim to be Opus 4.8. If the operator
> requires that specific model for lineage purposes, **this verification does not satisfy that
> requirement.** Per the No False Delegation rule this substitution is disclosed rather than
> silently absorbed.
>
> A separate **G2A audit still follows this seat** and is not discharged by this document.
> **Posture:** read-only except (1) one temporary, reverted probe mutation (obligation (e)) and
> (2) this file. No commits, no pushes, no untracked operator file was read, moved, or deleted.

---

## 1. Evidence table — every command actually executed

| # | Command | Exact result | Pass |
|---|---|---|---|
| a | `npx vitest run tests/collab-surface.test.ts` | `Test Files 1 passed (1)` · `Tests 13 passed (13)` · 1.69s | ✅ |
| b | `pnpm --filter @torqclaw/contracts check` | `[contracts:check] OK — 8 schemas match source of truth in 2 checked-in dirs.` | ✅ |
| c | `pnpm reachability` | `119 modules reachable from 6 entry points` · 3 pre-existing declared-dormant AUTH-005 CLI modules · `PASS: every substantial module is reachable or declared dormant.` | ✅ |
| d | `git show df49276` / `git show a2a3adf` | Every hunk read and audited; findings in §3 | ✅ |
| e | **Probe mutation** on `collabSurface.ts` → re-run | `Tests 1 failed | 12 passed (13)` — T-2 RED at `tests/collab-surface.test.ts:159` | ✅ (proven falsifiable) |
| e | `git checkout -- packages/gateway/src/collabSurface.ts` → `git diff --stat` | empty diff (exact restore) | ✅ |
| e | re-run after restore | `Tests 13 passed (13)` | ✅ |
| i | Semantic diff of the two generated `ClientCommand.json` copies | byte-equal after key-sorted normalization | ✅ |

Full-suite green on this HEAD (115/115 files, 2026/2026 tests) was supplied by the orchestrator and
**not re-run** by me; I record it as inherited, not verified.

---

## 2. Obligation (e) — T-2 byte-identity, PROVEN FALSIFIABLE (mutation probe)

The preferred mutation probe was performed; I did not fall back to structural inspection.

**Assertion audited first.** `tests/collab-surface.test.ts:137-160` asserts byte-identity at two
levels: the substrate error (`:137-143`, `JSON.stringify({code, message})` of hidden vs nonexistent,
`expect(hiddenPayload).toBe(nonexistentPayload)`) **and** the gateway-facing handler response
(`:157-159`, `expect(JSON.stringify(hiddenViaHandler)).toBe(JSON.stringify(nonexistentViaHandler))`).
That is byte-equality of serialized payloads, **not** error-code equality — the C3 packet §7.2
standard. Correct.

**Mutation applied** (temporary) at `packages/gateway/src/collabSurface.ts:166-168`: appended a
distinguishing oracle `' (channel is hidden from you)'` to the `COLLAB_NOT_FOUND` detail for the
hidden-channel arm only — precisely the regression shape prohibition #1 forbids.

**Result — the test went RED**, exactly where it must:

```
FAIL tests/collab-surface.test.ts > T-2: operator-kind caller who is NOT a member ...
AssertionError: expected '{"code":"COLLAB_NOT_FOUND","detail":"…' to be '…'
Expected: "{"code":"COLLAB_NOT_FOUND","detail":"Request could not be completed"}"
Received: "{"code":"COLLAB_NOT_FOUND","detail":"Request could not be completed (channel is hidden from you)"}"
  ❯ tests/collab-surface.test.ts:159:46
Tests  1 failed | 12 passed (13)
```

**Restored** with `git checkout -- packages/gateway/src/collabSurface.ts`; `git diff --stat` empty;
re-run 13/13 green. The gate is real: it is not vacuously true, and it catches the exact class of
regression it exists to catch.

**Underlying substrate property independently re-verified** (not inherited from C3):
`packages/collab/src/store.ts:96-105` defines `COLLAB_NOT_FOUND_MESSAGE = 'Request could not be
completed'` with a single `notFound()` constructor, and `assertChannelVisible`
(`store.ts:2032-2046`) throws that same `notFound()` for **absent channel**, **non-member**, and
**inactive membership** alike. Byte-identity holds at the source, not merely at the assertion.

---

## 3. Findings per obligation

### (d) Full-diff audit — all seven files

Every hunk in `df49276` and the single hunk in `a2a3adf` was read. No stray edit, no drive-by
refactor, no unrelated line. `git show df49276 --stat -- apps/ packages/collab/` is **empty**: the
console and the substrate were not touched at all.

### (f) Security invariants — verified in code

**f1 — NULL principal ⇒ terminal `COLLAB_IDENTITY_REQUIRED`, no operator bypass. HOLDS.**
`collabSurface.ts:117` and `:145` are the first statements of each handler:
`if (principalId === null) return COLLAB_IDENTITY_REQUIRED;` — before `getStore()`, before any
SELECT. The refusal is returned to `server.ts:615` / `:631` as `sendErr(listErr.code, ...)`.

Critically, **the operator seat earns nothing here.** Traced end to end: `connectionAuth` is
assigned **only** inside the `resolveSurface` closure (`server.ts:221-223`), which returns `null`
when `!collabEnabled()` and otherwise runs `resolveConnectIdentity(credential)` against a verified
`tq1_` surface credential. A legacy root-token operator authenticates via
`connectionAuth.ts:76-80` with `binding: null` and never assigns `connectionAuth` — so
`server.ts:614` reads `connectionAuth?.principalId ?? null` → `null` → refusal. **An operator seat
with no collab surface credential gets no substrate read.** This is the §2a "refuse" answer, and
the three wrong answers (substitute / synthesize / widen) are all structurally absent.

**f2 — CallerContext passed UNMODIFIED; no fabricated/widened membership. HOLDS, with a
documentation-grade nit (NB-1).**
`collabSurface.ts:120` and `:149` pass `callerFor(principalId)` straight into
`store.listChannels` / `store.getChannelTimeline`. The handler never inspects, rewrites, or
post-filters the result, and never touches the thrown `COLLAB_NOT_FOUND` beyond re-wrapping its
code and message verbatim (`:166-168`).

I examined the one thing that *looks* like a fabrication — `callerFor` hardcodes
`kind: 'operator'` (`collabSurface.ts:103`) — and **it cannot escalate.** Verified against the
substrate rather than trusting the builder's comment:
- `assertChannelVisible` (`store.ts:2032-2046`) consults **only** `caller.principalId` against
  `collab_members`; `kind` is never read.
- `listChannels` (`store.ts:1710-1782`) filters on `m.principal_id = ?` with
  `m.state = 'active'` — a membership JOIN, no kind predicate, no operator OR-arm.
- Every security-relevant kind check in the substrate reads `principals.kind` **from the DB**:
  `assertOperatorCaller` (`store.ts:1966-1974`), `assertChannelOwner` (`store.ts:2003-2020`),
  `getOperatorOrThrow` (`store.ts:1951`). None reads the caller struct.

So the hardcoded value is inert plumbing on the read paths S1 uses, and it satisfies PRD §8's
"CallerContext.kind source" rule in effect (the substrate refuses to trust it) though not in form.
Recorded as **NB-1**, non-blocking, because no failure scenario closes: for harm, someone would
first have to add a kind-trusting read predicate to the substrate, which prohibition #1 forbids.

**f3 — Narrowing flag gates both commands AND requires `TORQCLAW_COLLAB_ENABLED`. HOLDS.**
`collabSurface.ts:49-52`: `if (!collabEnabled()) return false;` then the
`TORQCLAW_COLLAB_SURFACE_COMMANDS` truthy check — conjunction, correct direction. Read per-call,
never captured at import, so it is testable without a module reload. Both dispatch arms check it
first (`server.ts:605-608`, `:620-623`) and answer `NOT_ENABLED` **before** the handler is called,
so a flag-off command never reaches the substrate. §9's rollback semantics are satisfied: flipping
`TORQCLAW_COLLAB_SURFACE_COMMANDS=0` removes this surface without touching `authz.ts` or the C0/C1
hardening.

**f4 — Channel-seat deny arms exist. HOLDS.**
`authz.ts:155-157` — explicit named `case 'LIST_CHANNELS': case 'GET_CHANNEL_TIMELINE': return
DENY_NOT_PERMITTED;` inside the `role === 'channel'` switch, matching the house pattern (named, not
default-deny), per C3 §7.3. `node` denies unconditionally at `authz.ts:125`. Pinned by
`tests/collab-surface.test.ts:225-251`.

I checked the sharpest version of this: `connectionAuth.ts:71` mints a **non-null synthetic
principal** `'service:channel-http'` for the channel_service seat — a principal id that reaches
`server.ts:614`'s `connectionAuth?.principalId ?? null` as a **non-null string**, which would sail
past the f1 null-check. It never gets there: **Gate 3 `authorize()` runs at `server.ts:314-320` and
`return`s on deny, before the dispatch switch at `:322`.** The seat deny is therefore load-bearing
and correctly ordered. Belt and braces: were it ever reached, `'service:channel-http'` has no
`collab_members` row, so `listChannels` returns empty and `getChannelTimeline` throws
`COLLAB_NOT_FOUND` — fail-closed either way. Two independent controls.

**f5 — publishOnly SYSTEM frames, no seq consumption. HOLDS.**
`collabSurface.ts:125-128` and `:154-163` use `publishOnly` (the LIST_APPROVALS pattern), not the
sequenced emitter. No session-cursor pollution; core invariant 2 (sessions resume by monotonic
`seq`) is untouched.

**f6 — H-1 intersection UNTOUCHED. HOLDS — verified byte-wise.**
The entire `authz.ts` diff is **10 added lines and 0 deletions**, all inside the `role === 'channel'`
switch (`:148-157`). `authorizeOperator` (`authz.ts:210-242`) is **not in the diff at all**: the
`if (!surface) return ALLOW;` at `:214`, the `currentRole() !== 'operator'` check at `:234`, and the
`!holdsAuthority('approve')` check at `:237` are unchanged characters. Prohibition #5 observed.
T-8 (`tests/collab-surface.test.ts:289-327`) now pins it with all four arms including the
absent-surface blanket-ALLOW path — this closes G1R C3's **NB-1 / R-6** gap, which the C3 packet
explicitly handed to the Builder as an obligation. **Delivered.**

**f7 — `grantedTools` injection surface. CLOSED.**
Neither command carries any authorization input. `LIST_CHANNELS` has exactly `{action, limit}`;
`GET_CHANNEL_TIMELINE` exactly `{action, channelId, cursor, limit}` (`commands.ts:125-148`). No
`principalId`, `surfaceId`, `authorPrincipalId`, `role`, `seat`, or `grantedTools` field —
prohibition #3 satisfied. Enforcement is structural, not conventional: both generated schemas emit
`"additionalProperties": false`, and `server.ts:291` rejects any non-conforming frame with
`SCHEMA_VIOLATION` before authz. Neither handler reads or writes approval state; both are
SELECT-only. Core invariant 5 untouched.

### (g) Scope creep — NONE

`git show df49276 --stat -- apps/ packages/collab/` empty. Grep across the full diff for
`POST_CHANNEL`, `presence`, `roster`, `NEXT_PUBLIC_COLLAB_UI` returns **only PRD-name mentions in
comments** — zero implementation. No console UI, no POST command, no presence/roster selectors, no
socket-delivery claim anywhere (prohibition #10 observed: the module header says "publishOnly SYSTEM
response frames", never that they are guaranteed to arrive). Schema changes are exactly the two read
commands. S1 = reads only. **Boundary respected.**

### (h) Adjudication — flag-off absent-deny verified at predicate level only

**Ruling: ACCEPTABLE for S1, carried as a note (NB-2). Not blocking.**

The Builder discloses this honestly in-line at `tests/collab-surface.test.ts:333-338` rather than
overclaiming — the disclosure itself is correct behavior and I weight it positively.

Reasoning. PRD §6 A1's "flag off ⇒ commands absent-deny" is an acceptance criterion, and the tested
predicate `collabSurfaceCommandsEnabled()` is the **exact and only** expression the dispatch arms
evaluate (`server.ts:605`, `:620`) — I confirmed the call sites are literally that function with no
intervening logic. The untested residue is therefore three lines of `if (!pred) { sendErr(...);
break; }` boilerplate, structurally identical in both arms and visually verifiable in the diff. A
live-socket harness for S1 alone would be new test infrastructure for a slice whose whole purpose is
reads; **S2 cannot ship without exercising this path over a real socket**, at which point it gets
covered for free.

What would flip this to blocking: if the flag check sat *after* the handler call, or if the two arms
differed. Neither is true. I note for G2A that A1 also says "operator seat lists channels + pages a
timeline over WS **against a live gateway**" — that half of A1 is likewise not demonstrated by unit
tests. It is a **carried acceptance-evidence gap for the slice, not a defect in the code**, and it is
S2's natural discharge point. Recorded as **NB-3** so it is not silently inherited as satisfied.

### (i) Contracts discipline — CLEAN

`pnpm --filter @torqclaw/contracts check` reports `OK — 8 schemas match source of truth in 2
checked-in dirs`, which covers both `packages/contracts/generated/` and
`engines/hermes_kernel/mcp_wrapper/schemas/`. So the emit is authoritative, not hand-written.

Visual audit confirms it independently: both copies received the identical 51-line addition, and a
key-sorted semantic diff of the two files is **byte-equal**. The emitted constraints faithfully
mirror `commands.ts:125-148` — `limit` integer 1..100 default 20, `cursor` minLength 1 default '0',
`channelId` minLength 1, and `additionalProperties: false` on both. The two-commit split (source +
generated in `df49276`, hermes copy in `a2a3adf`) is a minor housekeeping wobble — CLAUDE.md §4
prefers generated artifacts kept separate — but both landed before HEAD and the drift gate is green,
so the tree is consistent. Recorded as **NB-4**.

---

## 4. Blockers

**None.** I went looking adversarially — at the hardcoded `kind: 'operator'`, at the synthetic
`service:channel-http` principal that defeats the null-check, at the H-1 hunks, at the
`grantedTools` surface, and at whether T-2 could fail — and each closed against code I read myself.

---

## 5. Non-blocking notes (carry to G2A)

1. **NB-1 — `callerFor` hardcodes `kind: 'operator'`** (`collabSurface.ts:103`). Inert on S1's read
   paths (substrate reads `principals.kind` from its own DB; verified at `store.ts:1966`, `:2003`,
   `:2032`), and the comment says so accurately. But PRD §8's "CallerContext.kind source" rule says
   the gateway never *supplies* it. Cheapest honest fix for a later slice: make the field `'agent'`,
   or derive it, so no future reader mistakes it for an assertion of operator-ness. **No action
   required for S1.**
2. **NB-2 — flag-off absent-deny is predicate-level only**, not socket-level (Builder-disclosed at
   `tests/collab-surface.test.ts:333-338`). Adjudicated acceptable above; discharges naturally in S2.
3. **NB-3 — A1's "over WS against a live gateway" half is not demonstrated** by S1's unit tests.
   Carried, not satisfied. G2A should not read A1 as fully green on unit evidence alone.
4. **NB-4 — generated-artifact split across two commits** (`df49276` carried source *and*
   `packages/contracts/generated/`; `a2a3adf` carried the hermes copy). Drift gate green, tree
   consistent; noted only against CLAUDE.md §4's "keep generated artifacts separate" preference.
5. **Inherited, not verified by me:** the full-suite 115/115 files, 2026/2026 tests figure supplied
   by the orchestrator. I ran the targeted suite, contracts check, and reachability myself.
6. **G1R C3 obligations status:** T-1 ✅ (`:93-108`), T-2 ✅ (`:111-161`, mutation-proven),
   T-3 ✅ (`:215-251` + contracts:check), T-5 ✅ (`:164-198`), T-8 ✅ (`:289-327` — closes C3 NB-1/R-6).
   T-4/T-6/T-7 correctly belong to S3/S4/S5 and are properly declared out of scope at
   `tests/collab-surface.test.ts:14`. **No acceptance criterion was edited to satisfy it** — I
   diffed the PRD: it is untouched by both commits.

---

## 6. Final verdict

**READY_FOR_G2A.**

The three non-negotiable gates are green and were run by me, not reported to me. The highest-
consequence property in the PRD — hidden-channel indistinguishability — is asserted to the correct
byte-identity standard and was **empirically proven able to fail** by mutation, then restored to a
clean tree. The H-1 intersection is byte-wise untouched and is now pinned by T-8, closing the one
gap the G1R C3 packet handed forward. The seat lattice and the principal lattice are not conflated
anywhere I could find, and the operator seat earns no substrate read it is not entitled to as a
principal.

Working tree after this verification: restored to its pre-verification state; the only new file is
this verdict. No untracked operator file was touched.

---

*Independent verifier seat filled by `claude-opus-5` (substitution disclosed in the header) ·
read-only apart from one reverted probe mutation and this file · all code claims cite file:line and
were read at HEAD `a2a3adf` · a separate G2A audit follows and is not discharged by this document.*
