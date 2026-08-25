# Buzz channel-agent mechanics — survey + TorqClaw parity map (2026-08-24)

> Read-only survey of `E:\TORQ-BUZZ` (buzz-acp crate, ~37.8k lines) commissioned by the operator ("look at what's already working in e:\torq-buzz and apply it"). Scoping input for future gated slices; nothing here is authorized for build by itself. File:line citations refer to `E:\TORQ-BUZZ\source\buzz\crates\buzz-acp\` unless noted.

## TOP 5 BUZZ MECHANICS (ranked by the scout), with TorqClaw parity status

| # | Buzz mechanic | Citation | TorqClaw status (2026-08-24) |
|---|---|---|---|
| 1 | **Pin the agent's own most recent reply into the window with a dedicated query**; if outside the window, swap it in over the oldest message | `pool.rs:2902, 3209-3233` | **≈COVERED differently**: PR #59/#60 anchor window includes own turns, collapsed to the most recent representative + marker. Buzz's "swap-in when truncated" guarantee is worth checking against our WINDOW_EVENT_COUNT truncation — possible gap when the agent's newest reply falls outside the 40-event window. FOLLOW-UP CANDIDATE. |
| 2 | **Prompt-level bare-acknowledgement ban** with prohibited-string list + reason ("it re-triggers everyone you mention") + "silence is usually correct... a success, not a failure" | `base_prompt.md:86-101` | **GAP (cheap win)**: our local preamble says "no acknowledgement-only message" but lacks the prohibited-string list and the silence-is-success framing. Apply via PERSONA system_directives (operator content, no code) now; consider the shared preamble later (dispatcher edit → gated). |
| 3 | **Batch-drain all pending channel events into ONE prompt; scope = LAST event** (`MAX_BATCH_EVENTS=50`) + one-turn-per-channel in-flight lock | `queue.rs:260-330, 1412-1423, 137-171` | **≈COVERED**: coalescing + keyed turn ownership exist. Parity check worth doing: does a burst of N messages produce one reply or N? (Our coalescing is trigger-level; Buzz's is prompt-level.) FOLLOW-UP CANDIDATE. |
| 4 | **Harness-computed reply anchor injected as an IMPORTANT instruction**; human-facing flattens to thread root, agent↔agent nests freely; unknown identity fails open to human | `queue.rs:1187-1229, 1154-1177` | **N/A YET** (TorqClaw channels are flat, no threading) → **Rooms lane (PRD-008)** input: when the Timeline gains threading, compute anchors in the gateway, never leave threading to the model. |
| 5 | **Two-phase 👀→💬 reactions behind a Drop-guard + per-channel session affinity** (warm session skips session/new, system prompt sent once) | `lib.rs:2511-2517`, `pool.rs:3418-3477, 587-609` | **PARTIAL**: working/since presence overlay (S4) ≈ 💬; no instant 👀-class ack (UI, → Rooms lane). Session affinity: ollama keep_alive -1 + persistent ACP subprocess pool already give the warm path; per-channel ACP session reuse worth a parity check. |

**Honorable mention:** non-cancelling mid-turn steer with shared framing strings between native and cancel+merge paths (`lib.rs:3154-3235`, `queue.rs:1617-1631`) — relevant when TorqClaw agents get long turns.

## Other load-bearing detail (condensed from the scout)

- **Context**: fixed 6-section prompt as separate blocks; history is a FETCHED bounded window (default 12 msgs), never a running transcript, never LLM-summarized; truncation honestly labeled ("8 of 41 messages, truncated"); own messages rendered identically to others' (flat named transcript, `[N] Name (hex) (ts): content`), no assistant-role distinction.
- **Persona layering**: [Base] (147-line compiled base prompt) → [System] persona (markdown w/ YAML trigger frontmatter: mentions/keywords/all_messages/thread_replies) → [Team Instructions] → [Workspace] → [Agent Memory — core]. For protocol-v2 all of it rides session/new ONCE; per-turn payload starts at [Context].
- **Key base-prompt language worth copying into personas** (verbatim fragments):
  - "If your turn produced anything worth knowing, you MUST publish it... a result... exists only if you published it."
  - "If a human asked you something, you MUST reply to them — even if the reply is only that you have nothing to add."
  - "Otherwise... silence is usually correct... That is a success, not a failure."
  - "Never publish a bare acknowledgement... Prohibited: 'Got it', 'Confirmed', 'Acknowledged', 'Clear and noted', 'Aligned', 'Standing by', 'Parked', 'I won't reply again'... it re-triggers everyone you mention."
  - "After a context compaction or session restart, resume silently."
  - Session-identity framing: "You are one per-channel session of your agent identity — not the only copy... Sessions share your core memory... They do NOT share conversation context."
  - Delegation callback: "When you finish delegated work, you MUST @mention the delegator... completed work only."
- **Anti-storm = 8 structural layers**: self-reply suppression (default-on), inbound author gate (default owner-only, with signature-verified SIBLING admission for same-owner agent teams — the mechanism for bounded agent-to-agent talk), per-channel in-flight lock w/ expiring deadline, Queue-dedup batching, 500-deep queue with drop-oldest, exp backoff + dead-letter, fail-closed filter eval (errors never widen the subscription; 5 consecutive timeouts disable a rule), prompt-level ack ban. NO time cooldowns, NO output-text dedupe, NO hop counters.
- **Owner controls**: `!shutdown` / `!cancel` / `!rotate` — kind+content+mention+author==owner, consumed by harness, never forwarded.
- **Trigger**: default mention-gated AT THE RELAY SUBSCRIPTION (non-mentions never reach the process) + re-checked in-process; ordered first-match-wins rules with evalexpr; most-permissive-wins when merging into the relay filter.
- **Latency**: persistent ACP subprocess pool (spawned before subscribing), per-channel session affinity two-pass claim, system prompt in session/new only, bounded context fetches that degrade to None instead of blocking, fire-and-forget reactions/typing (try_publish never stalls the turn). Generous timeouts (idle 900s, turn 2h) — optimized for long work surviving, not sub-second chat.
- **Liveness UX**: 👀 on queue-accept, 💬 on prompt-start, both Drop-guard removed; typing indicator on a refresh timer; kind:20001 presence heartbeat online/offline.
- **Threading**: harness computes the reply anchor and injects a literal IMPORTANT instruction (two verbatim forms for thread-reply vs new-top-level); human-facing flattened to root, agent↔agent free; "do not reuse a remembered thread id."
- **Memory**: NIP-AE core engram injected per session; hygiene rules in base prompt (≤~10KB, cold detail to mem/<topic>, evict shipped work same turn).
- **Steer**: default multiple_event_handling="steer" — non-cancelling injection of the new event into the live turn; cancel+merge fallback shares framing strings; merge header deliberately does not overclaim preserved state.

## Recommended application order (G1D judgment, not yet gated)

1. **NOW (no code, operator-content):** upgrade channel-agent personas with the Buzz base-prompt language block (ack ban + silence-is-success + answer-the-newest + reply-when-human-asks). Done for TORQ AI via UPDATE_AGENT_PROFILE after the collapse fix ships; template for the other agents.
2. **Parity checks (cheap, evidence-first):** (a) burst-of-N → one reply? (b) does our window include the agent's newest own reply when it falls outside WINDOW_EVENT_COUNT? (c) per-channel ACP session reuse for subscription agents?
3. **Gated slice candidates, in value order:** shared base-prompt layer for the local-fallback preamble (dispatcher, needs G1R) · own-newest-reply swap-in guarantee (autoReplyContext, not frozen) · sibling-style co-member agent triggering when OQ-2 scope evolves (already partially ruled) · owner control commands (!cancel-class) as channel messages.
4. **Rooms lane (PRD-008) inputs:** 👀/💬 two-phase reactions, typing indicator, harness-computed reply anchors when threading lands, truncation honesty labels in the Timeline.
