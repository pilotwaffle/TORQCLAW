# `E:\torq-Buzz` reuse audit — what TorqClaw can actually take

**Date:** 2026-08-16 · **Author:** G1D (`claude-fable-5`) · **Method:** read-only review of the
operator's local Buzz distribution, plus direct verification by G1D of the load-bearing claims.
**Operator instruction:** *"review in detail e:\torq-buzz to see if you can use anything already
built on this system."*
**Companion:** `BUZZ-UPSTREAM-FEATURE-RESEARCH-2026-08-16.md` (upstream `block/buzz`).

> **Nothing was modified in `E:\torq-Buzz`.** No services started, no Docker, no writes.
> **Secret scan: clean.** No PEM keys and no `nsec1…` private keys found outside vendored
> source. The Nostr identity secret lives in Windows Credential Manager, outside that repo.
> `config/permanent-human.pubkey.txt` is a **public** key. No secret values are reproduced here.

---

## 0. What `E:\torq-Buzz` is

Not a vendored copy — an **operational wrapper** the operator built around upstream
`block/buzz`: `source/buzz` is a real git submodule (pinned `v0.5.2` / `3e48f1b2…` in
`config/installation.json`, currently checked out at `relay-v0.2.1` with the local patch
applied). Operator-authored: `harnesses/`, `patches/`, `scripts/`, `compose/`, `schemas/`,
two small Rust crates, `docs/`, and the `evidence/` + `state/` audit trail.

Gate state is honest and incident-scarred: only **C1 (read-only validation) verified**; a C5
partial live deployment hit a "pilot process regression" and triggered containment. C3
(signing), C4 (publish), and live migration remain unauthorized.

---

## 1. ⚠ CORRECTION — the biggest "find" is a trap

An automated review flagged `torq-Buzz/docs/PRD-TCLAW-COLLABORATION-SUBSTRATE-001-v0.2.md`
as the top reusable asset, recommending it be *"copied over verbatim as the starting
contract."*

**Do not.** G1D verified directly:

| | |
|---|---|
| `torq-Buzz/docs/` | `PRD-…-SUBSTRATE-001.md` + `-v0.2.md` |
| `TorqClaw/docs/prd-reviews/` | v0.2, v0.3, v0.3-ADDENDUM, v0.4, **…, v0.10–v0.14**, plus `PRD-TCLAW-COLLABORATION-FINAL-STATUS.md` |

TorqClaw already holds the canonical spec **through v0.14**, hardened across **twelve G1R
cycles** (TERRA 1–5, OPUS5 6–12) and seven G2A slice audits. The `torq-Buzz` copy is the
**v0.2 early draft — twelve versions stale**. Importing it would regress the contract to a
pre-review state.

**Correct disposition: `torq-Buzz`'s PRD copies are historical artifacts. v0.14 in
`TorqClaw/docs/prd-reviews/` remains authoritative.** Their real value is provenance — they
show the substrate was drafted with Buzz as the live reference sandbox, which is why the
data model is a good fit for co-presence in the first place.

---

## 2. Genuinely reusable — ranked

### 2.1 Presence state machine — **portable design, verified**
`source/buzz/desktop/src/features/presence/lib/presence.ts` (+ colocated `presence.test.mjs`).
Small, pure, dependency-light functions (`resolveAutomaticPresenceStatus`,
`mergePresenceUpdate`, `parseLivePresenceEvent`) around three constants:

```
PRESENCE_HEARTBEAT_INTERVAL_MS = 60_000
PRESENCE_TTL_SECONDS           = 3 * (heartbeat/1000)   // exactly 3 windows
PRESENCE_IDLE_TIMEOUT_MS       = 10 * 60_000
```

Two comments encode lessons you only learn by shipping it wrong:
1. *"The relay owns the authoritative TTL; **deploy its TTL increase before shipping a
   desktop build with a slower heartbeat**."* — a client/server rollout-ordering hazard.
2. *"**Away means 'human not at the machine'** (Slack/Discord semantics), **never 'Buzz is
   not the focused window'**. OS-wide idle is authoritative when available; otherwise fall
   back to in-app activity."*

**For TorqClaw:** the state machine ports cleanly (pure TS, no Nostr in these functions); the
*transport* does not. **But note the §11 feasibility ledger — our substrate has no presence
concept at all, and `surfaces.last_seen_at` is a dead column.** So this informs a *future*
presence effort, not S5. **S5's "working now" stays derived from gateway task truth.**

### 2.2 Typing indicator — **portable design, not needed yet**
Kind 20002; broadcast throttled to 1/3s, receiver TTL-expires at 8s with a 1s prune tick,
keyed per `(pubkey, thread)`, with a suppression window after a real message so a stale dot
never survives a send. Purely ephemeral — no persistence, which is exactly why it maps onto a
WebSocket gateway without a schema change. **PRD §12 currently declines typing** (no transport
for it); this is the design to use if that reverses.

### 2.3 Receipt-owned process lifecycle — **best operational pattern here**
`scripts/Stop-Buzz.ps1`, `scripts/Buzz-Status.ps1`. Never kills by process name. Loads a JSON
receipt and matches **pid + exe path + exe sha256 + creation time + redacted-cmdline-hash +
role** against the live process before allowing a stop. **Dry-run by default**; a live stop
needs both `-Mode Live` and `-ConfirmLiveStop`. Survives Windows PID reuse. Status probing is
read-only, redacts secrets from log tails before writing evidence, and treats
`Up … (unhealthy)` as **not** healthy (a common footgun).

**For TorqClaw:** directly applicable to gateway/dev-process supervision, independent of
language. This is the single most transferable thing in the repo.

### 2.4 Agent-turn control vocabulary — **design worth stealing**
`source/buzz/crates/buzz-acp/src/config.rs`:
- `RespondTo`: **owner-only / allowlist / anyone / nobody** — this is upstream's *willingness*
  axis, the one §12a says we lack.
- `MultipleEventHandling`: **Queue / Steer / Interrupt / OwnerInterrupt** — what to do when a
  message lands mid-turn.
- Two separate caps: idle timeout (900s) vs absolute max turn duration (7200s).

**For TorqClaw:** a minimal, well-factored vocabulary for "how does a running agent handle
incoming chat." Relevant **only if** mention-invocation is ever specified — and §12a is
explicit that it is **not** in this PRD. Recorded so that a future effort starts from this
vocabulary instead of inventing a worse one.

### 2.5 Schema-level secret exclusion — **portable idea, adopt now**
Both operator schemas carry:
```json
"not": { "anyOf": [ {"required":["private_key"]}, {"required":["nsec"]}, {"required":["secret_key"]} ] }
```
Defense in depth that a receipt/state artifact can **structurally** never carry a secret.
Trivial to mirror in a Zod contract. Worth adopting in TorqClaw's receipt/safe-export path.

### 2.6 Journal/state-machine crash recovery — **design, reimplementable**
`crates/torq-buzz-event-verify/src/step.rs`: idempotent
`PLANNED→DUPLICATE_CHECKED→SIGNED→PUBLISHED→VERIFIED→COMPLETE` with `COMPLETE_REUSED` /
`AMBIGUOUS_DUPLICATE` terminals, atomic write-then-rename, **never re-sign — only re-publish
the persisted artifact**, recovery-by-requery after interruption. Generalizes to any
exactly-once side-effecting operation. Rust, but small enough to reimplement.

### 2.7 Chat-UI edge-case checklist — **use as a checklist, not code**
`source/buzz/desktop/src/features/{chat,channels,messages,presence,agents}` is a mature
feature-sliced React app with colocated tests. Its `lib/` module names are a free inventory of
problems any chat UI hits: canonical name normalization, thread badge/unread counts, member
admission, search scoring, ephemeral channels, virtualized-list scroll settle. **Read the
names, not the code** — it is Tauri + Rust IPC.

### 2.8 The local patch — **tells you what upstream assumes**
`patches/torq-buzz-local.patch` (4 files) reveals three upstream gaps: Gemini CLI rejects ACP
`initialize` unless a `fs` capability block is present (declare it honestly as `false` rather
than omit); health/metrics needed env-configurable bind addresses to stay on **loopback**; and
Windows needs `CTRL_BREAK` handling for graceful shutdown. Upstream assumes Linux/containers
with all-interface binding. Confirms TorqClaw's loopback-first default is the right instinct.

---

## 3. NOT reusable — impedance mismatches (stated plainly)

| Asset | Why not |
|---|---|
| `buzz-relay` (Rust, Postgres + Redis + MinIO, NIP-01/42) | Architecturally incompatible with TS/SQLite/WebSocket and gateway-as-sole-authority. Do not port. |
| **Nostr identity model** (per-agent keypairs, self-signed events) | Buzz trusts a **signature**; TorqClaw's gateway **trusts itself**. Any code assuming event self-authentication is inapplicable once a single trusted gateway exists. This is the deep divergence — see §4. |
| `compose.torq-buzz.yml` (Postgres/Redis/MinIO) | TorqClaw is SQLite-only. Different persistence tier. |
| Tauri desktop packaging | Console is a Next.js web app; Rust-IPC bridge does not transfer. |
| `harnesses/*.json` | ~10-line CLI-spawn declarations for Buzz Desktop's picker (`command`, `args`, `env`). Not protocol code; nothing to port. |
| `evidence/`, `state/` | Audit data and one-off onboarding scripts, not infrastructure. |

---

## 4. The finding that matters most

The local install makes the architectural divergence concrete rather than theoretical.
**Buzz's trust anchor is the signature; TorqClaw's is the gateway.** Buzz can let any
participant emit an authoritative event because the keypair proves who emitted it —
which is exactly why a 👍 reaction can legitimately ship a release *in Buzz*.

TorqClaw has no per-agent keypairs and no self-sovereign signing (credentials are
`tq1_…` bearer tokens, HMAC-with-pepper, issued by the operator). An event in our
system proves nothing on its own; only the gateway's own evaluation does. **That is the
mechanical reason PRD §2(b) and §12's declines are correct, not merely conservative:
we lack the cryptographic substrate that makes Buzz's model sound, and adding channel
events to the authority path would create authority with no proof behind it.**

---

## 5. Recommended actions

1. **Do NOT import the substrate PRD from `torq-Buzz`** — v0.14 in `TorqClaw/docs/prd-reviews/`
   is authoritative and twelve review cycles ahead (§1).
2. **Adopt the schema-level secret exclusion** (§2.5) in TorqClaw's receipt/safe-export
   contracts — cheap, additive, defense in depth.
3. **Record the presence/typing designs** (§2.1, §2.2) against a *future* presence effort;
   they do not change S5, which stays gateway-task-derived per the feasibility ledger.
4. **Consider the receipt-owned process lifecycle** (§2.3) for dev/ops tooling — the strongest
   transferable pattern, and independent of this PRD.
5. **Leave `E:\torq-Buzz` alone.** It is a gated, incident-scarred operational exercise with a
   documented stop rule (never `Stop-Process -Name buzz-relay`; receipt-owned stop only).
   Nothing in this PRD requires touching it.
