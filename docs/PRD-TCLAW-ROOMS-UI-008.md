# PRD-TCLAW-ROOMS-UI-008 — Torq Rooms: the console reframed around a governed Room workspace

**Status:** v0.0 STUB — pre-G1D. Not scoped, not reviewed, not authorized for build.
**Worktree:** `E:\TorqClaw-worktrees\rooms-ui` on branch `rooms-ui-phase0` (base `8209d30`). All Rooms work happens THERE — never in the main checkout (ruling 2026-08-24, after the five-undeclared-files incident proved shared-checkout concurrency unsafe).
**Origin:** operator-forwarded proposal (GPT, 2026-08-24) + operator question "should they work on this in a separate tree to be merged when completed?" → ruled YES.

## Concept (from the proposal, accepted as direction)
Evolve — not redesign — the existing console: Channels become **Rooms**, the primary workspace. Room header (objective, owner, status, budget, policy, active agents); Room view split into **Timeline** (messages, handoffs, receipts, tool activity), **Work Queue** (active runs, blocked approvals, scheduled turns, completed), **Control Rail** (agents, permissions, budget, tools, memory scope, stop). Approval cards render in-room; receipts linkable from timeline items; agent presence states (idle / working / blocked / awaiting-approval / stopped / suppressed); room-level settings (auto-reply, schedule, spend cap, allowed tools, path scope, retention).

## Accepted constraints (verbatim from the proposal, matching standing rules)
No Slack/Discord/X adapters first (Phase 3 owns reach). No marketing dashboard. The task stream is not buried — it becomes the Room's operational timeline. No bot external messages or writes outside the existing approval/budget/receipt path.

## What already exists to build on (cite before scoping)
- Presence: `working/since` (S4, shipped), STOP state (S3), suppressed-duplicate discriminator (channels slice, in flight), `no_post` accounting.
- Governance surfaces: approvals stream, receipts, spend telemetry, export policy per channel, curated membership + enablement (channels slice, in flight).
- Live push: S5 fanout with per-delivery revalidation.

## Known collisions with open decisions (must be resolved at G1D, not assumed)
1. In-room approval cards ↔ the **unbuilt C3 delivery lane** (rendering in-room is UI; pushing a card to a surface is C3's scope — do not smuggle C3 in).
2. Room-level spend caps ↔ Phase-3 §11 open operator decision (per-channel cumulative caps).
3. Per-room allowed tools / path scope = **new authority surface** → High-risk tier, its own G1R, gateway-enforced (never UI-enforced).
4. Any presence/queue field visible to co-members beyond `{principalId, displayName, working, since}` requires a new §2a ruling (OQ-8 precedent: enablement state is operator-only).

## Merge contract
Rooms lands as reviewed PRs from `rooms-ui-phase0` onto master through the standard gates (G1D → G1R → build → verify → G2A), rebased before merge, deletion audit zero. The main-checkout lanes (channels slice, Phase 3) never edit the same files concurrently; where a Rooms slice needs a gateway/contract change, that change ships from the main lane first and Rooms rebases onto it.

## Next action
G1D scoping session IN THE WORKTREE: decompose into slices (likely: R1 rename+header from existing data · R2 timeline consolidation · R3 control rail from existing controls · R4 work queue · R5 in-room approval cards after C3 · R6 room settings after the authority PRD), each with its own packet.
