# TORQ CLAW vs. TORQ Buzz — Merged Comparison

**Type:** Review artifact · **Scope:** UI/console lens + repo/architecture lens
**Date:** 2026-08-15 · **Status:** code-grounded; every claim below cites a real file or is explicitly flagged unverified

---

## 1. Purpose

Two earlier lines of analysis — a UI/five-lens comparison (Buzz desktop vs. TorqClaw's
`apps/console`) and a repo-level comparison (TORQ CLAW = governed execution control
plane vs. TORQ Buzz = Nostr collaboration workspace) — produced complementary findings.
This document merges them so one artifact, grounded in actual code, can drive a single
set of decisions.

---

## 2. The two repos at a glance

| | **TORQ CLAW** (this repo) | **TORQ Buzz** (`E:\torq-Buzz`) |
|---|---|---|
| Role | Governed **execution control plane** (TS gateway/router/MCP bridge/console) wrapped around a vendored Hermes Python engine | Windows **collaboration workspace**: distribution of `block/buzz` — multi-agent Nostr workspace over a loopback relay |
| Stack | TypeScript (Fastify, Zod, Next.js) + Python Hermes kernel; pnpm monorepo | Rust (Buzz binaries) + Docker (Postgres/Redis/MinIO) + PowerShell ops + Nostr |
| Core subsystems | Routing (LOCAL_EDGE/FRONTIER), authz seats, approval-gated writes, budgets, receipts/safe-export, verified skills, execution profiles, provider failover | Pinned Buzz + patches, ACP harnesses, relay ops, receipt schemas, stop-ownership safety |
| Execution authority | Gateway is **the** authority; clients/collab cannot inject authority | Agents are distinct Nostr identities coordinated over a relay |
| Maturity | Phases 0–1 complete (~991 TS + 303 Python tests; adversarial G1D→G1R→Builder→G2A) | Gate 1 `C1_VERIFIED_READY_FOR_C2_C5`; 3 agents live in `#agent-lab` |

**Relationship:** these are two **layers of the same program**, not two implementations.
TORQ CLAW is the governed *brain* (routes a task to a local or cloud engine, enforces
approval/budget/receipts); TORQ Buzz is the *switchboard* (multiple CLI agents coexist as
identities on a relay). Buzz supplies identity/room; TORQCLAW supplies trust-governed
execution.

---

## 3. Five-lens UI/console comparison (verified)

| Lens | Buzz (`source/buzz/desktop`) | TorqClaw (`apps/console`) | Note |
|---|---|---|---|
| **Liveness** | Two-signal pipeline: observer-derived active turns → typing fallback, elapsed anchored to a real start (`agentWorkingSignal.ts`: `anchorAt`, kind 24200 observer → kind 20002 typing; `activeAgentTurnsStore.ts`); persistent `ui/TurnLivenessIndicator.tsx` at the transcript edge | Single hand-rolled `busy` flag derived from the last non-SYSTEM event (`TorqTerminal.tsx`, around the `{busy && … working…/stopping… }` block) with `<Elapsed />` that counts from mount — no start timestamp | Buzz wins. TorqClaw's elapsed is not anchored to the real turn start |
| **Cost** | Nearly none: one inline per-turn `Tokens: used/size ($amount)` line (`ui/agentSessionTranscript.ts` ~L1046–1072) | Rich: `components/CostPanel.tsx` (caps, totals, remaining, cap-state, provider summary, ledger) | TorqClaw wins. Keep the no-fabrication rules |
| **Staleness** | Keeps stale data visible + a non-blocking refresh-failure affordance; `features/presence/lib/presence.ts` + `ui/PresenceBadge.tsx`. *(The exact `MemoryStaleErrorBanner` filename from an earlier note could not be re-verified — treat the mechanism as real, the name as unconfirmed.)* | Connection dot (red/green) + "connected/reconnecting" text; no "last synced" and no live-vs-cached badge. Sole "last refresh" cue is in `components/ApprovalHistoryPanel.tsx:193` | Buzz has the better missing-piece pattern to copy |
| **Agent presence** | First-class: `features/presence/`, `features/pulse/ui/PulseScreen.tsx` + `PulseView.tsx` + `app/routes/pulse.tsx`, working badges | Opaque single process built around `activeRequestId` (`TorqTerminal.tsx:153`; `components/friendly.ts` `selectActiveRouteDiag`) — no roster, no channels | Biggest structural gap for TorqClaw |
| **Activity feed** | Pulse screen (relative timestamps, collapsible updates) + per-agent transcript rail | The whole terminal is the feed + overlay panels (Receipts/Approvals/Cost), friendly labels, `aria-live` | Different shapes, both strong |

---

## 4. The "hours from reuse" claim — **corrected**

Earlier analysis said the vendored Hermes kernel "already ships rich presence/status
primitives dead-in-repo, hours from reuse." **That is only partly right, and the details
matter before anyone promises a fast win:**

- **Verified present, but in the *bundled desktop web app*, not the Python kernel or the
  terminal TUI:** `LiveDuration` (`apps/desktop/src/lib/statusbar.ts`), `GlyphSpinner`
  (`apps/desktop/src/components/ui/glyph-spinner.tsx`), `ActionStatus`
  (component + `ActionStatusResponse` type + `getActionStatus` RPC in
  `apps/desktop/src/`), the statusbar health cluster (`gateway-health`/`agents`/`cron`/
  `command-center` in `use-statusbar-items.tsx`), and the **Command-Center** system/usage
  screen (`apps/desktop/src/app/command-center/index.tsx`).
- **Verified absent from the Python layer under those names:** `gateway/` (Python) has no
  `ActionStatus`; the Python status modules that do exist are different, unrelated things
  (`gateway/status.py`, `hermes_cli/status.py`, plus an unrelated `/statusbar` TUI toggle).
- **Polling refresh genuinely spans both:** desktop `startUpdatePoller()` (1500 ms,
  `apps/desktop/src/store/updates.ts`), Command-Center poll loop
  (`apps/desktop/src/app/command-center/index.tsx:236`), and the terminal TUI's own
  MTIME poll (5000 ms, `ui-tui/src/app/useConfigSync.ts`) + 1.5 s session list poll.

**Consequence:** the rich primitives are reusable as *React component/render patterns*, not
as callable Python primitives inside the TorqClaw Next.js console. "Hours from reuse" is
optimistic; "a fetch/render pattern worth porting" is accurate.

---

## 5. Synthesis — where the two lines meet

- The **gaps the five-lens pass surfaced** (liveness not anchored, no presence/roster,
  no last-synced badge in the console) are exactly the gaps Buzz already solved — and
  the transcript of a real governed cloud task (`working…` + elapsed from 0, no visible
  agent to watch) is the user-visible symptom.
- The **repo pass adds the missing layer:** the reason the console feels "minimal" is
  deliberate (one surface, one agent, read-only drill-downs); the rich liveness machinery
  sits in the vendored desktop bundle one package over, written for a multi-session product.
- TORQ Buzz and TORQ CLAW share the same governance DNA (receipts/evidence, secret
  hygiene, loopback-first, hard gate discipline, operator-controlled high-risk actions) but
  split the problem cleanly: **Buzz = identities + room, TORQCLAW = governed execution.**

---

## 6. Recommendation

Prioritize in this order:

1. **Anchor TorqClaw liveness + presence to a real turn/start signal** (mirror Buzz's
   `agentWorkingSignal`/`anchorAt` pattern under `activeRequestId`). This is the highest
   user-visible gap and it directly matches how the governed cloud tasks stream today.
2. **Port the cost panel is done — add the staleness "last synced"/live-vs-cached badge,**
   borrowing Buzz's non-blocking-refetch + refresh-failure affordance.
3. **Treat the vendored desktop primitives as reference patterns, not drop-in code** when
   adding a roster/Pulse-like surface — and only after confirming the vendored bundle is a
   version TorqClaw ships (it is vendored in-tree).
4. **Separately, close the cloud "web-only" toolset gap** (the landing-page task in the
   transcript could not write files): route build tasks to a write-capable profile while
   keeping approval gates.

---

## 7. Verifiability index (claims that could not be reproduced)

- `MemoryStaleErrorBanner` filename in Buzz — **unverified** (no file matched `*Stale*`);
  treat the mechanism as real, the name as unconfirmed.
- Line references in TorqClaw's `TorqTerminal.tsx` for the busy/`Elapsed` block are
  approximate (the block sits in the `{busy && …}` region ~L484–497); the `activeRequestId`
  memo at `:153` and the route-chip gate at `:505` were read directly.
- Buzz per-turn `Tokens:` line located at `agentSessionTranscript.ts` L1046–1072.