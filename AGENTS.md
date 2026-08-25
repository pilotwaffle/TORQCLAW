# AGENTS.md - Rooms UI lane (worktree `rooms-ui`, branch `rooms-ui-phase0`)

This worktree is the only place Rooms UI work happens. Do not edit the main checkout at `E:\TorqClaw` from this lane, and do not run this lane's sessions with full-access/auto-approve in `E:\.claude` or `E:\TorqClaw`.

## The job

Build Torq Rooms Phase 0 per `docs/PRD-TCLAW-ROOMS-UI-PHASE0.md` and the approved Gate 1 packet.

`docs/PRD-TCLAW-ROOMS-UI-008.md` is a historical/superseded stub and is not build authority.

Phase 0 is a reversible Room shell and product-label pass over existing console facts. It is not a new authority plane. Do not add Room-local approvals, receipts, budgets, agent management, schedules, export-policy mutation, message composer, ACK behavior, Web Locks/IndexedDB ledger, gateway correlation substitutes, or client-side operation recovery from this lane unless a later gated packet explicitly authorizes it.

## Hard boundaries

1. UI-first lane. Prefer data the gateway already serves. If a slice needs a gateway/contract change, stop and file it; that change ships from the main lane first, then this branch rebases onto it. Do not fork contracts, authz, store, or dispatcher logic here.
2. No approval/budget/receipt bypass. Bots never send external messages or write files outside the existing approval path. Never weaken member-payload key-set tests.
3. Room current-session evidence is rendering/navigation only. Room spend caps, per-room allowed tools/path scope, in-room approval decisions, and Room-local write controls are deferred unless a later gated packet authorizes them.
4. No Slack/Discord/X adapters. No new dependencies without saying so first. No secrets in code, logs, or commits; the repo is public.
5. Follow repo conventions: pnpm + turbo. Gates before done: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm --filter @torqclaw/contracts check`, `pnpm reachability` when available and relevant. Two tests are known load-sensitive: `tests/collab-build-lock.test.ts`, `tests/failover/*` cold-start; rerun isolated before calling them regressions.
6. Commit on this branch only. No push/merge to master from this lane without the operator's explicit go. Merges happen rebased, with a `git diff --stat origin/master...HEAD` deletion audit of zero.
7. Governed multi-model work uses packet handoffs in `E:\.claude\model-handoff\rooms-ui-phase0-implementation-20260824\`, fresh threads per seat, and the operator's OpenAI-only routing instructions.

## Coordination with the main lane

- Presence data available after the current master baseline: `working/since`, STOP state, `resolution_note='duplicate_suppressed'`, enablement through existing global agent surfaces, and membership add/remove events.
- Questions/blockers should go in this lane's notes or handoff packets rather than editing shared main-lane docs.
