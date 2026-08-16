# PRD-TCLAW-COLLAB-PRESENCE-UI-005 — Human + Agent Co-Presence Surface ("Buzz parity")

**Status:** v0.4 — **GATE 1 APPROVED (design)** at G1R Cycle 3 (`GATE1-C3.md`, APPROVE, 0 blocking, 4 non-blocking folded into this version). **Implementation remains closed behind the §7 operator gate** — no code slice may begin until the operator lands the auth-migration WIP or explicitly authorizes co-editing its files.
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
- Gate: full TS suite green; new authz arms tested; reachability green; checklist-10
  honesty sweep (no dead buttons, no invented data).

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

## 10. Operator stop conditions

Landing/authorizing the WIP co-edit (§7.1); the §11-004 open decisions if any S-slice
touches them; push/merge/release of any slice; enabling either flag in a deployment.
