# G1R — Gate 1 Adversarial Design Review — PRD-TCLAW-COLLAB-PRESENCE-UI-005

**Subject:** `docs/PRD-TCLAW-COLLAB-PRESENCE-UI-005.md` (DRAFT v0.1, 2026-08-16)
**Review date:** 2026-08-16
**Reviewer seat:** G1R (independent design reviewer)

> **MODEL LINEAGE DISCLOSURE — read before weighting this verdict.**
> The governing profile (`CLAUDE.md` §2) names **Opus 4.7** (historical) / **Opus 5**
> (current, operator-updated 2026-08-12) for the G1R seat. This review was produced by
> the session's `opus` alias, which resolves to **`claude-opus-5`**. I am filling the
> **G1R ROLE**; I make no claim to be any other model. A prompt label does not establish
> model lineage — treat this as an Opus-5 review of the G1R checklist, and if the operator
> requires a specific historical model for lineage purposes, this review does not satisfy
> that requirement.

**Posture:** read-only. No source file, no PRD, no git state was modified. This file is the
single authorized write. All code claims below are quoted from **`HEAD` (`4b0ee58`)** via
`git show`, never from the dirty working tree.

---

## VERDICT: **REJECT**

**Blocking findings: 6** · Non-blocking: 7

This is a well-constructed PRD. It correctly refuses to re-specify the substrate, it names
its own operator gate, its non-scope list is honest, and its controlling invariant is
pointed at the right hazard. It is rejected not for direction but because **three of its
five slices rest on a reuse claim that the committed code does not support**, and the
resulting failure is silent: a Builder who implements exactly what is written produces a
Channels view that either shows the operator nothing, or shows the operator everything —
and which of those two happens is decided by a provisioning detail the PRD never mentions.

That is precisely the question I was asked to answer: *what assumption could make this
architecture fail even if the Builder implements the written plan correctly?* The answer is
**§4's unstated assumption that "the operator seat" and "a collab principal" are the same
subject.** They are not, at HEAD, on any code path.

---

## 1. Controlling Invariant (independent derivation)

The PRD's §2 invariant is correct but **incomplete for what §4 actually builds**. I derive a
different controlling invariant, which subsumes the PRD's four clauses and adds the one it
omits:

> **A co-presence surface may render only what its own authenticated subject is already
> entitled to see, may write only what that subject is already entitled to write, and may
> never become a path by which either entitlement is computed, widened, or acted upon.**

Three consequences, each load-bearing and each violated somewhere in §4:

**(CI-a) — Authority direction.** Conversation flows *from* the substrate *to* the console.
Nothing flows the other way into an execution decision. This is the PRD's §2 and I endorse
it as written; I found **no path through S3 or S5 that can make a channel message
executable**. See §5, finding NB-1 — this is the PRD's strongest section, and I confirm it.

**(CI-b) — Read entitlement is the substrate's, not the gateway's.** The gateway's `role`
lattice (`operator|channel|node`) and the substrate's entitlement lattice
(`principal_id` × `collab_members`) are **different lattices over different subjects**. A
read surface that authorizes on the first and reads with the second is not "reusing" the
substrate — it is *bypassing* it. This is the invariant the PRD's §4 S1 silently breaks, and
the reason for B-1 and B-2.

**(CI-c) — Delivery guarantees do not survive a change of transport.** The substrate's
"no committed event is lost" is a property of the substrate's *own* queue, lock, and
close-frame discipline. Re-emitting those events on a different transport with different
persistence and different reconnect semantics does not carry the property across. This is
the reason for B-4.

---

## 2. Blocking Findings

### B-1 (CRITICAL) — S1 has no authenticated subject to read as; the PRD's central reuse claim does not typecheck against HEAD

**Finding.** §4 S1 specifies `LIST_CHANNELS` / `GET_CHANNEL_TIMELINE` as **"operator-seat
read commands."** The substrate functions it proposes to reuse do not take a seat. They take
a `CallerContext`:

```ts
// HEAD:packages/collab/src/store.ts:318
/** Minimal caller identity, established by the (not-yet-built) session layer. */
export interface CallerContext {
  principalId: string;
  kind: 'operator' | 'agent';
}
```

Note the comment shipped in the substrate itself: *"established by the (not-yet-built)
session layer."* The substrate authors flagged this exact gap.

At HEAD, a gateway connection acquires a `principalId` **only** by presenting a verified
`tq1_` surface credential:

```ts
// HEAD:packages/gateway/src/sessions.ts:65-68
'INSERT INTO sessions (id, role, client_name, principal_id, surface_id) VALUES (?, ?, ?, ?, ?)',
  ...
  caller?.principalId ?? null, caller?.surfaceId ?? null,
```

and `caller` is null whenever `collabEnabled()` is off **or the client presented no collab
credential** (`sessions.ts:33-36`, verbatim: *"callers (no collab credential, or
collabEnabled() off) pass no binding … with principal_id/surface_id both NULL, exactly as
before"*).

**Failure scenario (Builder implements §4 S1 exactly as written).** The console connects as
today — `role:'operator'`, root `token`, **no `auth` block**. `TORQCLAW_COLLAB_ENABLED=1`, so
S1's flag gate passes and `authorize()` returns `ALLOW` for the operator role. The handler
now needs a `CallerContext` and has `principal_id = NULL`. The Builder has exactly three
options, and the PRD specifies none of them:

1. **Refuse** → the Channels view is permanently empty for the console's actual connection
   shape. Ships a dead feature; A2's "renders real channels" is unachievable.
2. **Substitute the operator principal** (`assertOperatorCaller`-style lookup of the single
   bootstrap operator) → **this is B-2**, a substrate visibility violation.
3. **Invent a synthetic `CallerContext`** from the gateway role → identity is no longer
   server-derived from a credential, directly violating the PRD's own §2(c) and the C0 H-1
   discipline the PRD cites.

All three are wrong, and nothing in the PRD tells the Builder which wrongness to pick. §7.2
gestures at this ("S3-for-surfaces … depend on the C2 connect-path") but scopes the
dependency to *S3 posting for surfaces* — it explicitly says **"operator-seat posting can
precede it"** and says nothing at all about S1 reads. That is the error: S1 has the same
dependency, and S1 is the slice everything else is sequenced behind (§7.3).

**Violated invariant.** CI-b; and the PRD's own §2(c) ("identity is always server-derived
from authenticated credentials").

**Required correction.** S1 must state, normatively, which authenticated subject its
`CallerContext` is derived from, and must fail closed when there is none. My recommended
shape (the Builder may not choose freely):

> S1 read commands resolve `CallerContext` **solely** from the connection's server-derived
> collab binding (`sessions.principal_id`, populated by `resolveConnectIdentity`). A
> connection with `principal_id IS NULL` — i.e. any legacy root-token connection — receives
> an explicit deny, **not** an empty list and **not** a substituted principal. The gateway
> `role` is a *necessary* condition (operator-only) and never a *sufficient* one. The
> console must therefore present a surface credential before the Channels view can render,
> and §7 must list that as a dependency of S1, not only of S3.

---

### B-2 (CRITICAL) — "operator seat reads everything" would break hidden-channel indistinguishability, a G2A-verified substrate property

**Finding.** This is B-1's option (2), promoted to its own finding because it is the
*attractive* wrong answer — it makes A1/A2 demoable and it is what "operator-seat read
commands" most naturally reads as.

The substrate does **not** grant operators global read. `listChannels` is scoped by
membership, not by kind:

```sql
-- HEAD:packages/collab/src/store.ts:1727-1735 (listChannels)
FROM collab_channels c
JOIN collab_members m ON m.channel_id = c.id
WHERE m.principal_id = ? AND m.state = 'active' AND c.state IN (...)
```

and `assertChannelVisible` (store.ts:2032) requires the caller's **own** active
`collab_members` row — it does not consult `principals.kind` at all. `assertOperatorCaller`
and `assertChannelOwner` exist and *do* check operator-ness, but they gate **channel
administration**, not reading. The distinction is deliberate: a hidden channel is
undiscoverable, and every denial cause returns one byte-identical error —

```ts
// HEAD:packages/collab/src/store.ts:96-102
// (C3) COLLAB_NOT_FOUND is byte-identical across every denial cause —
// absent, hidden, archived-hidden, non-member, and owner-only-by-non-owner.
const COLLAB_NOT_FOUND_MESSAGE = 'Request could not be completed';
```

Hidden-channel indistinguishability was verified against a live DB and approved by G2A
(`PRD-TCLAW-COLLABORATION-FINAL-STATUS.md`, Slice-2 line: *"hidden-channel
indistinguishability and re-add interval math both verified against a live DB"*).

**Failure scenario.** The Builder reads "operator-seat read commands" as a seat-level
entitlement and implements S1 by resolving the bootstrap operator principal, or by adding
an `OR caller.kind = 'operator'` arm to the visibility predicate to make the view non-empty.
Result: a channel the operator principal is not a member of becomes discoverable through
the console — and, worse, the *shape* of the failure changes. Today, "hidden" and "absent"
are indistinguishable. After a seat-level read, the console can distinguish them by
comparing the list surface against the timeline surface. A G2A-verified security property is
destroyed by a UI convenience, and no test in §8 would catch it, because §8 tests **authz
deny arms** (the gateway lattice) and never asserts **substrate visibility parity** (the
substrate lattice).

**Violated invariant.** CI-b; substrate §7.6 hidden-channel undiscoverability; core invariant
that a read surface may not widen entitlement.

**Required correction.** The PRD must state as a binding constraint:

> S1/S2/S4 grant **no** visibility beyond what the calling principal's own
> `collab_members` rows already permit. `principals.kind = 'operator'` is not a read
> entitlement. The gateway operator role gates *access to the command*; the substrate's
> membership predicate gates *the rows returned*, and the second is never relaxed,
> short-circuited, widened, or supplemented for any seat. A required test must assert
> that a channel the calling principal is not a member of is **absent from
> `LIST_CHANNELS` and returns the byte-identical `COLLAB_NOT_FOUND` from
> `GET_CHANNEL_TIMELINE`, for an operator-kind caller.**

---

### B-3 (HIGH) — S3's stated wire shape cannot call the substrate's write path; the idempotency key is missing and un-owned

**Finding.** §4 S3: *"the command carries channel + body only."* The substrate's write
entrypoint requires a third argument:

```ts
// HEAD:packages/collab/src/store.ts:1422-1426
async postChannelMessage(
  caller: CallerContext,
  body: { channelId: string; text: string },
  idempotencyKey: string
): Promise<PostChannelMessageResult>
```

The key is not decorative. It is the lookup into `collab_mutation_results` via
`runKeyedCommand` — the mechanism that makes a retried post return the original
`{eventId, cursor, occurredAt}` instead of committing a duplicate `message_posted` event.
Substrate v0.14 §7 specifies idempotency keys as **canonical lowercase UUIDs**.

**Failure scenario.** The composer posts; the WS drops before the response frame arrives (a
routine event — the whole reason S4 exists). The user retries. If the Builder mints a fresh
key server-side per invocation, the key is a no-op and the retry commits a **second**
`message_posted` event at a new `channel_seq` — a duplicate message, permanently, in an
append-only log with no delete path. If instead the Builder derives the key from
`(principal, channel, text)` to avoid that, two legitimately identical messages ("ok")
silently collapse into one. Both outcomes are wrong, and the PRD's chosen shape forecloses
the correct one: **only the client knows whether this is a retry or a new utterance.**

Note this is *not* a `grantedTools`-style injection hazard — the idempotency key confers no
authority, so accepting it from the client is safe and is what the substrate's design
intends. The PRD appears to have over-applied the (correct) "server stamps author" rule to a
field where it does not apply.

**Violated invariant.** Substrate write contract; core invariant 1 (external frames
contract-validated) — a contract that cannot express a required argument is not validating it.

**Required correction.** S3's command shape becomes `{ channelId, text, idempotencyKey }`
with `idempotencyKey` a client-supplied canonical lowercase UUID, contract-validated for
shape. Add to §6 A3 and §8: a **retry test** proving that re-sending the identical command
with the same key returns the identical `{eventId, cursor}` and commits exactly one
`collab_events` row. Keep the author rule exactly as written — `actorPrincipalId` is stamped
server-side from `caller.principalId` (store.ts:1470) and must remain absent from the wire.

---

### B-4 (HIGH) — S4's "no-lost-event" acceptance is unachievable on the transport S4 chooses, and the substrate says so

**Finding.** §4 S4 bridges substrate fanout onto the gateway WS; §6 A4 requires
*"backlog→live transition loses no committed event."* Three facts at HEAD make that
unachievable as specified:

1. **The substrate's sink models write-initiation, not delivery, and defers real
   backpressure — by name, to the slice that was deferred.**
   ```ts
   // HEAD:packages/collab/src/subscriptions.ts (DeliverySink doc)
   // Modeling "write initiated" (Section 8.2/M3) rather than "write completed" —
   // the sink's return value (if any) is ignored by this module; real
   // backpressure/completion coupling is OWED to Slice 5 (M3).
   ```
   And `PRD-TCLAW-COLLABORATION-FINAL-STATUS.md` §19 lists **"real-socket backpressure"** as
   still owed. S4 *is* that owed item. The PRD frames S4 as reuse ("slow-consumer accounting
   already built"); the accounting is built, but the thing S4 must supply — coupling that
   accounting to a real socket's completion signal — is exactly what does not exist. The
   PRD's S4 description understates its own difficulty by one whole owed §19 line item.

2. **The only non-persisted gateway emission path deliberately carries no `seq`, and the
   console deliberately ignores it for cursor purposes.**
   ```ts
   // HEAD:packages/gateway/src/events.ts:64-68
   // The built event OMITS seq entirely ... the console's cursor guard
   // (useGatewayStream) only advances its resume cursor when an incoming event
   // carries a non-null seq, so a seq-less event can never rewind or corrupt a
   // client's reconnect position.
   ```
   A `publishOnly` channel event is therefore **unreplayable**: it is never INSERTed into
   `events`, so `getEventLogSince` cannot return it (sessions.ts:74-85), and the client's
   resume cursor never advances past it. Socket drops between two channel events ⇒ those
   events are gone from the gateway's perspective. The substrate can replay them from
   durable backlog — but only if S4 re-subscribes with the substrate's *own* cursor, which
   is a second, independent cursor the PRD never mentions.

3. **The alternative — `persistAndPublish` — creates the second-source-of-truth problem
   the PRD's §5 tries to avoid**, by writing channel messages into `state.db.events`
   alongside collab's `collab_events`. Two logs, two sequences, one conversation.

**Failure scenario.** A Builder implements A4 with `publishOnly` (the natural read of "the
LIST_APPROVALS pattern" from S1, carried forward). The A4 test passes: it exercises
backlog→live *inside* the substrate, over an in-process sink, exactly as slice 3's harness
does. Then in production a socket drops mid-conversation and messages vanish from the view
with no error, no gap indicator, and no recovery until a manual refresh. **The acceptance
test passes while the acceptance criterion is false** — because the test reuses the
substrate harness (§8: "substrate harness reuse") and never crosses the real transport,
which is the only place the property can break.

**Violated invariant.** CI-c; core invariant 2 (sessions resume by monotonic `seq` cursors);
§19's owed "real-socket backpressure."

**Required correction.** S4 must specify, before build:
(i) which cursor authority governs channel-event recovery — the substrate's per-channel
`channel_seq` or the gateway's `events.seq` — and it must be **one**, not both;
(ii) how a reconnecting console re-derives its position (my read: re-`SUBSCRIBE_CHANNEL`
with the substrate's `afterCursor`, and never rely on the gateway backlog for channel
events);
(iii) how the real socket's write-completion couples to `slowconsumer.ts` accounting, since
the substrate explicitly did not do this;
(iv) A4 must be re-specified to require a test **that kills a real socket mid-stream and
proves recovery**, not a substrate-harness transition test. As written, A4 is
un-falsifiable — and an un-falsifiable acceptance criterion on a "no-lost-event" claim is
the most dangerous line in this PRD.

---

### B-5 (HIGH) — S5 creates a second source of truth for task state, and the PRD's mitigation addresses the wrong hazard

**Finding.** §4 S5 mirrors task lifecycle events (started / awaiting approval / done) into a
channel "as data." §6 A5 tests that mirrored rows carry no dispatch affordance
(grep-provable: no `onClick`). That test is real and worth keeping — but it defends against
the *authority* hazard (CI-a), which I independently confirm is well-handled. It does not
touch the *integrity* hazard, which is unaddressed.

Task state truth lives in `state.db`: `events` is the append-only source of truth,
`run_receipts` is a **rebuildable, droppable projection** (`PRD-...-GATEWAY-004.md` §1.2
constraint 2, `ops/receipts-rebuild.mjs`). Mirroring into `collab_events` creates a copy in a
**different database, with a different WAL, that is append-only and has no rebuild path and
no delete path.** `collab_events` rows cannot be corrected — the substrate has no update or
tombstone semantics for them.

**Failure scenario.** A task's mirrored "awaiting approval" event commits to `collab_events`.
The approval is then rejected, or the task is cancelled, or the gateway crashes between
mirror-write and state transition. `collab_events` now permanently asserts a task state that
`state.db` contradicts, in a log that cannot be rebuilt or corrected, rendered in a roster
next to real messages. An operator reading the Channels view sees a task "awaiting approval"
that is not. There is no reconciliation story in §5, and §5's "Authoritative / Derived /
Mutation" table does not classify the mirror at all — it says "Mutation: S3 posting is the
only new mutation," which is **false as soon as S5 writes a mirrored event**.

Compounding: a mirrored event is a `collab_events` row, so it consumes `channel_seq` and is
delivered by fanout to every channel member. Task telemetry (tool names, tier, timing) is
gateway-operator-only today (see the `LIST_APPROVALS`/`GET_COST_SUMMARY` deny rationale in
`HEAD:authz.ts` — *"approval telemetry reveals gated tool names and decision timing"*).
Mirroring it into a channel distributes it to every member of that channel, who are
`agent`-kind principals with no operator entitlement. **S5 as written is an
operator-telemetry-to-agent-principal disclosure path**, and neither §6 nor §8 tests for it.

**Violated invariant.** Core invariant 8 (receipts from real telemetry only) — a
contradictory mirror is not real telemetry; §5's own authority/mutation contract;
the confidentiality posture pinned in `authz.ts`.

**Required correction.** S5 must either:
(a) **be deferred out of this PRD** (my recommendation — it is the least-ready slice and the
only one not required for "humans and agents chat"), or
(b) specify, normatively: the mirror is a **projection with a stated reconciliation rule**
(state.db wins; the console renders the mirror only when it agrees with a live read, and
labels divergence rather than displaying stale truth); an explicit **redaction contract**
naming exactly which task fields may cross into a channel (I would allow: task id, coarse
state, start epoch; I would forbid: tool names, args, tier, cost, provider, error text); and
a required test that a mirrored row's payload contains no field outside that allowlist.
§5's mutation line must be corrected to name the mirror as a second mutation.

---

### B-6 (MEDIUM-HIGH) — the §7.1 dirty-file gate is honest in intent but materially incomplete, which defeats its own purpose

**Finding.** §7.1 lists three files carrying uncommitted operator WIP: `commands.ts`,
`server.ts`, `authz.ts`. Verified against the working tree, the WIP also dirties two more
that every slice must touch:

```
 M packages/contracts/src/commands.ts        (listed)
 M packages/gateway/src/authz.ts             (listed)
 M packages/gateway/src/server.ts            (listed)
 M packages/gateway/src/sessions.ts          (NOT listed)
 M packages/gateway/src/collabIdentity.ts    (NOT listed)
```

Plus untracked new-file WIP: `packages/gateway/src/connectionAuth.ts`,
`tests/connection-auth.test.ts`.

`sessions.ts` and `collabIdentity.ts` are not incidental — they are **exactly** the two files
that resolve the `principalId` that B-1 shows S1 cannot proceed without. So the PRD
simultaneously (i) omits the dependency in §7.2 by scoping it to S3-for-surfaces, and
(ii) omits the two files where that dependency lives from the §7.1 collision list. The gate
is drawn one layer too shallow, and the effect is that S1 reads as *less* WIP-entangled than
it is.

I record explicitly that I found **no evidence of dishonest sequencing**. §7.1's rule
("implementation of S1+ starts only after the operator lands the WIP or authorizes
co-editing") is correctly stated, §7.3 correctly forbids S2-before-S1, and §10 correctly
lists the operator stop conditions. The defect is completeness, not integrity — but an
incomplete collision list is what turns a correct rule into an ineffective one.

**Failure scenario.** The operator, reading §7.1's three-file list, authorizes co-editing on
those three. The Builder then discovers S1 also needs `sessions.ts` and `collabIdentity.ts`,
and either edits them under an authorization that did not cover them, or stalls
mid-slice — with a half-built S1 sitting on top of the operator's uncommitted
auth migration.

**Violated invariant.** Repo rule: *"If a file already has unrelated owner edits, stop and
ask before editing it"* (CLAUDE.md §4, Change scoping).

**Required correction.** §7.1's file list is corrected to include `sessions.ts` and
`collabIdentity.ts`, and notes the untracked `connectionAuth.ts` / `tests/connection-auth.test.ts`.
§7.2 is corrected so the C2 connect-path dependency covers **S1 reads**, not only
S3-for-surfaces. Recommended sequencing consequence: **no slice of this PRD begins until the
WIP lands**, because after B-1 there is no slice that does not depend on it.

---

## 3. Non-Blocking Findings

**NB-1 (confirmation, not a defect) — the CI-a authority hazard is genuinely closed.** I
traced every path §4 opens for a channel message or mirrored event to become executable and
found none. Structural reasons, each verified: `postChannelMessage` writes only a
`message_posted` row into `collab_events` and returns; nothing in the gateway reads
`collab_events`; `ClientCommandSchema` is a closed discriminated union so a message body is
never parsed as a command; `APPROVE_TOOL` carries only an `approvalId` and reads the tool
name server-side (`commands.ts:38-41`); and H-1's intersection at
`authorizeOperator` (`authz.ts`) additionally requires `surface.currentRole() === 'operator'`
*and* a live `holdsAuthority('approve')`. §2 and §3's prohibition of approval mirrors are
correct and should be preserved verbatim. **This is the PRD's best work and I am not
manufacturing disagreement with it.**

**NB-2 — flag blast radius (the operator should rule, not the Builder).** `TORQCLAW_COLLAB_ENABLED`
today gates C0/C1 identity resolution and the H-1 authz subordination. §4 S1 reuses it to gate
a new *read* surface. That is a widening: one flag now turns on identity derivation, an
authz behavior change, and a data-read surface. Two independent consequences follow. First,
the rollback story in §9 becomes coarser than stated — flipping the flag off to remove the
Channels view also reverts the H-1 operator-authority intersection, i.e. **disabling a UI
feature silently re-opens a security hardening**. Second, the flag can no longer be soaked
independently. Recommend a distinct `TORQCLAW_COLLAB_CHANNELS` gated *behind*
`TORQCLAW_COLLAB_ENABLED` (both must be on), and a §9 note that the collab flag's
rollback is not scoped to this PRD's surface. **Operator decision, not Builder discretion.**

**NB-3 — Phase-3 SEC-1 is not reachable through this PRD, but the boundary should be
written down.** SEC-1 (`SCOPE-PHASE-3` §4) is a **cross-`channel`-seat** session-resume
hijack: `checkResumeRole` compares roles only, so two `role:'channel'` adapters can resume
each other's sessions. This PRD adds no `channel`-seat surface and its S1/S3 explicitly deny
`channel` and `node`. I confirm SEC-1 is **not reachable through anything this PRD adds**.
The terminology collision is nonetheless a live hazard for a Builder or future reviewer:
Phase-3 "channel" = a gateway seat/adapter; this PRD's "channel" = a collab room. They are
unrelated namespaces. §3's non-scope should say so in one line.

**NB-4 — Phase-3 invariant 8 is correctly adopted; invariants 3 and 4 should be too.**
S1 already commits to explicit `channel`/`node` deny arms plus tests (Phase-3 invariant 8) —
correct, and it matches the `authz.ts` house pattern where every operator-only command earns
a named deny with a comment. Two further Phase-3 invariants transfer cleanly and should be
adopted: **invariant 3** ("policy authority lives on the session, resolved at connect from
the *authenticated* credential; `ClientCommandSchema` gains nothing — a client-supplied
channel id is a scope-escalation primitive") is the exact discipline B-1/B-2 need; and
**invariant 4** ("evidence, never an authorization input") is what keeps S5's mirror from
drifting toward authority. Invariants 1, 2, 5-7, 9 concern channel *policy clamping* and do
not apply. Phase-3's SEC-2 and H-4 likewise do not apply — this PRD adds no adapter and
writes no `sourceChannel`.

**NB-5 — A2's honesty bar is the right one; extend it to gap-detection.** The
`ApprovalHistoryPanel` four-state pattern (null=loading / []=real-empty / sendFailed /
timeout) is the correct precedent and §4 S2 cites it well. One addition: with B-4 unresolved,
the Channels view can be *silently incomplete* (events lost in a socket gap) rather than
merely empty or stale. The honesty rules as written do not cover "I have some of the
conversation." A5's no-fabrication bar should be extended: **a visible gap indicator when the
rendered cursor range is non-contiguous.** The substrate makes this cheap —
`channel_seq` is dense (v0.14 §7.4), so a gap is detectable by arithmetic.

**NB-6 — the roster's data source is unspecified.** §4 S2 says "member roster from real
membership rows," and §6 A2 forbids "invented presence." But `collab_members` gives
*membership*, not *presence* — who is in the room, not who is currently connected. The
substrate's live presence signal is the in-memory `SubscriptionRegistry`
(`subscriptions.ts`), which is explicitly non-persisted. If the roster renders membership and
the UI labels it "present," that is fabricated presence by A2's own standard. Specify which
one the roster shows, and label it in the UI accordingly.

**NB-7 — S5's "epoch-anchored elapsed" is the right fix and should be lifted out of S5.**
The comparison doc's finding #1 (`TORQ-BUZZ-VS-TORQCLAW-COMPARISON.md` §6) — TorqClaw's
`<Elapsed />` counts from component mount, not from the real turn start — is the single
highest-value, lowest-risk improvement identified in the research basis, and it is
independent of every blocking finding here. It is currently buried inside S5, the slice I
recommend deferring (B-5). Recommend extracting it as a standalone slice that can ship
against the existing terminal with no substrate, no channel, and no WIP dependency at all.
It would deliver visible operator value while the WIP lands.

---

## 4. Required Test Obligations

Beyond §8 as written (which I accept in full, with B-3's and B-4's corrections folded in):

1. **T-1 (closes B-1).** A connection with `sessions.principal_id IS NULL` — legacy
   root-token operator, flag ON — is **denied** on `LIST_CHANNELS` and
   `GET_CHANNEL_TIMELINE`. Not empty-list: denied, with a distinct, legible reason.
2. **T-2 (closes B-2, the highest-value test in this suite).** Substrate visibility parity.
   Given an operator-kind principal that is **not** a member of channel X:
   `LIST_CHANNELS` omits X, and `GET_CHANNEL_TIMELINE(X)` returns the **byte-identical**
   `COLLAB_NOT_FOUND` payload as for a channel that does not exist. Assert byte-identity,
   not just error-code equality — the property is indistinguishability.
3. **T-3 (closes B-3).** Idempotent retry: the same `POST_CHANNEL_MESSAGE` with the same
   `idempotencyKey` sent twice returns the identical `{eventId, cursor}` and leaves exactly
   one `collab_events` row.
4. **T-4 (closes B-4).** Real-socket recovery: kill the WS mid-stream between two committed
   channel events, reconnect, and assert the console renders **both** — with the recovery
   path exercised over the real transport, not the substrate harness. This test must be able
   to fail; if it cannot, S4 is not testable and must not ship.
5. **T-5 (closes B-5, if S5 survives).** Mirrored-row payload allowlist: assert the mirrored
   event's `content_json` contains **only** the allowlisted fields, and that no tool name,
   arg, tier, cost, provider, or error string appears in any channel-delivered frame.
6. **T-6 (closes B-2's fanout leg).** The deny arms must be tested on the **fanout path**,
   not only the command path. S4 delivers events the caller never requested; a
   membership-revoked principal must stop receiving them. The substrate has per-write
   revalidation (`fanout.ts`) — the test proves the *bridge* preserves it.
7. **T-7 (NB-2).** Flag matrix: with `TORQCLAW_COLLAB_ENABLED=1` and the new channels flag
   off, the new commands are absent-denied and the H-1 intersection is still active.
8. **T-8.** Contract emit + drift gate after any `commands.ts` change (`pnpm --filter
   @torqclaw/contracts check`), and `pnpm reachability` — both already required by house rule
   and both non-negotiable given the WIP collision.

---

## 5. Approved Implementation Boundaries

If the operator overrides this REJECT and authorizes partial work, the following is the
**maximum** approved scope, and it is deliberately narrow:

- **Approved now, independent of everything else:** NB-7's epoch-anchored elapsed fix on the
  existing terminal. No substrate, no channel, no contract change, no WIP collision.
- **Approved after the WIP lands, and only with B-1/B-2 corrections written into the PRD:**
  S1 as a *credential-authenticated, membership-scoped* read surface. Not before.
- **Approved after S1 lands green:** S2, read-only, with NB-5's gap indicator and NB-6's
  roster labeling resolved.
- **Not approved at any effort level until re-reviewed:** S3 (needs B-3), S4 (needs B-4 —
  this is a design question, not an implementation detail), S5 (needs B-5 or deferral).

---

## 6. Prohibited Changes

Binding on the Builder regardless of any later authorization:

1. **No widening of substrate visibility for any seat, kind, or role.** No `OR kind =
   'operator'` arm in `assertChannelVisible`, no operator bypass in `listChannels`, no
   second query path that skips `collab_members`.
2. **No synthetic `CallerContext`.** `principalId` comes from the server-derived connection
   binding or the command is denied. Never from a gateway role, never from a frame field,
   never from a config default, never from "the single operator principal."
3. **No new `ClientCommandSchema` field that is an authorization input.** `channelId` and
   `idempotencyKey` are permitted (neither confers entitlement — the first is re-checked
   against membership server-side, the second confers nothing). A `principalId`,
   `surfaceId`, `authorPrincipalId`, or any seat/role field is prohibited (Phase-3
   invariant 3; C0 H-1).
4. **No approval affordance, mirror, reaction, or command-parse anywhere in a channel
   timeline**, in the wire surface or the UI (frozen operator ruling 2026-08-08; PRD §3).
5. **No modification of `authorizeOperator`'s H-1 intersection** to accommodate a new
   command. New commands earn explicit arms; the intersection is not relaxed.
6. **No editing of any WIP-dirty file** until the operator lands the migration or explicitly
   authorizes co-editing on the **corrected** (five-file) list.
7. **No second execution/event/receipt/approval state machine** (`GATEWAY-004` §1.2
   constraint 2). If S5 proceeds, the mirror is a projection and must be labeled as one.
8. **No weakening or deletion of the substrate's existing tests** to accommodate the bridge.

---

## 7. Accepted Residual Risks

Recorded as accepted **if** the corrections above are made — not waived:

- **R-1.** `collab.db` and `state.db` have separate WALs; no cross-database atomicity is
  claimed or possible (`GATEWAY-004` §1.4). Any S5 mirror is eventually-consistent by
  construction. Accepted only under B-5(b)'s reconciliation rule, which makes the divergence
  *visible* rather than *silent*.
- **R-2.** Substrate §7.4's accepted metadata visibility: `channel_seq` is dense, so a
  current member can derive the **count** — never content — of events committed during a
  removal window. Pre-existing, documented, and accepted in v0.14. This PRD's read surface
  exposes it to a human eye for the first time, which changes its practical (not formal)
  significance. Accepted, recorded so no stronger guarantee is implied by the UI.
- **R-3.** `WindowsCredentialManagerStore` is still a stub that throws `NOT_IMPLEMENTED`
  (`collabIdentity.ts` header; §19 owed list). With B-1's correction, S1 therefore does not
  function in production until a real `SecretStore` adapter lands. Accepted: the failure is
  **closed** (`AUTH_FAILED`, no bypass), and the dependency should be stated in §7 so the
  gap is not discovered at demo time.
- **R-4.** Slice-3's C3 no-gap property was verified structurally against an in-process
  sequencer. Re-verifying it across a real socket is S4's job and is not yet done. Accepted
  as scoped work, not as an existing guarantee — B-4 exists precisely so it is not inherited
  as one.
- **R-5.** This review is a design review of committed state plus a declared WIP dependency.
  I did not execute the test suite, boot the gateway, or read the uncommitted working-tree
  diff. Every code claim is quoted from `HEAD` (`4b0ee58`) and is verifiable by `git show`.
  Conclusions about the WIP's *content* are deliberately absent — where the PRD relies on
  WIP details, I recorded that reliance as a finding (B-6) rather than adjudicating it.

---

## 8. Handoff

**Verdict: REJECT.** Six blocking findings. B-1 and B-2 are the ones that matter: they share
a single root cause — **the PRD treats the gateway seat lattice and the substrate principal
lattice as one lattice, and they are two.** Correct that, and B-3/B-6 are mechanical edits;
B-4 needs a real design decision on cursor authority; B-5 is best resolved by deferral.

Return path: G1D revises to v0.2 addressing B-1 through B-6, then re-review. I expect a
corrected v0.2 to approve — the direction is right, the invariant is aimed at the right
hazard, the non-scope discipline is genuine, and NB-1 confirms the highest-consequence
security property is already structurally sound.

No file other than this one was created or modified.
