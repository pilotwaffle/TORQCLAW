# PRD-TCLAW-COLLAB-PRESENCE-UI-005 — Human + Agent Co-Presence Surface ("Buzz parity")

**Status:** v0.5 — **GATE 1 APPROVED (design)** at G1R Cycle 3 (`GATE1-C3.md`, APPROVE, 0 blocking, 4 non-blocking folded into v0.4). §7 operator gate **RESOLVED 2026-08-16** (operator chose (a): WIP landed). **S1 COMPLETE and G2A-APPROVED** (`G2A-…-S1-REAUDIT.md`); S2 is next.
**v0.5 amendment (2026-08-16):** adds **A6** (§6) and **T-9** (§8) — the handler-totality criterion, closing carried obligation **CO-4** from the S1 audit. Amendment is **additive only**: no existing criterion, test, or scope was weakened, reworded, or removed. See §9b.
**v0.6 (2026-08-16):** (i) A6/T-9 **hardened after a G1R REJECT** (3 blockers — falsifiability standard made self-contained and artifact-producing; "narrowest grammar" now requires citing the consuming validator by `file:line`; totality extended from the handler to the whole `socket.on('message')` path incl. the dispatch arm). (ii) Adds **PART II** (§11–§16) — the **product build-out** on operator instruction: a substrate feasibility ledger, an honest definition of "Buzz parity", the end-user surfaces S2–S7, and their acceptance criteria A7–A10 / T-10–T-13. Part II **adds no authority and relaxes nothing** in Part I.
**G1R Cycle 1:** `docs/prd-reviews/G1R-OPUS-COLLAB-PRESENCE-UI-005-GATE1.md` (REJECT, 6 blocking)
**G1R Cycle 2:** `docs/prd-reviews/G1R-OPUS-COLLAB-PRESENCE-UI-005-GATE1-C2.md` (REJECT, 0 unresolved + 4 NEW: §6/§8/§9 not propagated from the §4 rescopes; `text` field name). Both reviews ran on `claude-opus-5` filling the G1R role — disclosed in their headers.
**Date:** 2026-08-16 (v0.1 → v0.3)
**Program:** Collaboration (successor effort to PRD-TCLAW-COLLABORATION-SUBSTRATE-001 §19
owed items and PRD-TCLAW-COLLAB-GATEWAY-004 C-chain)
**Author:** G1D (session orchestrator; runtime model `claude-fable-5`)
**Operator instruction:** "have the function that Buzz offers — agents and humans chat
and interact." Research first; PRD if none exists; then governed implementation.

---

## 0. Research finding — what exists, what doesn't (the reason this PRD exists)

| Layer | State | Evidence |
|---|---|---|
| Channels/members/messages/live-delivery **data+protocol substrate** | **BUILT, G2A-approved, headless** — slices 0,1,2,3,5 | `packages/collab/src/*` (store, subscriptions, fanout, sessions, surfaces…); `PRD-TCLAW-COLLABORATION-FINAL-STATUS.md` |
| Surface **identity on the wire** (tq1_ credential in CONNECT, server-derived identity) | **LANDED** (C0/C1; `TORQCLAW_COLLAB_ENABLED`, default off) | `contracts/src/commands.ts` auth carrier (HEAD:131-145); `gateway/src/collabIdentity.ts`, `principalBridge.ts` |
| Connection **auth migration** (server-owned authority, channel service seats) | **IN FLIGHT — operator WIP**, uncommitted on `phase1-server-owned-authority` | working tree: `connectionAuth.ts` (new), `ConnectFrame` schema changes |
| Channel **read/post commands on the WS wire** | **ABSENT** | `git show HEAD:contracts/src/commands.ts` — no LIST_CHANNELS / timeline / post |
| **Human-facing co-presence UI** (channels, roster, chat) | **ABSENT — explicitly owed**: "operator UI + real-socket wiring DEFERRED to a separate gateway effort" | `PRD-TCLAW-COLLABORATION-FINAL-STATUS.md` (Slice-5 note, §19 owed list) |
| Buzz functional model | Analyzed: **Buzz = identities + room; TorqClaw = governed execution** — two layers of one program | `docs/prd-reviews/TORQ-BUZZ-VS-TORQCLAW-COMPARISON.md` |

**Conclusion:** no PRD covers the human+agent co-presence surface. This document is that
PRD. It deliberately does **not** re-specify the substrate (v0.14 is authoritative for
channel semantics, cursors, fanout, revocation) or the C-chain (004 is authoritative for
identity/capability/authority) — it specifies the *surface* that puts humans and agents
in the same room, and the minimal wire surface the console needs to render truth.

## 1. Objective

An operator opens the console's **Channels** view and sees the real collaboration
fabric: the channels that exist, who is present (humans by surface identity, agents by
their working sessions), the message timeline, and a composer to speak into a channel.
Agents participating in tasks appear as co-present, working entities (Buzz's
roster/Pulse experience) — while every execution-authority rule TorqClaw already
enforces remains exactly intact.

## 2. Controlling invariant (v0.2 — adopts G1R's independent formulation)

**A co-presence surface may render only what its own authenticated subject is already
entitled to see, write only what that subject may write, and never become a path by
which either entitlement is computed, widened, or acted upon.**

Concretely: (a) the gateway remains the sole execution authority; (b) `approve` remains
reserved operator-surface authority — no channel message, agent post, or collab event
may approve, trigger, or widen a gated action (frozen operator ruling, 2026-08-08 /
collab-gateway-004); (c) identity is always server-derived from authenticated
credentials — no client-supplied principal/surface/channel id is ever trusted (C0 H-1
discipline); (d) a message is data, not a command: nothing in a channel timeline is
parsed into gateway actions.

### 2a. THE TWO LATTICES (v0.2, resolves G1R B-1 + B-2 at their shared root)

The gateway **seat** lattice (`operator|channel|node`) and the substrate **principal**
lattice (`principal_id × collab_members`) are two different authorization systems and
must never be conflated:

- The **seat** decides only whether a connection may use a collab command *class* at
  all (operator seat: yes; channel/node seats: explicit deny arms + tests).
- The **subject** of every substrate call is the connection's resolved collab
  principal (`CallerContext`), established at CONNECT from an authenticated `tq1_`
  surface credential. Substrate visibility scoping (membership JOINs, byte-identical
  `COLLAB_NOT_FOUND` hidden-channel denial) applies **unmodified** — there is NO
  operator bypass, NO seat-level read entitlement, NO principal synthesis.
- A connection with `principal_id = NULL` (legacy root-token operator) receives an
  honest terminal refusal — error code `COLLAB_IDENTITY_REQUIRED` — from every collab
  command. Of B-1's three wrong answers (refuse / substitute / synthesize), **refuse
  is the specified behavior**; the console renders it as an honest "connect with a
  collab surface credential to join channels" state, never an empty fabrication.

## 3. Non-scope (binding)

- Approvals in channels, approval mirrors, or "react-to-approve" — prohibited (ruling).
- Nostr/relay federation (Buzz's transport). TorqClaw stays loopback-first,
  gateway-mediated. Buzz interop is a possible future adapter, not this PRD.
- Slack/Discord adapters, channel policy clamps — that is SCOPE-PHASE-3 (separate).
- Per-tool allowlists (ruled out of Phase 3 for mechanical honesty; same here).
- Re-opening substrate semantics (cursors, fold, name_key, revocation) — v0.14 owns them.
- Remote skill distribution, CredMan adapter, destructive-restore — remain owed to their
  own efforts (§19 list), not silently absorbed here.

## 4. Slices (each independently gate-green, flag-gated, reversible)

### S1 — Wire read surface (gateway + contracts)
`LIST_CHANNELS` and `GET_CHANNEL_TIMELINE` (paged by the substrate's `channel_seq`
cursor rules), issued from an operator **seat** but executed with the connection's
resolved collab **principal** as the substrate `CallerContext` (§2a — no bypass, no
NULL subject: `COLLAB_IDENTITY_REQUIRED` refusal when unresolved). publishOnly SYSTEM
response frames (the LIST_APPROVALS pattern). Gated on a **dedicated narrowing flag**
`TORQCLAW_COLLAB_SURFACE_COMMANDS` that requires `TORQCLAW_COLLAB_ENABLED` — so
turning the read surface off never reverts the C0/C1 identity hardening (G1R
non-blocking flag-blast-radius finding, adopted; final flag naming is an operator
decision). Explicit `channel` and `node` **deny arms + tests** in authz (Phase-3
invariant 8 discipline). No writes.

### S2 — Console Channels view (UI)
Fourth nav item in the PRD-UI-1 shell. Channel list → timeline (Inter for message
bodies, mono chrome), member roster from real membership rows. Read-only in this slice.
Flag `NEXT_PUBLIC_COLLAB_UI`; absent wire data renders the honest ApprovalHistoryPanel
pattern (null=loading / []=real-empty / sendFailed / timeout — never fabricated rows).

### S3 — Human posting
`POST_CHANNEL_MESSAGE` carrying exactly `{channelId, text, idempotencyKey}` — field
name `text` per the substrate's actual contract
(`postChannelMessage(caller, { channelId, text }, idempotencyKey)`,
`normalizeMessageText(body.text)`; NEW-4 corrected). The idempotency key is a
**client-supplied canonical UUID** (resolves G1R B-3: a
retried post after a dropped socket must not commit a duplicate immortal
`message_posted` event, and a text-derived key would silently collapse two legitimate
identical messages). The server stamps the author from the connection's resolved
principal — the command has no author field to spoof. Composer in the Channels view.
Explicit channel/node deny arms. Subject rules per §2a apply (surface-credentialed
connections only).

### S4 — Live delivery as hint-then-refetch (v0.2 rescope — resolves G1R B-4)
The gateway's publishOnly frames are seq-less and non-persisted, and the substrate's
delivery sink models write-INITIATED with real backpressure explicitly owed to §19 —
so "no committed event lost over the socket" is not an honest claim on this
transport. S4 therefore specifies: live frames are **invalidation hints only**
("channel N advanced"); on receipt (or on reconnect) the console **re-reads from the
durable store via the S1 cursor path**, which is the source of truth. No-loss holds
because the store is authoritative and the cursor is monotonic — not because the
socket promises delivery. Hint-triggered re-reads are **coalesced** (one in-flight
re-read per channel; further hints during it mark it dirty for exactly one follow-up)
so a busy channel cannot thundering-herd the store (Cycle-2 NB-3, adopted). The
real-socket backpressure item **remains owed to §19** and is not discharged by this
slice (v0.1 overclaimed; withdrawn).

### S5 — Agent co-presence (v0.2 rescope — resolves G1R B-5)
**Presence only, read-side only.** The roster shows working agents derived from the
gateway's existing task truth (active tasks / receipts — the same selectors the
console's liveness surfaces already use), joined at render time. The v0.1
lifecycle-event *mirroring* into channels is **CUT**: it created a second,
uncorrectable source of truth for task state in a different DB/WAL with no
rebuild/tombstone path, and a telemetry-to-members disclosure path. If narrative
mirroring is ever wanted, it gets its own PRD with a rebuild story. §5's "S3 is the
only new mutation" is therefore true again.

## 5. Authority & state contract

- Authoritative: collab store (channels/members/messages) for conversation;
  gateway sessions + connection auth for identity; gateway for all execution.
- Derived: everything the console renders (snapshot-on-frame discipline).
- Mutation: S3 posting is the only new mutation, server-stamped, substrate-validated.
- Persistence: substrate's collab.db (self-migrating per C1). No new stores.
- Failure: absent frames render honest empty/error states; subscription loss falls back
  to the S2 read path; flags off = feature fully absent (rollback story).

## 6. Acceptance criteria (per slice, evidence required)

- A1 (S1): operator seat lists channels + pages a timeline over WS against a live
  gateway; channel/node seats receive explicit denies (authz tests); flag off ⇒
  commands absent-deny.
- A2 (S2): Channels view renders real channels/timeline/roster; kill the gateway ⇒
  honest stale/empty states; zero fabricated fields (no invented presence, no fake
  read receipts).
- A3 (S3): a posted message round-trips: visible in a second operator session's
  timeline read; author identity is server-stamped (attempting to spoof author in the
  command shape is structurally impossible — field absent from contract).
- A4 (S4, v0.3 — matches the §4 rescope): store-backed contiguous recovery. After any
  hint receipt, disconnect, or reconnect, the rendered timeline is a contiguous,
  prefix-consistent sequence of committed events re-read from the durable store via
  `channel_seq` cursors (the dense cursor makes contiguity assertable). **No delivery
  guarantee is claimed or tested for hint frames.** Live hints demonstrably trigger a
  coalesced re-read (event visible without manual refresh).
- A5 (S5, v0.3 — matches the §4 cut): a running task appears in the roster with
  anchored elapsed, derived from existing task truth; **a full task lifecycle
  (submit → run → terminal) produces ZERO writes to `collab_events`** (DB-provable),
  and no roster row carries any dispatch affordance.
- **A6 (EVERY slice that adds or changes a wire command — v0.5, closes CO-4):** each
  such command is **total on every input its contract admits**. Concretely, for each new
  or changed command: (a) the contract constrains each free-form field to the narrowest
  grammar the consuming layer accepts, **and the slice's evidence cites the consuming
  validator by `file:line` for every free-form field — the specific function that would
  reject the value downstream (e.g. `cursor` → `store.ts` `parseCursor`). A field whose
  consuming validator is not cited is not graded green**; and the emitted schemas carry
  that constraint. (b) **No input the contract still admits can cause the handler — or the
  `server.ts` dispatch arm that consumes its return value — to throw**; every failure
  resolves to a structured error frame, never an exception. **The unit of totality is the
  entire code path executed inside `socket.on('message')` for that command, not the handler
  function alone.** (c) Failures are reported through the existing error-code union without
  introducing a new distinguishing signal on any indistinguishability-protected path
  (§2a / T-2).
  **Evidence required: the T-9 matrix below, not an assertion of care.** A6 is graded
  per slice and is never inherited from a prior slice.
- Gate: full TS suite green; new authz arms tested; reachability green; checklist-10
  honesty sweep (no dead buttons, no invented data).

**A6 rationale (why this criterion exists — do not delete as boilerplate):** S1 shipped
a `cursor` field typed `z.string().min(1)` whose value the substrate validated by
*throwing*. The gateway's `socket.on('message')` handler wraps only `JSON.parse`, and
there is no `unhandledRejection` listener in `packages/` or `ops/`, so one malformed
cursor from any authorized connection terminated the whole gateway process — killing
every live session. The Builder missed it, the independent verifier missed it, and the
**§6/§8 gate set as written would have accepted it**, because no criterion asked the
question. See `docs/prd-reviews/G2A-OPUS-COLLAB-PRESENCE-UI-005-S1.md` (D-1).

**A6 scope boundaries (so silence is not mistaken for coverage):**
- **Resource exhaustion is OUT of A6's scope.** A6 is a *totality* criterion, not a resource
  one: a grammatically valid but enormous input is a different failure mode needing a
  different control (an explicit length/size bound). S3's free-form `text` is bounded by the
  substrate at **16,384 UTF-8 bytes** (§11 row 12) and that bound must be named in S3's own
  criteria — A6 will not catch it.
- **One known exception to "total"**: a thrown object whose `code` *getter* itself throws
  still escapes, because `err?.code` is evaluated inside the catch. Unreachable by
  construction today (`CollabError.code` is a plain readonly data property; zero accessors
  in `packages/collab/src`), carried as CO-9. Stated because "total" is a strong claim and
  this is its single exception — not a licence to widen it.

## 7. Dependencies and the operator gate (blocking, honest — v0.2 completes B-6)

1. **Dirty-file collision (complete list):** S1/S3/S4 must edit
   `packages/contracts/src/commands.ts`, `packages/gateway/src/server.ts`,
   `packages/gateway/src/authz.ts`, `packages/gateway/src/sessions.ts`, and
   `packages/gateway/src/collabIdentity.ts` — **all carrying uncommitted operator
   WIP** — and interact with the **untracked** `packages/gateway/src/connectionAuth.ts`,
   which is precisely where the principal resolution §2a depends on is being built.
   Repo rule: stop and ask before co-editing files with owner edits.
   **Implementation of every code slice therefore starts only after the operator
   either lands the WIP or explicitly authorizes co-editing.**
2. **The C2 connect-path governs S1 reads too, not just S3** (B-6 second half): §2a's
   subject model requires surface-credentialed connections, which is the WIP's exact
   domain. All slices are architecturally downstream of the migration.
3. S2 alone without S1 would be a dead view (violates honesty rules) — S2 ships only
   with or after S1.
4. **Terminology note (G1R non-blocking, adopted):** this PRD's "channels" are
   substrate conversation channels; SCOPE-PHASE-3's "channels" are transport adapters
   (Slack/Discord seats). The two efforts are disjoint; docs must not blur the term.
5. **Production reality (Cycle-3 NB-4):** the substrate's Windows Credential Manager
   store is still the §19-owed stub, so in production S1 fails closed to
   `COLLAB_IDENTITY_REQUIRED` until a real SecretStore adapter lands. Dev/loopback
   surface credentials work today; the CredMan adapter remains owed to its own effort
   and is NOT absorbed here.

## 8. Required tests (v0.3 — named, non-negotiable; each enforces a Gate-1 resolution)

- **T-1 (enforces B-1/§2a refuse):** every new collab command issued on a connection
  with an unresolved principal returns the terminal `COLLAB_IDENTITY_REQUIRED`
  refusal — one test per command.
- **T-2 (enforces B-2/§2a no-bypass):** substrate visibility parity — an
  operator-kind caller who is NOT a member of a hidden channel receives a
  **byte-identical `COLLAB_NOT_FOUND` payload** to the nonexistent-channel case (byte
  equality, not error-code equality), proving the seat lattice never leaks into
  substrate visibility.
- **T-3:** explicit `channel` and `node` seat deny arms for each new command, plus the
  contract emit + drift gate (`pnpm contracts:check`).
- **T-4 (enforces B-3):** idempotent retry — re-posting with the same
  `idempotencyKey` commits exactly one `message_posted` event; two posts with
  identical `text` but distinct keys commit two.
- **T-5:** timeline cursor paging against a live store, asserting dense
  `channel_seq` contiguity across page boundaries.
- **T-6 (enforces B-4 rescope):** hint-then-refetch recovery — sever the socket
  mid-stream, commit events, reconnect: the re-read renders the contiguous committed
  sequence. Asserts store-backed recovery only; contains **no** socket-delivery
  assertion.
- **T-7 (enforces B-5 cut):** a full task lifecycle produces zero `collab_events`
  rows; roster presence selectors unit-tested; honest empty/loading states
  (component tests, ApprovalHistoryPanel pattern).

- **T-8 (Cycle-3 NB-1, adopted):** flag-matrix regression assertion — with
  `TORQCLAW_COLLAB_ENABLED=1`, `authorizeOperator` enforces both live checks
  (`currentRole()==='operator'` and `holdsAuthority('approve')`) on `APPROVE_TOOL`;
  the test pins the H-1 hardening this PRD's §9 prohibition protects. Note: this
  asserts code the PRD is prohibited from *modifying* — it is a repo-suite hardening
  obligation carried by the Builder, and §10's prohibition #5 is load-bearing until
  T-8 exists.

- **T-9 (enforces A6 — v0.5, closes CO-4): handler totality matrix.** Required for
  **every** slice that adds or changes a wire command; one matrix per command. A slice
  adding no wire command declares T-9 not-applicable and says so explicitly. The matrix
  has four parts, all four required:

  1. **Contract-boundary rejection.** Parse the *compiled/emitted* schema (not the Zod
     source) and assert it rejects each malformed form of every free-form field, and
     still accepts the valid forms including the default. **Parse the built artifact** —
     mutating only `src` and testing it goes falsely green (the repo's
     verify-the-artifact-not-the-unit-test trap). **The test must also fail if the
     `@torqclaw/contracts` alias resolves to source rather than `dist`** — `vitest.config.ts`
     can flip that alias via `TORQCLAW_PROFILE_CONFORMANCE_SOURCE_CONTRACTS=1`, which would
     silently downgrade this whole part to a Zod-source test while staying green.
  2. **Residue enumeration (the part that catches what a regex cannot).** Name, in the
     test, every input the contract *still admits* that the consuming layer rejects by
     throwing, and assert each resolves to a structured error. A grammar constraint that
     mirrors a downstream validator is **not equivalent to it** — range checks,
     safe-integer checks, referential checks, and anything stateful are not
     regex-expressible. *S1's measured case: a 21-digit cursor has no leading zero, so
     it satisfies `^(0|[1-9][0-9]*)$` and passes the contract, then fails
     `Number.isSafeInteger` inside the substrate. A contract-only fix would have left
     D-1 open.*
  3. **Throw-class totality.** Drive each handler through its test seam with, at minimum:
     a domain error carrying the expected code; a domain error carrying some *other*
     code; a plain `Error`; and **non-`Error` throws (string, `null`, `undefined`,
     number)** — the last class matters because optional-chained `err?.code` on a thrown
     string is `undefined` and must land in a generic arm rather than escaping. Assert
     every case **resolves**; a rejected promise is a failure.
     **Beyond the handler:** the slice's evidence additionally **names every throwing call
     reachable from the command's dispatch arm but OUTSIDE the handler's own try/catch** —
     including `sendErr`'s `JSON.stringify` and `socket.send`, any `publishOnly` /
     `GatewayEventSchema.parse`, and the flag-off `NOT_ENABLED` residue — and states for
     each why it cannot throw on any wire-admissible input, **or nets it**. *This is not
     hypothetical: `events.ts`'s `publishOnly` calls a throwing validator over
     store-derived metadata and is netted today only because it happens to sit inside both
     handlers' try/catch. Nothing but this clause requires it to stay there.*
  4. **No new oracle.** Re-run the §8 indistinguishability assertion (T-2 for this PRD)
     across the *malformed* inputs as well as the well-formed ones, proving the new error
     path did not become a distinguishing signal. Unclassified failures must return a
     **detail-free** generic code; a caller-supplied value echoed back is acceptable,
     server state is not.

  **Falsifiability obligation.** Each of the four parts must be shown able to fail. For
  each part: revert the specific guard it pins, run the test file, **record the observed
  RED output (test name + failure message + pass/fail counts)**, restore, and re-run GREEN.
  The **four RED excerpts and the exact revert applied** are recorded in the slice's
  verification evidence file; **a probe reported without its RED output is not a discharged
  probe.** For part 1 the revert must include `pnpm --filter @torqclaw/contracts build`, and
  the restore must `git checkout` the source **and both checked-in generated copies** and
  rebuild, or the probe is vacuous. *(This is the mutation-probe discipline used by the S1
  G2A re-audit, M-1/M-2/M-3. It is stated here in full because **no other §8 test carries
  it — do not read T-2/T-6 as the calibration**.)*

The v0.1 "S4 no-lost-event (substrate harness reuse)" and "S5 no-dispatch-surface
structural" tests are **deleted** — the first was un-falsifiable as specified, the
second tested a cut feature.

**Roster label rule (Cycle-3 NB-2):** the S2/S5 roster renders two labeled sections
from two distinct sources — "members" (substrate `collab_members` rows, the
entitlement truth) and "working now" (gateway task truth, the presence overlay). The
two are never merged into one unlabeled list, and presence never implies membership.

**CallerContext.kind source (Cycle-3 NB-3):** the substrate reads `principals.kind`
from its own DB; the gateway never supplies or overrides it.

## 9. Rollback (v0.3 — resolves NEW-3)

`TORQCLAW_COLLAB_SURFACE_COMMANDS=0` removes this PRD's wire surface;
`NEXT_PUBLIC_COLLAB_UI=0` removes the view. Both default off; each slice is a separate
commit whose revert restores the prior gate-green state. No schema changes beyond the
substrate's own (already self-migrating).

**`TORQCLAW_COLLAB_ENABLED=0` is NOT a rollback for this PRD's surface and must never
be used as one:** at HEAD, flag-off returns `authorizeOperator` to the legacy blanket
ALLOW (`if (!surface) return ALLOW`), silently dropping the H-1 hardening's live
`currentRole()==='operator'` and `holdsAuthority('approve')` checks. Flipping that
flag is a security decision about the C0/C1 identity layer, owned by the operator,
outside this PRD.

## 9a. G1D resolution record — Cycle 1 (all six blockers)

| Blocker | Resolution in v0.2 |
|---|---|
| B-1 (subjectless reads) | §2a: substrate subject = resolved collab principal; NULL principal ⇒ honest `COLLAB_IDENTITY_REQUIRED` refusal (the "refuse" answer, named) |
| B-2 (hidden-channel break) | §2a: no operator bypass, no seat-level read entitlement; membership scoping and byte-identical `COLLAB_NOT_FOUND` untouched |
| B-3 (idempotency) | S3 wire shape now `{channelId, text, idempotencyKey}` with client-supplied canonical UUID per the substrate contract (field name corrected per Cycle-2 NEW-4) |
| B-4 (no-loss overclaim) | S4 rescoped to hint-then-refetch; store is the source of truth; §19 backpressure item explicitly NOT discharged |
| B-5 (mirror = second truth) | S5 mirroring CUT; presence is read-side render-time join of existing task truth; "§5 S3-only-mutation" true again |
| B-6 (incomplete gate) | §7.1 names all five dirty files + untracked `connectionAuth.ts`; §7.2 extends the C2 dependency to S1 reads |

Adopted non-blocking findings: dedicated narrowing flag for the wire surface (final
name = operator decision); Phase-3 "channel" terminology note. Declined with
rationale: extracting an epoch-anchored-elapsed fix as standalone work — the console's
elapsed surfaces were all epoch-anchored by the PRD-UI-1 passes landed 2026-08-16;
the gap the reviewer flagged no longer exists (Cycle 2 independently audited and
upheld this declination).

### Cycle-2 resolution record (v0.3)

| Blocker | Resolution |
|---|---|
| NEW-1 (§6 not propagated) | A4 rewritten to store-backed contiguous recovery with an explicit no-delivery-guarantee clause (folds Cycle-2 NB-1 contiguity); A5 rewritten to the zero-`collab_events`-writes assertion; mirroring clause deleted, not softened |
| NEW-2 (§8 unenforced) | §8 replaced by named non-negotiable T-1..T-7, each mapped to the Gate-1 resolution it enforces; T-2 requires byte-identical `COLLAB_NOT_FOUND` payloads; the two stale v0.1 tests deleted |
| NEW-3 (§9 wrong rollback flag) | §9 names `TORQCLAW_COLLAB_SURFACE_COMMANDS=0` as the rollback and explicitly prohibits `TORQCLAW_COLLAB_ENABLED=0` as a rollback, citing the H-1 blanket-ALLOW reversion at HEAD |
| NEW-4 (`body` vs `text`) | S3 wire shape corrected to `{channelId, text, idempotencyKey}` |

Adopted Cycle-2 non-blocking: NB-1 contiguity (folded into A4), NB-3 coalesced
re-reads (folded into S4).

## 9b. Amendment record — v0.5 (CO-4: handler totality)

| Item | Record |
|---|---|
| **Origin** | Carried obligation **CO-4**, raised by the S1 G2A audit and re-affirmed as still-open by the S1 re-audit: *"the §6/§8 gate set contains NO handler-robustness or malformed-input criterion; it would have accepted D-1."* |
| **Defect that exposed the gap** | **D-1** — a `cursor` field the contract admitted freely, validated downstream by *throwing*, escaping an un-netted async socket handler ⇒ whole-process termination from one malformed input. Found only at G2A, after Builder and independent verifier both passed it. |
| **Change** | **A6** added to §6 (with a non-deletable rationale note); **T-9** added to §8 (four-part matrix + falsifiability obligation). Nothing else altered. |
| **Additive-only proof** | A1–A5, T-1–T-8, §2/§2a/§3/§4/§5/§7/§9 are byte-unchanged; the diff is insertions plus the status header. **Independently confirmed by G1R** (`G1R-OPUS-COLLAB-PRESENCE-UI-005-A6-T9.md` §1: 68 insertions / 1 deletion, the deletion being the v0.4 status header). This is the repo's most-recorded defect class (editing an AC to fit an implementation), so the amendment had to be reviewable as strictly additive — and was reviewed as such rather than self-certified. |
| **Review** | **G1R REJECTED v0.5 (3 blockers), all fixed in v0.6** — B-1: the falsifiability clause cited "the same standard as T-2/T-6", but neither carries one, so a Builder would correctly derive that no probe was required — *the unenforced-claim pattern reproduced inside the criterion written to cure it*. Now self-contained and artifact-producing. B-2: "narrowest grammar" was satisfiable by assertion; now requires citing the consuming validator by `file:line`. B-3: A6 proved the *handler* total while D-1's mechanism was "a throw reaches the unprotected socket handler" — the dispatch arm runs `sendErr` outside that try/catch; the unit of totality is now the whole path inside `socket.on('message')`. |
| **Applies to** | S2 onward. **S1 is not retroactively re-graded** — its D-1 fix already satisfies A6 in substance (both layers, 18 totality probes, 3 mutation probes, oracle re-check), which is what made this criterion writable from evidence rather than speculation. |
| **Why it generalizes** | The failure was not "someone forgot a validation." It was **a gate that never asked the question**, so no amount of diligence inside the gate could have failed it. A6/T-9 make the question mandatory — the repo's recurring unenforced-claim pattern in a new costume: the invariant was real, believed, and pinned by nothing. |

## 10. Operator stop conditions

Landing/authorizing the WIP co-edit (§7.1); the §11-004 open decisions if any S-slice
touches them; push/merge/release of any slice; enabling either flag in a deployment.

---

# PART II — PRODUCT BUILD-OUT (v0.6, added on operator instruction)

> **Operator instruction (2026-08-16):** *"i want the complete prd built out with all the
> features for the end user we need to look at the frontend ui also for the buzz feature
> of having agents and humans chatting in the same channel to build or research, etc..."*
> plus *"you can find updated code to use https://github.com/block/buzz"*.
>
> Part I (§1–§10) specifies the **mechanism** — five engineering slices, S1 shipped. Part II
> specifies the **product**: what the end user actually sees and does, grounded in upstream
> Buzz (`docs/prd-reviews/BUZZ-UPSTREAM-FEATURE-RESEARCH-2026-08-16.md`) and in a full
> capability audit of our own substrate and console. Part II **adds no authority** and
> **relaxes nothing** in Part I; §2, §2a, §3, §5, §9 and §10 bind every word below.

## 11. Feasibility ledger — what the substrate can and cannot support

**This table is the honesty spine of Part II.** Every feature named later cites a row here.
Verified by direct source audit of `packages/collab/src/**` and `apps/console/src/**` on
2026-08-16. **A feature marked ✗ cannot be specified as shipping without a new substrate
migration and its own review cycle — no acceptance criterion below may assume one.**

| # | Capability | State | Evidence / constraint |
|---|---|---|---|
| 1 | Channels (create, archive, unarchive, name uniqueness) | ✔ built | `collab_channels`; partial unique index on `name_key` scoped to `state='active'` |
| 2 | Channel **description / topic / purpose** | ✗ **absent** | no column anywhere; would need a nullable-column migration (light, precedented) |
| 3 | Public / discoverable channels | ✗ **absent** | visibility is 100% membership-derived; **every channel is invite-only** |
| 4 | Membership (`owner` / `agent`, `active` / `removed`) | ✔ built | `collab_members`; only the operator may create channels or manage membership |
| 5 | Messages (`message_posted`, immutable, append-only) | ✔ built | `collab_events`; payload is exactly `{channelId, text}` |
| 6 | Message **edit / delete** | ✗ **absent** | no such event kind; events are append-only, no UPDATE/DELETE path |
| 7 | **Threads / replies** | ✗ **absent** | no `parentEventId`; would need a new event kind (heavy: CHECK-constraint migration) |
| 8 | **Reactions** | ✗ **absent** | no event kind, no table |
| 9 | **Attachments / media** | ✗ **absent** | no field, no blob storage |
| 10 | **Mentions** (server-side parsing/notification) | ✗ **absent** | no parsing, no mentions array, no notify-on-mention |
| 11 | Markdown / rich text | ✗ no server support | `text` is a raw string; any rendering is a pure client choice |
| 12 | Message size cap | ✔ enforced | **1–16,384 UTF-8 bytes**; only TAB/LF/CR allowed among control chars |
| 13 | Timeline paging (cursor, contiguity, clamp) | ✔ built + **wired (S1)** | `channel_seq` cursor; `rejoined_seq` clamp; limit 1–100; **64 KiB frame cut** |
| 14 | Channel list | ✔ built + **wired (S1)** | returns **only** `channelId, name, state, role, lastAcknowledgedCursor` |
| 15 | **Unread count** | ✗ **not computed** | `collab_cursors` stores a last-read cursor and `listChannels` returns it — but **no max `channel_seq` is returned**, so a badge cannot be derived from one call |
| 16 | Read cursor (`ackChannelCursor`) | ✔ built, **not wired** | naturally idempotent, monotonic max-upsert |
| 17 | **Search** | ✗ **absent** | no FTS, no LIKE query, no index over `content_json` |
| 18 | **Presence / online / typing** | ✗ **absent from substrate** | zero hits; `surfaces.last_seen_at` exists but **is never written — a dead column** |
| 19 | "Working now" (agent activity) | ⚠ **derivable, not stored** | **no join key from `principals` to any task**; task truth lives in the gateway |
| 20 | Live pub/sub (subscribe, fan-out, revalidation) | ⚠ **built, NOT wired** | real engine w/ per-write revalidation, but **in-memory only** and **no gateway code path calls it** |
| 21 | Message posting from a client | ✗ **not wired** | `postChannelMessage` exists in the store; **no gateway path reaches it** (S3) |
| 22 | Multiple distinct **human** users | ✗ **architecturally absent** | `principals.kind ∈ {operator, agent}` with a **unique index enforcing ONE operator** |
| 23 | Rate limit on posting | ✗ absent | rate limiting covers **auth attempts only**, not message frequency |
| 24 | Display-name uniqueness | ✗ absent | normalized, but **no unique constraint** — two agents may share a name |

### 11a. The four findings that reshape the product

1. **"Humans and agents chatting" is, at this substrate, ONE human and N agents** (row 22).
   A single-operator unique index makes multi-human chat architecturally impossible today.
   Part II therefore specifies **an operator working alongside their agents** — which is the
   real TorqClaw use case — and explicitly declines to imply a team chat product.
2. **Nothing can be posted or delivered live today** (rows 20, 21). The substrate's pub/sub
   is genuine and well-tested but **headless — no gateway path calls it.** S1 shipped reads
   only. Every "live" claim in Part II is hint-then-refetch (§4 S4), never socket delivery.
3. **Buzz's marquee features are absent from our substrate** (rows 6–10, 17): threads,
   reactions, edits, attachments, mentions, search. "Buzz parity" is therefore **explicitly
   redefined** in §12 as *co-presence parity*, not feature parity.
4. **An unread badge is not free** (row 15). The obvious product affordance needs either a
   second call per channel or a substrate addition. §13 specifies the honest interim.

## 12. What "Buzz parity" means here — scope, honestly bounded

Upstream Buzz's thesis, adopted: **"agents are members, not bots"** — scoped *by identity,
not by permission flags*. That maps onto §2a exactly: a human and an agent are both
principals with membership rows, and entitlement is membership. **We already have Buzz's
identity model; we lack its surface.** That gap is this PRD.

Upstream Buzz's second thesis — one event log as the source of truth for messages,
reactions, workflow steps **and review approvals** — is **DECLINED**. Buzz's own canonical
example ships a release when a workflow *"gets 👍 reaction"*. In TorqClaw a reaction that
ships anything is a direct violation of §2(b) and the frozen 2026-08-08 ruling.

| Buzz feature | Disposition | Rationale |
|---|---|---|
| Channels, timeline, roster, co-presence | **ADOPT** — §13 | the co-presence surface this PRD exists to build |
| @-mention **addressing** of agents | **ADOPT, S7** | mention = addressing, **never** authorization (§12a) |
| Reactions | **DEFER** (needs row 8 migration) | if ever built: **sentiment only**, never a trigger |
| Threads | **DEFER** (needs row 7 migration) | flat timeline first; threads are their own effort |
| Search, attachments, canvases, DMs, git events, media | **OUT OF SCOPE** | each is its own PRD; naming them here keeps "parity" honest |
| Reaction/message-**triggered workflows that execute** | **DECLINE, permanently** | collides with §2(b); no channel artifact may trigger execution |
| In-channel **workflow approval gates** | **DECLINE, permanently** | `approve` is reserved operator-surface authority |
| Nostr keypairs / relay identity | **DECLINE** | identity is server-derived surface credentials (C0/C1 H-1) |
| Typing indicators | **DECLINE for now** | ephemeral transport state; we have no transport for it (row 20) |

### 12a. The mention rule (load-bearing — read before specifying S7)

Upstream computes mentionability from **two independent** properties: *membership*
(`agent.channelIds.includes(channelId)`) and *willingness* (a per-agent `respondTo` policy
of `anyone` or `allowlist`). TorqClaw has only the first.

**Ruling for this PRD:** an `@mention` is **addressing, not authorization, and not dispatch.**
Mentioning an agent in a channel MUST NOT start a task, resume one, widen a grant, or reach
the dispatcher in any way. §2(d) — *"a message is data, not a command"* — is unconditional
and a mention is a message. S7 therefore ships mention **rendering and autocomplete only**;
any future "mention invokes an agent" behavior is a **separate PRD with its own G1R**, and
would have to answer the willingness question upstream already answers.

## 13. The end-user product — surfaces, slice by slice

Everything below follows the console's real conventions (verified 2026-08-16): Tailwind v4
tokens in `apps/console/src/app/globals.css` (`bg-panel`, `text-muted`, `text-faint`,
`border-edge`, `text-torque`; **`text-bad` is reserved for genuine errors only**); JetBrains
Mono (`font-chrome`) for all chrome and Inter (`font-reading`) for message bodies; the
`view` union + sidebar button + conditional render pattern in `TorqTerminal.tsx`; and the
`ApprovalHistoryPanel` honesty state machine (**`null` = loading, `[]` = real-empty**,
plus `sendFailed` and `timeout`). `ReceiptsPanel` is the list→detail precedent.
**`ReceiptsPanel` initializes its snapshot to `[]` — that is a known bug there and MUST NOT
be copied.**

### S2 — Channels view (read-only) · flag `NEXT_PUBLIC_COLLAB_UI`
Fourth nav item. **Master/detail:** channel list (left) → timeline (right).
- **Channel list row:** name, `state` badge when archived, `role` badge (`owner`/`agent`).
  Data comes from `LIST_CHANNELS` (row 14) — **name, state, role and nothing else.** No
  last-message preview, no member count, no timestamp: the API does not return them and
  the view must not invent them (§2, no fabricated fields).
- **Timeline:** author display name, message text in Inter, timestamp. Paged by the S1
  cursor; **"Load older" is an explicit control**, because the 64 KiB frame cut (row 13)
  means a page can be short for reasons unrelated to how many messages exist.
- **Empty/loading/error:** the four honest states, dashed-border empty card
  (`◌` + "No channels yet"). **Loading and empty must be visually distinguishable.**
- **Timestamps:** if they arrive in SQLite `YYYY-MM-DD HH:MM:SS` shape, format via the
  existing `formatApprovalTimestamp` rule (exact-match → append `" UTC"`; otherwise
  verbatim). **Never `new Date()` on a space-separated string — it silently parses as local
  time.** "Invalid Date" must never reach the DOM.
- **Structural inertness:** this view dispatches only `LIST_CHANNELS` and
  `GET_CHANNEL_TIMELINE`. Enforced by the click-everything test (§14 T-11).

### S3 — Composer (human posting)
`POST_CHANNEL_MESSAGE {channelId, text, idempotencyKey}` per §4 S3 (client-supplied
canonical UUID; author server-stamped; no author field exists to spoof).
- **Live character budget against the real cap** — 16,384 **UTF-8 bytes**, not characters
  (row 12). Count bytes, not `string.length`; a CJK or emoji message hits the cap ~3–4×
  sooner than a naive counter suggests. Warn approaching, block over.
- **Optimistic echo is FORBIDDEN.** A message appears only after the store commits it and a
  re-read returns it. A pending row may render as visibly pending, but never as sent.
- **Send failure is explicit** — `sendCommand` returns `false` when the socket is closed;
  surface "didn't send, retry", never a silent drop.
- **Retry reuses the same `idempotencyKey`** — that is precisely what it is for (B-3).
- Empty/whitespace-only text: the substrate *permits* it (no trim), but the composer
  **declines to send** empty content. Client-side choice, stated so it is not mistaken for
  a substrate rule.

### S4 — Freshness (hint-then-refetch)
Per §4 S4, unchanged: hints are **invalidation only**, the store is authoritative, re-reads
are coalesced. Product surface:
- A **"last synced"** indicator — the gap the Buzz comparison named as our weakest point
  versus theirs.
- A non-blocking **stale badge** on refresh failure that **keeps the last known rows
  visible** (never blanks the list).
- **No delivery language anywhere in the UI.** No "delivered", no "live", no checkmarks.
  The transport cannot support the claim (row 20).

### S5 — Roster (co-presence)
**Two sections, never merged** (§8 roster label rule, already frozen):
- **"Members"** — substrate `collab_members` rows: the entitlement truth.
- **"Working now"** — gateway task truth joined at render time: the presence overlay.
- **Presence never implies membership, and membership never implies presence.** A working
  agent that is not a member does not appear as a member; a member who is idle is not
  hidden.
- **Elapsed must be epoch-anchored** — `selectTurnStartMs` + `<LiveDuration since={...}>`,
  anchored to the real first-event timestamp, never a mount counter. A remount must not
  reset the clock to `0:00`.
- Port upstream's **unified working-signal discipline** (`agentWorkingSignal.ts`): one
  module every surface reads, with an explicit scope rule (in *this* channel vs anywhere).
  Upstream has a primary (observer, carrying a start anchor) and a typing fallback;
  **TorqClaw has the primary only and no fallback — state that plainly rather than
  simulating a second signal.**
- **Identity rendering is new design surface** — no avatar or identity-chip component
  exists in the console today. Display names are **not unique** (row 24), so a name alone
  is not an identifier; pair it with a truncated principal id (the `LivenessChip`
  `turn {id.slice(0,8)}` convention) wherever ambiguity is possible.

### S6 — Read state (NEW)
Wire `ackChannelCursor` (row 16) so an operator's read position persists across sessions.
- **On the unread badge (row 15):** `listChannels` returns `lastAcknowledgedCursor` but
  **not** the channel's max `channel_seq`, so an unread *count* cannot be derived from one
  call. **Interim, honest affordance: a boolean "new" dot** — set when a timeline read for
  that channel returns a cursor beyond the acknowledged one. **No numeric badge until the
  substrate returns a max cursor.** A fabricated or client-guessed count violates §2.
- Ack is idempotent and monotonic; acking backwards is a no-op by construction.

### S7 — Mention rendering (NEW, strictly bounded by §12a)
- Composer autocomplete over **channel members only** (never a global principal directory —
  that would leak the existence of principals outside the channel).
- Mentions render as a highlighted span. **Server-side mention parsing does not exist**
  (row 10), so this is **client-side rendering over the stored raw text** — the substrate
  neither stores nor notifies mentions, and the UI must not imply a notification occurred.
- **No dispatch, no notification, no authority.** See §12a.

### 13a. Deliberately NOT specified
Threads, reactions, edits, deletions, attachments, search, DMs, canvases, typing
indicators, multi-human membership, and any numeric unread count. Each is either absent
from the substrate (§11) or declined on authority grounds (§12). **Naming them here is the
point:** a reader must be able to tell what "Buzz parity" excludes without reading the
substrate.

## 14. Additional acceptance criteria and tests (Part II)

Additive to §6 and §8. A6/T-9 (handler totality) apply unchanged to every new wire command.

- **A7 (S6):** an acked cursor survives a reconnect and a gateway restart; acking an older
  cursor never moves it backwards. **No numeric unread count is rendered anywhere.**
- **A8 (S3):** the composer's byte budget matches the substrate's 16,384-**byte** cap
  measured in UTF-8, proven with a multi-byte (CJK/emoji) fixture; over-cap text cannot be
  sent; a send failure is surfaced, never silent.
- **A9 (S5):** the roster renders "members" and "working now" as two separately-labeled
  sections from two distinct sources; a fixture with a working non-member proves presence
  never implies membership; elapsed is epoch-anchored across a simulated remount.
- **A10 (S7):** mention autocomplete offers only members of the current channel; a message
  containing `@name` produces **zero** dispatches and zero gateway commands beyond the
  ordinary post.
- **T-10 (honest states, every new panel):** loading (`null`), real-empty (`[]`),
  `sendFailed`, and `timeout` are four distinguishable renders; a malformed frame leaves
  the last good data visible and never crashes; **"Invalid Date" never reaches the DOM.**
- **T-11 (structural inertness, every read-only view):** click every rendered control and
  assert the dispatched action set is a subset of that view's read-only allowlist and
  **disjoint** from `{SUBMIT_PROMPT, CANCEL_TASK, APPROVE_TOOL, APPROVE_SKILL,
  POST_CHANNEL_MESSAGE}` (the ApprovalHistoryPanel P4/P5 pattern). For S3, the composer's
  post is the *only* addition to the allowlist.
- **T-12 (no fabrication sweep):** for each rendered field, assert a wire source exists.
  Specifically: the channel list renders no last-message preview, no member count, and no
  numeric unread badge, because `LIST_CHANNELS` returns none of them.
- **T-13 (mention inertness, S7):** posting text containing a mention commits exactly one
  `message_posted` event and reaches no dispatcher path — the §12a rule, pinned.

## 15. Build order and dependencies

`S2 → S3 → S4 → S5 → S6 → S7`, each a separate revertable commit through the full governed
chain (build → independent verify → G2A), per §7's rule that a slice ships only when its
predecessor is gate-green.

- **S2 is unblocked today** — S1 shipped its wire reads.
- **S3 requires a new wire command** ⇒ A6/T-9 apply in full.
- **S6 requires wiring `ackChannelCursor`** (a new command) ⇒ A6/T-9 apply.
- **S5 requires the gateway-side task-truth join** (row 19) — the substrate has no join key,
  so this is gateway render-time work, not a substrate change.
- **S7 is client-only** — no new wire command, no substrate change.

**Production reality, unchanged (§7.5 / CO-7):** the real `WindowsCredentialManagerStore`
is still a `NOT_IMPLEMENTED` stub, so in production every one of these surfaces fails closed
to `COLLAB_IDENTITY_REQUIRED` until a real SecretStore adapter lands. **Dev/loopback surface
credentials work today. Do not mistake that fail-closed for a defect at demo time.**

## 16. Corrections to prior analysis (recorded so they are not re-inherited)

- **`PresenceCard` was never retired.** An earlier note in this program's history said the
  PRD-UI-1 redesign retired it. `git log` on `apps/console/src/components/PresenceCard.tsx`
  shows three commits, all additive/styling, and it is actively rendered in
  `TorqTerminal.tsx`. It was **never a roster** — its own docstring says it is honest
  presence for *"the ONE agent the console watches … there is no roster here to populate."*
  Building on the "retired roster" premise would have been building on nothing.
- **Upstream Buzz paths differ from the vendored copy.** `TORQ-BUZZ-VS-TORQCLAW-COMPARISON.md`
  (2026-08-15) cites `source/buzz/desktop` / `apps/desktop/src` from a local copy; upstream
  `block/buzz` is `desktop/src/**` over a `crates/` Rust workspace. **Upstream wins on
  paths**; that document's *judgments* still stand.
- **The Buzz comparison's recommendation #1 (anchor liveness to a real start) is already
  done** — the PRD-UI-1 passes landed epoch-anchored elapsed on 2026-08-16. Its
  recommendation #2 (a "last synced" badge) is **open, and is now S4's product surface.**
