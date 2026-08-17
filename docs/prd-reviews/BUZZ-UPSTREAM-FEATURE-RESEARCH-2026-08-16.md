# Buzz upstream feature research — `github.com/block/buzz`

**Date:** 2026-08-16 · **Author:** G1D (`claude-fable-5`) · **Purpose:** ground
PRD-TCLAW-COLLAB-PRESENCE-UI-005's product build-out in the ACTUAL upstream Buzz
implementation, not in the local second-hand comparison doc.
**Operator instruction:** "you can find updated code to use https://github.com/block/buzz"
**Method:** upstream README fetched, plus `gh api` reads of the real desktop client tree
and source files. Every claim below is either quoted from the README or read from source;
anything inferred is labelled INFERENCE.

> **Supersedes on facts, not on judgment:** `TORQ-BUZZ-VS-TORQCLAW-COMPARISON.md`
> (2026-08-15) analyzed a **vendored/local** copy at `E:\torq-Buzz` and reported paths
> like `source/buzz/desktop` and `apps/desktop/src`. The upstream layout is
> **`desktop/src/…`** with a `crates/` Rust workspace. Where the two disagree on file
> paths, upstream wins. The comparison doc's *judgments* (Buzz wins on liveness/presence;
> TorqClaw wins on cost; the primitives are render patterns, not callable Python) still
> stand.

---

## 1. The architectural thesis TorqClaw should copy

> **"Agents are members, not bots."** Agents have their own keypairs and audit trails,
> join channels through the same interface as people, and access the same command surface.
> Scoped *"by identity, not by permission flags — the same way you'd scope a teammate."*

This maps **exactly** onto TorqClaw's existing §2a principal lattice: a human and an agent
are both `principals` rows with `collab_members` rows, and entitlement is membership, not a
role flag. **TorqClaw does not need to invent an agent-participant model — it already has
one.** What it lacks is the surface.

Buzz's second thesis — one signed event log as the single source of truth for messages,
reactions, workflow steps, review approvals, and git events — is the part TorqClaw must
**deliberately decline** (see §5 boundary).

---

## 2. Upstream repo layout (verified via `gh api`)

Top level: `crates/` (Rust workspace), `desktop/` (Tauri + React client), `web/`,
`admin-web/`, `mobile/` (Flutter), `migrations/`, `schema/`, `docs/`, `examples/`.

**Desktop routes** (`desktop/src/app/routes/`) — the surface inventory:

| Route file | Surface |
|---|---|
| `channels.$channelId.tsx` | channel view (the main room) |
| `channels.$channelId.posts.$postId.tsx` | **thread** view (nested conversation) |
| `ChannelRouteScreen.tsx` | channel shell |
| `pulse.tsx` | **Pulse** — cross-channel activity feed |
| `agents.tsx` | agent roster / management |
| `workflows.tsx`, `workflows.$workflowId.tsx`, `WorkflowsRouteScreen.tsx` | YAML workflow automation |
| `projects.tsx`, `projects.$projectId.tsx` | projects |
| `messages.new.tsx` | DM composer |
| `reminders.tsx`, `settings.tsx`, `root.tsx`, `index.tsx` | supporting |

**Feature modules** (`desktop/src/features/`): `agents/` (large — see §3),
`agent-memory/` (incl. `buildMemoryGraph.ts`), plus presence/pulse modules.

---

## 3. The two patterns worth porting (read from source)

### 3.1 `agentWorkingSignal.ts` — ONE working signal, many surfaces

Verbatim from the module docstring:

> Every surface that shows a working affordance (sidebar channel badges, profile badges,
> agent rows, composer activity bar, activity panel header, future thread ingresses)
> should read from this module instead of picking one of the underlying pipes.

Its rules:
1. **Observer-derived active turns** (kind 24200 → `activeAgentTurnsStore`) are the
   **primary** signal — *"they carry channel scope and a start anchor."*
2. **Typing indicators** (kind 20002) are the **fallback** for agents whose observer
   stream is absent for that scope.
3. **Scope rule:** with a `channelId`, "working" means working *in that channel*; without
   one, it means any active work in any channel.

Exported shape: `AgentWorkingSource = "observer" | "typing" | "none"`;
`AgentWorkingChannel = { channelId, anchorAt, source }` where `anchorAt` is the
*"desktop-clock anchor for elapsed displays (turn start / first typing)."*

**Why this matters for TorqClaw:** the anchored-elapsed lesson is already learned locally
(PRD-UI-1 epoch-anchoring), but the *unified-signal* discipline is not. TorqClaw's
equivalent primary source is **gateway task truth** (`activeRequestId` / task store), and
there is no relay-observer equivalent — so TorqClaw has a **primary and no fallback**,
which is simpler and should be stated as such rather than faked.

### 3.2 `agentAutocompleteEligibility.ts` — how an agent gets addressed

Agents are addressed by **@-mention**, and mentionability is computed from two independent
things:

- **Membership:** `agent.channelIds.includes(channelId)` and the channel is one the user is
  a member of and not archived (`getSharedChannelIds` filters `isMember && archivedAt === null`).
- **Willingness:** a per-agent `respondTo` policy of `"anyone"` or `"allowlist"`, the latter
  checked against the requesting user's pubkey (`respondToAllowlist`).

`AgentEligibilityScope` is `{community} | {channel, channelId} | {managed-only}`.

**Design consequence TorqClaw must decide deliberately:** *being in a channel* and *being
willing to answer* are **separate** properties upstream. TorqClaw currently has only the
first (membership). If mentions are specified, the willingness axis must either be
specified or explicitly declined — not silently collapsed into membership.

---

## 4. Upstream feature status (README, verbatim categories)

**Working today:** relay; **channels, threads, DMs, canvases, media**; full-text **search**;
audit log; desktop app (Tauri + React); `buzz-cli` (agent-first, JSON in/out) + **ACP
harness (Goose, Codex, Claude Code)**; **YAML workflows** with message/reaction/schedule/
webhook triggers; git events (NIP-34); git hosting backend.

**In development:** mobile clients; **workflow approval gates** (*"infrastructure exists,
integration pending"*); huddle lifecycle events.

**Planned:** web-of-trust reputation across relays; push notifications; culture features.

**Presence/typing/roster** are implemented in `buzz-pubsub` (*"Redis-backed pub/sub,
presence, typing indicators"*) — i.e. **ephemeral transport state, not durable log state.**
That is an important structural cue: presence is NOT an event in the permanent record.

**UI affordances evidenced by README screenshots:** emoji **reactions** in-channel; an
**"Add a channel" dialog with search, filters, and channels to join or create"**;
media with **frame-anchored comments**.

---

## 5. THE BOUNDARY — what TorqClaw must NOT copy

Buzz's canonical workflow example (quoted): *"A workflow fires on a tag. An agent reads
merged PRs, drafts release notes, posts for human review, **gets 👍 reaction, and ships**."*

**A reaction triggering a ship is precisely what TorqClaw's frozen operator ruling
forbids.** In TorqClaw, `approve` is reserved operator-surface authority; no channel
message, agent post, reaction, or collab event may approve, trigger, or widen a gated
action (PRD §2(b), frozen 2026-08-08). PRD §2(d) already says it: *"a message is data, not
a command."*

Therefore, when porting Buzz features:

| Buzz feature | TorqClaw disposition |
|---|---|
| Channels, threads, timeline, roster, presence | **Adopt** (this PRD) |
| @-mentions of agents | **Adopt with care** — mention = addressing, never authorization |
| Reactions | **Adopt as sentiment only**, never as a trigger/approval signal |
| Reaction/message-triggered workflows that execute | **DECLINE** — collides with the frozen ruling |
| Workflow approval gates in-channel | **DECLINE** — approvals stay on the operator surface |
| Nostr keypair identity / relay | **DECLINE** — TorqClaw identity is server-derived surface credentials (C0/C1 H-1) |
| One event log as the source of truth for everything | **DECLINE** — the gateway remains sole execution authority; collab is a co-presence record, not a command bus |
| Canvases, media, git events, DMs, search, workflows | **OUT OF SCOPE for 005** — name them as future efforts so the PRD is honest about what "Buzz parity" does and does not mean |

---

## 6. Feature inventory for the product build-out (what a user would expect)

Ordered by how load-bearing each is for "humans and agents chatting in the same channel to
build or research." Feasibility is judged against the substrate research (separate thread);
anything marked **NEEDS SUBSTRATE** must be confirmed before it enters an acceptance criterion.

| # | Feature | Buzz has it | Notes for TorqClaw |
|---|---|---|---|
| 1 | Channel list + join/create dialog with search/filters | yes | listChannels exists; create exists in substrate |
| 2 | Channel timeline (paged, contiguous) | yes | **S1 shipped the read path** |
| 3 | Composer / post a message | yes | S3 |
| 4 | Roster: members vs working-now, two labeled sections | yes | PRD §8 roster label rule already frozen |
| 5 | Agent participants rendered as members | yes | principal `kind` distinguishes; §2a lattice already supports |
| 6 | Working/liveness badge with anchored elapsed | yes (`anchorAt`) | port the UNIFIED-SIGNAL pattern; primary = gateway task truth |
| 7 | @-mention addressing + autocomplete | yes | decide the willingness axis (§3.2) |
| 8 | Threads (nested replies) | yes | **NEEDS SUBSTRATE** — likely absent |
| 9 | Reactions | yes | **NEEDS SUBSTRATE**; sentiment only, never a trigger |
| 10 | Unread counts / last-read cursor | not confirmed | **NEEDS SUBSTRATE** — chat UIs assume it |
| 11 | Search over messages | yes (Postgres FTS) | **NEEDS SUBSTRATE** — likely absent |
| 12 | Typing indicators | yes (ephemeral) | ephemeral transport state; do not persist |
| 13 | Cross-channel activity feed (Pulse) | yes | a later slice at best |
| 14 | DMs, canvases, media, git events, workflows | yes | explicitly OUT of 005 |

---

## 7. Honest gaps in this research

- The README does **not** state the mention/slash-command mechanism explicitly; the
  @-mention conclusion is read from `agentAutocompleteEligibility.ts` source, which is
  strong evidence but is client-side eligibility logic rather than a protocol statement.
- Channel/thread/reaction **data shapes** were not read from `crates/` — only the client
  feature surface and the README. Any TorqClaw claim about wire shape must come from
  TorqClaw's own substrate, not from this doc.
- Buzz's UI *visual* design was not inspected (no screenshots fetched); the TorqClaw view
  must follow the console's own token system regardless.
